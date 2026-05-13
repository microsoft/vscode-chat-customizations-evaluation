import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  DiagnosticSeverity,
  Diagnostic,
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
  // Set up LLM proxy: server sends requests to client, client calls vscode.lm
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

// Analysis is triggered manually via the command / status bar button only.
async function runFullAnalysis(
  textDocument: TextDocument,
  customDiagnostics?: CustomDiagnosticConfig[],
): Promise<{ duration: number; resultCount: number }> {
  const uri = textDocument.uri;

  const startTime = Date.now();
  const llmResults = await llmAnalyzer.analyze(textDocument, customDiagnostics);

  const diagnostics = resultsToDiagnostics(llmResults);
  await connection.sendDiagnostics({ uri, diagnostics });
  // Allow one stale-content notification on the next edit after analysis completes.
  staleNotificationEligibleUris.add(uri);
  connection.console.log(`[Analysis] Sent ${diagnostics.length} diagnostics for ${uri}`);
  return { duration: Date.now() - startTime, resultCount: diagnostics.length };
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
  if (!staleNotificationEligibleUris.has(uri)) {
    return;
  }
  staleNotificationEligibleUris.delete(uri);
  // Send a custom notification to the client to show a popup dialog
  connection.sendNotification('chatCustomizationsEvaluations/contentStale', {
    uri,
  });
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
