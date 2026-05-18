import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  DiagnosticSeverity,
  Diagnostic,
  Range,
  TextDocumentContentChangeEvent,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { LLMAnalyzer } from './analyzers/llm';
import {
  AnalysisResult,
  LLMProxyRequest,
  LLMProxyResponse,
  CustomDiagnosticConfig,
} from './types';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
const staleNotificationEligibleUris = new Set<string>();
const diagnosticsByUri = new Map<string, Diagnostic[]>();

const llmAnalyzer = new LLMAnalyzer();

connection.onInitialize((_params: InitializeParams) => {
  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
      },
    },
  };

  if (_params.capabilities.workspace?.workspaceFolders) {
    result.capabilities.workspace = {
      workspaceFolders: { supported: true },
    };
  }

  return result;
});

connection.onInitialized(() => {
  connection.console.log('Chat Customizations Evaluations initialized');
  llmAnalyzer.setProxyFn(async (request: LLMProxyRequest): Promise<LLMProxyResponse> => {
    try {
      const response = await connection.sendRequest<LLMProxyResponse>('chatCustomizationsEvaluations/llmRequest', request);
      return response;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Proxy request failed';
      return { text: '{}', error: msg };
    }
  });
});

async function runFullAnalysis(
  textDocument: TextDocument,
  customDiagnostics?: CustomDiagnosticConfig[],
): Promise<{ duration: number; resultCount: number }> {
  const uri = textDocument.uri;
  const startTime = Date.now();
  const llmResults = await llmAnalyzer.analyze(textDocument, customDiagnostics);
  const diagnostics = resultsToDiagnostics(llmResults);
  diagnosticsByUri.set(uri, diagnostics);
  await connection.sendDiagnostics({ uri, diagnostics });
  staleNotificationEligibleUris.add(uri);
  connection.console.log(`[Analysis] Sent ${diagnostics.length} diagnostics for ${uri}`);
  return { duration: Date.now() - startTime, resultCount: diagnostics.length };
}

function rangesOverlap(a: Range, b: Range): boolean {
  if (a.end.line < b.start.line || b.end.line < a.start.line) {
    return false;
  }
  if (a.end.line === b.start.line && a.end.character <= b.start.character) {
    return false;
  }
  if (b.end.line === a.start.line && b.end.character <= a.start.character) {
    return false;
  }
  return true;
}

function clearDiagnosticsTouchingContentChanges(uri: string, changedRanges: Range[]): void {
  const existingDiagnostics = diagnosticsByUri.get(uri);
  if (!existingDiagnostics || existingDiagnostics.length === 0) {
    return;
  }

  const updatedDiagnostics = existingDiagnostics.filter((diagnostic) => {
    return !changedRanges.some((changedRange) => rangesOverlap(diagnostic.range, changedRange));
  });

  const removedCount = existingDiagnostics.length - updatedDiagnostics.length;
  if (removedCount > 0) {
    connection.console.log(`[ContentChange] Cleared ${removedCount} overlapping diagnostics`);
    diagnosticsByUri.set(uri, updatedDiagnostics);
    void connection.sendDiagnostics({ uri, diagnostics: updatedDiagnostics });
  }
}

export function resultsToDiagnostics(results: AnalysisResult[]): Diagnostic[] {
  return results.map((result) => {
    let severity: DiagnosticSeverity;
    switch (result.severity) {
      case 'error':
        severity = DiagnosticSeverity.Error;
        break;
      case 'warning':
        severity = DiagnosticSeverity.Warning;
        break;
      case 'info':
        severity = DiagnosticSeverity.Information;
        break;
      default:
        severity = DiagnosticSeverity.Hint;
    }
    return {
      severity,
      range: result.range,
      message: result.message,
      source: `chat-customizations-evaluations (${result.analyzer})`,
      code: result.code,
      data: result.suggestion,
    };
  });
}

documents.onDidChangeContent((change) => {
  const uri = change.document.uri;
  connection.console.log(`[ContentChange] Document changed: ${uri}`);

  if (!staleNotificationEligibleUris.has(uri)) {
    return;
  }
  staleNotificationEligibleUris.delete(uri);
  connection.console.log(`[ContentChange] Sending stale content notification for ${uri}`);

  connection.sendNotification('chatCustomizationsEvaluations/contentStale', {
    uri,
  });
});

connection.onDidChangeTextDocument((params) => {
  const uri = params.textDocument.uri;
  const changedRanges = params.contentChanges
    .filter(TextDocumentContentChangeEvent.isIncremental)
    .map((change) => change.range);
  connection.console.log(`[ContentChange] Full document change for ${uri}`);

  if (changedRanges.length === 0) {
    diagnosticsByUri.set(uri, []);
    void connection.sendDiagnostics({ uri, diagnostics: [] });
  } else {
    clearDiagnosticsTouchingContentChanges(uri, changedRanges);
  }
});

connection.onRequest('chatCustomizationsEvaluations/analyze', (params: {
  uri: string;
  customDiagnostics?: CustomDiagnosticConfig[];
}) => {
  const document = documents.get(params.uri);
  connection.console.log(`[Analysis] Received analyze request for ${params.uri}`);
  if (document) {
    return runFullAnalysis(document, params.customDiagnostics);
  }
  return { duration: 0, resultCount: 0 };
});

documents.listen(connection);

connection.listen();
