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
import { AnalysisResult, LLMProxyRequest, LLMProxyResponse } from './types';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

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
async function runFullAnalysis(textDocument: TextDocument): Promise<void> {
  const uri = textDocument.uri;

  const llmResults = await llmAnalyzer.analyze(textDocument);

  const diagnostics = resultsToDiagnostics(llmResults);
  connection.sendDiagnostics({ uri, diagnostics });
  connection.console.log(`[Analysis] Sent ${diagnostics.length} diagnostics for ${uri}`);
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

connection.onNotification('chatCustomizationsEvaluations/analyze', (params: { uri: string }) => {
  const document = documents.get(params.uri);
  if (document) {
    runFullAnalysis(document);
  }
});

// Clear diagnostics when the document is modified
documents.onDidChangeContent((change) => {
  connection.sendDiagnostics({ uri: change.document.uri, diagnostics: [] });
});

documents.listen(connection);

connection.listen();
