import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as https from 'https';
import * as vscode from 'vscode';
import { WazaCommandExecutor } from './wazaCommandExecutor';
import { WazaGuideService } from './wazaGuideService';
import type {
    CommandResult,
    EvalScaffoldSummary,
    GitHubRelease,
    SkillContext,
    WazaAssetTarget,
    WazaDependencies,
} from './wazaTypes';
import {
    ANALYSIS_AND_FIX_USER_GUIDE_FALLBACK,
    WAZA_USER_GUIDE_FALLBACK,
} from './wazaFallbackGuides';

export type { SkillContext, TelemetryData } from './wazaTypes';

class WazaOrchestrator {
    private static readonly WAZA_CREATE_TIMEOUT_MS = 30_000;

    private deps: WazaDependencies | undefined;
    private readonly wazaCommandExecutor: WazaCommandExecutor;

    constructor() {
        this.wazaCommandExecutor = new WazaCommandExecutor({
            getOutputChannel: () => this.requireDeps().outputChannel,
            getWazaCommand: () => this.getWazaCommand(),
            getManagedWazaBinaryPath: () => this.getManagedWazaBinaryPath(),
            getExtensionStoragePath: () => this.requireDeps().extensionContext.globalStorageUri.fsPath,
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
        const { logTelemetryUsage } = this.requireDeps();
        logTelemetryUsage('command/wazaCreateEval');
        const skillContext = this.resolveSkillContext(obj);
        if (!skillContext) {
            logTelemetryUsage('command/wazaCreateEval/result', { outcome: 'noSkillContext' });
            void vscode.window.showWarningMessage('Open a SKILL.md file (or select a customization item) to create an eval scaffold.');
            return;
        }

        const scaffold = await this.createWazaEvalScaffold(skillContext);
        if (!scaffold) {
            logTelemetryUsage('command/wazaCreateEval/result', { outcome: 'failed' });
            return;
        }

        logTelemetryUsage('command/wazaCreateEval/result', { outcome: 'success' });
        void vscode.window.showInformationMessage(`Created waza eval scaffold for ${skillContext.skillName}.`);
    }

    private async handleWazaRunEvalCommand(obj: unknown): Promise<void> {
        const { logTelemetryUsage } = this.requireDeps();
        logTelemetryUsage('command/wazaRunEval');
        const skillContext = this.resolveSkillContext(obj);
        if (!skillContext) {
            logTelemetryUsage('command/wazaRunEval/result', { outcome: 'noSkillContext' });
            void vscode.window.showWarningMessage('Open a SKILL.md file (or select a customization item) to run waza evaluation.');
            return;
        }

        const evalPath = this.findEvalPath(skillContext);
        if (!evalPath) {
            logTelemetryUsage('command/wazaRunEval/result', { outcome: 'missingEval' });
            const action = await vscode.window.showWarningMessage(
                `No eval.yaml found for ${skillContext.skillName}.`,
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
        const { outputChannel, logTelemetryUsage } = this.requireDeps();
        logTelemetryUsage('command/wazaRunEvalFromFile');
        const editor = vscode.window.activeTextEditor;
        outputChannel.appendLine('[Waza] wazaRunEvalFromFile called');
        outputChannel.appendLine(`[Waza] Editor: ${editor ? 'exists' : 'null'}`);
        if (editor) {
            outputChannel.appendLine(`[Waza] Document fileName: ${editor.document.fileName}`);
            outputChannel.appendLine(`[Waza] Ends with eval.yaml: ${editor.document.fileName.endsWith('eval.yaml')}`);
        }

        if (!editor || !editor.document.fileName.endsWith('eval.yaml')) {
            logTelemetryUsage('command/wazaRunEvalFromFile/result', { outcome: 'invalidActiveFile' });
            void vscode.window.showWarningMessage('This command requires an eval.yaml file to be active.');
            return;
        }

        const evalUri = editor.document.uri;
        const evalDir = path.dirname(evalUri.fsPath);
        outputChannel.appendLine(`[Waza] Eval URI fsPath: ${evalUri.fsPath}`);
        outputChannel.appendLine(`[Waza] Eval dir: ${evalDir}`);

        const skillFilePath = this.findSkillFilePathFromEvalDir(evalDir);
        if (!skillFilePath) {
            outputChannel.appendLine('[Waza] Could not find SKILL.md');
            logTelemetryUsage('command/wazaRunEvalFromFile/result', { outcome: 'missingSkillFile' });
            void vscode.window.showWarningMessage('Could not find SKILL.md associated with this eval.yaml file.');
            return;
        }

        const skillContext = this.buildSkillContextForEvalFile(evalUri, skillFilePath);
        await this.runWazaEvaluationForContext(skillContext, evalUri.fsPath);
    }

    private buildSkillContextForEvalFile(evalUri: vscode.Uri, skillFilePath: string): SkillContext {
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

    private async handleWazaDownloadBinaryCommand(): Promise<void> {
        const { outputChannel, logTelemetryUsage, logTelemetryError } = this.requireDeps();
        logTelemetryUsage('command/wazaDownloadBinary');
        try {
            outputChannel.show(true);
            outputChannel.appendLine('[Waza] Downloading latest waza binary...');

            const installPath = await this.downloadAndInstallWazaBinary();
            const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
            await configuration.update('waza.command', installPath, vscode.ConfigurationTarget.Global);

            outputChannel.appendLine(`[Waza] Installed to ${installPath}`);
            logTelemetryUsage('command/wazaDownloadBinary/result', { outcome: 'success' });
            void vscode.window.showInformationMessage(`waza binary downloaded and configured: ${installPath}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            outputChannel.appendLine(`[Waza] Download failed: ${message}`);
            logTelemetryError('command/wazaDownloadBinary/result', error, { outcome: 'failed' });
            void vscode.window.showErrorMessage(`Failed to download waza binary: ${message}`);
        }
    }

    private async handleOpenWazaUserGuideCommand(): Promise<void> {
        await this.openGuide(
            'command/openWazaUserGuide',
            'WAZA-USER-GUIDE.md',
            WAZA_USER_GUIDE_FALLBACK,
            '[Waza] Guide file not found in extension package; opening built-in fallback guide.',
        );
    }

    private async handleOpenAnalysisAndFixUserGuideCommand(): Promise<void> {
        await this.openGuide(
            'command/openAnalysisAndFixUserGuide',
            'ANALYSIS-AND-FIX-USER-GUIDE.md',
            ANALYSIS_AND_FIX_USER_GUIDE_FALLBACK,
            '[Docs] Analysis and fix guide file not found in extension package; opening built-in fallback guide.',
        );
    }

    private async openGuide(
        telemetryEvent: string,
        guideFileName: string,
        fallbackMarkdown: string,
        fallbackLogMessage: string,
    ): Promise<void> {
        const { extensionContext, outputChannel, logTelemetryUsage } = this.requireDeps();
        logTelemetryUsage(telemetryEvent);
        const guideService = new WazaGuideService(extensionContext, outputChannel);
        await guideService.openGuide(guideFileName, fallbackMarkdown, fallbackLogMessage);
    }

    resolveSkillContext(obj: unknown): SkillContext | undefined {
        const { getCustomizationUri } = this.requireDeps();
        const uri = getCustomizationUri(obj) ?? vscode.window.activeTextEditor?.document.uri;
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

    async handlePostFixDiagnosticsFlow(context: SkillContext): Promise<void> {
        const evalPath = this.findEvalPath(context);
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
        const { extensionContext } = this.requireDeps();
        const fileName = process.platform === 'win32' ? 'waza.exe' : 'waza';
        return path.join(extensionContext.globalStorageUri.fsPath, 'bin', fileName);
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

    private findSkillFilePath(startPath: string): string | undefined {
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

    private findSkillFilePathFromEvalDir(evalDir: string): string | undefined {
        const { outputChannel } = this.requireDeps();
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

    private findEvalPath(context: SkillContext): string | undefined {
        const { outputChannel } = this.requireDeps();
        const candidates = new Set<string>();

        candidates.add(path.join(context.workspaceRoot, 'evals', context.skillName, 'eval.yaml'));

        const skillsDir = path.dirname(context.skillDirPath);
        if (path.basename(skillsDir) === 'skills') {
            const projectRoot = path.dirname(skillsDir);
            candidates.add(path.join(projectRoot, 'evals', context.skillName, 'eval.yaml'));
        }

        let current = context.skillDirPath;
        while (true) {
            candidates.add(path.join(current, 'evals', context.skillName, 'eval.yaml'));
            candidates.add(path.join(current, 'evals', 'eval.yaml'));

            const parent = path.dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }

        candidates.add(path.join(context.skillDirPath, 'evals', 'eval.yaml'));
        candidates.add(path.join(context.skillDirPath, 'eval.yaml'));

        outputChannel.appendLine(`[Waza] Looking for eval.yaml for ${context.skillName}`);
        for (const candidate of candidates) {
            outputChannel.appendLine(`[Waza] Eval candidate: ${candidate}`);
            if (fs.existsSync(candidate)) {
                outputChannel.appendLine(`[Waza] Using eval file: ${candidate}`);
                return candidate;
            }
        }

        return undefined;
    }

    private resolveWazaScaffoldCwd(context: SkillContext): string {
        const skillsDir = path.dirname(context.skillDirPath);
        if (path.basename(skillsDir) === 'skills') {
            return path.dirname(skillsDir);
        }

        return skillsDir;
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
        const targetEvalPath = path.join(scaffoldRoot, 'evals', context.skillName, 'eval.yaml');

        try {
            await fs.promises.mkdir(tempSkillDir, { recursive: true });
            await fs.promises.copyFile(context.skillFilePath, path.join(tempSkillDir, 'SKILL.md'));

            outputChannel.appendLine(`[Waza] Temp scaffold root: ${tempRoot}`);
            outputChannel.appendLine(`[Waza] Target eval output: ${targetEvalPath}`);

            return await this.runWazaCommand(
                ['new', 'eval', context.skillName, '--output', targetEvalPath],
                tempRoot,
                WazaOrchestrator.WAZA_CREATE_TIMEOUT_MS,
            );
        } finally {
            await fs.promises.rm(tempRoot, { recursive: true, force: true });
        }
    }

    private detectWazaAssetTarget(): WazaAssetTarget {
        let os: WazaAssetTarget['os'];
        switch (process.platform) {
            case 'darwin':
                os = 'darwin';
                break;
            case 'linux':
                os = 'linux';
                break;
            case 'win32':
                os = 'windows';
                break;
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }

        let arch: WazaAssetTarget['arch'];
        switch (process.arch) {
            case 'x64':
                arch = 'amd64';
                break;
            case 'arm64':
                arch = 'arm64';
                break;
            default:
                throw new Error(`Unsupported architecture: ${process.arch}`);
        }

        const fileName = os === 'windows' ? `waza-${os}-${arch}.exe` : `waza-${os}-${arch}`;
        return { os, arch, fileName };
    }

    private async downloadAndInstallWazaBinary(): Promise<string> {
        const { extensionContext, outputChannel } = this.requireDeps();
        const target = this.detectWazaAssetTarget();
        const tag = await this.fetchLatestWazaTag();
        const binaryUrl = `https://github.com/microsoft/waza/releases/download/${tag}/${target.fileName}`;
        const checksumsUrl = `https://github.com/microsoft/waza/releases/download/${tag}/checksums.txt`;

        const installDir = path.join(extensionContext.globalStorageUri.fsPath, 'bin');
        const binaryPath = path.join(installDir, target.os === 'windows' ? 'waza.exe' : 'waza');
        const tempDir = path.join(extensionContext.globalStorageUri.fsPath, 'tmp');
        const tempBinaryPath = path.join(tempDir, target.fileName);
        const tempChecksumsPath = path.join(tempDir, 'checksums.txt');

        await fs.promises.mkdir(installDir, { recursive: true });
        await fs.promises.mkdir(tempDir, { recursive: true });

        outputChannel.appendLine(`[Waza] Target platform: ${target.os}/${target.arch}`);
        outputChannel.appendLine(`[Waza] Release tag: ${tag}`);
        await this.downloadFile(binaryUrl, tempBinaryPath);
        await this.downloadFile(checksumsUrl, tempChecksumsPath);

        await this.verifyChecksum(tempBinaryPath, tempChecksumsPath, target.fileName);
        await fs.promises.copyFile(tempBinaryPath, binaryPath);
        if (target.os !== 'windows') {
            await fs.promises.chmod(binaryPath, 0o755);
        }

        return binaryPath;
    }

    private async fetchLatestWazaTag(): Promise<string> {
        const url = 'https://api.github.com/repos/microsoft/waza/releases';
        const payload = await this.httpGetText(url, {
            'User-Agent': 'vscode-chat-customizations-evaluation',
            Accept: 'application/vnd.github+json',
        });

        let releases: GitHubRelease[];
        try {
            releases = JSON.parse(payload) as GitHubRelease[];
        } catch {
            throw new Error('Could not parse GitHub releases response');
        }

        const tag = releases.find((r) => typeof r.tag_name === 'string' && r.tag_name.startsWith('v'))?.tag_name;
        if (!tag) {
            throw new Error('Could not determine latest waza release tag');
        }

        return tag;
    }

    private async downloadFile(url: string, destinationPath: string): Promise<void> {
        const data = await this.httpGetBuffer(url, {
            'User-Agent': 'vscode-chat-customizations-evaluation',
            Accept: 'application/octet-stream',
        });
        await fs.promises.writeFile(destinationPath, data);
    }

    private async verifyChecksum(binaryPath: string, checksumsPath: string, fileName: string): Promise<void> {
        const checksums = await fs.promises.readFile(checksumsPath, 'utf8');
        const checksumLine = checksums.split(/\r?\n/).find((line) => line.trim().endsWith(` ${fileName}`));
        if (!checksumLine) {
            throw new Error(`No checksum found for ${fileName}`);
        }

        const expected = checksumLine.trim().split(/\s+/)[0].toLowerCase();
        const actual = createHash('sha256').update(await fs.promises.readFile(binaryPath)).digest('hex').toLowerCase();
        if (expected !== actual) {
            throw new Error('Checksum verification failed');
        }
    }

    private async httpGetText(url: string, headers?: Record<string, string>): Promise<string> {
        const buffer = await this.httpGetBuffer(url, headers);
        return buffer.toString('utf8');
    }

    private httpGetBuffer(url: string, headers?: Record<string, string>, redirectCount = 0): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            if (redirectCount > 5) {
                reject(new Error('Too many HTTP redirects'));
                return;
            }

            const request = https.get(url, { headers }, (response) => {
                const status = response.statusCode ?? 0;
                const location = response.headers.location;

                if (status >= 300 && status < 400 && location) {
                    response.resume();
                    const redirected = new URL(location, url).toString();
                    this.httpGetBuffer(redirected, headers, redirectCount + 1).then(resolve, reject);
                    return;
                }

                if (status < 200 || status >= 300) {
                    const chunks: Buffer[] = [];
                    response.on('data', (chunk: Buffer) => chunks.push(chunk));
                    response.on('end', () => {
                        const body = Buffer.concat(chunks).toString('utf8');
                        reject(new Error(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`));
                    });
                    return;
                }

                const chunks: Buffer[] = [];
                response.on('data', (chunk: Buffer) => chunks.push(chunk));
                response.on('end', () => resolve(Buffer.concat(chunks)));
            });

            request.on('error', reject);
        });
    }

    private async runWazaCommand(args: string[], cwd: string, timeoutMs?: number): Promise<CommandResult> {
        return this.wazaCommandExecutor.runWazaCommand(args, cwd, timeoutMs);
    }

    private async runWazaEvaluationForContext(context: SkillContext, evalPath: string): Promise<void> {
        const { extensionContext, outputChannel, logTelemetryUsage } = this.requireDeps();
        outputChannel.show(true);
        outputChannel.appendLine(`[Waza] Running evaluation for ${context.skillName}`);
        logTelemetryUsage('waza/runEval/start');

        const resultsFile = await this.createWazaResultsFilePath(extensionContext.globalStorageUri.fsPath, context.skillName);

        outputChannel.appendLine(`[Waza] Command: ${this.getWazaCommand()} run ${evalPath} --context-dir ${context.skillDirPath} --output ${resultsFile}`);

        const result = await this.runWazaCommand(
            ['run', evalPath, '--context-dir', context.skillDirPath, '--output', resultsFile],
            context.workspaceRoot,
        );

        this.appendWazaCommandOutput(result, outputChannel);

        if (result.exitCode !== 0) {
            this.logAndNotifyWazaRunEvalFailure();
            return;
        }

        await this.handleWazaRunEvalSuccess(context, resultsFile);
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

    private logAndNotifyWazaRunEvalFailure(): void {
        const { logTelemetryUsage } = this.requireDeps();
        logTelemetryUsage('waza/runEval/result', { outcome: 'failed' });
        void vscode.window.showErrorMessage('waza evaluation failed. See "Chat Customizations Evaluations" output for details.');
    }

    private async handleWazaRunEvalSuccess(context: SkillContext, resultsFile: string): Promise<void> {
        const { outputChannel, logTelemetryUsage } = this.requireDeps();
        const resultsFileExists = fs.existsSync(resultsFile);

        if (!resultsFileExists) {
            logTelemetryUsage('waza/runEval/result', {
                outcome: 'success',
                resultsFileCreated: false,
            });
            void vscode.window.showInformationMessage(`waza evaluation completed for ${context.skillName}.`);
            return;
        }

        const resultsUri = vscode.Uri.file(resultsFile);
        outputChannel.appendLine(`[Waza] Results saved to: ${resultsUri.toString()}`);

        const action = await vscode.window.showInformationMessage(
            `waza evaluation completed for ${context.skillName}.`,
            'View Results'
        );

        if (action === 'View Results') {
            const document = await vscode.workspace.openTextDocument(resultsUri);
            await vscode.window.showTextDocument(document, { preview: false });
        }

        logTelemetryUsage('waza/runEval/result', {
            outcome: 'success',
            resultsFileCreated: true,
        });
    }

    private async handleExistingEvalAfterFix(context: SkillContext, evalPath: string): Promise<void> {
        if (this.getAlwaysRunEvalsAfterFixDiagnostics()) {
            await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaRunEval', { uri: context.uri });
            return;
        }

        const runNow = 'Run Eval';
        const alwaysRun = 'Always Run Evals After Fix Diagnostics';
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
            `Diagnostics were fixed for ${context.skillName}. No eval.yaml found. Create evals powered by waza now? You can also run the "Create Waza Eval Scaffold" command later.`,
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
            `Created waza scaffold at ${relativeEvalPath}.${fileSummary}`,
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

        outputChannel.appendLine('[Waza] waza command unavailable; downloading managed binary.');

        try {
            const installPath = await this.downloadAndInstallWazaBinary();
            const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
            await configuration.update('waza.command', installPath, vscode.ConfigurationTarget.Global);
            outputChannel.appendLine(`[Waza] Installed managed binary at ${installPath}`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            outputChannel.appendLine(`[Waza] Failed to install managed binary: ${message}`);
            void vscode.window.showErrorMessage(`Failed to install waza binary: ${message}`);
            return false;
        }
    }

    private async createWazaEvalScaffold(context: SkillContext): Promise<EvalScaffoldSummary | undefined> {
        const { outputChannel, logTelemetryUsage } = this.requireDeps();
        const scaffoldCwd = this.resolveWazaScaffoldCwd(context);
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

        const evalPath = this.findEvalPath(context);
        if (!evalPath) {
            logTelemetryUsage('waza/createEvalScaffold/result', {
                outcome: 'missingEvalAfterSuccess',
                usedTemporaryWorkspaceFallback,
            });
            return undefined;
        }

        const createdFiles = this.collectEvalScaffoldFiles(evalPath);
        return this.logAndBuildScaffoldSummary(evalPath, createdFiles, usedTemporaryWorkspaceFallback);
    }

    private async runCreateEvalScaffoldCommand(
        context: SkillContext,
        scaffoldCwd: string,
    ): Promise<{ result: CommandResult; usedTemporaryWorkspaceFallback: boolean }> {
        const { outputChannel } = this.requireDeps();
        const firstAttempt = await this.runWazaCommand(
            ['new', 'eval', context.skillName],
            scaffoldCwd,
            WazaOrchestrator.WAZA_CREATE_TIMEOUT_MS,
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
        const { outputChannel, logTelemetryUsage } = this.requireDeps();
        logTelemetryUsage('waza/createEvalScaffold/result', {
            outcome: 'failed',
            usedTemporaryWorkspaceFallback,
        });
        outputChannel.appendLine(`[Waza] eval scaffold failed\n${result.stderr || result.stdout}`);
        void vscode.window.showErrorMessage('Failed to create waza eval scaffold. See "Chat Customizations Evaluations" output for details.');
    }

    private logAndBuildScaffoldSummary(
        evalPath: string,
        createdFiles: string[],
        usedTemporaryWorkspaceFallback: boolean,
    ): EvalScaffoldSummary {
        const { logTelemetryUsage } = this.requireDeps();
        logTelemetryUsage('waza/createEvalScaffold/result', {
            outcome: 'success',
            usedTemporaryWorkspaceFallback,
            createdFileCount: createdFiles.length,
        });
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
