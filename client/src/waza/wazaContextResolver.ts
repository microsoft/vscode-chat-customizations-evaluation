import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SkillContext } from './wazaTypes';
import { SUPPORTED_EVAL_FILE_NAMES } from './wazaConstants';

interface WazaContextResolverDependencies {
    getCustomizationUri: (obj: unknown) => vscode.Uri | undefined;
    getOutputChannel: () => vscode.OutputChannel;
}

export class WazaContextResolver {

    constructor(private readonly deps: WazaContextResolverDependencies) { }

    resolveSkillContext(obj: unknown): SkillContext | undefined {
        const uri = this.deps.getCustomizationUri(obj) ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri || uri.scheme !== 'file') {
            return undefined;
        }

        const skillFilePath = this.findSkillFilePath(uri.fsPath);
        if (!skillFilePath) {
            return undefined;
        }

        const skillDirPath = path.dirname(skillFilePath);
        const skillName = path.basename(skillDirPath);
        const workspaceRoot = this.inferSkillProjectRoot(uri, skillDirPath);

        return {
            uri,
            skillFilePath,
            skillDirPath,
            skillName,
            workspaceRoot,
        };
    }

    buildSkillContextForEvalFile(evalUri: vscode.Uri, skillFilePath: string): SkillContext {
        const skillDirPath = path.dirname(skillFilePath);
        const skillName = path.basename(skillDirPath);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(evalUri);
        const workspaceRoot = workspaceFolder?.uri.fsPath || path.dirname(skillDirPath);

        return {
            uri: evalUri,
            skillFilePath,
            skillDirPath,
            skillName,
            workspaceRoot,
        };
    }

    findSkillFilePath(startPath: string): string | undefined {
        const stat = fs.statSync(startPath, { throwIfNoEntry: false });
        let current = stat?.isDirectory() ? startPath : path.dirname(startPath);

        while (true) {
            const candidate = path.join(current, 'SKILL.md');
            if (fs.existsSync(candidate)) {
                return candidate;
            }

            const parent = path.dirname(current);
            if (parent === current) {
                return undefined;
            }
            current = parent;
        }
    }

    findSkillFilePathFromEvalDir(evalDir: string): string | undefined {
        const outputChannel = this.deps.getOutputChannel();
        const skillName = path.basename(evalDir);
        outputChannel.appendLine(`[Waza] Extracted skill name: ${skillName}`);

        let current = evalDir;
        while (true) {
            const directCandidate = path.join(current, 'SKILL.md');
            outputChannel.appendLine(`[Waza] Searching for SKILL.md at: ${directCandidate}`);
            if (fs.existsSync(directCandidate)) {
                outputChannel.appendLine(`[Waza] Found SKILL.md at: ${directCandidate}`);
                return directCandidate;
            }

            const evalsIndex = current.indexOf('/evals/');
            if (evalsIndex !== -1) {
                const beforeEvals = current.substring(0, evalsIndex);
                const skillsPath = path.join(beforeEvals, 'skills', skillName, 'SKILL.md');
                outputChannel.appendLine(`[Waza] Searching in parallel skills dir: ${skillsPath}`);
                if (fs.existsSync(skillsPath)) {
                    outputChannel.appendLine(`[Waza] Found SKILL.md at: ${skillsPath}`);
                    return skillsPath;
                }
            }

            const parent = path.dirname(current);
            if (parent === current) {
                outputChannel.appendLine('[Waza] Reached filesystem root, no SKILL.md found');
                return undefined;
            }
            current = parent;
        }
    }

    findEvalPath(context: SkillContext): string | undefined {
        const outputChannel = this.deps.getOutputChannel();
        const candidates = new Set<string>();

        const addEvalCandidates = (basePath: string): void => {
            for (const evalFileName of SUPPORTED_EVAL_FILE_NAMES) {
                candidates.add(path.join(basePath, evalFileName));
            }
        };

        addEvalCandidates(path.join(context.workspaceRoot, 'evals', context.skillName));

        const skillsDir = path.dirname(context.skillDirPath);
        if (path.basename(skillsDir) === 'skills') {
            const projectRoot = path.dirname(skillsDir);
            addEvalCandidates(path.join(projectRoot, 'evals', context.skillName));
        }

        let current = context.skillDirPath;
        while (true) {
            addEvalCandidates(path.join(current, 'evals', context.skillName));
            addEvalCandidates(path.join(current, 'evals'));

            const parent = path.dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }

        addEvalCandidates(path.join(context.skillDirPath, 'evals'));
        addEvalCandidates(context.skillDirPath);

        outputChannel.appendLine(`[Waza] Looking for Waza eval file for ${context.skillName}`);
        for (const candidate of candidates) {
            outputChannel.appendLine(`[Waza] Eval candidate: ${candidate}`);
            if (fs.existsSync(candidate)) {
                outputChannel.appendLine(`[Waza] Using eval file: ${candidate}`);
                return candidate;
            }
        }

        return undefined;
    }

    resolveWazaScaffoldCwd(context: SkillContext): string {
        const skillsDir = path.dirname(context.skillDirPath);
        if (path.basename(skillsDir) === 'skills') {
            return path.dirname(skillsDir);
        }

        return skillsDir;
    }

    isSupportedEvalFile(filePath: string): boolean {
        const fileName = path.basename(filePath);
        return SUPPORTED_EVAL_FILE_NAMES.includes(fileName);
    }

    private inferSkillProjectRoot(uri: vscode.Uri, skillDirPath: string): string {
        const workspaceRoot = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
        if (workspaceRoot) {
            return workspaceRoot;
        }

        const skillsDir = path.dirname(skillDirPath);
        if (path.basename(skillsDir) === 'skills') {
            return path.dirname(skillsDir);
        }

        return skillDirPath;
    }
}
