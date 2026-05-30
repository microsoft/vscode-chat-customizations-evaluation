import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as https from 'https';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
  RequestType,
} from 'vscode-languageclient/node';
import {
  initializeWaza,
  registerWazaCommands,
} from './waza';
import {
  ACTION_ANALYZE_AGAIN,
  ACTION_FIX_DIAGNOSTICS,
  ACTION_INSTALL_WAZA_BINARY,
  ACTION_OPEN_WAZA_USER_GUIDE,
  ACTION_SHOW_PROBLEMS,
  NON_FIXABLE_DIAGNOSTIC_CODES,
  TELEMETRY_AUTH_TOKEN_ENV,
  TELEMETRY_ENDPOINT_ENV,
} from './strings';
import type {
  AnalysisSnapshot,
  AnalysisState,
  AnalyzeRequest,
  CommandResult,
  CustomDiagnosticConfig,
  EvalScaffoldSummary,
  LLMProxyRequest,
  LLMProxyResponse,
  SkillContext,
  TelemetryData,
} from './extensionTypes';

const LLMRequestType = new RequestType<LLMProxyRequest, LLMProxyResponse, void>('chatCustomizationsEvaluations/llmRequest');
const STATUS_BAR_COMPLETION_DURATION_MS = 5000;
const NON_FIXABLE_DIAGNOSTIC_CODE_SET = new Set<string>(NON_FIXABLE_DIAGNOSTIC_CODES);

class AnalysisCoordinator {

  constructor(
    private readonly getDiagnosticsForUri: (uri: vscode.Uri) => vscode.Diagnostic[],
    private readonly isNonFixableDiagnosticForEntry: (diagnostic: vscode.Diagnostic) => boolean,
  ) {
  }

  private readonly urisWithDiagnostics = new Set<string>();
  private readonly pendingAnalysisUris = new Set<string>();
  private readonly analysisStatesByUri = new Map<string, AnalysisState>();
  private readonly analysisSnapshotsByUri = new Map<string, AnalysisSnapshot>();
  private statusBarItem: vscode.StatusBarItem | undefined;
  private statusBarCompletionMessage: string | undefined;
  private statusBarCompletionTimer: ReturnType<typeof setTimeout> | undefined;

  initialize(context: vscode.ExtensionContext): void {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    this.statusBarItem.name = 'Chat Customizations Evaluations Analysis Status';
    context.subscriptions.push(this.statusBarItem);
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
      this.updateAnalysisStatusBar();
      this.updateHasDiagnosticsContext();
    }));
  }

  dispose(): void {
    if (this.statusBarCompletionTimer) {
      clearTimeout(this.statusBarCompletionTimer);
      this.statusBarCompletionTimer = undefined;
    }
  }

  isAnalysisPending(uri: vscode.Uri): boolean {
    return this.pendingAnalysisUris.has(uri.toString());
  }

  beginAnalysis(uri: string): void {
    const existingState = this.analysisStatesByUri.get(uri);
    if (existingState?.resolveProgress) {
      existingState.resolveProgress();
    }

    this.pendingAnalysisUris.add(uri);
    this.analysisStatesByUri.set(uri, {
      startedAt: Date.now(),
      stage: 'Starting analysis...',
      llmRequestsInFlight: 0,
    });
    this.updateIsAnalyzingContext();
    this.startProgressNotification(uri);
    this.updateAnalysisStatusBar();
  }

  markAnalysisStage(stage: string): void {
    if (this.analysisStatesByUri.size === 0) {
      return;
    }

    for (const [uri, state] of this.analysisStatesByUri.entries()) {
      state.stage = stage;
      this.updateProgressNotificationMessage(uri);
    }
    this.updateAnalysisStatusBar();
  }

  markAnalysisStageWithRequestCount(stage: string): void {
    if (this.analysisStatesByUri.size === 0) {
      return;
    }

    for (const [uri, state] of this.analysisStatesByUri.entries()) {
      const requestScope = state.llmRequestsInFlight > 1
        ? ` (${state.llmRequestsInFlight} requests in flight)`
        : '';
      state.stage = `${stage}${requestScope}`;
      this.updateProgressNotificationMessage(uri);
    }
    this.updateAnalysisStatusBar();
  }

  markLLMRequestStart(): void {
    if (this.analysisStatesByUri.size === 0) {
      return;
    }

    for (const [uri, state] of this.analysisStatesByUri.entries()) {
      state.llmRequestsInFlight += 1;
      const requestCount = state.llmRequestsInFlight;
      state.stage = requestCount > 1
        ? `Connecting to Copilot... (${requestCount} requests in flight)`
        : 'Connecting to Copilot...';
      this.updateProgressNotificationMessage(uri);
    }
    this.updateAnalysisStatusBar();
  }

  markLLMRequestDone(): void {
    if (this.analysisStatesByUri.size === 0) {
      return;
    }

    for (const [uri, state] of this.analysisStatesByUri.entries()) {
      state.llmRequestsInFlight = Math.max(0, state.llmRequestsInFlight - 1);
      state.stage = state.llmRequestsInFlight > 0
        ? 'Waiting for Copilot responses...'
        : 'Finalizing diagnostics...';
      this.updateProgressNotificationMessage(uri);
    }
    this.updateAnalysisStatusBar();
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

      if (this.pendingAnalysisUris.has(uriKey)) {
        this.markDiagnosticsFound(uri, diagnostics.length);
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
    const state = this.analysisStatesByUri.get(uriKey);
    if (state?.resolveProgress) {
      state.resolveProgress();
    }
    this.pendingAnalysisUris.delete(uriKey);
    this.analysisStatesByUri.delete(uriKey);
    this.updateIsAnalyzingContext();

    const issueCount = result.resultCount;
    this.statusBarCompletionMessage = issueCount > 0
      ? `$(check) ${this.formatIssueSummary(issueCount)}`
      : '$(check) No issues';
    if (this.statusBarCompletionTimer) {
      clearTimeout(this.statusBarCompletionTimer);
    }
    this.statusBarCompletionTimer = setTimeout(() => {
      this.statusBarCompletionMessage = undefined;
      this.statusBarCompletionTimer = undefined;
      this.updateAnalysisStatusBar();
    }, STATUS_BAR_COMPLETION_DURATION_MS);
    this.updateAnalysisStatusBar();

    const filename = path.basename(uri.fsPath);
    const durationText = state ? ` in ${this.formatDurationMs(result.duration)}` : '';
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

  private updateAnalysisStatusBar(): void {
    if (!this.statusBarItem) {
      return;
    }

    const runningCount = this.analysisStatesByUri.size;
    if (runningCount === 0) {
      if (this.statusBarCompletionMessage) {
        this.statusBarItem.text = this.statusBarCompletionMessage;
        this.statusBarItem.command = 'workbench.actions.view.problems';
        this.statusBarItem.tooltip = 'Click to open Problems panel';
        this.statusBarItem.show();
      } else {
        this.statusBarItem.command = undefined;
        this.statusBarItem.hide();
      }
      return;
    }

    const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
    const activeState = activeUri ? this.analysisStatesByUri.get(activeUri) : undefined;
    const fallbackState = activeState ?? this.analysisStatesByUri.values().next().value as AnalysisState;
    const scope = runningCount > 1 ? ` (${runningCount} files)` : '';

    this.statusBarItem.text = `$(sync~spin) Analyze: ${fallbackState.stage}${scope}`;
    this.statusBarItem.command = undefined;
    this.statusBarItem.tooltip = 'Chat Customizations Evaluations analysis in progress';
    this.statusBarItem.show();
  }

  private updateIsAnalyzingContext(): void {
    void vscode.commands.executeCommand('setContext', 'chatCustomizationsEvaluations.isAnalyzing', this.pendingAnalysisUris.size > 0);
  }

  private updateHasDiagnosticsContext(): void {
    const editor = vscode.window.activeTextEditor;
    const hasDiagnostics = editor ? this.urisWithDiagnostics.has(editor.document.uri.toString()) : false;
    void vscode.commands.executeCommand('setContext', 'chatCustomizationsEvaluations.hasDiagnostics', hasDiagnostics);
  }

  private updateProgressNotificationMessage(uri: string): void {
    const state = this.analysisStatesByUri.get(uri);
    if (!state?.progressReporter) {
      return;
    }

    state.progressReporter.report({ message: state.stage });
  }

  private startProgressNotification(uri: string): void {
    const state = this.analysisStatesByUri.get(uri);
    if (!state) {
      return;
    }

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Running prompt analysis',
        cancellable: false,
      },
      async (progress) => {
        const currentState = this.analysisStatesByUri.get(uri);
        if (!currentState) {
          return;
        }

        currentState.progressReporter = progress;
        progress.report({ message: currentState.stage });

        await new Promise<void>((resolve) => {
          currentState.resolveProgress = resolve;
        });
      }
    );
  }

  private markDiagnosticsFound(uri: vscode.Uri, count: number): void {
    const uriKey = uri.toString();
    const state = this.analysisStatesByUri.get(uriKey);
    if (!state) {
      return;
    }

    state.stage = `Collecting results: ${this.formatIssueSummary(count)}`;
    this.updateProgressNotificationMessage(uriKey);
    this.updateAnalysisStatusBar();
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
        ? [ACTION_SHOW_PROBLEMS, ACTION_ANALYZE_AGAIN]
        : [ACTION_SHOW_PROBLEMS, ACTION_FIX_DIAGNOSTICS];
      const action = await vscode.window.showInformationMessage(message, ...actions);
      if (action === ACTION_SHOW_PROBLEMS) {
        await vscode.commands.executeCommand('workbench.actions.view.problems');
      } else if (action === ACTION_ANALYZE_AGAIN) {
        await vscode.commands.executeCommand('chatCustomizationsEvaluations.analyzePrompt');
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

class ExtensionTelemetrySender implements vscode.TelemetrySender {

  constructor(
    private readonly endpoint: string | undefined,
    private readonly authToken: string | undefined,
    private readonly extensionVersion: string,
    private readonly outputChannel: vscode.OutputChannel,
  ) { }

  sendEventData(eventName: string, data?: Record<string, unknown>): void {
    this.postPayload('usage', eventName, data);
  }

  sendErrorData(error: Error, data?: Record<string, unknown>): void {
    this.postPayload('error', 'extension/error', {
      ...data,
      errorName: error.name,
      errorMessage: error.message,
    });
  }

  private postPayload(kind: 'usage' | 'error', eventName: string, data?: Record<string, unknown>): void {
    if (!this.endpoint) {
      return;
    }

    const body = JSON.stringify({
      kind,
      eventName,
      extensionVersion: this.extensionVersion,
      timestamp: new Date().toISOString(),
      data,
    });

    const request = https.request(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
      },
    }, (response) => {
      response.resume();
    });

    request.on('error', (error) => {
      this.outputChannel.appendLine(`[Telemetry] Failed to send telemetry: ${error.message}`);
    });

    request.write(body);
    request.end();
  }
}
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

  activate(context: vscode.ExtensionContext): void {
    this.extensionContext = context;
    this.outputChannel = vscode.window.createOutputChannel('Chat Customizations Evaluations');
    this.analysisCoordinator = new AnalysisCoordinator(
      (uri) => this.getExtensionDiagnostics(uri),
      (diagnostic) => this.isNonFixableDiagnostic(diagnostic),
    );
    this.analysisCoordinator.initialize(context);
    this.telemetryLogger = this.createExtensionTelemetryLogger(context);
    context.subscriptions.push(this.telemetryLogger);
    this.logTelemetryUsage('extension/activate', {
      workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
    });

    initializeWaza({
      extensionContext: this.extensionContext,
      outputChannel: this.outputChannel,
      getCustomizationUri: (obj) => this.getCustomizationUri(obj),
      logTelemetryUsage: (eventName, data) => this.logTelemetryUsage(eventName, data),
      logTelemetryError: (eventName, error, data) => this.logTelemetryError(eventName, error, data),
    });

    this.outputChannel.appendLine(`[Activation] Extension path: ${context.extensionPath}`);

    const bundledServer = context.asAbsolutePath(path.join('out', 'server.js'));
    const devServer = context.asAbsolutePath(path.join('..', 'out', 'server.js'));
    const serverModule = fs.existsSync(bundledServer) ? bundledServer : devServer;

    this.outputChannel.appendLine(`[Activation] Server module: ${serverModule} (exists: ${fs.existsSync(serverModule)})`);

    const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };
    const serverOptions: ServerOptions = {
      run: { module: serverModule, transport: TransportKind.ipc },
      debug: {
        module: serverModule,
        transport: TransportKind.ipc,
        options: debugOptions,
      },
    };

    const clientOptions: LanguageClientOptions = {
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
      outputChannel: this.outputChannel,
    };

    this.client = new LanguageClient(
      'chatCustomizationsEvaluations',
      'Chat Customizations Evaluations',
      serverOptions,
      clientOptions
    );

    this.client.onNotification('chatCustomizationsEvaluations/contentStale', (_params: { uri: string }) => {
      this.logTelemetryUsage('analysis/contentStaleNotificationShown');
      void vscode.window.showInformationMessage('Content is stale. Run Analyze to update diagnostics.');
    });

    this.client.onRequest(LLMRequestType, async (request: LLMProxyRequest): Promise<LLMProxyResponse> => {
      this.analysisCoordinator?.markLLMRequestStart();
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
        this.analysisCoordinator?.markLLMRequestDone();
      }
    });

    this.registerCommands(context);
    context.subscriptions.push(...registerWazaCommands(context));
    context.subscriptions.push(
      vscode.languages.onDidChangeDiagnostics((e) => {
        this.analysisCoordinator?.handleDiagnosticsChanged(e.uris);
      }),
    );

    if (vscode.lm && vscode.lm.onDidChangeChatModels) {
      context.subscriptions.push(
        vscode.lm.onDidChangeChatModels(() => {
          this.outputChannel.appendLine('[LLM Proxy] Models changed, clearing cache');
          this.cachedModel = undefined;
          this.modelSelectionPromise = undefined;
        })
      );
    }

    this.client.start().then(() => {
      this.outputChannel.appendLine('[Activation] Language server started successfully');
      this.logTelemetryUsage('extension/languageServerStart', { outcome: 'success' });
    }).catch((err: Error) => {
      this.outputChannel.appendLine(`[Activation] Language server failed to start: ${err.message}`);
      this.logTelemetryError('extension/languageServerStart', err, { outcome: 'failed' });
      this.outputChannel.show(true);
    });

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
      vscode.commands.registerCommand('chatCustomizationsEvaluations.analyzePrompt', async () => {
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

        const analyzeRequest: AnalyzeRequest = {
          uri: editor.document.uri.toString(),
          customDiagnostics: this.getCustomDiagnostics(),
        };

        const currentSnapshot = await this.analysisCoordinator.getCurrentAnalysisSnapshot(editor.document.uri, analyzeRequest.customDiagnostics);
        if (currentSnapshot.isFresh) {
          if (currentSnapshot.diagnostics.length > 0) {
            await this.analysisCoordinator.focusExistingDiagnostics(editor.document.uri);
            this.logTelemetryUsage('command/analyzePrompt/result', {
              outcome: 'alreadyCurrentWithDiagnostics',
              resultCount: currentSnapshot.diagnostics.length,
              customDiagnosticsCount: analyzeRequest.customDiagnostics?.length ?? 0,
            });
            vscode.window.showInformationMessage('Analysis is already up to date.');
            return;
          }
          await vscode.window.showTextDocument(currentSnapshot.document, { preview: false, preserveFocus: false });
          this.logTelemetryUsage('command/analyzePrompt/result', {
            outcome: 'alreadyCurrentNoIssues',
            resultCount: currentSnapshot.resultCount ?? 0,
            customDiagnosticsCount: analyzeRequest.customDiagnostics?.length ?? 0,
          });
          void vscode.window.showInformationMessage('Analysis is already up to date: no issues found.');
          return;
        }

        this.analysisCoordinator.beginAnalysis(editor.document.uri.toString());
        this.analysisCoordinator.markAnalysisStage('Submitting analysis request...');
        try {
          const result = await this.client!.sendRequest<{ duration: number; resultCount: number }>('chatCustomizationsEvaluations/analyze', analyzeRequest);
          this.analysisCoordinator.recordAnalysisSnapshot(editor.document, analyzeRequest.customDiagnostics, result.resultCount);
          this.logTelemetryUsage('command/analyzePrompt/result', {
            outcome: 'success',
            resultCount: result.resultCount,
            durationMs: result.duration,
            customDiagnosticsCount: analyzeRequest.customDiagnostics?.length ?? 0,
          });
          await this.analysisCoordinator.completeAnalysis(editor.document.uri, result);
        } catch (error) {
          this.logTelemetryError('command/analyzePrompt/result', error, { outcome: 'failed' });
          void vscode.window.showErrorMessage('Prompt analysis failed. See output for details.');
        }
      }),
      vscode.commands.registerCommand('chatCustomizationsEvaluations.fixDiagnostics', async () => {
        this.logTelemetryUsage('command/fixDiagnostics');
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          this.logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'noActiveEditor' });
          return;
        }

        const targetUri = editor.document.uri;
        const initialText = editor.document.getText();
        const diagnostics = this.getExtensionDiagnostics(targetUri)
          .slice()
          .sort((a, b) => {
            if (a.range.start.line !== b.range.start.line) {
              return a.range.start.line - b.range.start.line;
            }
            return a.range.start.character - b.range.start.character;
          });

        if (diagnostics.length === 0) {
          this.logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'noDiagnostics' });
          void vscode.window.showInformationMessage('No diagnostics found for the active file. Run Analyze first.');
          return;
        }

        const fixableDiagnostics = diagnostics.filter(diagnostic => !this.isNonFixableDiagnostic(diagnostic));
        if (fixableDiagnostics.length === 0) {
          this.logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'nonFixableDiagnosticsOnly' });
          const action = await vscode.window.showInformationMessage(
            'Fix Diagnostics is unavailable for LLM analysis error diagnostics. Run Analyze again.',
            ACTION_ANALYZE_AGAIN,
          );
          if (action === ACTION_ANALYZE_AGAIN) {
            await vscode.commands.executeCommand('chatCustomizationsEvaluations.analyzePrompt');
          }
          return;
        }

        await vscode.window.showTextDocument(editor.document, { preview: false, preserveFocus: false });

        const query = this.buildFixDiagnosticsChatQuery(editor.document, fixableDiagnostics);
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query,
          isPartialQuery: false,
        });

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

        await this.handlePostFixDiagnosticsFlow(skillContext);
        this.logTelemetryUsage('command/fixDiagnostics/result', {
          outcome: 'success',
          diagnosticsCount: fixableDiagnostics.length,
        });
      }),
      vscode.commands.registerCommand('chatCustomizationsEvaluations.analyzePromptFromCustomization', async (obj) => {
        this.logTelemetryUsage('command/analyzePromptFromCustomization');
        this.outputChannel.appendLine(`customization obj : ${JSON.stringify(obj)}`);
        const uri = this.getCustomizationUri(obj);
        if (!uri) {
          this.outputChannel.appendLine('[Analyze Prompt From Customization] Missing URI in command arguments');
          this.logTelemetryUsage('command/analyzePromptFromCustomization/result', { outcome: 'missingUri' });
          void vscode.window.showWarningMessage('Unable to analyze prompt: no URI was provided by the customization item.');
          return;
        }

        const analyzeRequest: AnalyzeRequest = {
          uri: uri.toString(),
          customDiagnostics: this.getCustomDiagnostics(),
        };

        const currentSnapshot = await this.analysisCoordinator.getCurrentAnalysisSnapshot(uri, analyzeRequest.customDiagnostics);
        if (currentSnapshot.isFresh) {
          if (currentSnapshot.diagnostics.length > 0) {
            await this.analysisCoordinator.focusExistingDiagnostics(uri);
            this.logTelemetryUsage('command/analyzePromptFromCustomization/result', {
              outcome: 'alreadyCurrentWithDiagnostics',
              resultCount: currentSnapshot.diagnostics.length,
              customDiagnosticsCount: analyzeRequest.customDiagnostics?.length ?? 0,
            });
            vscode.window.showInformationMessage('Analysis is already up to date.');
            return;
          }
          await vscode.window.showTextDocument(currentSnapshot.document, { preview: false, preserveFocus: false });
          this.logTelemetryUsage('command/analyzePromptFromCustomization/result', {
            outcome: 'alreadyCurrentNoIssues',
            resultCount: currentSnapshot.resultCount ?? 0,
            customDiagnosticsCount: analyzeRequest.customDiagnostics?.length ?? 0,
          });
          vscode.window.showInformationMessage('Analysis is already up to date: no issues found.');
          return;
        }

        this.analysisCoordinator.beginAnalysis(uri.toString());
        this.analysisCoordinator.markAnalysisStage('Submitting analysis request...');
        try {
          const result = await this.client!.sendRequest<{ duration: number; resultCount: number }>('chatCustomizationsEvaluations/analyze', analyzeRequest);
          this.analysisCoordinator.recordAnalysisSnapshot(currentSnapshot.document, analyzeRequest.customDiagnostics, result.resultCount);
          await vscode.window.showTextDocument(currentSnapshot.document, { preview: false, preserveFocus: false });

          await this.analysisCoordinator.completeAnalysis(uri, result);
          this.logTelemetryUsage('command/analyzePromptFromCustomization/result', {
            outcome: 'success',
            resultCount: result.resultCount,
            durationMs: result.duration,
            customDiagnosticsCount: analyzeRequest.customDiagnostics?.length ?? 0,
          });
        } catch (error) {
          this.logTelemetryError('command/analyzePromptFromCustomization/result', error, { outcome: 'failed' });
          void vscode.window.showErrorMessage('Prompt analysis failed. See output for details.');
        }
      }),
    );
  }

  private getExtensionDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
    return vscode.languages.getDiagnostics(uri).filter(
      d => d.source?.startsWith('chat-customizations-evaluations')
    );
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
        `- line: ${startLine}${endLine !== startLine ? `-${endLine}` : ''}`,
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

  private getWazaCommand(): string {
    const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
    return configuration.get<string>('waza.command', 'waza');
  }

  private getManagedWazaBinaryPath(): string {
    const fileName = process.platform === 'win32' ? 'waza.exe' : 'waza';
    return path.join(this.extensionContext.globalStorageUri.fsPath, 'bin', fileName);
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

  private findEvalPath(context: SkillContext): string | undefined {
    const candidates = new Set<string>();

    candidates.add(path.join(context.workspaceRoot, 'evals', context.skillName, 'eval.yaml'));

    const skillsDir = path.dirname(context.skillDirPath);
    if (path.basename(skillsDir) === 'skills') {
      const projectRoot = path.dirname(skillsDir);
      candidates.add(path.join(projectRoot, 'evals', context.skillName, 'eval.yaml'));
    }

    let current = context.skillDirPath;
    while (true) {
      candidates.add(path.join(current, 'evals', context.skillName, 'eval.yaml'));
      candidates.add(path.join(current, 'evals', 'eval.yaml'));

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    candidates.add(path.join(context.skillDirPath, 'evals', 'eval.yaml'));
    candidates.add(path.join(context.skillDirPath, 'eval.yaml'));

    const ordered = Array.from(candidates);
    this.outputChannel.appendLine(`[Waza] Looking for eval.yaml for ${context.skillName}`);
    for (const candidate of ordered) {
      this.outputChannel.appendLine(`[Waza] Eval candidate: ${candidate}`);
      if (fs.existsSync(candidate)) {
        this.outputChannel.appendLine(`[Waza] Using eval file: ${candidate}`);
        return candidate;
      }
    }

    return undefined;
  }

  private resolveWazaScaffoldCwd(context: SkillContext): string {
    const skillsDir = path.dirname(context.skillDirPath);
    if (path.basename(skillsDir) === 'skills') {
      return path.dirname(skillsDir);
    }

    return skillsDir;
  }

  private isWazaSkillLookupError(output: string): boolean {
    const lower = output.toLowerCase();
    return lower.includes('finding skill') && lower.includes('not found in workspace');
  }

  private async runWazaScaffoldViaTempWorkspace(context: SkillContext, scaffoldRoot: string): Promise<CommandResult> {
    const tempBase = path.join(this.extensionContext.globalStorageUri.fsPath, 'tmp-scaffold');
    await fs.promises.mkdir(tempBase, { recursive: true });

    const tempRoot = await fs.promises.mkdtemp(path.join(tempBase, 'waza-'));
    const tempSkillDir = path.join(tempRoot, 'skills', context.skillName);
    const targetEvalPath = path.join(scaffoldRoot, 'evals', context.skillName, 'eval.yaml');

    try {
      await fs.promises.mkdir(tempSkillDir, { recursive: true });
      await fs.promises.copyFile(context.skillFilePath, path.join(tempSkillDir, 'SKILL.md'));

      this.outputChannel.appendLine(`[Waza] Temp scaffold root: ${tempRoot}`);
      this.outputChannel.appendLine(`[Waza] Target eval output: ${targetEvalPath}`);

      return await this.runWazaCommand(
        ['new', 'eval', context.skillName, '--output', targetEvalPath],
        tempRoot,
        ExtensionRuntime.WAZA_CREATE_TIMEOUT_MS,
      );
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  }

  private findLocalWazaRepo(startDir: string): string | undefined {
    let current = startDir;
    while (true) {
      const repoCandidate = path.join(current, 'waza');
      const mainPath = path.join(repoCandidate, 'cmd', 'waza', 'main.go');
      if (fs.existsSync(mainPath)) {
        return repoCandidate;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }

  private shouldFallbackToLocalGo(stderr: string): boolean {
    const lower = stderr.toLowerCase();
    return (
      lower.includes('spawn') && lower.includes('enoent')
    ) || lower.includes('command not found') || lower.includes('executable file not found');
  }

  private isWazaUnavailableResult(result: CommandResult): boolean {
    if (result.exitCode === 0) {
      return false;
    }

    const output = `${result.stderr}\n${result.stdout}`;
    const lower = output.toLowerCase();
    return this.shouldFallbackToLocalGo(output) || lower.includes('go is not available on path for local fallback');
  }

  private async showWazaInstallPrompt(message: string): Promise<boolean> {
    const action = await vscode.window.showWarningMessage(
      message,
      ACTION_INSTALL_WAZA_BINARY,
      ACTION_OPEN_WAZA_USER_GUIDE,
    );

    if (action === ACTION_INSTALL_WAZA_BINARY) {
      await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaDownloadBinary');
      return true;
    }

    if (action === ACTION_OPEN_WAZA_USER_GUIDE) {
      await vscode.commands.executeCommand('chatCustomizationsEvaluations.openWazaUserGuide');
    }

    return false;
  }

  private async runWazaCommand(args: string[], cwd: string, timeoutMs?: number): Promise<CommandResult> {
    const configuredCommand = this.getWazaCommand();
    let result = await this.runCommand(configuredCommand, args, cwd, timeoutMs);

    if (result.exitCode === 0 || !this.shouldFallbackToLocalGo(result.stderr)) {
      return result;
    }

    const managedBinary = this.getManagedWazaBinaryPath();
    if (managedBinary !== configuredCommand && fs.existsSync(managedBinary)) {
      this.outputChannel.appendLine(`[Waza] Falling back to downloaded binary at ${managedBinary}`);
      result = await this.runCommand(managedBinary, args, cwd, timeoutMs);
      if (result.exitCode === 0 || !this.shouldFallbackToLocalGo(result.stderr)) {
        return result;
      }
    }

    const goAvailable = await this.isCommandAvailable('go');
    if (!goAvailable) {
      return {
        stdout: result.stdout,
        stderr: `${result.stderr}\nGo is not available on PATH for local fallback. Run "Chat Customizations Evaluations: Download Waza Binary" to install waza for this extension.`.trim(),
        exitCode: 1,
      };
    }

    const localWazaRepo = this.findLocalWazaRepo(cwd);
    if (!localWazaRepo) {
      return result;
    }

    this.outputChannel.appendLine(`[Waza] Falling back to local repo via go run in ${localWazaRepo}`);
    result = await this.runCommand('go', ['run', './cmd/waza', ...args], localWazaRepo, timeoutMs);
    return result;
  }

  private async isCommandAvailable(command: string): Promise<boolean> {
    const probe = await this.runCommand(command, ['--version'], this.extensionContext.globalStorageUri.fsPath, 5_000);
    return !this.shouldFallbackToLocalGo(probe.stderr);
  }

  private runCommand(command: string, args: string[], cwd: string, timeoutMs?: number): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timeout: NodeJS.Timeout | undefined;

      if (timeoutMs) {
        timeout = setTimeout(() => {
          child.kill();
        }, timeoutMs);
      }

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve({
          stdout,
          stderr: `${stderr}\n${error.message}`.trim(),
          exitCode: 1,
        });
      });

      child.on('close', (code) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
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

  private async handlePostFixDiagnosticsFlow(context: SkillContext): Promise<void> {
    const evalPath = this.findEvalPath(context);
    if (evalPath) {
      await this.handleExistingEvalAfterFix(context, evalPath);
      return;
    }

    await this.handleMissingEvalAfterFix(context);
  }

  private async handleExistingEvalAfterFix(context: SkillContext, evalPath: string): Promise<void> {
    if (this.getAlwaysRunEvalsAfterFixDiagnostics()) {
      await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaRunEval', { uri: context.uri });
      return;
    }

    const runNow = 'Run Eval';
    const alwaysRun = 'Always Run Evals After Fix Diagnostics';
    const docs = 'Waza Docs';
    const action = await vscode.window.showInformationMessage(
      `Diagnostics were fixed for ${context.skillName}. Found existing eval at ${path.relative(context.workspaceRoot, evalPath)}. Run it now?`,
      runNow,
      alwaysRun,
      docs,
    );

    if (action === docs) {
      await vscode.commands.executeCommand('chatCustomizationsEvaluations.openWazaUserGuide');
      return;
    }

    if (action === alwaysRun) {
      await this.setAlwaysRunEvalsAfterFixDiagnostics(true);
      await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaRunEval', { uri: context.uri });
      return;
    }

    if (action === runNow) {
      await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaRunEval', { uri: context.uri });
    }
  }

  private async handleMissingEvalAfterFix(context: SkillContext): Promise<void> {
    const create = 'Create Evals';
    const docs = 'Waza Docs';
    const action = await vscode.window.showInformationMessage(
      `Diagnostics were fixed for ${context.skillName}. No eval.yaml found. Create evals powered by waza now? You can also run the "Create Waza Eval Scaffold" command later.`,
      create,
      docs,
    );

    if (action === docs) {
      await vscode.commands.executeCommand('chatCustomizationsEvaluations.openWazaUserGuide');
      return;
    }

    if (action !== create) {
      return;
    }

    const ensured = await this.ensureWazaInstalled(context.workspaceRoot);
    if (!ensured) {
      return;
    }

    const summary = await this.createWazaEvalScaffold(context);
    if (!summary) {
      return;
    }

    const evalUri = vscode.Uri.file(summary.evalPath);
    const document = await vscode.workspace.openTextDocument(evalUri);
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });

    const relativeEvalPath = path.relative(context.workspaceRoot, summary.evalPath);
    const relativeFiles = summary.createdFiles
      .map(file => path.relative(context.workspaceRoot, file))
      .slice(0, 3);
    const fileSummary = relativeFiles.length > 0
      ? ` Created files include: ${relativeFiles.join(', ')}${summary.createdFiles.length > 3 ? ', ...' : ''}.`
      : '';

    const runEval = 'Run Eval';
    const openDocs = 'Waza Docs';
    const notificationAction = await vscode.window.showInformationMessage(
      `Created waza scaffold at ${relativeEvalPath}.${fileSummary}`,
      runEval,
      openDocs,
    );

    if (notificationAction === runEval) {
      await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaRunEval', { uri: context.uri });
    }

    if (notificationAction === openDocs) {
      await vscode.commands.executeCommand('chatCustomizationsEvaluations.openWazaUserGuide');
    }
  }

  private getAlwaysRunEvalsAfterFixDiagnostics(): boolean {
    const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
    return configuration.get<boolean>('waza.alwaysRunAfterFixDiagnostics', false);
  }

  private async setAlwaysRunEvalsAfterFixDiagnostics(value: boolean): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
    await configuration.update('waza.alwaysRunAfterFixDiagnostics', value, vscode.ConfigurationTarget.Global);
  }

  private async ensureWazaInstalled(cwd: string): Promise<boolean> {
    const probe = await this.runWazaCommand(['--version'], cwd, 10_000);
    if (probe.exitCode === 0) {
      return true;
    }

    this.outputChannel.appendLine('[Waza] waza command unavailable; prompting for binary installation.');
    const installRequested = await this.showWazaInstallPrompt('waza is not installed or not available. Install the binary now?');
    if (!installRequested) {
      return false;
    }

    const postInstallProbe = await this.runWazaCommand(['--version'], cwd, 10_000);
    if (postInstallProbe.exitCode === 0) {
      return true;
    }

    void vscode.window.showErrorMessage('waza is still unavailable after installation attempt. See "Chat Customizations Evaluations" output for details.');
    return false;
  }

  private async createWazaEvalScaffold(context: SkillContext): Promise<EvalScaffoldSummary | undefined> {
    const scaffoldCwd = this.resolveWazaScaffoldCwd(context);
    this.outputChannel.show(true);
    this.outputChannel.appendLine(`[Waza] Creating eval scaffold for ${context.skillName}`);
    this.outputChannel.appendLine(`[Waza] Command: ${this.getWazaCommand()} new eval ${context.skillName}`);
    this.outputChannel.appendLine(`[Waza] CWD: ${scaffoldCwd}`);

    const result = await this.runWazaCommand(
      ['new', 'eval', context.skillName],
      scaffoldCwd,
      ExtensionRuntime.WAZA_CREATE_TIMEOUT_MS,
    );

    let finalResult = result;
    let usedTemporaryWorkspaceFallback = false;
    const resultText = `${result.stderr}\n${result.stdout}`;
    if (result.exitCode !== 0 && this.isWazaSkillLookupError(resultText)) {
      this.outputChannel.appendLine('[Waza] Workspace skill lookup failed; retrying with temporary canonical workspace...');
      finalResult = await this.runWazaScaffoldViaTempWorkspace(context, scaffoldCwd);
      usedTemporaryWorkspaceFallback = true;
    }

    if (finalResult.exitCode !== 0) {
      this.logTelemetryUsage('waza/createEvalScaffold/result', {
        outcome: 'failed',
        usedTemporaryWorkspaceFallback,
      });
      this.outputChannel.appendLine(`[Waza] eval scaffold failed\n${finalResult.stderr || finalResult.stdout}`);

      if (this.isWazaUnavailableResult(finalResult)) {
        await this.showWazaInstallPrompt('waza is not installed or not available. Install the binary now?');
        return undefined;
      }

      void vscode.window.showErrorMessage('Failed to create waza eval scaffold. See "Chat Customizations Evaluations" output for details.');
      return undefined;
    }

    this.outputChannel.appendLine(`[Waza] eval scaffold created for ${context.skillName}\n${finalResult.stdout}`);

    const evalPath = this.findEvalPath(context);
    if (!evalPath) {
      this.logTelemetryUsage('waza/createEvalScaffold/result', {
        outcome: 'missingEvalAfterSuccess',
        usedTemporaryWorkspaceFallback,
      });
      return undefined;
    }

    const createdFiles = this.collectEvalScaffoldFiles(evalPath);
    this.logTelemetryUsage('waza/createEvalScaffold/result', {
      outcome: 'success',
      usedTemporaryWorkspaceFallback,
      createdFileCount: createdFiles.length,
    });
    return { evalPath, createdFiles };
  }

  private collectEvalScaffoldFiles(evalPath: string): string[] {
    const root = path.dirname(evalPath);
    const files: string[] = [];

    const visit = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(entryPath);
        } else {
          files.push(entryPath);
        }
      }
    };

    if (fs.existsSync(root)) {
      visit(root);
    }

    files.sort();
    return files;
  }

  private async selectModel(): Promise<vscode.LanguageModelChat | undefined> {
    if (this.cachedModel) {
      return this.cachedModel;
    }

    if (this.modelSelectionPromise) {
      return this.modelSelectionPromise;
    }

    this.modelSelectionPromise = this.doSelectModel();
    try {
      return await this.modelSelectionPromise;
    } finally {
      this.modelSelectionPromise = undefined;
    }
  }

  private async doSelectModel(): Promise<vscode.LanguageModelChat | undefined> {
    if (!vscode.lm || !vscode.lm.selectChatModels) {
      return undefined;
    }

    const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
    const userModel = configuration.get<string>('model', '').trim();

    if (userModel) {
      this.analysisCoordinator?.markAnalysisStageWithRequestCount(`Looking for user-selected model: ${userModel}`);
      this.outputChannel.appendLine(`[LLM Proxy] Looking for user-selected model: ${userModel}`);
      const models = await vscode.lm.selectChatModels({ family: userModel });
      this.outputChannel.appendLine(`[LLM Proxy] User model matches found: ${models.length}`);
      if (models.length > 0) {
        this.cachedModel = models[0];
        this.analysisCoordinator?.markAnalysisStageWithRequestCount(`Using user-selected model: ${this.cachedModel.name}`);
        this.outputChannel.appendLine(`[LLM Proxy] Using user-selected model: ${this.cachedModel.name} (${this.cachedModel.vendor}/${this.cachedModel.family})`);
        return this.cachedModel;
      }
      this.analysisCoordinator?.markAnalysisStageWithRequestCount('User model not found, falling back to default selection...');
    }

    this.analysisCoordinator?.markAnalysisStageWithRequestCount('Discovering Copilot models (claude-sonnet-4.6)...');
    this.outputChannel.appendLine('[LLM Proxy] Selecting chat models...');

    let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'claude-sonnet-4.6' });
    this.outputChannel.appendLine(`[LLM Proxy] claude-sonnet-4.6 models found: ${models.length}`);

    if (models.length === 0) {
      this.analysisCoordinator?.markAnalysisStageWithRequestCount('No claude-sonnet-4.6 model found, trying any Copilot model...');
      models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      this.outputChannel.appendLine(`[LLM Proxy] Any Copilot models found: ${models.length}`);
    }

    if (models.length === 0) {
      this.analysisCoordinator?.markAnalysisStageWithRequestCount('No Copilot-only match, trying all available models...');
      models = await vscode.lm.selectChatModels();
      this.outputChannel.appendLine(`[LLM Proxy] Any models found: ${models.length}`);
    }

    if (models.length === 0) {
      this.analysisCoordinator?.markAnalysisStageWithRequestCount('No model available.');
      return undefined;
    }

    this.cachedModel = models[0];
    this.analysisCoordinator?.markAnalysisStageWithRequestCount(`Using model: ${this.cachedModel.name}`);
    this.outputChannel.appendLine(`[LLM Proxy] Using model: ${this.cachedModel.name} (${this.cachedModel.vendor}/${this.cachedModel.family})`);
    return this.cachedModel;
  }

  private async handleLLMProxyRequest(request: LLMProxyRequest): Promise<LLMProxyResponse> {
    const cts = new vscode.CancellationTokenSource();
    const timeout = setTimeout(() => cts.cancel(), ExtensionRuntime.LLM_REQUEST_TIMEOUT_MS);
    try {
      this.analysisCoordinator?.markAnalysisStageWithRequestCount('Preparing Copilot request payload...');
      const model = await this.selectModel();

      if (!model) {
        return { text: '{}', error: 'No language models available - sign in to GitHub Copilot' };
      }

      const messages = [
        vscode.LanguageModelChatMessage.User(request.systemPrompt + '\n\n' + request.prompt),
      ];

      this.analysisCoordinator?.markAnalysisStageWithRequestCount('Sending request to Copilot...');
      const response = await model.sendRequest(messages, {}, cts.token);

      this.analysisCoordinator?.markAnalysisStageWithRequestCount('Streaming Copilot response...');
      let text = '';
      let chunkCount = 0;
      for await (const part of response.text) {
        text += part;
        chunkCount += 1;
        if (chunkCount <= 3 || chunkCount % 10 === 0) {
          this.analysisCoordinator?.markAnalysisStageWithRequestCount(`Streaming Copilot response (chunk ${chunkCount})...`);
        }
      }

      this.analysisCoordinator?.markAnalysisStageWithRequestCount('Processing Copilot response...');

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
}

const runtime = new ExtensionRuntime();

export function activate(context: vscode.ExtensionContext): void {
  runtime.activate(context);
}

export function deactivate(): Thenable<void> | undefined {
  return runtime.deactivate();
}
