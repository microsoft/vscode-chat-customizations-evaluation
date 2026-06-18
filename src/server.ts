import {
  createConnection,
  TextDocuments,
  ProposedFeatures, TextDocumentSyncKind,
  InitializeResult,
  DiagnosticSeverity,
  Diagnostic
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { LLMAnalyzer } from './analyzers/llm';
import {
  LLMProxyRequest,
  LLMProxyResponse,
  CustomDiagnosticConfig,
  AnalysisResult
} from './types';

class ChatCustomizationsEvaluationServer {

  private readonly connection = createConnection(ProposedFeatures.all);
  private readonly documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
  private readonly llmAnalyzer = new LLMAnalyzer();

  constructor() {
    this.registerHandlers();
  }

  public start(): void {
    this.documents.listen(this.connection);
    this.connection.listen();
  }

  private registerHandlers(): void {
    this.connection.onInitialize(() => {
      const result: InitializeResult = {
        capabilities: {
          textDocumentSync: {
            openClose: true,
            change: TextDocumentSyncKind.Incremental,
          },
          workspace: {
            workspaceFolders: { supported: true },
          },
        },
      };
      return result;
    });

    this.connection.onInitialized(() => {
      this.connection.console.log('Chat Customizations Evaluations initialized');
      this.llmAnalyzer.setProxyFn(async (request: LLMProxyRequest): Promise<LLMProxyResponse> => {
        try {
          return this.connection.sendRequest<LLMProxyResponse>('chatCustomizationsEvaluations/llmRequest', request);
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Proxy request failed';
          return { text: '', error: msg };
        }
      });
    });

    this.connection.onRequest('chatCustomizationsEvaluations/analyze', async (params: {
      uri: string;
      customDiagnostics?: CustomDiagnosticConfig[];
      previousDiagnosticMessages?: string[];
    }) => {
      const customDiagnosticsCount = params.customDiagnostics?.length ?? 0;
      const document = this.documents.get(params.uri);

      this.connection.console.log(`[Analysis] Received analyze request for ${params.uri} (customDiagnostics=${customDiagnosticsCount})`);

      if (!document) {
        this.connection.console.warn(`[Analysis] No open document found for ${params.uri}; skipping analysis`);
        return { duration: 0, resultCount: 0 };
      }

      this.connection.console.log(`[Analysis] Found document for ${params.uri}; starting request analysis`);

      try {
        const result = await this.runFullAnalysis(document, params.customDiagnostics, params.previousDiagnosticMessages);
        this.connection.console.log(`[Analysis] Analyze request finished for ${params.uri} (duration=${result.duration}ms, diagnostics=${result.resultCount})`);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        this.connection.console.error(`[Analysis] Analyze request failed for ${params.uri}: ${message}`);
        if (stack) {
          this.connection.console.error(`[Analysis] Stack for ${params.uri}: ${stack}`);
        }
        return { duration: 0, resultCount: 0 };
      }
    });
  }

  private async runFullAnalysis(
    textDocument: TextDocument,
    customDiagnostics?: CustomDiagnosticConfig[],
    previousDiagnosticMessages?: string[],
  ): Promise<{ duration: number; resultCount: number }> {
    const uri = textDocument.uri;
    const customDiagnosticsCount = customDiagnostics?.length ?? 0;

    const startTime = Date.now();
    this.connection.console.log(`[Analysis] Starting full analysis for ${uri} (customDiagnostics=${customDiagnosticsCount})`);

    this.connection.console.log(`[Analysis] Running LLM analyzer for ${uri}`);
    const llmResults = await this.llmAnalyzer.analyze(textDocument, customDiagnostics, previousDiagnosticMessages);
    this.connection.console.log(`[Analysis] LLM analyzer completed for ${uri} with ${llmResults.length} results`);

    this.connection.console.log(`[Analysis] Converting results to diagnostics for ${uri}`);
    const diagnostics = resultsToDiagnostics(llmResults);
    this.connection.console.log(`[Analysis] Sending diagnostics for ${uri}`);
    await this.connection.sendDiagnostics({ uri, diagnostics });

    const duration = Date.now() - startTime;
    this.connection.console.log(`[Analysis] Completed full analysis for ${uri} in ${duration}ms with ${diagnostics.length} diagnostics`);
    return { duration, resultCount: diagnostics.length };
  }
}

export function resultsToDiagnostics(results: AnalysisResult[]): Diagnostic[] {
  return results.map((result) => {
    return {
      severity: DiagnosticSeverity.Warning,
      range: result.range,
      message: result.message,
      source: `chat-customizations-evaluations (${result.analyzer})`,
      code: result.code,
      data: result.suggestion,
    };
  });
}

const server = new ChatCustomizationsEvaluationServer();
server.start();
