import * as vscode from 'vscode';
import { NON_FIXABLE_DIAGNOSTIC_CODES } from './strings';

interface DiagnosticEdit {
  ranges: vscode.Range[];
}

export class DiagnosticsManager {

  private readonly diagnosticCollection: vscode.DiagnosticCollection;
  private readonly pendingDiagnosticEditsByUri = new Map<string, DiagnosticEdit>();
  private readonly nonFixableDiagnosticCodeSet: Set<string>;

  private static collectionName = 'chat-customizations-evaluations-client';

  constructor(context: vscode.ExtensionContext) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection(DiagnosticsManager.collectionName);
    this.nonFixableDiagnosticCodeSet = new Set(NON_FIXABLE_DIAGNOSTIC_CODES);
    context.subscriptions.push(this.diagnosticCollection);
  }

  handleLanguageClientDiagnostics(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]): void {
    const uriKey = uri.toString();
    const pendingEdit = this.pendingDiagnosticEditsByUri.get(uriKey);
    const filteredDiagnostics = pendingEdit
      ? this.filterDiagnosticsForEdit(diagnostics, pendingEdit)
      : diagnostics;

    this.pendingDiagnosticEditsByUri.delete(uriKey);
    this.diagnosticCollection.set(uri, filteredDiagnostics);
  }

  handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    if (event.contentChanges.length === 0) {
      return;
    }

    const uri = event.document.uri;
    const uriKey = uri.toString();
    const currentEdit = this.pendingDiagnosticEditsByUri.get(uriKey) ?? { fullDocument: false, ranges: [] };
    const nextEdit = this.mergeDiagnosticEdit(currentEdit, event.contentChanges);
    this.pendingDiagnosticEditsByUri.set(uriKey, nextEdit);

    const existingDiagnostics = this.diagnosticCollection.get(uri) ?? [];
    if (existingDiagnostics.length === 0) {
      return;
    }

    const filteredDiagnostics = this.filterDiagnosticsForEdit(existingDiagnostics, nextEdit);
    if (filteredDiagnostics.length === existingDiagnostics.length) {
      return
    }
    this.diagnosticCollection.set(uri, filteredDiagnostics);
  }

  handleDocumentClosed(uri: vscode.Uri): void {
    const uriKey = uri.toString();
    this.pendingDiagnosticEditsByUri.delete(uriKey);
    this.diagnosticCollection.delete(uri);
  }

  clearDiagnosticsForUri(uri: vscode.Uri): void {
    this.diagnosticCollection.set(uri, []);
  }

  getDiagnosticsForUri(uri: vscode.Uri): vscode.Diagnostic[] {
    const fromCollection = this.diagnosticCollection.get(uri) ?? [];
    if (fromCollection.length > 0) {
      return fromCollection.filter(diagnostic => diagnostic.source?.startsWith('chat-customizations-evaluations'));
    }

    return vscode.languages.getDiagnostics(uri).filter(diagnostic => diagnostic.source?.startsWith('chat-customizations-evaluations'));
  }

  hasErrorDiagnostics(diagnostic: vscode.Diagnostic): boolean {
    return this.nonFixableDiagnosticCodeSet.has(this.diagnosticCodeToString(diagnostic.code));
  }

  rangesOverlap(left: vscode.Range, right: vscode.Range): boolean {
    return this.comparePosition(left.start, right.end) <= 0
      && this.comparePosition(right.start, left.end) <= 0;
  }

  private mergeDiagnosticEdit(
    existing: DiagnosticEdit,
    contentChanges: readonly vscode.TextDocumentContentChangeEvent[],
  ): DiagnosticEdit {
    const hasFullDocumentEdit = contentChanges.some(change => !change.range);
    if (hasFullDocumentEdit) {
      return { ranges: [] };
    }

    const nextRanges = existing.ranges.slice();
    for (const change of contentChanges) {
      if (change.range) {
        nextRanges.push(change.range);
      }
    }

    return {
      ranges: nextRanges,
    };
  }

  private filterDiagnosticsForEdit(
    diagnostics: readonly vscode.Diagnostic[],
    edit: DiagnosticEdit,
  ): vscode.Diagnostic[] {
    if (edit.ranges.length === 0) {
      return diagnostics.slice();
    }

    return diagnostics.filter((diagnostic) => {
      return !edit.ranges.some((range) => this.rangesOverlap(diagnostic.range, range));
    });
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
