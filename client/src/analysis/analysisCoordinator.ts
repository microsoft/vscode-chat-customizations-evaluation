import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import type {
    AnalysisDocumentSnapshot, AnalyzeRequest
} from './types';
import { ACTION_ANALYZE_AGAIN, ACTION_FIX_DIAGNOSTICS } from './strings';
import { DiagnosticsManager } from './diagnosticsManager';
import { LanguageClient } from 'vscode-languageclient/node';

export class AnalysisCoordinator {

    private static readonly QUEUED_ANALYSIS_TIMEOUT_MS = 60000;
    private static readonly MAX_PREVIOUS_DIAGNOSTICS = 10;
    private static readonly ANALYSIS_PROGRESS_UPDATE_INTERVAL_MS = 5000;

    private readonly urisWithDiagnostics = new Set<string>();
    private readonly queuedAnalysisUris = new Set<string>();
    private readonly queuedAnalysisTimeoutsByUri = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly analysisSnapshotsByUri = new Map<string, string>();
    private readonly previousDiagnosticsByUri = new Map<string, string[]>();

    constructor(
        context: vscode.ExtensionContext,
        private readonly diagnosticsManager: DiagnosticsManager,
        private readonly client: LanguageClient,
        private readonly outputChannel: vscode.OutputChannel
    ) {
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => this.updateHasDiagnosticsContext()));
    }

    dispose(): void {
        for (const timeout of this.queuedAnalysisTimeoutsByUri.values()) {
            clearTimeout(timeout);
        }
        this.queuedAnalysisTimeoutsByUri.clear();
        this.queuedAnalysisUris.clear();
        this.updateIsAnalyzingContext();
    }

    async handleAnalyzePromptCommand(candidateUri: vscode.Uri | undefined): Promise<void> {
        const uri = candidateUri ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri) {
            return;
        }
        if (this.isAnalysisRunning(uri)) {
            return;
        }
        await this.runAnalyzeWorkflow(uri);
    }

    async runAnalyzeWorkflow(uri: vscode.Uri): Promise<void> {
        const uriKey = uri.toString();
        if (!this.queuedAnalysisUris.has(uriKey)) {
            this.queueAnalysis(uri);
        }
        this.clearQueuedAnalysisTimeout(uriKey);

        const snapshot = await this.getCurrentAnalysisSnapshot(uri);
        if (snapshot.isFresh && snapshot.diagnostics.length > 0) {
            this.clearQueuedAnalysis(uriKey);
            this.updateIsAnalyzingContext();
            await this.focusExistingDiagnostics(uri);
            vscode.window.showInformationMessage('Analysis is already up to date.');
            return;
        }
        const previousDiagnostics = this.previousDiagnosticsByUri.get(uri.toString());
        this.executeAnalyzeRequest(uri, snapshot, previousDiagnostics);
    }

    isAnalysisPending(uri: vscode.Uri): boolean {
        return this.queuedAnalysisUris.has(uri.toString());
    }

    queueAnalysis(uri: vscode.Uri): void {
        const uriKey = uri.toString();
        this.clearQueuedAnalysisTimeout(uriKey);

        const timeout = setTimeout(() => {
            this.queuedAnalysisUris.delete(uriKey);
            this.queuedAnalysisTimeoutsByUri.delete(uriKey);
            this.updateIsAnalyzingContext();
        }, AnalysisCoordinator.QUEUED_ANALYSIS_TIMEOUT_MS);

        this.queuedAnalysisUris.add(uriKey);
        this.queuedAnalysisTimeoutsByUri.set(uriKey, timeout);
        this.updateIsAnalyzingContext();
    }

    handleDiagnosticsChanged(uris: readonly vscode.Uri[]): void {
        for (const uri of uris) {
            const diagnostics = this.diagnosticsManager.getDiagnosticsForUri(uri);
            const uriKey = uri.toString();
            if (diagnostics.length > 0) {
                this.urisWithDiagnostics.add(uriKey);
            } else {
                this.urisWithDiagnostics.delete(uriKey);
            }
        }
        this.updateHasDiagnosticsContext();
    }

    handleDocumentClosed(uri: vscode.Uri): void {
        const uriKey = uri.toString();
        this.previousDiagnosticsByUri.delete(uriKey);
        this.clearQueuedAnalysis(uriKey);
        this.updateIsAnalyzingContext();
    }

    async focusExistingDiagnostics(uri: vscode.Uri): Promise<void> {
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
        const firstDiagnostic = this.getSortedDiagnostics(uri)[0];
        if (!firstDiagnostic) {
            return;
        }
        editor.selection = new vscode.Selection(firstDiagnostic.range.start, firstDiagnostic.range.start);
        editor.revealRange(firstDiagnostic.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        await vscode.commands.executeCommand('workbench.actions.view.problems');
    }

    private getSortedDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
        return this.diagnosticsManager.getDiagnosticsForUri(uri)
            .slice()
            .sort((a, b) => {
                if (a.range.start.line !== b.range.start.line) {
                    return a.range.start.line - b.range.start.line;
                }
                return a.range.start.character - b.range.start.character;
            })
    }

    recordAnalysisSnapshot(document: vscode.TextDocument): void {
        this.analysisSnapshotsByUri.set(document.uri.toString(), this.computeAnalysisFingerprint(document));
    }

    async getCurrentAnalysisSnapshot(uri: vscode.Uri): Promise<AnalysisDocumentSnapshot> {
        const document = await vscode.workspace.openTextDocument(uri);
        const fingerprint = this.analysisSnapshotsByUri.get(uri.toString());
        const diagnostics = this.diagnosticsManager.getDiagnosticsForUri(uri);
        const isFresh = fingerprint === this.computeAnalysisFingerprint(document);
        return { document, diagnostics, isFresh };
    }

    async completeAnalysis(uri: vscode.Uri, result: { duration: number; resultCount: number }): Promise<void> {
        const uriKey = uri.toString();
        this.queuedAnalysisUris.delete(uriKey);
        this.clearQueuedAnalysisTimeout(uriKey);
        this.updateIsAnalyzingContext();

        await vscode.commands.executeCommand('workbench.actions.view.problems');

        const filename = path.basename(uri.fsPath);
        if (result.resultCount === 0) {
            vscode.window.showInformationMessage(`Analysis of ${filename} complete: no issues found.`);
            return;
        }
        const diagnostics = this.getSortedDiagnostics(uri);

        (async () => {
            const message = `Analysis of ${filename} complete in ${Math.floor(result.duration / 1000)} seconds: ${this.formatIssueSummary(result.resultCount)}.`;
            const hasErrorDiagnostics = diagnostics.some(diagnostic => this.diagnosticsManager.hasErrorDiagnostics(diagnostic));
            const actions = hasErrorDiagnostics ? [ACTION_ANALYZE_AGAIN] : [ACTION_FIX_DIAGNOSTICS];
            const action = await vscode.window.showInformationMessage(message, ...actions);
            if (action === ACTION_ANALYZE_AGAIN) {
                await vscode.commands.executeCommand('chatCustomizationsEvaluations.analyzePrompt');
            } else if (action === ACTION_FIX_DIAGNOSTICS) {
                await vscode.commands.executeCommand('chatCustomizationsEvaluations.fixDiagnostics');
            }
        })();

        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
        const firstDiagnostic = diagnostics[0];
        if (!firstDiagnostic) {
            return;
        }
        editor.selection = new vscode.Selection(firstDiagnostic.range.start, firstDiagnostic.range.start);
        editor.revealRange(firstDiagnostic.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    private formatIssueSummary(count: number): string {
        return count === 1 ? '1 issue found' : `${count} issues found`;
    }

    private async executeAnalyzeRequest(
        uri: vscode.Uri,
        snapshot: AnalysisDocumentSnapshot,
        previousDiagnostics: string[] | undefined
    ): Promise<void> {
        const filename = path.basename(uri.fsPath || uri.path || 'prompt');
        try {
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Analyzing ${filename}`,
                    cancellable: false,
                },
                async (progress) => {
                    progress.report({ message: 'Analysis in progress...' });
                    const interval = setInterval(() => {
                        progress.report({ message: 'Analysis in progress...' });
                    }, AnalysisCoordinator.ANALYSIS_PROGRESS_UPDATE_INTERVAL_MS);

                    try {
                        const analyzeRequest: AnalyzeRequest = { uri: uri.toString(), previousDiagnosticMessages: previousDiagnostics };
                        return await this.client.sendRequest<{ duration: number; resultCount: number }>('chatCustomizationsEvaluations/analyze', analyzeRequest);
                    } finally {
                        clearInterval(interval);
                    }
                }
            );
            this.recordAnalysisSnapshot(snapshot.document);
            await vscode.window.showTextDocument(snapshot.document, { preview: false, preserveFocus: false });
            await this.completeAnalysis(uri, result);
            this.accumulatePreviousDiagnostics(uri);
        } catch (error) {
            this.clearQueuedAnalysis(uri.toString());
            this.updateIsAnalyzingContext();
            this.outputChannel.appendLine(`[Analysis] Error: ${error}`);
            vscode.window.showErrorMessage('Prompt analysis failed. See output for details.');
        }
    }

    private accumulatePreviousDiagnostics(uri: vscode.Uri): void {
        const currentDiagnostics = this.diagnosticsManager.getDiagnosticsForUri(uri);
        if (currentDiagnostics.length === 0) {
            return;
        }
        const uriKey = uri.toString();
        const existing = this.previousDiagnosticsByUri.get(uriKey) ?? [];
        const existingSet = new Set(existing);
        for (const diagnostic of currentDiagnostics) {
            const message = diagnostic.message.trim();
            if (message && !existingSet.has(message)) {
                existing.push(message);
                existingSet.add(message);
            }
        }
        if (existing.length > AnalysisCoordinator.MAX_PREVIOUS_DIAGNOSTICS) {
            existing.splice(0, existing.length - AnalysisCoordinator.MAX_PREVIOUS_DIAGNOSTICS);
        }
        this.previousDiagnosticsByUri.set(uriKey, existing);
    }

    private updateIsAnalyzingContext(): void {
        const analyzingCount = this.queuedAnalysisUris.size;
        void vscode.commands.executeCommand('setContext', 'chatCustomizationsEvaluations.isAnalyzing', analyzingCount > 0);
    }

    private isAnalysisRunning(uri: vscode.Uri): boolean {
        const uriKey = uri.toString();
        return this.queuedAnalysisUris.has(uriKey) && !this.queuedAnalysisTimeoutsByUri.has(uriKey);
    }

    private clearQueuedAnalysis(uriKey: string): void {
        this.queuedAnalysisUris.delete(uriKey);
        this.clearQueuedAnalysisTimeout(uriKey);
    }

    private clearQueuedAnalysisTimeout(uriKey: string): void {
        const timeout = this.queuedAnalysisTimeoutsByUri.get(uriKey);
        if (!timeout) {
            return;
        }
        clearTimeout(timeout);
        this.queuedAnalysisTimeoutsByUri.delete(uriKey);
    }

    private updateHasDiagnosticsContext(): void {
        const editor = vscode.window.activeTextEditor;
        const hasDiagnostics = editor ? this.urisWithDiagnostics.has(editor.document.uri.toString()) : false;
        void vscode.commands.executeCommand('setContext', 'chatCustomizationsEvaluations.hasDiagnostics', hasDiagnostics);
    }

    private computeAnalysisFingerprint(document: vscode.TextDocument): string {
        return createHash('sha256')
            .update(document.getText())
            .update('\0')
            .digest('hex');
    }
}