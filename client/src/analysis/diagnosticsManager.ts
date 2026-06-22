import * as vscode from 'vscode';
import { ERROR_DIAGNOSTIC_CODES } from './strings';

export class DiagnosticsManager {

  private readonly errorDiagnosticCodeSet: Set<string>;
  private readonly diagnosticCollection: vscode.DiagnosticCollection;

  private static DIAGNOSTIC_COLLECTION_NAME = 'chat-customizations-evaluations-client';

  constructor(context: vscode.ExtensionContext) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection(DiagnosticsManager.DIAGNOSTIC_COLLECTION_NAME);
    this.errorDiagnosticCodeSet = new Set(ERROR_DIAGNOSTIC_CODES);
    context.subscriptions.push(this.diagnosticCollection);
  }


  handleLanguageClientDiagnostics(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]): void {
    this.diagnosticCollection.set(uri, diagnostics);
  }

  handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    if (event.contentChanges.length === 0) {
      return;
    }
    const uri = event.document.uri;
    const diagnostics = this.diagnosticCollection.get(uri) ?? [];
    if (diagnostics.length === 0) {
      return;
    }
    const filteredDiagnostics = this.filterDiagnosticsForEdit(diagnostics, event.contentChanges);
    if (filteredDiagnostics.length === diagnostics.length) {
      return
    }
    this.diagnosticCollection.set(uri, filteredDiagnostics);
  }

  handleDocumentClosed(uri: vscode.Uri): void {
    this.diagnosticCollection.delete(uri);
  }

  clearDiagnosticsForUri(uri: vscode.Uri): void {
    this.diagnosticCollection.set(uri, []);
  }

  getDiagnosticsForUri(uri: vscode.Uri): readonly vscode.Diagnostic[] {
    return this.diagnosticCollection.get(uri) ?? [];
  }

  hasErrorDiagnostics(diagnostic: vscode.Diagnostic): boolean {
    return this.errorDiagnosticCodeSet.has(this.diagnosticCodeToString(diagnostic.code));
  }

  private filterDiagnosticsForEdit(
    diagnostics: readonly vscode.Diagnostic[],
    edits: readonly vscode.TextDocumentContentChangeEvent[],
  ): vscode.Diagnostic[] {
    if (edits.length === 0) {
      return diagnostics.slice();
    }
    return diagnostics.filter((diagnostic) => {
      return !edits.some((edit) => {
        return this.rangesOverlap(diagnostic.range, edit.range);
      });
    });
  }

  public rangesOverlap(left: vscode.Range, right: vscode.Range): boolean {
    return this.comparePosition(left.start, right.end) <= 0
      && this.comparePosition(right.start, left.end) <= 0;
  }

  private comparePosition(left: vscode.Position, right: vscode.Position): number {
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.character - right.character;
  }

  private diagnosticCodeToString(code: vscode.Diagnostic['code']): string {
    if (code === undefined) {
      return 'n/a';
    }
    if (typeof code === 'string' || typeof code === 'number') {
      return String(code);
    }
    return String(code.value);
  }
}
