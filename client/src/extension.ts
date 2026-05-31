import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
  RequestType,
} from 'vscode-languageclient/node';
import {
  handlePostFixDiagnosticsFlow,
  initializeWaza,
  registerWazaCommands,
} from './waza/waza';
import {
  ACTION_ANALYZE_AGAIN, NON_FIXABLE_DIAGNOSTIC_CODES,
  TELEMETRY_AUTH_TOKEN_ENV,
  TELEMETRY_ENDPOINT_ENV
} from './strings';
import type {
  AnalyzeRequest, CustomDiagnosticConfig, LLMProxyRequest,
  LLMProxyResponse,
  SkillContext,
  TelemetryData
} from './types';
import { AnalysisCoordinator } from './analysisCoordinator';
import { ExtensionTelemetrySender } from './telemetry';

const LLMRequestType = new RequestType<LLMProxyRequest, LLMProxyResponse, void>('chatCustomizationsEvaluations/llmRequest');
const NON_FIXABLE_DIAGNOSTIC_CODE_SET = new Set<string>(NON_FIXABLE_DIAGNOSTIC_CODES);
type AnalysisSnapshot = Awaited<ReturnType<AnalysisCoordinator['getCurrentAnalysisSnapshot']>>;

class ExtensionRuntime {

  private static readonly LLM_REQUEST_TIMEOUT_MS = 30_000;
  private static readonly WAZA_CREATE_TIMEOUT_MS = 30_000;
  private static readonly FIX_DIAGNOSTICS_IMPROVEMENT_TIMEOUT_MS = 5 * 60_000;

  private client: LanguageClient | undefined;
  private outputChannel!: vscode.OutputChannel;
  private cachedModel: vscode.LanguageModelChat | undefined;
  private modelSelectionPromise: Promise<vscode.LanguageModelChat | undefined> | undefined;
  private extensionContext!: vscode.ExtensionContext;
  private telemetryLogger: vscode.TelemetryLogger | undefined;
  private analysisCoordinator!: AnalysisCoordinator;
  private extensionDiagnosticCollection!: vscode.DiagnosticCollection;
  private readonly pendingDiagnosticEditsByUri = new Map<string, { fullDocument: boolean; ranges: vscode.Range[] }>();

  activate(context: vscode.ExtensionContext): void {
    this.initializeCoreServices(context);
    this.initializeWazaRuntime();

    const serverOptions = this.createServerOptions(context);
    const clientOptions = this.createClientOptions();
    this.client = new LanguageClient(
      'chatCustomizationsEvaluations',
      'Chat Customizations Evaluations',
      serverOptions,
      clientOptions
    );

    this.registerLanguageClientHandlers();
    this.registerCommands(context);
    context.subscriptions.push(...registerWazaCommands(context));
    this.registerWorkspaceHandlers(context);
    this.registerModelHandlers(context);
    this.startLanguageClient();

    console.log('Chat Customizations Evaluations extension activated');
  }

  deactivate(): Thenable<void> | undefined {
    this.analysisCoordinator?.dispose();
    this.logTelemetryUsage('extension/deactivate');
    this.telemetryLogger?.dispose();
    if (!this.client) {
      return undefined;
    }
    return this.client.stop();
  }

  private initializeCoreServices(context: vscode.ExtensionContext): void {
    this.extensionContext = context;
    this.outputChannel = vscode.window.createOutputChannel('Chat Customizations Evaluations');
    this.extensionDiagnosticCollection = vscode.languages.createDiagnosticCollection('chat-customizations-evaluations-client');
    context.subscriptions.push(this.extensionDiagnosticCollection);

    this.analysisCoordinator = new AnalysisCoordinator(
      (uri) => this.getExtensionDiagnostics(uri),
      (diagnostic) => this.isNonFixableDiagnostic(diagnostic),
    );
    this.analysisCoordinator.initialize(context);

    this.telemetryLogger = this.createExtensionTelemetryLogger(context);
    context.subscriptions.push(this.telemetryLogger);
    this.logTelemetryUsage('extension/activate', { workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0 });
  }

  private initializeWazaRuntime(): void {
    initializeWaza({
      extensionContext: this.extensionContext,
      outputChannel: this.outputChannel,
      getCustomizationUri: (obj) => this.getCustomizationUri(obj),
      logTelemetryUsage: (eventName, data) => this.logTelemetryUsage(eventName, data),
      logTelemetryError: (eventName, error, data) => this.logTelemetryError(eventName, error, data),
    });
  }

  private createServerOptions(context: vscode.ExtensionContext): ServerOptions {
    this.outputChannel.appendLine(`[Activation] Extension path: ${context.extensionPath}`);
    const serverModule = this.resolveServerModulePath(context);

    const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };
    return {
      run: { module: serverModule, transport: TransportKind.ipc },
      debug: {
        module: serverModule,
        transport: TransportKind.ipc,
        options: debugOptions,
      },
    };
  }

  private resolveServerModulePath(context: vscode.ExtensionContext): string {
    const bundledServer = context.asAbsolutePath(path.join('out', 'server.js'));
    const devServer = context.asAbsolutePath(path.join('..', 'out', 'server.js'));
    const serverModule = fs.existsSync(bundledServer) ? bundledServer : devServer;
    this.outputChannel.appendLine(`[Activation] Server module: ${serverModule} (exists: ${fs.existsSync(serverModule)})`);
    return serverModule;
  }

  private createClientOptions(): LanguageClientOptions {
    return {
      documentSelector: [
        { scheme: 'file', language: 'prompt' },
        { scheme: 'file', language: 'chatagent' },
        { scheme: 'file', language: 'skill' },
        { scheme: 'file', language: 'instructions' },
        { scheme: 'file', language: 'markdown', pattern: '**/AGENTS.md' },
      ],
      synchronize: {
        fileEvents: [
          vscode.workspace.createFileSystemWatcher('**/*{prompt.md, agent.md, instructions.md, SKILL.md, AGENTS.md}')
        ],
      },
      middleware: {
        handleDiagnostics: (uri, diagnostics, next) => {
          this.handleLanguageClientDiagnostics(uri, diagnostics);

          // Prevent duplicate display by routing diagnostics through the client-owned collection.
          next(uri, []);
        },
      },
      outputChannel: this.outputChannel,
    };
  }

  private handleLanguageClientDiagnostics(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]): void {
    const uriKey = uri.toString();
    const pendingEdit = this.pendingDiagnosticEditsByUri.get(uriKey);
    const filteredDiagnostics = pendingEdit
      ? this.filterDiagnosticsForEdit(diagnostics, pendingEdit)
      : diagnostics;

    this.pendingDiagnosticEditsByUri.delete(uriKey);
    this.extensionDiagnosticCollection.set(uri, filteredDiagnostics);
  }

  private registerLanguageClientHandlers(): void {
    if (!this.client) {
      return;
    }

    this.client.onNotification('chatCustomizationsEvaluations/contentStale', (_params: { uri: string }) => {
      this.logTelemetryUsage('analysis/contentStaleNotificationShown');
      void vscode.window.showInformationMessage('Content is stale. Run Analyze to update diagnostics.');
    });

    this.client.onRequest(LLMRequestType, async (request: LLMProxyRequest): Promise<LLMProxyResponse> => {
      this.analysisCoordinator?.markLLMRequestStart(request.uri);
      this.outputChannel.appendLine('[LLM Proxy] Received request from server');
      try {
        const result = await this.handleLLMProxyRequest(request);
        if (result.error) {
          this.outputChannel.appendLine(`[LLM Proxy] Error: ${result.error}`);
        } else {
          this.outputChannel.appendLine(`[LLM Proxy] Success (${result.text.length} chars)`);
        }
        return result;
      } finally {
        this.analysisCoordinator?.markLLMRequestDone(request.uri);
      }
    });
  }

  private registerWorkspaceHandlers(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.languages.onDidChangeDiagnostics((e) => {
        this.analysisCoordinator?.handleDiagnosticsChanged(e.uris);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.handleDocumentChangeForDiagnostics(event);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const uriKey = document.uri.toString();
        this.pendingDiagnosticEditsByUri.delete(uriKey);
        this.extensionDiagnosticCollection.delete(document.uri);
      }),
    );
  }

  private registerModelHandlers(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.lm.onDidChangeChatModels(() => {
        this.outputChannel.appendLine('[LLM Proxy] Models changed, clearing cache');
        this.cachedModel = undefined;
        this.modelSelectionPromise = undefined;
      })
    );
  }

  private startLanguageClient(): void {
    this.client?.start().then(() => {
      this.outputChannel.appendLine('[Activation] Language server started successfully');
      this.logTelemetryUsage('extension/languageServerStart', { outcome: 'success' });
    }).catch((err: Error) => {
      this.outputChannel.appendLine(`[Activation] Language server failed to start: ${err.message}`);
      this.logTelemetryError('extension/languageServerStart', err, { outcome: 'failed' });
      this.outputChannel.show(true);
    });
  }

  private createExtensionTelemetryLogger(context: vscode.ExtensionContext): vscode.TelemetryLogger {
    const endpoint = process.env[TELEMETRY_ENDPOINT_ENV];
    const authToken = process.env[TELEMETRY_AUTH_TOKEN_ENV];
    if (!endpoint) {
      this.outputChannel.appendLine(
        `[Telemetry] ${TELEMETRY_ENDPOINT_ENV} is not set; telemetry events will be collected by VS Code but not exported by this extension sender.`
      );
    }
    const extensionVersion = String(context.extension.packageJSON.version ?? 'unknown');
    const sender = new ExtensionTelemetrySender(endpoint, authToken, extensionVersion, this.outputChannel);
    return vscode.env.createTelemetryLogger(sender, {
      additionalCommonProperties: {
        extensionVersion,
      },
    });
  }

  private logTelemetryUsage(eventName: string, data?: TelemetryData): void {
    this.telemetryLogger?.logUsage(eventName, data);
  }

  private logTelemetryError(eventName: string, error: unknown, data?: TelemetryData): void {
    this.telemetryLogger?.logError(eventName, {
      ...data,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  private isUriLike(value: unknown): value is vscode.Uri {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as {
      scheme?: unknown;
      path?: unknown;
      toString?: unknown;
    };

    return (
      typeof candidate.scheme === 'string'
      && typeof candidate.path === 'string'
      && typeof candidate.toString === 'function'
    );
  }

  private toUri(value: unknown): vscode.Uri | undefined {
    if (!value) {
      return undefined;
    }

    if (this.isUriLike(value)) {
      return value;
    }

    if (typeof value === 'string') {
      try {
        return vscode.Uri.parse(value);
      } catch {
        return undefined;
      }
    }

    if (typeof value === 'object') {
      const candidate = value as {
        scheme?: unknown;
        path?: unknown;
        authority?: unknown;
        query?: unknown;
        fragment?: unknown;
      };
      if (typeof candidate.scheme === 'string' && typeof candidate.path === 'string') {
        return vscode.Uri.from({
          scheme: candidate.scheme,
          path: candidate.path,
          authority: typeof candidate.authority === 'string' ? candidate.authority : '',
          query: typeof candidate.query === 'string' ? candidate.query : '',
          fragment: typeof candidate.fragment === 'string' ? candidate.fragment : '',
        });
      }
    }

    return undefined;
  }

  private getCustomizationUri(obj: unknown): vscode.Uri | undefined {
    if (!obj || typeof obj !== 'object') {
      return undefined;
    }

    const arg = obj as {
      uri?: unknown;
      resourceUri?: unknown;
      item?: {
        uri?: unknown;
        resourceUri?: unknown;
      };
    };

    return (
      this.toUri(arg.uri)
      ?? this.toUri(arg.resourceUri)
      ?? this.toUri(arg.item?.uri)
      ?? this.toUri(arg.item?.resourceUri)
    );
  }

  private registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('chatCustomizationsEvaluations.analyzePrompt', async () => this.handleAnalyzePromptCommand()),
      vscode.commands.registerCommand('chatCustomizationsEvaluations.fixDiagnostics', async () => this.handleFixDiagnosticsCommand()),
      vscode.commands.registerCommand('chatCustomizationsEvaluations.analyzePromptFromCustomization', async (obj) => this.handleAnalyzePromptFromCustomizationCommand(obj)),
    );
  }

  private async handleAnalyzePromptCommand(): Promise<void> {
    this.logTelemetryUsage('command/analyzePrompt', { source: 'activeEditor' });
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.logTelemetryUsage('command/analyzePrompt/result', { outcome: 'noActiveEditor' });
      return;
    }
    if (this.analysisCoordinator?.isAnalysisPending(editor.document.uri)) {
      this.logTelemetryUsage('command/analyzePrompt/result', { outcome: 'alreadyRunning' });
      return;
    }

    await this.runAnalyzeWorkflow({
      uri: editor.document.uri,
      resultEventName: 'command/analyzePrompt/result',
      revealDocumentAfterSuccess: false,
    });
  }

  private async handleFixDiagnosticsCommand(): Promise<void> {
    this.logTelemetryUsage('command/fixDiagnostics');
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'noActiveEditor' });
      return;
    }

    const targetUri = editor.document.uri;
    const initialText = editor.document.getText();
    const diagnostics = this.getSortedExtensionDiagnostics(targetUri);

    if (diagnostics.length === 0) {
      this.logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'noDiagnostics' });
      void vscode.window.showInformationMessage('No diagnostics found for the active file. Run Analyze first.');
      return;
    }

    const fixableDiagnostics = diagnostics.filter(diagnostic => !this.isNonFixableDiagnostic(diagnostic));
    if (await this.handleNonFixableDiagnosticsOnly(fixableDiagnostics.length)) {
      return;
    }

    await this.openFixDiagnosticsChat(editor.document, fixableDiagnostics);

    const hasImprovements = await this.waitForDocumentImprovements(
      targetUri,
      initialText,
      ExtensionRuntime.FIX_DIAGNOSTICS_IMPROVEMENT_TIMEOUT_MS,
    );
    if (!hasImprovements) {
      this.logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'noChangesDetected' });
      return;
    }

    const skillContext = this.resolveSkillContext({ uri: targetUri });
    if (!skillContext) {
      this.logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'noSkillContext' });
      return;
    }

    await handlePostFixDiagnosticsFlow(skillContext);
    this.logTelemetryUsage('command/fixDiagnostics/result', {
      outcome: 'success',
      diagnosticsCount: fixableDiagnostics.length,
    });
  }

  private async handleAnalyzePromptFromCustomizationCommand(obj: unknown): Promise<void> {
    this.logTelemetryUsage('command/analyzePromptFromCustomization');
    this.outputChannel.appendLine(`customization obj : ${JSON.stringify(obj)}`);
    const uri = this.getCustomizationUri(obj);
    if (!uri) {
      this.outputChannel.appendLine('[Analyze Prompt From Customization] Missing URI in command arguments');
      this.logTelemetryUsage('command/analyzePromptFromCustomization/result', { outcome: 'missingUri' });
      void vscode.window.showWarningMessage('Unable to analyze prompt: no URI was provided by the customization item.');
      return;
    }

    await this.runAnalyzeWorkflow({
      uri,
      resultEventName: 'command/analyzePromptFromCustomization/result',
      revealDocumentAfterSuccess: true,
    });
  }

  private async runAnalyzeWorkflow(options: {
    uri: vscode.Uri;
    resultEventName: string;
    revealDocumentAfterSuccess: boolean;
  }): Promise<void> {
    const analyzeRequest = this.createAnalyzeRequest(options.uri);
    const customDiagnosticsCount = analyzeRequest.customDiagnostics?.length ?? 0;
    const currentSnapshot = await this.analysisCoordinator.getCurrentAnalysisSnapshot(options.uri, analyzeRequest.customDiagnostics);

    if (await this.handleFreshAnalysisSnapshot(options.uri, currentSnapshot, options.resultEventName, customDiagnosticsCount)) {
      return;
    }

    await this.executeAnalyzeRequest({
      uri: options.uri,
      snapshot: currentSnapshot,
      analyzeRequest,
      resultEventName: options.resultEventName,
      customDiagnosticsCount,
      revealDocumentAfterSuccess: options.revealDocumentAfterSuccess,
    });
  }

  private createAnalyzeRequest(uri: vscode.Uri): AnalyzeRequest {
    return {
      uri: uri.toString(),
      customDiagnostics: this.getCustomDiagnostics(),
    };
  }

  private async handleFreshAnalysisSnapshot(
    uri: vscode.Uri,
    snapshot: AnalysisSnapshot,
    resultEventName: string,
    customDiagnosticsCount: number,
  ): Promise<boolean> {
    if (!snapshot.isFresh) {
      return false;
    }

    if (snapshot.diagnostics.length > 0) {
      await this.analysisCoordinator.focusExistingDiagnostics(uri);
      this.logTelemetryUsage(resultEventName, {
        outcome: 'alreadyCurrentWithDiagnostics',
        resultCount: snapshot.diagnostics.length,
        customDiagnosticsCount,
      });
      vscode.window.showInformationMessage('Analysis is already up to date.');
      return true;
    }

    await vscode.window.showTextDocument(snapshot.document, { preview: false, preserveFocus: false });
    this.logTelemetryUsage(resultEventName, {
      outcome: 'alreadyCurrentNoIssues',
      resultCount: snapshot.resultCount ?? 0,
      customDiagnosticsCount,
    });
    void vscode.window.showInformationMessage('Analysis is already up to date: no issues found.');
    return true;
  }

  private async executeAnalyzeRequest(options: {
    uri: vscode.Uri;
    snapshot: AnalysisSnapshot;
    analyzeRequest: AnalyzeRequest;
    resultEventName: string;
    customDiagnosticsCount: number;
    revealDocumentAfterSuccess: boolean;
  }): Promise<void> {
    this.analysisCoordinator.beginAnalysis(options.uri.toString());
    this.analysisCoordinator.markAnalysisStage(options.uri.toString(), 'Submitting analysis request...');

    try {
      const result = await this.sendAnalyzeRequest(options.analyzeRequest);
      this.analysisCoordinator.recordAnalysisSnapshot(options.snapshot.document, options.analyzeRequest.customDiagnostics, result.resultCount);

      if (options.revealDocumentAfterSuccess) {
        await vscode.window.showTextDocument(options.snapshot.document, { preview: false, preserveFocus: false });
      }

      await this.analysisCoordinator.completeAnalysis(options.uri, result);
      this.logTelemetryUsage(options.resultEventName, {
        outcome: 'success',
        resultCount: result.resultCount,
        durationMs: result.duration,
        customDiagnosticsCount: options.customDiagnosticsCount,
      });
    } catch (error) {
      this.logTelemetryError(options.resultEventName, error, { outcome: 'failed' });
      void vscode.window.showErrorMessage('Prompt analysis failed. See output for details.');
    }
  }

  private sendAnalyzeRequest(analyzeRequest: AnalyzeRequest): Thenable<{ duration: number; resultCount: number }> {
    return this.client!.sendRequest<{ duration: number; resultCount: number }>('chatCustomizationsEvaluations/analyze', analyzeRequest);
  }

  private getSortedExtensionDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
    return this.getExtensionDiagnostics(uri)
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

    this.logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'nonFixableDiagnosticsOnly' });
    const action = await vscode.window.showInformationMessage(
      'Fix Diagnostics is unavailable for LLM analysis error diagnostics. Run Analyze again.',
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
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query,
      isPartialQuery: false,
    });
  }

  private getExtensionDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
    const fromCollection = this.extensionDiagnosticCollection.get(uri) ?? [];
    if (fromCollection.length > 0) {
      return fromCollection.filter(
        d => d.source?.startsWith('chat-customizations-evaluations')
      );
    }

    return vscode.languages.getDiagnostics(uri).filter(
      d => d.source?.startsWith('chat-customizations-evaluations')
    );
  }

  private handleDocumentChangeForDiagnostics(event: vscode.TextDocumentChangeEvent): void {
    if (event.contentChanges.length === 0) {
      return;
    }

    const uri = event.document.uri;
    const uriKey = uri.toString();
    const currentEdit = this.pendingDiagnosticEditsByUri.get(uriKey) ?? { fullDocument: false, ranges: [] };
    const nextEdit = this.mergeDiagnosticEdit(currentEdit, event.contentChanges);
    this.pendingDiagnosticEditsByUri.set(uriKey, nextEdit);

    const existingDiagnostics = this.extensionDiagnosticCollection.get(uri) ?? [];
    if (existingDiagnostics.length === 0) {
      return;
    }

    const filteredDiagnostics = this.filterDiagnosticsForEdit(existingDiagnostics, nextEdit);
    if (filteredDiagnostics.length === existingDiagnostics.length) {
      return;
    }

    this.extensionDiagnosticCollection.set(uri, filteredDiagnostics);
    this.outputChannel.appendLine(`[Diagnostics] Removed ${existingDiagnostics.length - filteredDiagnostics.length} touched diagnostics for ${uri.fsPath}`);
  }

  private mergeDiagnosticEdit(
    existing: { fullDocument: boolean; ranges: vscode.Range[] },
    contentChanges: readonly vscode.TextDocumentContentChangeEvent[],
  ): { fullDocument: boolean; ranges: vscode.Range[] } {
    const hasFullDocumentEdit = existing.fullDocument || contentChanges.some(change => !change.range);
    if (hasFullDocumentEdit) {
      return { fullDocument: true, ranges: [] };
    }

    const nextRanges = existing.ranges.slice();
    for (const change of contentChanges) {
      if (change.range) {
        nextRanges.push(change.range);
      }
    }

    return {
      fullDocument: false,
      ranges: nextRanges,
    };
  }

  private filterDiagnosticsForEdit(
    diagnostics: readonly vscode.Diagnostic[],
    edit: { fullDocument: boolean; ranges: vscode.Range[] },
  ): vscode.Diagnostic[] {
    if (edit.fullDocument) {
      return [];
    }

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

  private rangesOverlap(left: vscode.Range, right: vscode.Range): boolean {
    return this.comparePosition(left.start, right.end) <= 0
      && this.comparePosition(right.start, left.end) <= 0;
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

  private isNonFixableDiagnostic(diagnostic: vscode.Diagnostic): boolean {
    return NON_FIXABLE_DIAGNOSTIC_CODE_SET.has(this.diagnosticCodeToString(diagnostic.code));
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

  private getCustomDiagnostics(): CustomDiagnosticConfig[] | undefined {
    const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
    const diagnostics = configuration.get<CustomDiagnosticConfig[]>('customDiagnostics', []);
    return diagnostics.length > 0 ? diagnostics : undefined;
  }

  private resolveSkillContext(obj: unknown): SkillContext | undefined {
    const uri = this.getCustomizationUri(obj) ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      return undefined;
    }

    const skillFilePath = this.findSkillFilePath(uri.fsPath);
    if (!skillFilePath) {
      return undefined;
    }

    const skillDirPath = path.dirname(skillFilePath);
    const skillName = path.basename(skillDirPath);
    const workspaceRoot = this.inferSkillProjectRoot(uri, skillDirPath);

    return {
      uri,
      skillFilePath,
      skillDirPath,
      skillName,
      workspaceRoot,
    };
  }

  private inferSkillProjectRoot(uri: vscode.Uri, skillDirPath: string): string {
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    if (workspaceRoot) {
      return workspaceRoot;
    }

    const skillsDir = path.dirname(skillDirPath);
    if (path.basename(skillsDir) === 'skills') {
      return path.dirname(skillsDir);
    }

    return skillDirPath;
  }

  private findSkillFilePath(startPath: string): string | undefined {
    const stat = fs.statSync(startPath, { throwIfNoEntry: false });
    let current = stat?.isDirectory() ? startPath : path.dirname(startPath);

    while (true) {
      const candidate = path.join(current, 'SKILL.md');
      if (fs.existsSync(candidate)) {
        return candidate;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
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

  private async selectModel(analysisUri: string): Promise<vscode.LanguageModelChat | undefined> {
    if (this.cachedModel) {
      return this.cachedModel;
    }
    if (this.modelSelectionPromise) {
      return this.modelSelectionPromise;
    }

    this.modelSelectionPromise = this.doSelectModel(analysisUri);
    try {
      return await this.modelSelectionPromise;
    } finally {
      this.modelSelectionPromise = undefined;
    }
  }

  private async doSelectModel(analysisUri: string): Promise<vscode.LanguageModelChat | undefined> {
    if (!vscode.lm || !vscode.lm.selectChatModels) {
      return undefined;
    }

    const userSelectedModel = await this.trySelectUserConfiguredModel(analysisUri);
    if (userSelectedModel) {
      this.cachedModel = userSelectedModel;
      return userSelectedModel;
    }

    const fallbackModel = await this.selectFallbackModel(analysisUri);
    if (!fallbackModel) {
      this.analysisCoordinator?.markAnalysisStageWithRequestCount(analysisUri, 'No model available.');
      return undefined;
    }

    this.cachedModel = fallbackModel;
    this.analysisCoordinator?.markAnalysisStageWithRequestCount(analysisUri, `Using model: ${this.cachedModel.name}`);
    this.outputChannel.appendLine(`[LLM Proxy] Using model: ${this.cachedModel.name} (${this.cachedModel.vendor}/${this.cachedModel.family})`);
    return this.cachedModel;
  }

  private async trySelectUserConfiguredModel(analysisUri: string): Promise<vscode.LanguageModelChat | undefined> {
    const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
    const userModel = configuration.get<string>('model', '').trim();
    if (!userModel) {
      return undefined;
    }

    this.analysisCoordinator?.markAnalysisStageWithRequestCount(analysisUri, `Looking for user-selected model: ${userModel}`);
    this.outputChannel.appendLine(`[LLM Proxy] Looking for user-selected model: ${userModel}`);
    const models = await vscode.lm.selectChatModels({ family: userModel });
    this.outputChannel.appendLine(`[LLM Proxy] User model matches found: ${models.length}`);
    if (models.length > 0) {
      const selectedModel = models[0];
      this.analysisCoordinator?.markAnalysisStageWithRequestCount(analysisUri, `Using user-selected model: ${selectedModel.name}`);
      this.outputChannel.appendLine(`[LLM Proxy] Using user-selected model: ${selectedModel.name} (${selectedModel.vendor}/${selectedModel.family})`);
      return selectedModel;
    }

    this.analysisCoordinator?.markAnalysisStageWithRequestCount(analysisUri, 'User model not found, falling back to default selection...');
    return undefined;
  }

  private async selectFallbackModel(analysisUri: string): Promise<vscode.LanguageModelChat | undefined> {
    this.analysisCoordinator?.markAnalysisStageWithRequestCount(analysisUri, 'Discovering Copilot models (claude-sonnet-4.6)...');
    this.outputChannel.appendLine('[LLM Proxy] Selecting chat models...');

    let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'claude-sonnet-4.6' });
    this.outputChannel.appendLine(`[LLM Proxy] claude-sonnet-4.6 models found: ${models.length}`);

    if (models.length === 0) {
      this.analysisCoordinator?.markAnalysisStageWithRequestCount(analysisUri, 'No claude-sonnet-4.6 model found, trying any Copilot model...');
      models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      this.outputChannel.appendLine(`[LLM Proxy] Any Copilot models found: ${models.length}`);
    }

    if (models.length === 0) {
      this.analysisCoordinator?.markAnalysisStageWithRequestCount(analysisUri, 'No Copilot-only match, trying all available models...');
      models = await vscode.lm.selectChatModels();
      this.outputChannel.appendLine(`[LLM Proxy] Any models found: ${models.length}`);
    }

    return models[0];
  }

  private async handleLLMProxyRequest(request: LLMProxyRequest): Promise<LLMProxyResponse> {
    const cts = new vscode.CancellationTokenSource();
    const timeout = setTimeout(() => cts.cancel(), ExtensionRuntime.LLM_REQUEST_TIMEOUT_MS);
    try {
      this.analysisCoordinator?.markAnalysisStageWithRequestCount(request.uri, 'Preparing Copilot request payload...');
      const model = await this.selectModel(request.uri);

      if (!model) {
        return { text: '{}', error: 'No language models available - sign in to GitHub Copilot' };
      }

      const messages = this.buildLLMProxyMessages(request);

      this.analysisCoordinator?.markAnalysisStageWithRequestCount(request.uri, 'Sending request to Copilot...');
      const response = await model.sendRequest(messages, {}, cts.token);

      const text = await this.collectStreamedResponseText(response, request.uri);

      this.analysisCoordinator?.markAnalysisStageWithRequestCount(request.uri, 'Processing Copilot response...');

      return { text };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.outputChannel.appendLine(`[LLM Proxy] Error: ${message}`);
      return { text: '{}', error: `vscode.lm request failed: ${message}` };
    } finally {
      clearTimeout(timeout);
      cts.dispose();
    }
  }

  private buildLLMProxyMessages(request: LLMProxyRequest): vscode.LanguageModelChatMessage[] {
    return [
      vscode.LanguageModelChatMessage.User(request.systemPrompt + '\n\n' + request.prompt),
    ];
  }

  private async collectStreamedResponseText(
    response: vscode.LanguageModelChatResponse,
    analysisUri: string,
  ): Promise<string> {
    this.analysisCoordinator?.markAnalysisStageWithRequestCount(analysisUri, 'Streaming Copilot response...');

    let text = '';
    let chunkCount = 0;
    for await (const part of response.text) {
      text += part;
      chunkCount += 1;
      if (chunkCount <= 3 || chunkCount % 10 === 0) {
        this.analysisCoordinator?.markAnalysisStageWithRequestCount(analysisUri, `Streaming Copilot response (chunk ${chunkCount})...`);
      }
    }

    return text;
  }
}

const runtime = new ExtensionRuntime();

export function activate(context: vscode.ExtensionContext): void {
  runtime.activate(context);
}

export function deactivate(): Thenable<void> | undefined {
  return runtime.deactivate();
}
