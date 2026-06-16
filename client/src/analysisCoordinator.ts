import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import {
    ACTION_ANALYZE_AGAIN,
    ACTION_FIX_DIAGNOSTICS
} from './strings';
import type {
    AnalysisSnapshot, CustomDiagnosticConfig
} from './types';

export class AnalysisCoordinator {

    constructor(
        private readonly getDiagnosticsForUri: (uri: vscode.Uri) => vscode.Diagnostic[],
        private readonly isNonFixableDiagnosticForEntry: (diagnostic: vscode.Diagnostic) => boolean,
    ) { }

    private readonly urisWithDiagnostics = new Set<string>();
    private readonly pendingAnalysisUris = new Set<string>();
    private readonly analysisSnapshotsByUri = new Map<string, AnalysisSnapshot>();

    initialize(context: vscode.ExtensionContext): void {
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
            this.updateHasDiagnosticsContext();
        }));
    }

    dispose(): void {
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

    private formatDurationMs(durationMs: number): string {
        const seconds = Math.max(1, Math.round(durationMs / 1000));
        return `${seconds}s`;
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