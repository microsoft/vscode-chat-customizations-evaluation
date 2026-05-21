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
  const customDiagnosticsCount = customDiagnostics?.length ?? 0;

  const startTime = Date.now();
  connection.console.log(
    `[Analysis] Starting full analysis for ${uri} (customDiagnostics=${customDiagnosticsCount})`,
  );

  connection.console.log(`[Analysis] Running LLM analyzer for ${uri}`);
  const llmResults = await llmAnalyzer.analyze(textDocument, customDiagnostics);
  connection.console.log(`[Analysis] LLM analyzer completed for ${uri} with ${llmResults.length} results`);

  connection.console.log(`[Analysis] Converting results to diagnostics for ${uri}`);
  const diagnostics = resultsToDiagnostics(llmResults);
  connection.console.log(`[Analysis] Sending diagnostics for ${uri}`);
  await connection.sendDiagnostics({ uri, diagnostics });
  // Allow one stale-content notification on the next edit after analysis completes.
  staleNotificationEligibleUris.add(uri);
  const duration = Date.now() - startTime;
  connection.console.log(
    `[Analysis] Completed full analysis for ${uri} in ${duration}ms with ${diagnostics.length} diagnostics`,
  );
  return { duration, resultCount: diagnostics.length };
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

connection.onRequest('chatCustomizationsEvaluations/analyze', async (params: {
  uri: string;
  customDiagnostics?: CustomDiagnosticConfig[];
}) => {
  const customDiagnosticsCount = params.customDiagnostics?.length ?? 0;
  const document = documents.get(params.uri);

  connection.console.log(
    `[Analysis] Received analyze request for ${params.uri} (customDiagnostics=${customDiagnosticsCount})`,
  );

  if (!document) {
    connection.console.warn(`[Analysis] No open document found for ${params.uri}; skipping analysis`);
    return { duration: 0, resultCount: 0 };
  }

  connection.console.log(`[Analysis] Found document for ${params.uri}; starting request analysis`);

  try {
    const result = await runFullAnalysis(document, params.customDiagnostics);
    connection.console.log(
      `[Analysis] Analyze request finished for ${params.uri} (duration=${result.duration}ms, diagnostics=${result.resultCount})`,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    connection.console.error(`[Analysis] Analyze request failed for ${params.uri}: ${message}`);
    if (stack) {
      connection.console.error(`[Analysis] Stack for ${params.uri}: ${stack}`);
    }
    return { duration: 0, resultCount: 0 };
  }
});

documents.listen(connection);

connection.listen();
