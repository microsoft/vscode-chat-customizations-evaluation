import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import {
    ACTION_ANALYZE_AGAIN,
    ACTION_FIX_DIAGNOSTICS
} from './strings';
import type {
    AnalysisSnapshot, AnalyzeRequest, CustomDiagnosticConfig
} from './types';

type TelemetryData = Record<string, string | number | boolean | undefined>;

export type AnalysisWorkflowResult =
    | {
        outcome: 'alreadyCurrentWithDiagnostics';
        resultCount: number;
        customDiagnosticsCount: number;
    }
    | {
        outcome: 'success';
        resultCount: number;
        durationMs: number;
        customDiagnosticsCount: number;
    }
    | {
        outcome: 'failed';
        error: unknown;
        customDiagnosticsCount: number;
    };

export class AnalysisCoordinator {

    constructor(
        private readonly getDiagnosticsForUri: (uri: vscode.Uri) => vscode.Diagnostic[],
        private readonly isNonFixableDiagnosticForEntry: (diagnostic: vscode.Diagnostic) => boolean,
        private readonly sendAnalyzeRequest: (request: AnalyzeRequest) => Thenable<{ duration: number; resultCount: number }>,
    ) { }

    private readonly urisWithDiagnostics = new Set<string>();
    private readonly pendingAnalysisUris = new Set<string>();
    private readonly analysisSnapshotsByUri = new Map<string, AnalysisSnapshot>();
    private readonly previousDiagnosticMessagesByUri = new Map<string, string[]>();

    initialize(context: vscode.ExtensionContext): void {
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
            this.updateHasDiagnosticsContext();
        }));
    }

    dispose(): void {
    }

    async handleAnalyzePromptCommand(options: {
        candidateUri: vscode.Uri | undefined;
        logTelemetryUsage: (eventName: string, data?: TelemetryData) => void;
        logTelemetryError: (eventName: string, error: unknown, data?: TelemetryData) => void;
        resultEventName: string;
        revealDocumentAfterSuccess: boolean;
    }): Promise<void> {
        options.logTelemetryUsage('command/analyzePrompt', { source: 'activeEditor' });

        const uri = options.candidateUri ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri) {
            options.logTelemetryUsage(options.resultEventName, { outcome: 'noActiveEditor' });
            return;
        }

        if (this.isAnalysisPending(uri)) {
            options.logTelemetryUsage(options.resultEventName, { outcome: 'alreadyRunning' });
            return;
        }

        const result = await this.runAnalyzeWorkflow({
            uri,
            revealDocumentAfterSuccess: options.revealDocumentAfterSuccess,
        });

        if (result.outcome === 'failed') {
            options.logTelemetryError(options.resultEventName, result.error, {
                outcome: result.outcome,
                customDiagnosticsCount: result.customDiagnosticsCount,
            });
            return;
        }

        options.logTelemetryUsage(options.resultEventName, result);
    }

    async runAnalyzeWorkflow(options: {
        uri: vscode.Uri;
        revealDocumentAfterSuccess: boolean;
    }): Promise<AnalysisWorkflowResult> {
        const analyzeRequest = this.createAnalyzeRequest(options.uri);
        const customDiagnosticsCount = analyzeRequest.customDiagnostics?.length ?? 0;
        const currentSnapshot = await this.getCurrentAnalysisSnapshot(options.uri, analyzeRequest.customDiagnostics);

        if (currentSnapshot.isFresh && currentSnapshot.diagnostics.length > 0) {
            await this.focusExistingDiagnostics(options.uri);
            vscode.window.showInformationMessage('Analysis is already up to date.');
            return {
                outcome: 'alreadyCurrentWithDiagnostics',
                resultCount: currentSnapshot.diagnostics.length,
                customDiagnosticsCount,
            };
        }

        return this.executeAnalyzeRequest({
            uri: options.uri,
            snapshot: currentSnapshot,
            analyzeRequest,
            customDiagnosticsCount,
            revealDocumentAfterSuccess: options.revealDocumentAfterSuccess,
        });
    }

    isAnalysisPending(uri: vscode.Uri): boolean {
        return this.pendingAnalysisUris.has(uri.toString());
    }

    beginAnalysis(uri: string): void {
        this.pendingAnalysisUris.add(uri);
        this.updateIsAnalyzingContext();
    }

    handleDiagnosticsChanged(uris: readonly vscode.Uri[]): void {
        for (const uri of uris) {
            const diagnostics = this.getDiagnosticsForUri(uri);
            const uriKey = uri.toString();
            if (diagnostics.length > 0) {
                this.urisWithDiagnostics.add(uriKey);
            } else {
                this.urisWithDiagnostics.delete(uriKey);
            }
        }
        this.updateHasDiagnosticsContext();
    }

    handleDocumentContentChanged(uri: vscode.Uri): void {
        this.previousDiagnosticMessagesByUri.delete(uri.toString());
    }

    handleDocumentClosed(uri: vscode.Uri): void {
        const uriKey = uri.toString();
        this.previousDiagnosticMessagesByUri.delete(uriKey);
        this.pendingAnalysisUris.delete(uriKey);
        this.updateIsAnalyzingContext();
    }

    async focusExistingDiagnostics(uri: vscode.Uri): Promise<boolean> {
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
        const firstDiagnostic = this.getDiagnosticsForUri(uri)
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

    recordAnalysisSnapshot(document: vscode.TextDocument, customDiagnostics: CustomDiagnosticConfig[] | undefined, resultCount: number): void {
        this.analysisSnapshotsByUri.set(document.uri.toString(), {
            fingerprint: this.computeAnalysisFingerprint(document, customDiagnostics),
            resultCount,
        });
    }

    async getCurrentAnalysisSnapshot(uri: vscode.Uri, customDiagnostics?: CustomDiagnosticConfig[]): Promise<{
        document: vscode.TextDocument;
        diagnostics: vscode.Diagnostic[];
        isFresh: boolean;
        resultCount: number | undefined;
    }> {
        const document = await vscode.workspace.openTextDocument(uri);
        const cachedSnapshot = this.analysisSnapshotsByUri.get(uri.toString());
        const isFresh = cachedSnapshot?.fingerprint === this.computeAnalysisFingerprint(document, customDiagnostics);

        return {
            document,
            diagnostics: this.getDiagnosticsForUri(uri),
            isFresh,
            resultCount: cachedSnapshot?.resultCount,
        };
    }

    async completeAnalysis(uri: vscode.Uri, result: { duration: number; resultCount: number }): Promise<void> {
        const uriKey = uri.toString();
        this.pendingAnalysisUris.delete(uriKey);
        this.updateIsAnalyzingContext();

        // Open Problems as soon as analysis finishes so results are visible without another click.
        await vscode.commands.executeCommand('workbench.actions.view.problems');

        const filename = path.basename(uri.fsPath);
        const durationText = ` in ${this.formatDurationMs(result.duration)}`;
        if (result.resultCount === 0) {
            void vscode.window.showInformationMessage(`Analysis of ${filename} complete${durationText}: no issues found.`);
            return;
        }

        await this.notifyAndFocusProblems(uri, result.resultCount, filename, durationText);
    }

    private formatIssueSummary(count: number): string {
        return count === 1 ? '1 issue found' : `${count} issues found`;
    }

    private createAnalyzeRequest(uri: vscode.Uri): AnalyzeRequest {
        const previousMessages = this.previousDiagnosticMessagesByUri.get(uri.toString());
        return {
            uri: uri.toString(),
            customDiagnostics: this.getCustomDiagnostics(),
            previousDiagnosticMessages: previousMessages?.length ? previousMessages : undefined,
        };
    }

    private getCustomDiagnostics(): CustomDiagnosticConfig[] | undefined {
        const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
        const diagnostics = configuration.get<CustomDiagnosticConfig[]>('customDiagnostics', []);
        return diagnostics.length > 0 ? diagnostics : undefined;
    }

    private async executeAnalyzeRequest(options: {
        uri: vscode.Uri;
        snapshot: {
            document: vscode.TextDocument;
            diagnostics: vscode.Diagnostic[];
            isFresh: boolean;
            resultCount: number | undefined;
        };
        analyzeRequest: AnalyzeRequest;
        customDiagnosticsCount: number;
        revealDocumentAfterSuccess: boolean;
    }): Promise<AnalysisWorkflowResult> {
        this.beginAnalysis(options.uri.toString());

        try {
            const result = await this.sendAnalyzeRequest(options.analyzeRequest);
            this.recordAnalysisSnapshot(options.snapshot.document, options.analyzeRequest.customDiagnostics, result.resultCount);

            if (options.revealDocumentAfterSuccess) {
                await vscode.window.showTextDocument(options.snapshot.document, { preview: false, preserveFocus: false });
            }

            await this.completeAnalysis(options.uri, result);
            this.accumulatePreviousDiagnostics(options.uri);
            return {
                outcome: 'success',
                resultCount: result.resultCount,
                durationMs: result.duration,
                customDiagnosticsCount: options.customDiagnosticsCount,
            };
        } catch (error) {
            void vscode.window.showErrorMessage('Prompt analysis failed. See output for details.');
            return {
                outcome: 'failed',
                error,
                customDiagnosticsCount: options.customDiagnosticsCount,
            };
        }
    }

    private formatDurationMs(durationMs: number): string {
        const seconds = Math.max(1, Math.round(durationMs / 1000));
        return `${seconds}s`;
    }

    private accumulatePreviousDiagnostics(uri: vscode.Uri): void {
        const currentDiagnostics = this.getDiagnosticsForUri(uri);
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

        this.previousDiagnosticMessagesByUri.set(uriKey, existing);
    }

    private updateIsAnalyzingContext(): void {
        void vscode.commands.executeCommand('setContext', 'chatCustomizationsEvaluations.isAnalyzing', this.pendingAnalysisUris.size > 0);
    }

    private updateHasDiagnosticsContext(): void {
        const editor = vscode.window.activeTextEditor;
        const hasDiagnostics = editor ? this.urisWithDiagnostics.has(editor.document.uri.toString()) : false;
        void vscode.commands.executeCommand('setContext', 'chatCustomizationsEvaluations.hasDiagnostics', hasDiagnostics);
    }

    private computeAnalysisFingerprint(document: vscode.TextDocument, customDiagnostics?: CustomDiagnosticConfig[]): string {
        return createHash('sha256')
            .update(document.getText())
            .update('\0')
            .update(JSON.stringify(customDiagnostics ?? []))
            .digest('hex');
    }

    private async notifyAndFocusProblems(uri: vscode.Uri, resultCount: number, filename: string, durationSuffix = ''): Promise<void> {
        const message = `Analysis of ${filename} complete${durationSuffix}: ${this.formatIssueSummary(resultCount)}.`;
        const diagnostics = this.getDiagnosticsForUri(uri)
            .slice()
            .sort((a, b) => {
                if (a.range.start.line !== b.range.start.line) {
                    return a.range.start.line - b.range.start.line;
                }
                return a.range.start.character - b.range.start.character;
            });
        const hasNonFixableDiagnostics = diagnostics.some(diagnostic => this.isNonFixableDiagnosticForEntry(diagnostic));

        void (async () => {
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
}