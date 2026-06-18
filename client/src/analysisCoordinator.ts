import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import type {
    AnalysisDocumentSnapshot,
    AnalysisSnapshot, AnalysisWorkflowResult, AnalyzeRequest, TelemetryData
} from './types';
import { ACTION_ANALYZE_AGAIN, ACTION_FIX_DIAGNOSTICS } from './strings';
import { DiagnosticsManager } from './diagnosticsManager';

export class AnalysisCoordinator {
    private static readonly QUEUED_ANALYSIS_TIMEOUT_MS = 60000;

    private static readonly MAX_PREVIOUS_DIAGNOSTICS = 10;

    private readonly urisWithDiagnostics = new Set<string>();
    private readonly queuedAnalysisUris = new Set<string>();
    private readonly queuedAnalysisTimeoutsByUri = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly analysisSnapshotsByUri = new Map<string, AnalysisSnapshot>();
    private readonly previousDiagnosticMessagesByUri = new Map<string, string[]>();

    constructor(
        private readonly diagnosticsManager: DiagnosticsManager,
        private readonly sendAnalyzeRequest: (request: AnalyzeRequest) => Thenable<{ duration: number; resultCount: number }>,
    ) { }

    initialize(context: vscode.ExtensionContext): void {
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => this.updateHasDiagnosticsContext()));
    }

    dispose(): void {
        for (const timeout of this.queuedAnalysisTimeoutsByUri.values()) {
            clearTimeout(timeout);
        }
        this.queuedAnalysisTimeoutsByUri.clear();
        this.queuedAnalysisUris.clear();
    }

    async handleAnalyzePromptCommand(options: {
        candidateUri: vscode.Uri | undefined;
        logTelemetryUsage: (eventName: string, data?: TelemetryData) => void;
        logTelemetryError: (eventName: string, error: unknown, data?: TelemetryData) => void;
    }): Promise<void> {
        const resultEventName = 'command/analyzePrompt/result';
        const uri = options.candidateUri ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri) {
            options.logTelemetryUsage(resultEventName, { outcome: 'noActiveEditor' });
            return;
        }
        if (this.isAnalysisRunning(uri)) {
            options.logTelemetryUsage(resultEventName, { outcome: 'alreadyRunning' });
            return;
        }
        const result = await this.runAnalyzeWorkflow(uri);
        if (result.outcome === 'failed') {
            options.logTelemetryError(resultEventName, result.error, { outcome: result.outcome });
            return;
        }
        options.logTelemetryUsage(resultEventName, result);
    }

    async runAnalyzeWorkflow(uri: vscode.Uri): Promise<AnalysisWorkflowResult> {
        const uriKey = uri.toString();
        if (!this.queuedAnalysisUris.has(uriKey)) {
            this.queueAnalysis(uri);
        }
        this.clearQueuedAnalysisTimeout(uriKey);

        const previousDiagnosticMessages = this.previousDiagnosticMessagesByUri.get(uri.toString());
        const analyzeRequest = {
            uri: uri.toString(),
            previousDiagnosticMessages,
        };
        const currentSnapshot = await this.getCurrentAnalysisSnapshot(uri);

        if (currentSnapshot.isFresh && currentSnapshot.diagnostics.length > 0) {
            await this.focusExistingDiagnostics(uri);
            vscode.window.showInformationMessage('Analysis is already up to date.');
            return {
                outcome: 'alreadyCurrentWithDiagnostics',
                resultCount: currentSnapshot.diagnostics.length,
            };
        }
        return this.executeAnalyzeRequest({
            uri,
            snapshot: currentSnapshot,
            analyzeRequest,
        });
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
        this.previousDiagnosticMessagesByUri.delete(uriKey);
        this.clearQueuedAnalysis(uriKey);
        this.updateIsAnalyzingContext();
    }

    async focusExistingDiagnostics(uri: vscode.Uri): Promise<boolean> {
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
        const firstDiagnostic = this.diagnosticsManager.getDiagnosticsForUri(uri)
            .slice()
            .sort((a, b) => {
                if (a.range.start.line !== b.range.start.line) {
                    return a.range.start.line - b.range.start.line;
                }
                return a.range.start.character - b.range.start.character;
            })[0];

        if (!firstDiagnostic) {
            return false;
        }
        editor.selection = new vscode.Selection(firstDiagnostic.range.start, firstDiagnostic.range.start);
        editor.revealRange(firstDiagnostic.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        await vscode.commands.executeCommand('workbench.actions.view.problems');
        return true;
    }

    recordAnalysisSnapshot(document: vscode.TextDocument, resultCount: number): void {
        this.analysisSnapshotsByUri.set(document.uri.toString(), {
            fingerprint: this.computeAnalysisFingerprint(document),
            resultCount,
        });
    }

    async getCurrentAnalysisSnapshot(uri: vscode.Uri): Promise<AnalysisDocumentSnapshot> {
        const document = await vscode.workspace.openTextDocument(uri);
        const cachedSnapshot = this.analysisSnapshotsByUri.get(uri.toString());
        const diagnostics = this.diagnosticsManager.getDiagnosticsForUri(uri);
        const isFresh = cachedSnapshot?.fingerprint === this.computeAnalysisFingerprint(document);
        const resultCount = cachedSnapshot?.resultCount;
        return {
            document,
            diagnostics,
            isFresh,
            resultCount,
        };
    }

    async completeAnalysis(uri: vscode.Uri, result: { duration: number; resultCount: number }): Promise<void> {
        const uriKey = uri.toString();
        this.queuedAnalysisUris.delete(uriKey);
        this.clearQueuedAnalysisTimeout(uriKey);
        this.updateIsAnalyzingContext();

        await vscode.commands.executeCommand('workbench.actions.view.problems');

        const filename = path.basename(uri.fsPath);
        const durationText = ` in ${this.formatDurationMs(result.duration)}`;
        if (result.resultCount === 0) {
            vscode.window.showInformationMessage(`Analysis of ${filename} complete${durationText}: no issues found.`);
            return;
        }
        const message = `Analysis of ${filename} complete${result.duration}: ${this.formatIssueSummary(result.resultCount)}.`;
        const diagnostics = this.diagnosticsManager.getDiagnosticsForUri(uri)
            .slice()
            .sort((a, b) => {
                if (a.range.start.line !== b.range.start.line) {
                    return a.range.start.line - b.range.start.line;
                }
                return a.range.start.character - b.range.start.character;
            });
        const hasNonFixableDiagnostics = diagnostics.some(diagnostic => this.diagnosticsManager.isNonFixableDiagnostic(diagnostic));

        (async () => {
            const actions = hasNonFixableDiagnostics
                ? [ACTION_ANALYZE_AGAIN]
                : [ACTION_FIX_DIAGNOSTICS];
            const action = await vscode.window.showInformationMessage(message, ...actions);
            if (action === ACTION_ANALYZE_AGAIN) {
                await vscode.commands.executeCommand('chatCustomizationsEvaluations.analyzePromptUsingSlashCommand');
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

    private async executeAnalyzeRequest(options: {
        uri: vscode.Uri;
        snapshot: AnalysisDocumentSnapshot;
        analyzeRequest: AnalyzeRequest;
    }): Promise<AnalysisWorkflowResult> {
        try {
            const result = await this.sendAnalyzeRequest(options.analyzeRequest);
            this.recordAnalysisSnapshot(options.snapshot.document, result.resultCount);
            await vscode.window.showTextDocument(options.snapshot.document, { preview: false, preserveFocus: false });
            await this.completeAnalysis(options.uri, result);
            this.accumulatePreviousDiagnostics(options.uri);
            return {
                outcome: 'success',
                resultCount: result.resultCount,
                durationMs: result.duration,
            };
        } catch (error) {
            void vscode.window.showErrorMessage('Prompt analysis failed. See output for details.');
            return {
                outcome: 'failed',
                error,
            };
        }
    }

    private formatDurationMs(durationMs: number): string {
        const seconds = Math.max(1, Math.round(durationMs / 1000));
        return `${seconds}s`;
    }

    private accumulatePreviousDiagnostics(uri: vscode.Uri): void {
        const currentDiagnostics = this.diagnosticsManager.getDiagnosticsForUri(uri);
        if (currentDiagnostics.length === 0) {
            return;
        }

        const uriKey = uri.toString();
        const existing = this.previousDiagnosticMessagesByUri.get(uriKey) ?? [];
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
        this.previousDiagnosticMessagesByUri.set(uriKey, existing);
    }

    private updateIsAnalyzingContext(): void {
        void vscode.commands.executeCommand('setContext', 'chatCustomizationsEvaluations.isAnalyzing', this.queuedAnalysisUris.size > 0);
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