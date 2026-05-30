import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import {
    ACTION_ANALYZE_AGAIN,
    ACTION_FIX_DIAGNOSTICS, ACTION_SHOW_PROBLEMS
} from './strings';
import type {
    AnalysisSnapshot,
    AnalysisState, CustomDiagnosticConfig
} from './extensionTypes';

const STATUS_BAR_COMPLETION_DURATION_MS = 5000;


export class AnalysisCoordinator {

    constructor(
        private readonly getDiagnosticsForUri: (uri: vscode.Uri) => vscode.Diagnostic[],
        private readonly isNonFixableDiagnosticForEntry: (diagnostic: vscode.Diagnostic) => boolean,
    ) { }

    private readonly urisWithDiagnostics = new Set<string>();
    private readonly pendingAnalysisUris = new Set<string>();
    private readonly analysisStatesByUri = new Map<string, AnalysisState>();
    private readonly analysisSnapshotsByUri = new Map<string, AnalysisSnapshot>();
    private statusBarItem: vscode.StatusBarItem | undefined;
    private statusBarCompletionMessage: string | undefined;
    private statusBarCompletionTimer: ReturnType<typeof setTimeout> | undefined;

    initialize(context: vscode.ExtensionContext): void {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
        this.statusBarItem.name = 'Chat Customizations Evaluations Analysis Status';
        context.subscriptions.push(this.statusBarItem);
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
            this.updateAnalysisStatusBar();
            this.updateHasDiagnosticsContext();
        }));
    }

    dispose(): void {
        if (this.statusBarCompletionTimer) {
            clearTimeout(this.statusBarCompletionTimer);
            this.statusBarCompletionTimer = undefined;
        }
    }

    isAnalysisPending(uri: vscode.Uri): boolean {
        return this.pendingAnalysisUris.has(uri.toString());
    }

    beginAnalysis(uri: string): void {
        const existingState = this.analysisStatesByUri.get(uri);
        if (existingState?.resolveProgress) {
            existingState.resolveProgress();
        }

        this.pendingAnalysisUris.add(uri);
        this.analysisStatesByUri.set(uri, {
            startedAt: Date.now(),
            stage: 'Starting analysis...',
            llmRequestsInFlight: 0,
        });
        this.updateIsAnalyzingContext();
        this.startProgressNotification(uri);
        this.updateAnalysisStatusBar();
    }

    markAnalysisStage(stage: string): void {
        if (this.analysisStatesByUri.size === 0) {
            return;
        }

        for (const [uri, state] of this.analysisStatesByUri.entries()) {
            state.stage = stage;
            this.updateProgressNotificationMessage(uri);
        }
        this.updateAnalysisStatusBar();
    }

    markAnalysisStageWithRequestCount(stage: string): void {
        if (this.analysisStatesByUri.size === 0) {
            return;
        }

        for (const [uri, state] of this.analysisStatesByUri.entries()) {
            const requestScope = state.llmRequestsInFlight > 1
                ? ` (${state.llmRequestsInFlight} requests in flight)`
                : '';
            state.stage = `${stage}${requestScope}`;
            this.updateProgressNotificationMessage(uri);
        }
        this.updateAnalysisStatusBar();
    }

    markLLMRequestStart(): void {
        if (this.analysisStatesByUri.size === 0) {
            return;
        }

        for (const [uri, state] of this.analysisStatesByUri.entries()) {
            state.llmRequestsInFlight += 1;
            const requestCount = state.llmRequestsInFlight;
            state.stage = requestCount > 1
                ? `Connecting to Copilot... (${requestCount} requests in flight)`
                : 'Connecting to Copilot...';
            this.updateProgressNotificationMessage(uri);
        }
        this.updateAnalysisStatusBar();
    }

    markLLMRequestDone(): void {
        if (this.analysisStatesByUri.size === 0) {
            return;
        }

        for (const [uri, state] of this.analysisStatesByUri.entries()) {
            state.llmRequestsInFlight = Math.max(0, state.llmRequestsInFlight - 1);
            state.stage = state.llmRequestsInFlight > 0
                ? 'Waiting for Copilot responses...'
                : 'Finalizing diagnostics...';
            this.updateProgressNotificationMessage(uri);
        }
        this.updateAnalysisStatusBar();
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

            if (this.pendingAnalysisUris.has(uriKey)) {
                this.markDiagnosticsFound(uri, diagnostics.length);
            }
        }

        this.updateHasDiagnosticsContext();
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
        const state = this.analysisStatesByUri.get(uriKey);
        if (state?.resolveProgress) {
            state.resolveProgress();
        }
        this.pendingAnalysisUris.delete(uriKey);
        this.analysisStatesByUri.delete(uriKey);
        this.updateIsAnalyzingContext();

        const issueCount = result.resultCount;
        this.statusBarCompletionMessage = issueCount > 0
            ? `$(check) ${this.formatIssueSummary(issueCount)}`
            : '$(check) No issues';
        if (this.statusBarCompletionTimer) {
            clearTimeout(this.statusBarCompletionTimer);
        }
        this.statusBarCompletionTimer = setTimeout(() => {
            this.statusBarCompletionMessage = undefined;
            this.statusBarCompletionTimer = undefined;
            this.updateAnalysisStatusBar();
        }, STATUS_BAR_COMPLETION_DURATION_MS);
        this.updateAnalysisStatusBar();

        const filename = path.basename(uri.fsPath);
        const durationText = state ? ` in ${this.formatDurationMs(result.duration)}` : '';
        if (result.resultCount === 0) {
            void vscode.window.showInformationMessage(`Analysis of ${filename} complete${durationText}: no issues found.`);
            return;
        }

        await this.notifyAndFocusProblems(uri, result.resultCount, filename, durationText);
    }

    private formatIssueSummary(count: number): string {
        return count === 1 ? '1 issue found' : `${count} issues found`;
    }

    private formatDurationMs(durationMs: number): string {
        const seconds = Math.max(1, Math.round(durationMs / 1000));
        return `${seconds}s`;
    }

    private updateAnalysisStatusBar(): void {
        if (!this.statusBarItem) {
            return;
        }

        const runningCount = this.analysisStatesByUri.size;
        if (runningCount === 0) {
            if (this.statusBarCompletionMessage) {
                this.statusBarItem.text = this.statusBarCompletionMessage;
                this.statusBarItem.command = 'workbench.actions.view.problems';
                this.statusBarItem.tooltip = 'Click to open Problems panel';
                this.statusBarItem.show();
            } else {
                this.statusBarItem.command = undefined;
                this.statusBarItem.hide();
            }
            return;
        }

        const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
        const activeState = activeUri ? this.analysisStatesByUri.get(activeUri) : undefined;
        const fallbackState = activeState ?? this.analysisStatesByUri.values().next().value as AnalysisState;
        const scope = runningCount > 1 ? ` (${runningCount} files)` : '';

        this.statusBarItem.text = `$(sync~spin) Analyze: ${fallbackState.stage}${scope}`;
        this.statusBarItem.command = undefined;
        this.statusBarItem.tooltip = 'Chat Customizations Evaluations analysis in progress';
        this.statusBarItem.show();
    }

    private updateIsAnalyzingContext(): void {
        void vscode.commands.executeCommand('setContext', 'chatCustomizationsEvaluations.isAnalyzing', this.pendingAnalysisUris.size > 0);
    }

    private updateHasDiagnosticsContext(): void {
        const editor = vscode.window.activeTextEditor;
        const hasDiagnostics = editor ? this.urisWithDiagnostics.has(editor.document.uri.toString()) : false;
        void vscode.commands.executeCommand('setContext', 'chatCustomizationsEvaluations.hasDiagnostics', hasDiagnostics);
    }

    private updateProgressNotificationMessage(uri: string): void {
        const state = this.analysisStatesByUri.get(uri);
        if (!state?.progressReporter) {
            return;
        }

        state.progressReporter.report({ message: state.stage });
    }

    private startProgressNotification(uri: string): void {
        const state = this.analysisStatesByUri.get(uri);
        if (!state) {
            return;
        }

        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Running prompt analysis',
                cancellable: false,
            },
            async (progress) => {
                const currentState = this.analysisStatesByUri.get(uri);
                if (!currentState) {
                    return;
                }

                currentState.progressReporter = progress;
                progress.report({ message: currentState.stage });

                await new Promise<void>((resolve) => {
                    currentState.resolveProgress = resolve;
                });
            }
        );
    }

    private markDiagnosticsFound(uri: vscode.Uri, count: number): void {
        const uriKey = uri.toString();
        const state = this.analysisStatesByUri.get(uriKey);
        if (!state) {
            return;
        }

        state.stage = `Collecting results: ${this.formatIssueSummary(count)}`;
        this.updateProgressNotificationMessage(uriKey);
        this.updateAnalysisStatusBar();
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
                ? [ACTION_SHOW_PROBLEMS, ACTION_ANALYZE_AGAIN]
                : [ACTION_SHOW_PROBLEMS, ACTION_FIX_DIAGNOSTICS];
            const action = await vscode.window.showInformationMessage(message, ...actions);
            if (action === ACTION_SHOW_PROBLEMS) {
                await vscode.commands.executeCommand('workbench.actions.view.problems');
            } else if (action === ACTION_ANALYZE_AGAIN) {
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
}