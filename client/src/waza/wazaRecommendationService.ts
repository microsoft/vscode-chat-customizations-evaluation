import * as fs from 'fs';
import * as path from 'path';
import type { SkillContext, WazaDependencies } from './wazaTypes';
import {
    MAX_PROMPT_SECTION_CHARS,
    MAX_TASK_FILE_COUNT,
    MAX_TASK_FILE_SIZE_BYTES,
} from './wazaConstants';

interface WazaRecommendationServiceDependencies {
    getExtensionContext: () => WazaDependencies['extensionContext'];
    getOutputChannel: () => WazaDependencies['outputChannel'];
    requestLLM: WazaDependencies['requestLLM'];
}

export class WazaRecommendationService {

    constructor(private readonly deps: WazaRecommendationServiceDependencies) { }

    async generatePostEvalRecommendation(
        context: SkillContext,
        evalPath: string,
        resultsFile: string | undefined,
        failureContext?: {
            commandStdout: string;
            commandStderr: string;
            commandExitCode: number;
        },
    ): Promise<string | undefined> {
        const extensionContext = this.deps.getExtensionContext();
        const outputChannel = this.deps.getOutputChannel();

        try {
            outputChannel.appendLine(`[Waza] Generating post-eval recommendation for ${context.skillName}...`);
            outputChannel.appendLine('[Waza] This recommendation will analyze your skill file, evaluation tasks, and failure context to suggest what should be fixed next.');

            const [skillContent, evalContent, taskFiles] = await Promise.all([
                fs.promises.readFile(context.skillFilePath, 'utf8'),
                fs.promises.readFile(evalPath, 'utf8'),
                this.collectTaskFileContents(evalPath),
            ]);

            const resultsContent = await this.resolvePostEvalResultsContent(resultsFile, failureContext);

            const systemPrompt = [
                'You are an expert evaluator for VS Code chat customizations and Waza eval suites.',
                'Decide what should be updated next: task files, skill file, both, or neither.',
                'Favor concrete, low-risk edits and reference evidence from eval results and file contents.',
                'Respond in natural language markdown with concise sections and actionable next steps.',
            ].join(' ');

            const prompt = this.buildPostEvalRecommendationPrompt({
                skillName: context.skillName,
                skillPath: context.skillFilePath,
                evalPath,
                resultsPath: resultsFile ?? 'Unavailable (evaluation failed before results file was written)',
                skillContent,
                evalContent,
                resultsContent,
                taskFiles,
                failureContext,
            });

            const llmResponse = await this.deps.requestLLM({
                uri: context.uri.toString(),
                systemPrompt,
                prompt,
            });

            if (llmResponse.error) {
                outputChannel.appendLine(`[Waza] Post-eval recommendation failed: ${llmResponse.error}`);
                return undefined;
            }

            const recommendationText = this.normalizeRecommendationText(llmResponse.text);
            if (!recommendationText) {
                outputChannel.appendLine('[Waza] Post-eval recommendation returned empty output.');
                return undefined;
            }

            const reportPath = await this.writeRecommendationReport(
                extensionContext.globalStorageUri.fsPath,
                context.skillName,
                evalPath,
                resultsFile,
                recommendationText,
            );
            outputChannel.appendLine(`[Waza] Recommendation successfully generated with ${recommendationText.length} characters of actionable guidance.`);
            return reportPath;
        } catch (error) {
            outputChannel.appendLine(`[Waza] Post-eval recommendation crashed: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    private async collectTaskFileContents(evalPath: string): Promise<Array<{ path: string; content: string }>> {
        const evalRoot = path.dirname(evalPath);
        const collected: Array<{ path: string; content: string }> = [];

        const visit = async (dir: string): Promise<void> => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (collected.length >= MAX_TASK_FILE_COUNT) {
                    return;
                }

                const entryPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await visit(entryPath);
                    continue;
                }

                if (path.resolve(entryPath) === path.resolve(evalPath)) {
                    continue;
                }

                const stat = await fs.promises.stat(entryPath);
                if (stat.size > MAX_TASK_FILE_SIZE_BYTES) {
                    continue;
                }

                const content = await fs.promises.readFile(entryPath, 'utf8');
                collected.push({ path: entryPath, content });
            }
        };

        await visit(evalRoot);
        return collected;
    }

    private buildPostEvalRecommendationPrompt(input: {
        skillName: string;
        skillPath: string;
        evalPath: string;
        resultsPath: string;
        skillContent: string;
        evalContent: string;
        resultsContent: string;
        taskFiles: Array<{ path: string; content: string }>;
        failureContext?: {
            commandStdout: string;
            commandStderr: string;
            commandExitCode: number;
        };
    }): string {
        const taskFilesBlock = input.taskFiles.length === 0
            ? 'No task files were found near eval.yaml.'
            : input.taskFiles
                .map((file) => [
                    `### Task File: ${file.path}`,
                    this.truncateForPrompt(file.content),
                ].join('\n'))
                .join('\n\n');

        return [
            `Skill name: ${input.skillName}`,
            `Skill file: ${input.skillPath}`,
            `Eval file: ${input.evalPath}`,
            `Results file: ${input.resultsPath}`,
            '',
            'Analyze the evaluation output and determine the best next action.',
            'Focus on whether failures are caused mainly by weak or misaligned eval tasks versus issues in the skill behavior/specification.',
            input.failureContext
                ? 'This run FAILED. Prioritize the root cause of failure in stderr/stdout and explain whether to fix eval task files or skill instructions first.'
                : 'This run SUCCEEDED. Focus on quality improvements based on result evidence.',
            '',
            'Output format requirements (natural text, not JSON):',
            '- Start with a clear recommendation: Change task files / Change skill file / Both / Neither.',
            '- Explain why with evidence from eval output and file contents.',
            '- Provide concrete edits for task files (if any).',
            '- Provide concrete edits for skill file (if any).',
            '- End with a short ordered list of first steps.',
            '',
            '### Waza Results',
            this.truncateForPrompt(input.resultsContent),
            ...(input.failureContext
                ? [
                    '',
                    '### Waza Command Failure Context',
                    `Exit code: ${input.failureContext.commandExitCode}`,
                    '',
                    'STDERR:',
                    this.truncateForPrompt(input.failureContext.commandStderr || '(empty)'),
                    '',
                    'STDOUT:',
                    this.truncateForPrompt(input.failureContext.commandStdout || '(empty)'),
                ]
                : []),
            '',
            '### Eval Framework (eval.yaml)',
            this.truncateForPrompt(input.evalContent),
            '',
            '### Skill File (SKILL.md)',
            this.truncateForPrompt(input.skillContent),
            '',
            '### Task Files',
            taskFilesBlock,
        ].join('\n');
    }

    private truncateForPrompt(text: string): string {
        if (text.length <= MAX_PROMPT_SECTION_CHARS) {
            return text;
        }

        const head = text.slice(0, Math.floor(MAX_PROMPT_SECTION_CHARS * 0.8));
        const tail = text.slice(-Math.floor(MAX_PROMPT_SECTION_CHARS * 0.2));
        return `${head}\n\n...[truncated ${text.length - head.length - tail.length} chars]...\n\n${tail}`;
    }

    private normalizeRecommendationText(rawText: string): string | undefined {
        const trimmed = rawText.trim();
        if (!trimmed) {
            return undefined;
        }

        const fencedMatch = trimmed.match(/^```(?:markdown|md|text|json)?\s*([\s\S]*?)\s*```$/i);
        const candidate = (fencedMatch?.[1] ?? trimmed).trim();
        if (!candidate) {
            return undefined;
        }

        try {
            const parsed = JSON.parse(candidate) as {
                recommendation?: string;
                confidence?: number;
                evidence?: string[];
                task_file_changes?: string[];
                skill_file_changes?: string[];
                first_steps?: string[];
            };

            if (parsed && typeof parsed === 'object') {
                const lines: string[] = [];
                lines.push('## Recommendation');
                lines.push(parsed.recommendation
                    ? `Recommendation: ${parsed.recommendation}`
                    : 'Recommendation: unknown');

                if (typeof parsed.confidence === 'number') {
                    lines.push(`Confidence: ${parsed.confidence}`);
                }

                if (Array.isArray(parsed.evidence) && parsed.evidence.length > 0) {
                    lines.push('');
                    lines.push('## Evidence');
                    for (const item of parsed.evidence) {
                        lines.push(`- ${item}`);
                    }
                }

                if (Array.isArray(parsed.task_file_changes) && parsed.task_file_changes.length > 0) {
                    lines.push('');
                    lines.push('## Task File Changes');
                    for (const item of parsed.task_file_changes) {
                        lines.push(`- ${item}`);
                    }
                }

                if (Array.isArray(parsed.skill_file_changes) && parsed.skill_file_changes.length > 0) {
                    lines.push('');
                    lines.push('## Skill File Changes');
                    for (const item of parsed.skill_file_changes) {
                        lines.push(`- ${item}`);
                    }
                }

                if (Array.isArray(parsed.first_steps) && parsed.first_steps.length > 0) {
                    lines.push('');
                    lines.push('## First Steps');
                    for (const [index, item] of parsed.first_steps.entries()) {
                        lines.push(`${index + 1}. ${item}`);
                    }
                }

                return lines.join('\n');
            }
        } catch {
            // Keep natural text as-is.
        }

        return candidate;
    }

    private async resolvePostEvalResultsContent(
        resultsFile: string | undefined,
        failureContext?: {
            commandStdout: string;
            commandStderr: string;
            commandExitCode: number;
        },
    ): Promise<string> {
        if (resultsFile && fs.existsSync(resultsFile)) {
            return fs.promises.readFile(resultsFile, 'utf8');
        }

        if (!failureContext) {
            return 'No results content available.';
        }

        return [
            'Evaluation command failed before a results file was available.',
            `Exit code: ${failureContext.commandExitCode}`,
            '',
            'STDERR:',
            failureContext.commandStderr || '(empty)',
            '',
            'STDOUT:',
            failureContext.commandStdout || '(empty)',
        ].join('\n');
    }

    private async writeRecommendationReport(
        globalStoragePath: string,
        skillName: string,
        evalPath: string,
        resultsFile: string | undefined,
        recommendationText: string,
    ): Promise<string> {
        const recommendationsDir = path.join(globalStoragePath, 'recommendations');
        await fs.promises.mkdir(recommendationsDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const reportPath = path.join(recommendationsDir, `${skillName}-${timestamp}.md`);

        const report = [
            `# Waza Post-Eval Recommendation (${skillName})`,
            '',
            '## About This File',
            'This recommendation file is generated when a Waza evaluation fails. It contains AI-powered suggestions to help you fix the issues preventing your skill evaluation from passing. The recommendations analyze your skill file, evaluation tasks, and failure context to provide actionable next steps.',
            '',
            `- Eval file: ${evalPath}`,
            `- Results file: ${resultsFile ?? 'Unavailable (evaluation failed before results were written)'}`,
            `- Generated at: ${new Date().toISOString()}`,
            '',
            '## Recommendation',
            recommendationText,
            '',
            'Interpretation tip: If the recommendation is to change task files, update eval task definitions before editing the skill. If it recommends changing the skill file, prioritize SKILL.md behavior/instructions updates first.',
        ].join('\n');

        await fs.promises.writeFile(reportPath, report, 'utf8');
        return reportPath;
    }
}
