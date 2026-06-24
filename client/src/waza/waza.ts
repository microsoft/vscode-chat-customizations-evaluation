import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { WazaCommandExecutor } from './wazaCommandExecutor';
import { WazaGuideService } from './wazaGuideService';
import { WazaContextResolver } from './wazaContextResolver';
import { WazaBinaryManager } from './wazaBinaryManager';
import { WazaRecommendationService } from './wazaRecommendationService';
import type {
    CommandResult,
    EvalScaffoldSummary,
    SkillContext,
    WazaDependencies,
} from './wazaTypes';
import {
    ANALYSIS_AND_FIX_USER_GUIDE_FALLBACK,
    WAZA_USER_GUIDE_FALLBACK,
} from './wazaFallbackGuides';
import {
    PREFERRED_EVAL_FILE_NAME,
    WAZA_CREATE_TIMEOUT_MS,
} from './wazaConstants';

export type { SkillContext, TelemetryData } from './wazaTypes';

class WazaOrchestrator {
    private deps: WazaDependencies | undefined;
    private readonly wazaCommandExecutor: WazaCommandExecutor;
    private readonly contextResolver: WazaContextResolver;
    private readonly binaryManager: WazaBinaryManager;
    private readonly recommendationService: WazaRecommendationService;
    private readonly inProgressEvalKeys = new Set<string>();

    constructor() {
        this.wazaCommandExecutor = new WazaCommandExecutor({
            getOutputChannel: () => this.requireDeps().outputChannel,
            getWazaCommand: () => this.getWazaCommand(),
            getManagedWazaBinaryPath: () => this.getManagedWazaBinaryPath(),
            installManagedWazaBinary: async () => await this.installManagedWazaBinary(),
        });
        this.contextResolver = new WazaContextResolver({
            getCustomizationUri: (obj) => this.requireDeps().getCustomizationUri(obj),
            getOutputChannel: () => this.requireDeps().outputChannel,
        });
        this.binaryManager = new WazaBinaryManager({
            getExtensionContext: () => this.requireDeps().extensionContext,
            getOutputChannel: () => this.requireDeps().outputChannel,
        });
        this.recommendationService = new WazaRecommendationService({
            getExtensionContext: () => this.requireDeps().extensionContext,
            getOutputChannel: () => this.requireDeps().outputChannel,
            requestLLM: async (request) => this.requireDeps().requestLLM(request)
        });
    }

    initializeWaza(wazaDeps: WazaDependencies): void {
        this.deps = wazaDeps;
    }

    registerWazaCommands(_context: vscode.ExtensionContext): vscode.Disposable[] {
        return [
            this.registerWazaCreateEvalCommand(),
            this.registerWazaRunEvalCommand(),
            this.registerWazaRunEvalFromFileCommand(),
            this.registerWazaDownloadBinaryCommand(),
            this.registerOpenWazaUserGuideCommand(),
            this.registerOpenAnalysisAndFixUserGuideCommand(),
        ];
    }

    private registerWazaCreateEvalCommand(): vscode.Disposable {
        return vscode.commands.registerCommand('chatCustomizationsEvaluations.wazaCreateEval', async (obj) => this.handleWazaCreateEvalCommand(obj));
    }

    private registerWazaRunEvalCommand(): vscode.Disposable {
        return vscode.commands.registerCommand('chatCustomizationsEvaluations.wazaRunEval', async (obj) => this.handleWazaRunEvalCommand(obj));
    }

    private registerWazaRunEvalFromFileCommand(): vscode.Disposable {
        return vscode.commands.registerCommand('chatCustomizationsEvaluations.wazaRunEvalFromFile', async () => this.handleWazaRunEvalFromFileCommand());
    }

    private registerWazaDownloadBinaryCommand(): vscode.Disposable {
        return vscode.commands.registerCommand('chatCustomizationsEvaluations.wazaDownloadBinary', async () => this.handleWazaDownloadBinaryCommand());
    }

    private registerOpenWazaUserGuideCommand(): vscode.Disposable {
        return vscode.commands.registerCommand('chatCustomizationsEvaluations.openWazaUserGuide', async () => this.handleOpenWazaUserGuideCommand());
    }

    private registerOpenAnalysisAndFixUserGuideCommand(): vscode.Disposable {
        return vscode.commands.registerCommand('chatCustomizationsEvaluations.openAnalysisAndFixUserGuide', async () => this.handleOpenAnalysisAndFixUserGuideCommand());
    }

    private async handleWazaCreateEvalCommand(obj: unknown): Promise<void> {
        const skillContext = this.contextResolver.resolveSkillContext(obj);
        if (!skillContext) {
            void vscode.window.showWarningMessage('Open a SKILL.md file (or select a customization item) to create an eval scaffold.');
            return;
        }

        const scaffold = await this.createWazaEvalScaffold(skillContext);
        if (!scaffold) {
            return;
        }
        // Open the main eval file and show success notification with action
        const evalUri = vscode.Uri.file(scaffold.evalPath);
        await vscode.commands.executeCommand('vscode.open', evalUri);

        const action = await vscode.window.showInformationMessage(
            `✓ Created Waza eval scaffold for ${skillContext.skillName}. ${scaffold.createdFiles.length} files created.`,
            'Open Eval File',
            'View Output'
        );

        if (action === 'Open Eval File') {
            // Open the eval file
            await vscode.commands.executeCommand('vscode.open', evalUri);
        } else if (action === 'View Output') {
            // Show the output channel to see the full details
            const { outputChannel } = this.requireDeps();
            outputChannel.show(true);
        }
    }

    private async handleWazaRunEvalCommand(obj: unknown): Promise<void> {
        const skillContext = this.contextResolver.resolveSkillContext(obj);
        if (!skillContext) {
            void vscode.window.showWarningMessage('Open a SKILL.md file (or select a customization item) to run Waza evaluation.');
            return;
        }

        const evalPath = this.contextResolver.findEvalPath(skillContext);
        if (!evalPath) {
            const action = await vscode.window.showWarningMessage(
                `No Waza eval file found for ${skillContext.skillName}.`,
                'Create Eval'
            );

            if (action === 'Create Eval') {
                await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaCreateEval', obj);
            }
            return;
        }

        await this.runWazaEvaluationForContext(skillContext, evalPath);
    }

    private async handleWazaRunEvalFromFileCommand(): Promise<void> {
        const { outputChannel } = this.requireDeps();
        const editor = vscode.window.activeTextEditor;
        outputChannel.appendLine('[Waza] wazaRunEvalFromFile called');
        outputChannel.appendLine(`[Waza] Editor: ${editor ? 'exists' : 'null'}`);
        if (editor) {
            outputChannel.appendLine(`[Waza] Document fileName: ${editor.document.fileName}`);
            outputChannel.appendLine(`[Waza] Supported eval file: ${this.contextResolver.isSupportedEvalFile(editor.document.fileName)}`);
        }

        if (!editor || !this.contextResolver.isSupportedEvalFile(editor.document.fileName)) {
            vscode.window.showWarningMessage('This command requires a Waza eval file to be active.');
            return;
        }

        const evalUri = editor.document.uri;
        const evalDir = path.dirname(evalUri.fsPath);
        outputChannel.appendLine(`[Waza] Eval URI fsPath: ${evalUri.fsPath}`);
        outputChannel.appendLine(`[Waza] Eval dir: ${evalDir}`);

        const skillFilePath = this.contextResolver.findSkillFilePathFromEvalDir(evalDir);
        if (!skillFilePath) {
            outputChannel.appendLine('[Waza] Could not find SKILL.md');
            vscode.window.showWarningMessage('Could not find SKILL.md associated with this Waza eval file.');
            return;
        }

        const skillContext = this.contextResolver.buildSkillContextForEvalFile(evalUri, skillFilePath);
        await this.runWazaEvaluationForContext(skillContext, evalUri.fsPath);
    }

    private async handleWazaDownloadBinaryCommand(): Promise<void> {
        const { outputChannel } = this.requireDeps();
        try {
            outputChannel.show(true);
            outputChannel.appendLine('[Waza] Downloading latest Waza binary...');

            const installPath = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Downloading Waza binary',
                    cancellable: false,
                },
                async (progress) => {
                    progress.report({ message: 'Preparing download...' });
                    return this.binaryManager.downloadAndInstallWazaBinary((message) => progress.report({ message }));
                }
            );

            const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
            await configuration.update('waza.command', installPath, vscode.ConfigurationTarget.Global);

            outputChannel.appendLine(`[Waza] Installed to ${installPath}`);
            vscode.window.showInformationMessage(`Waza binary downloaded and configured: ${installPath}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            outputChannel.appendLine(`[Waza] Download failed: ${message}`);
            vscode.window.showErrorMessage(`Failed to download Waza binary: ${message}`);
        }
    }

    private async handleOpenWazaUserGuideCommand(): Promise<void> {
        await this.openGuide(
            'WAZA-USER-GUIDE.md',
            WAZA_USER_GUIDE_FALLBACK,
            '[Waza] Guide file not found in extension package; opening built-in fallback guide.',
        );
    }

    private async handleOpenAnalysisAndFixUserGuideCommand(): Promise<void> {
        await this.openGuide(
            'ANALYSIS-AND-FIX-USER-GUIDE.md',
            ANALYSIS_AND_FIX_USER_GUIDE_FALLBACK,
            '[Docs] Analysis and fix guide file not found in extension package; opening built-in fallback guide.',
        );
    }

    private async openGuide(
        guideFileName: string,
        fallbackMarkdown: string,
        fallbackLogMessage: string,
    ): Promise<void> {
        const { extensionContext, outputChannel } = this.requireDeps();
        const guideService = new WazaGuideService(extensionContext, outputChannel);
        await guideService.openGuide(guideFileName, fallbackMarkdown, fallbackLogMessage);
    }

    async handlePostFixDiagnosticsFlow(context: SkillContext): Promise<void> {
        const evalPath = this.contextResolver.findEvalPath(context);
        if (evalPath) {
            await this.handleExistingEvalAfterFix(context, evalPath);
            return;
        }

        await this.handleMissingEvalAfterFix(context);
    }

    private requireDeps(): WazaDependencies {
        if (!this.deps) {
            throw new Error('Waza module is not initialized');
        }

        return this.deps;
    }

    private getWazaCommand(): string {
        const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
        return configuration.get<string>('waza.command', 'waza');
    }

    private getManagedWazaBinaryPath(): string {
        return this.binaryManager.getManagedWazaBinaryPath();
    }

    private async installManagedWazaBinary(): Promise<void> {
        await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaDownloadBinary');
    }

    private isWazaSkillLookupError(output: string): boolean {
        const lower = output.toLowerCase();
        return lower.includes('finding skill') && lower.includes('not found in workspace');
    }

    private async runWazaScaffoldViaTempWorkspace(context: SkillContext, scaffoldRoot: string): Promise<CommandResult> {
        const { extensionContext, outputChannel } = this.requireDeps();
        const tempBase = path.join(extensionContext.globalStorageUri.fsPath, 'tmp-scaffold');
        await fs.promises.mkdir(tempBase, { recursive: true });

        const tempRoot = await fs.promises.mkdtemp(path.join(tempBase, 'waza-'));
        const tempSkillDir = path.join(tempRoot, 'skills', context.skillName);
        const targetEvalPath = path.join(scaffoldRoot, 'evals', context.skillName, PREFERRED_EVAL_FILE_NAME);

        try {
            await fs.promises.mkdir(tempSkillDir, { recursive: true });
            await fs.promises.copyFile(context.skillFilePath, path.join(tempSkillDir, 'SKILL.md'));

            outputChannel.appendLine(`[Waza] Temp scaffold root: ${tempRoot}`);
            outputChannel.appendLine(`[Waza] Target eval output: ${targetEvalPath}`);

            return await this.runWazaCommand(
                ['new', 'eval', context.skillName, '--output', targetEvalPath],
                tempRoot,
                WAZA_CREATE_TIMEOUT_MS,
            );
        } finally {
            await fs.promises.rm(tempRoot, { recursive: true, force: true });
        }
    }

    private async runWazaCommand(args: string[], cwd: string, timeoutMs?: number): Promise<CommandResult> {
        return this.wazaCommandExecutor.runWazaCommand(args, cwd, timeoutMs);
    }

    private async runWazaEvaluationForContext(context: SkillContext, evalPath: string): Promise<void> {
        const { extensionContext, outputChannel } = this.requireDeps();
        const evalRunKey = this.getEvalRunKey(context, evalPath);
        if (this.inProgressEvalKeys.has(evalRunKey)) {
            const action = await vscode.window.showInformationMessage(
                `Waza evaluation is already running for ${context.skillName}.`,
                'Show Output'
            );
            if (action === 'Show Output') {
                outputChannel.show(true);
            }
            return;
        }

        this.inProgressEvalKeys.add(evalRunKey);

        try {
            outputChannel.show(true);
            outputChannel.appendLine(`[Waza] Running evaluation for ${context.skillName}`);

            const resultsFile = await this.createWazaResultsFilePath(extensionContext.globalStorageUri.fsPath, context.skillName);
            const commandLine = `${this.getWazaCommand()} run ${evalPath} --context-dir ${context.skillDirPath} --output ${resultsFile}`;

            outputChannel.appendLine(`[Waza] Command: ${commandLine}`);

            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Running Waza evaluation: ${context.skillName}`,
                    cancellable: false,
                },
                async (progress) => {
                    progress.report({ message: 'Evaluation in progress...' });
                    const interval = setInterval(() => {
                        // Re-reporting keeps the notification visibly active while command runs.
                        progress.report({ message: 'Evaluation in progress...' });
                    }, 5_000);

                    try {
                        return await this.runWazaCommand(
                            ['run', evalPath, '--context-dir', context.skillDirPath, '--output', resultsFile],
                            context.workspaceRoot,
                        );
                    } finally {
                        clearInterval(interval);
                    }
                }
            );

            this.appendWazaCommandOutput(result, outputChannel);

            const detailedOutputFile = await this.writeDetailedOutput(
                extensionContext.globalStorageUri.fsPath,
                context.skillName,
                commandLine,
                result,
            );
            if (detailedOutputFile) {
                outputChannel.appendLine(`[Waza] Detailed output saved to: ${detailedOutputFile}\n`);
            }

            if (result.exitCode !== 0) {
                await this.handleWazaRunEvalFailure(context, evalPath, result, detailedOutputFile);
                return;
            }

            await this.handleWazaRunEvalSuccess(context, evalPath, resultsFile, detailedOutputFile);
        } finally {
            this.inProgressEvalKeys.delete(evalRunKey);
        }
    }

    private getEvalRunKey(context: SkillContext, evalPath: string): string {
        return `${context.workspaceRoot}::${context.skillDirPath}::${evalPath}`;
    }

    private async createWazaResultsFilePath(globalStoragePath: string, skillName: string): Promise<string> {
        const resultsDir = path.join(globalStoragePath, 'results');
        await fs.promises.mkdir(resultsDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        return path.join(resultsDir, `${skillName}-${timestamp}.json`);
    }

    private appendWazaCommandOutput(result: CommandResult, outputChannel: vscode.OutputChannel): void {
        if (result.stdout) {
            outputChannel.appendLine(result.stdout);
        }
        if (result.stderr) {
            outputChannel.appendLine(result.stderr);
        }
    }

    private async writeDetailedOutput(
        globalStoragePath: string,
        skillName: string,
        commandLine: string,
        result: CommandResult,
    ): Promise<string | undefined> {
        try {
            const outputDir = path.join(globalStoragePath, 'output');
            await fs.promises.mkdir(outputDir, { recursive: true });

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outputFile = path.join(outputDir, `${skillName}-${timestamp}.txt`);

            const lines = [
                `Command: ${commandLine}`,
                `Exit code: ${result.exitCode}`,
                `Timestamp: ${new Date().toISOString()}`,
                '',
                '--- STDOUT ---',
                result.stdout || '(empty)',
                '',
                '--- STDERR ---',
                result.stderr || '(empty)',
            ];

            await fs.promises.writeFile(outputFile, lines.join('\n'), 'utf8');
            return outputFile;
        } catch {
            return undefined;
        }
    }

    private async handleWazaRunEvalFailure(context: SkillContext, evalPath: string, commandResult: CommandResult, detailedOutputFile?: string): Promise<void> {
        const { outputChannel } = this.requireDeps();
        const recommendationReportPath = await this.recommendationService.generatePostEvalRecommendation(
            context,
            evalPath,
            undefined,
            {
                commandStdout: commandResult.stdout,
                commandStderr: commandResult.stderr,
                commandExitCode: commandResult.exitCode,
            },
        );

        if (recommendationReportPath) {
            outputChannel.appendLine(`[Waza] Recommendation report saved to: ${recommendationReportPath}`);
            outputChannel.appendLine('[Waza] The recommendation document contains AI-powered suggestions to help you fix the evaluation failures. It analyzes your skill file, evaluation tasks, and failure context to provide actionable next steps.');
            const actions: string[] = [];
            if (detailedOutputFile) {
                actions.push('Open Detailed Output');
            }
            actions.push('Open Recommendation');
            const action = await vscode.window.showInformationMessage(
                'Waza evaluation failed. A recommendation document with AI-powered fix suggestions has been generated.',
                ...actions,
            );
            if (action === 'Open Detailed Output' && detailedOutputFile) {
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(detailedOutputFile));
                await vscode.window.showTextDocument(document, { preview: false });
            } else if (action === 'Open Recommendation') {
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(recommendationReportPath));
                await vscode.window.showTextDocument(document, { preview: false });
            }
        } else {
            const actions: string[] = [];
            if (detailedOutputFile) {
                actions.push('Open Detailed Output');
            }
            actions.push('Show Output');
            const action = await vscode.window.showInformationMessage(
                'Waza evaluation failed. See "Chat Customizations Evaluations" output for details.',
                ...actions,
            );
            if (action === 'Open Detailed Output' && detailedOutputFile) {
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(detailedOutputFile));
                await vscode.window.showTextDocument(document, { preview: false });
            } else if (action === 'Show Output') {
                outputChannel.show(true);
            }
        }
    }

    private async handleWazaRunEvalSuccess(context: SkillContext, evalPath: string, resultsFile: string, detailedOutputFile?: string): Promise<void> {
        const { outputChannel } = this.requireDeps();
        const resultsFileExists = fs.existsSync(resultsFile);

        if (!resultsFileExists) {
            const actions: string[] = [];
            if (detailedOutputFile) {
                actions.push('Open Detailed Output');
            }
            const action = await vscode.window.showInformationMessage(
                `Waza evaluation completed for ${context.skillName}.`,
                ...actions,
            );
            if (action === 'Open Detailed Output' && detailedOutputFile) {
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(detailedOutputFile));
                await vscode.window.showTextDocument(document, { preview: false });
            }
            return;
        }

        const resultsUri = vscode.Uri.file(resultsFile);
        outputChannel.appendLine(`[Waza] Results saved to: ${resultsUri.toString()}`);

        const actions: string[] = [];
        if (detailedOutputFile) {
            actions.push('Open Detailed Output');
        }
        actions.push('View Results');
        const action = await vscode.window.showInformationMessage(
            `Waza evaluation completed for ${context.skillName}.`,
            ...actions,
        );

        if (action === 'Open Detailed Output' && detailedOutputFile) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(detailedOutputFile));
            await vscode.window.showTextDocument(document, { preview: false });
        } else if (action === 'View Results') {
            const document = await vscode.workspace.openTextDocument(resultsUri);
            await vscode.window.showTextDocument(document, { preview: false });
        }
    }

    private async handleExistingEvalAfterFix(context: SkillContext, evalPath: string): Promise<void> {
        if (this.getAlwaysRunEvalsAfterFixDiagnostics()) {
            await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaRunEval', { uri: context.uri });
            return;
        }

        const runNow = 'Run Eval';
        const alwaysRun = 'Always Run Evals';
        const docs = 'Waza Docs';
        const action = await vscode.window.showInformationMessage(
            `Diagnostics were fixed for ${context.skillName}. Found existing eval at ${path.relative(context.workspaceRoot, evalPath)}. Run it now?`,
            runNow,
            alwaysRun,
            docs,
        );

        if (action === docs) {
            await vscode.commands.executeCommand('chatCustomizationsEvaluations.openWazaUserGuide');
            return;
        }

        if (action === alwaysRun) {
            await this.setAlwaysRunEvalsAfterFixDiagnostics(true);
            await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaRunEval', { uri: context.uri });
            return;
        }

        if (action === runNow) {
            await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaRunEval', { uri: context.uri });
        }
    }

    private async handleMissingEvalAfterFix(context: SkillContext): Promise<void> {
        const create = 'Create Evals';
        const docs = 'Waza Docs';
        const action = await vscode.window.showInformationMessage(
            `Diagnostics were fixed for ${context.skillName}. No Waza eval file found. Create evals powered by Waza now? You can also run the "Create Waza Eval Scaffold" command later.`,
            create,
            docs,
        );

        if (action === docs) {
            await vscode.commands.executeCommand('chatCustomizationsEvaluations.openWazaUserGuide');
            return;
        }

        if (action !== create) {
            return;
        }

        const ensured = await this.ensureWazaInstalled(context.workspaceRoot);
        if (!ensured) {
            return;
        }

        const summary = await this.createWazaEvalScaffold(context);
        if (!summary) {
            return;
        }

        const evalUri = vscode.Uri.file(summary.evalPath);
        const document = await vscode.workspace.openTextDocument(evalUri);
        await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });

        const relativeEvalPath = path.relative(context.workspaceRoot, summary.evalPath);
        const relativeFiles = summary.createdFiles
            .map((file) => path.relative(context.workspaceRoot, file))
            .slice(0, 3);
        const fileSummary = relativeFiles.length > 0
            ? ` Created files include: ${relativeFiles.join(', ')}${summary.createdFiles.length > 3 ? ', ...' : ''}.`
            : '';

        const runEval = 'Run Eval';
        const openDocs = 'Waza Docs';
        const notificationAction = await vscode.window.showInformationMessage(
            `Created Waza scaffold at ${relativeEvalPath}.${fileSummary}`,
            runEval,
            openDocs,
        );

        if (notificationAction === runEval) {
            await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaRunEval', { uri: context.uri });
        }

        if (notificationAction === openDocs) {
            await vscode.commands.executeCommand('chatCustomizationsEvaluations.openWazaUserGuide');
        }
    }

    private getAlwaysRunEvalsAfterFixDiagnostics(): boolean {
        const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
        return configuration.get<boolean>('waza.alwaysRunAfterFixDiagnostics', false);
    }

    private async setAlwaysRunEvalsAfterFixDiagnostics(value: boolean): Promise<void> {
        const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
        await configuration.update('waza.alwaysRunAfterFixDiagnostics', value, vscode.ConfigurationTarget.Global);
    }

    private async ensureWazaInstalled(cwd: string): Promise<boolean> {
        const { outputChannel } = this.requireDeps();
        const probe = await this.runWazaCommand(['--version'], cwd, 10_000);
        if (probe.exitCode === 0) {
            return true;
        }

        outputChannel.appendLine('[Waza] Waza command unavailable; downloading managed binary.');

        try {
            const installPath = await this.binaryManager.downloadAndInstallWazaBinary();
            const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
            await configuration.update('waza.command', installPath, vscode.ConfigurationTarget.Global);
            outputChannel.appendLine(`[Waza] Installed managed binary at ${installPath}`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            outputChannel.appendLine(`[Waza] Failed to install managed binary: ${message}`);
            void vscode.window.showErrorMessage(`Failed to install Waza binary: ${message}`);
            return false;
        }
    }

    private async createWazaEvalScaffold(context: SkillContext): Promise<EvalScaffoldSummary | undefined> {
        const { outputChannel } = this.requireDeps();
        const scaffoldCwd = this.contextResolver.resolveWazaScaffoldCwd(context);
        outputChannel.show(true);
        outputChannel.appendLine(`[Waza] Creating eval scaffold for ${context.skillName}`);
        outputChannel.appendLine(`[Waza] Command: ${this.getWazaCommand()} new eval ${context.skillName}`);
        outputChannel.appendLine(`[Waza] CWD: ${scaffoldCwd}`);

        const { result: finalResult, usedTemporaryWorkspaceFallback } = await this.runCreateEvalScaffoldCommand(context, scaffoldCwd);

        if (finalResult.exitCode !== 0) {
            this.logAndNotifyCreateScaffoldFailure(finalResult, usedTemporaryWorkspaceFallback);
            return undefined;
        }

        outputChannel.appendLine(`[Waza] eval scaffold created for ${context.skillName}\n${finalResult.stdout}`);

        const evalPath = this.contextResolver.findEvalPath(context);
        if (!evalPath) {
            return undefined;
        }

        const createdFiles = this.collectEvalScaffoldFiles(evalPath);
        return this.logAndBuildScaffoldSummary(evalPath, createdFiles);
    }

    private async runCreateEvalScaffoldCommand(
        context: SkillContext,
        scaffoldCwd: string,
    ): Promise<{ result: CommandResult; usedTemporaryWorkspaceFallback: boolean }> {
        const { outputChannel } = this.requireDeps();
        const firstAttempt = await this.runWazaCommand(
            ['new', 'eval', context.skillName],
            scaffoldCwd,
            WAZA_CREATE_TIMEOUT_MS,
        );

        const firstAttemptText = `${firstAttempt.stderr}\n${firstAttempt.stdout}`;
        if (firstAttempt.exitCode === 0 || !this.isWazaSkillLookupError(firstAttemptText)) {
            return { result: firstAttempt, usedTemporaryWorkspaceFallback: false };
        }

        outputChannel.appendLine('[Waza] Workspace skill lookup failed; retrying with temporary canonical workspace...');
        const fallbackResult = await this.runWazaScaffoldViaTempWorkspace(context, scaffoldCwd);
        return { result: fallbackResult, usedTemporaryWorkspaceFallback: true };
    }

    private logAndNotifyCreateScaffoldFailure(result: CommandResult, usedTemporaryWorkspaceFallback: boolean): void {
        const { outputChannel } = this.requireDeps();
        outputChannel.appendLine(`[Waza] Rval scaffold failed\n${result.stderr || result.stdout}`);
        void vscode.window.showErrorMessage('Failed to create Waza eval scaffold. See "Chat Customizations Evaluations" output for details. Error: ' + (result.stderr || result.stdout));
    }

    private logAndBuildScaffoldSummary(
        evalPath: string,
        createdFiles: string[],
    ): EvalScaffoldSummary {
        return { evalPath, createdFiles };
    }

    private collectEvalScaffoldFiles(evalPath: string): string[] {
        const root = path.dirname(evalPath);
        const files: string[] = [];

        const visit = (dir: string): void => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    visit(entryPath);
                } else {
                    files.push(entryPath);
                }
            }
        };

        if (fs.existsSync(root)) {
            visit(root);
        }

        files.sort();
        return files;
    }

}

const wazaOrchestrator = new WazaOrchestrator();

export function initializeWaza(wazaDeps: WazaDependencies): void {
    wazaOrchestrator.initializeWaza(wazaDeps);
}

export function registerWazaCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
    return wazaOrchestrator.registerWazaCommands(context);
}

export async function handlePostFixDiagnosticsFlow(context: SkillContext): Promise<void> {
    await wazaOrchestrator.handlePostFixDiagnosticsFlow(context);
}
