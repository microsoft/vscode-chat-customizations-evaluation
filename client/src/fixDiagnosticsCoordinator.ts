import * as vscode from 'vscode';
import { ACTION_ANALYZE_AGAIN } from './strings';
import type { SkillContext, TelemetryData } from './types';
import { handlePostFixDiagnosticsFlow } from './waza/waza';

interface FixDiagnosticsCoordinatorOptions {
  getDiagnosticsForUri: (uri: vscode.Uri) => vscode.Diagnostic[];
  isNonFixableDiagnostic: (diagnostic: vscode.Diagnostic) => boolean;
  clearDiagnosticsForUri: (uri: vscode.Uri) => void;
  resolveSkillContextForUri: (uri: vscode.Uri) => SkillContext | undefined;
  logTelemetryUsage: (eventName: string, data?: TelemetryData) => void;
}

export class FixDiagnosticsCoordinator {

  private static readonly FIX_DIAGNOSTICS_IMPROVEMENT_TIMEOUT_MS = 5 * 60_000;

  constructor(
    private readonly options: FixDiagnosticsCoordinatorOptions,
  ) { }

  async handleFixDiagnosticsCommand(scopedDiagnostics?: vscode.Diagnostic[]): Promise<void> {
    this.options.logTelemetryUsage('command/fixDiagnostics');
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.options.logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'noActiveEditor' });
      return;
    }

    const targetUri = editor.document.uri;
    const initialText = editor.document.getText();

    let fixableDiagnostics: vscode.Diagnostic[];
    if (scopedDiagnostics && scopedDiagnostics.length > 0) {
      fixableDiagnostics = scopedDiagnostics.filter(diagnostic => !this.options.isNonFixableDiagnostic(diagnostic));
    } else {
      const diagnostics = this.getSortedDiagnostics(targetUri);

      if (diagnostics.length === 0) {
        this.options.logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'noDiagnostics' });
        void vscode.window.showInformationMessage('No diagnostics found for the active file. Run Analyze first.');
        return;
      }

      fixableDiagnostics = diagnostics.filter(diagnostic => !this.options.isNonFixableDiagnostic(diagnostic));
    }
    if (await this.handleNonFixableDiagnosticsOnly(fixableDiagnostics.length)) {
      return;
    }

    await this.openFixDiagnosticsChat(editor.document, fixableDiagnostics);
    this.options.clearDiagnosticsForUri(targetUri);

    const hasImprovements = await this.waitForDocumentImprovements(
      targetUri,
      initialText,
      FixDiagnosticsCoordinator.FIX_DIAGNOSTICS_IMPROVEMENT_TIMEOUT_MS,
    );
    if (!hasImprovements) {
      this.options.logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'noChangesDetected' });
      return;
    }

    const skillContext = this.options.resolveSkillContextForUri(targetUri);
    if (!skillContext) {
      this.options.logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'noSkillContext' });
      return;
    }

    await handlePostFixDiagnosticsFlow(skillContext);
    this.options.logTelemetryUsage('command/fixDiagnostics/result', {
      outcome: 'success',
      diagnosticsCount: fixableDiagnostics.length,
    });
  }

  private getSortedDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
    return this.options.getDiagnosticsForUri(uri)
      .slice()
      .sort((a, b) => {
        if (a.range.start.line !== b.range.start.line) {
          return a.range.start.line - b.range.start.line;
        }
        return a.range.start.character - b.range.start.character;
      });
  }

  private async handleNonFixableDiagnosticsOnly(fixableDiagnosticsCount: number): Promise<boolean> {
    if (fixableDiagnosticsCount > 0) {
      return false;
    }

    this.options.logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'nonFixableDiagnosticsOnly' });
    const action = await vscode.window.showInformationMessage(
      'Implement suggestions is unavailable for LLM analysis error diagnostics. Run Analyze again.',
      ACTION_ANALYZE_AGAIN,
    );
    if (action === ACTION_ANALYZE_AGAIN) {
      await vscode.commands.executeCommand('chatCustomizationsEvaluations.analyzePrompt');
    }

    return true;
  }

  private async openFixDiagnosticsChat(document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]): Promise<void> {
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    const query = this.buildFixDiagnosticsChatQuery(document, diagnostics);
    await vscode.commands.executeCommand('workbench.action.chat.newChat');
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query,
      isPartialQuery: false,
    });
  }

  private buildFixDiagnosticsChatQuery(document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]): string {
    const payload = diagnostics.map((diagnostic) => {
      const startLine = diagnostic.range.start.line + 1;
      const endLine = diagnostic.range.end.line + 1;
      const diagnosticWithData = diagnostic as vscode.Diagnostic & { data?: unknown };
      const message = String(diagnostic.message ?? '').trim();
      const rawSuggestion = typeof diagnosticWithData.data === 'string' ? diagnosticWithData.data : undefined;
      const suggestion = rawSuggestion?.trim();
      const shouldIncludeSuggestion = Boolean(suggestion) && suggestion !== message;
      const lineText = diagnostic.range.start.line >= 0 && diagnostic.range.start.line < document.lineCount
        ? document.lineAt(diagnostic.range.start.line).text
        : 'n/a';
      return [
        ` - line: ${startLine}${endLine !== startLine ? `-${endLine}` : ''}`,
        ` - lineText: ${lineText}`,
        ` - message: ${message || 'n/a'}`,
        ...(shouldIncludeSuggestion ? [`  suggestion: ${suggestion}`] : []),
        `\n`
      ].join('\n');
    }).join('\n');

    return [
      '/fix-customization-evaluation-diagnostics',
      `Target file: ${document.uri.fsPath}`,
      'Use ONLY the diagnostics below for this target file. Do not lint or rewrite the skill file itself.',
      'Field meanings:',
      '- line: 1-based line number where the diagnostic starts (or start-end for a multi-line range).',
      '- lineText: exact text currently present at the diagnostic start line in the target file.',
      '- message: diagnostic description explaining what is wrong and needs to be fixed.',
      'Diagnostics:',
      payload,
    ].join('\n\n');
  }

  private waitForDocumentImprovements(uri: vscode.Uri, initialText: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;

      const dispose = vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== uri.toString()) {
          return;
        }
        if (event.document.getText() === initialText) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        dispose.dispose();
        resolve(true);
      });

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        dispose.dispose();
        resolve(false);
      }, timeoutMs);
    });
  }
}
