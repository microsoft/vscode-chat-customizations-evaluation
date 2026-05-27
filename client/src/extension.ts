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

interface LLMProxyRequest {
  prompt: string;
  systemPrompt: string;
}

interface LLMProxyResponse {
  text: string;
  error?: string;
}

const LLMRequestType = new RequestType<LLMProxyRequest, LLMProxyResponse, void>('chatCustomizationsEvaluations/llmRequest');
const urisWithDiagnostics = new Set<string>();
const pendingAnalysisUris = new Set<string>();
const analysisStatesByUri = new Map<string, AnalysisState>();
let analysisStatusBarItem: vscode.StatusBarItem | undefined;
let statusBarCompletionMessage: string | undefined;
let statusBarCompletionTimer: ReturnType<typeof setTimeout> | undefined;

const STATUS_BAR_COMPLETION_DURATION_MS = 5000;
const ACTION_SHOW_PROBLEMS = 'Show Problems';
const ACTION_FIX_DIAGNOSTICS = 'Fix Diagnostics';
const ACTION_INSTALL_WAZA_BINARY = 'Install Waza Binary';
const ACTION_OPEN_WAZA_USER_GUIDE = 'Open Waza User Guide';
const TELEMETRY_ENDPOINT_ENV = 'CHAT_CUSTOMIZATIONS_EVALUATIONS_TELEMETRY_ENDPOINT';
const TELEMETRY_AUTH_TOKEN_ENV = 'CHAT_CUSTOMIZATIONS_EVALUATIONS_TELEMETRY_AUTH_TOKEN';

interface AnalysisState {
  startedAt: number;
  stage: string;
  llmRequestsInFlight: number;
  progressReporter?: vscode.Progress<{ message?: string; increment?: number }>;
  resolveProgress?: () => void;
}

function formatIssueSummary(count: number): string {
  return count === 1 ? '1 issue found' : `${count} issues found`;
}

function formatDurationMs(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `${seconds}s`;
}

function updateAnalysisStatusBar(): void {
  if (!analysisStatusBarItem) {
    return;
  }

  const runningCount = analysisStatesByUri.size;
  if (runningCount === 0) {
    if (statusBarCompletionMessage) {
      analysisStatusBarItem.text = statusBarCompletionMessage;
      analysisStatusBarItem.command = 'workbench.actions.view.problems';
      analysisStatusBarItem.tooltip = 'Click to open Problems panel';
      analysisStatusBarItem.show();
    } else {
      analysisStatusBarItem.command = undefined;
      analysisStatusBarItem.hide();
    }
    return;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
  const activeState = activeUri ? analysisStatesByUri.get(activeUri) : undefined;
  const fallbackState = activeState ?? analysisStatesByUri.values().next().value as AnalysisState;
  const scope = runningCount > 1 ? ` (${runningCount} files)` : '';

  analysisStatusBarItem.text = `$(sync~spin) Analyze: ${fallbackState.stage}${scope}`;
  analysisStatusBarItem.command = undefined;
  analysisStatusBarItem.tooltip = 'Chat Customizations Evaluations analysis in progress';
  analysisStatusBarItem.show();
}

function updateIsAnalyzingContext(): void {
  void vscode.commands.executeCommand('setContext', 'chatCustomizationsEvaluations.isAnalyzing', pendingAnalysisUris.size > 0);
}

function updateProgressNotificationMessage(uri: string): void {
  const state = analysisStatesByUri.get(uri);
  if (!state?.progressReporter) {
    return;
  }

  state.progressReporter.report({ message: state.stage });
}

function startProgressNotification(uri: string): void {
  const state = analysisStatesByUri.get(uri);
  if (!state) {
    return;
  }

  void vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Running prompt analysis',
      cancellable: false,
    },
    async (progress) => {
      const currentState = analysisStatesByUri.get(uri);
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

function beginAnalysis(uri: string): void {
  const existingState = analysisStatesByUri.get(uri);
  if (existingState?.resolveProgress) {
    existingState.resolveProgress();
  }

  pendingAnalysisUris.add(uri);
  analysisStatesByUri.set(uri, {
    startedAt: Date.now(),
    stage: 'Starting analysis...',
    llmRequestsInFlight: 0,
  });
  updateIsAnalyzingContext();
  startProgressNotification(uri);
  updateAnalysisStatusBar();
}

function markAnalysisStage(stage: string): void {
  if (analysisStatesByUri.size === 0) {
    return;
  }

  for (const [uri, state] of analysisStatesByUri.entries()) {
    state.stage = stage;
    updateProgressNotificationMessage(uri);
  }
  updateAnalysisStatusBar();
}

function markAnalysisStageWithRequestCount(stage: string): void {
  if (analysisStatesByUri.size === 0) {
    return;
  }

  for (const [uri, state] of analysisStatesByUri.entries()) {
    const requestScope = state.llmRequestsInFlight > 1
      ? ` (${state.llmRequestsInFlight} requests in flight)`
      : '';
    state.stage = `${stage}${requestScope}`;
    updateProgressNotificationMessage(uri);
  }
  updateAnalysisStatusBar();
}

function markLLMRequestStart(): void {
  if (analysisStatesByUri.size === 0) {
    return;
  }

  for (const [uri, state] of analysisStatesByUri.entries()) {
    state.llmRequestsInFlight += 1;
    const requestCount = state.llmRequestsInFlight;
    state.stage = requestCount > 1
      ? `Connecting to Copilot... (${requestCount} requests in flight)`
      : 'Connecting to Copilot...';
    updateProgressNotificationMessage(uri);
  }
  updateAnalysisStatusBar();
}

function markLLMRequestDone(): void {
  if (analysisStatesByUri.size === 0) {
    return;
  }

  for (const [uri, state] of analysisStatesByUri.entries()) {
    state.llmRequestsInFlight = Math.max(0, state.llmRequestsInFlight - 1);
    state.stage = state.llmRequestsInFlight > 0
      ? 'Waiting for Copilot responses...'
      : 'Finalizing diagnostics...';
    updateProgressNotificationMessage(uri);
  }
  updateAnalysisStatusBar();
}

function markDiagnosticsFound(uri: vscode.Uri, count: number): void {
  const uriKey = uri.toString();
  const state = analysisStatesByUri.get(uriKey);
  if (!state) {
    return;
  }

  state.stage = `Collecting results: ${formatIssueSummary(count)}`;
  updateProgressNotificationMessage(uriKey);
  updateAnalysisStatusBar();
}

const analysisSnapshotsByUri = new Map<string, AnalysisSnapshot>();

interface AnalysisSnapshot {
  fingerprint: string;
  resultCount: number;
}

function computeAnalysisFingerprint(document: vscode.TextDocument, customDiagnostics?: CustomDiagnosticConfig[]): string {
  return createHash('sha256')
    .update(document.getText())
    .update('\0')
    .update(JSON.stringify(customDiagnostics ?? []))
    .digest('hex');
}

function recordAnalysisSnapshot(document: vscode.TextDocument, customDiagnostics: CustomDiagnosticConfig[] | undefined, resultCount: number): void {
  analysisSnapshotsByUri.set(document.uri.toString(), {
    fingerprint: computeAnalysisFingerprint(document, customDiagnostics),
    resultCount,
  });
}

async function getCurrentAnalysisSnapshot(uri: vscode.Uri, customDiagnostics?: CustomDiagnosticConfig[]): Promise<{
  document: vscode.TextDocument;
  diagnostics: vscode.Diagnostic[];
  isFresh: boolean;
  resultCount: number | undefined;
}> {
  const document = await vscode.workspace.openTextDocument(uri);
  const cachedSnapshot = analysisSnapshotsByUri.get(uri.toString());
  const isFresh = cachedSnapshot?.fingerprint === computeAnalysisFingerprint(document, customDiagnostics);

  return {
    document,
    diagnostics: getExtensionDiagnostics(uri),
    isFresh,
    resultCount: cachedSnapshot?.resultCount,
  };
}

async function completeAnalysis(uri: vscode.Uri, result: { duration: number; resultCount: number }): Promise<void> {
  const uriKey = uri.toString();
  const state = analysisStatesByUri.get(uriKey);
  if (state?.resolveProgress) {
    state.resolveProgress();
  }
  pendingAnalysisUris.delete(uriKey);
  analysisStatesByUri.delete(uriKey);
  updateIsAnalyzingContext();

  const issueCount = result.resultCount;
  statusBarCompletionMessage = issueCount > 0
    ? `$(check) ${formatIssueSummary(issueCount)}`
    : `$(check) No issues`;
  if (statusBarCompletionTimer) {
    clearTimeout(statusBarCompletionTimer);
  }
  statusBarCompletionTimer = setTimeout(() => {
    statusBarCompletionMessage = undefined;
    statusBarCompletionTimer = undefined;
    updateAnalysisStatusBar();
  }, STATUS_BAR_COMPLETION_DURATION_MS);
  updateAnalysisStatusBar();

  const filename = path.basename(uri.fsPath);
  const durationText = state ? ` in ${formatDurationMs(result.duration)}` : '';
  if (result.resultCount === 0) {
    void vscode.window.showInformationMessage(`Analysis of ${filename} complete${durationText}: no issues found.`);
    return;
  }

  await notifyAndFocusProblems(uri, result.resultCount, filename, durationText);
}

interface CustomDiagnosticConfig {
  name: string;
  description: string;
}

interface AnalyzeRequest {
  uri: string;
  customDiagnostics?: CustomDiagnosticConfig[];
}

interface SkillContext {
  uri: vscode.Uri;
  skillFilePath: string;
  skillDirPath: string;
  skillName: string;
  workspaceRoot: string;
}

interface EvalScaffoldSummary {
  evalPath: string;
  createdFiles: string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let client: LanguageClient;
let outputChannel: vscode.OutputChannel;
let cachedModel: vscode.LanguageModelChat | undefined;
let modelSelectionPromise: Promise<vscode.LanguageModelChat | undefined> | undefined;
let extensionContext: vscode.ExtensionContext;
let telemetryLogger: vscode.TelemetryLogger | undefined;
type TelemetryData = Record<string, string | number | boolean | undefined>;

class ExtensionTelemetrySender implements vscode.TelemetrySender {
  constructor(
    private readonly endpoint: string | undefined,
    private readonly authToken: string | undefined,
    private readonly extensionVersion: string,
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
      outputChannel.appendLine(`[Telemetry] Failed to send telemetry: ${error.message}`);
    });

    request.write(body);
    request.end();
  }
}

function createExtensionTelemetryLogger(context: vscode.ExtensionContext): vscode.TelemetryLogger {
  const endpoint = process.env[TELEMETRY_ENDPOINT_ENV];
  const authToken = process.env[TELEMETRY_AUTH_TOKEN_ENV];
  if (!endpoint) {
    outputChannel.appendLine(
      `[Telemetry] ${TELEMETRY_ENDPOINT_ENV} is not set; telemetry events will be collected by VS Code but not exported by this extension sender.`
    );
  }
  const extensionVersion = String(context.extension.packageJSON.version ?? 'unknown');
  const sender = new ExtensionTelemetrySender(endpoint, authToken, extensionVersion);
  return vscode.env.createTelemetryLogger(sender, {
    additionalCommonProperties: {
      extensionVersion,
    },
  });
}

function logTelemetryUsage(eventName: string, data?: TelemetryData): void {
  telemetryLogger?.logUsage(eventName, data);
}

function logTelemetryError(eventName: string, error: unknown, data?: TelemetryData): void {
  telemetryLogger?.logError(eventName, {
    ...data,
    errorMessage: error instanceof Error ? error.message : String(error),
  });
}

function isUriLike(value: unknown): value is vscode.Uri {
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

function toUri(value: unknown): vscode.Uri | undefined {
  if (!value) {
    return undefined;
  }

  if (isUriLike(value)) {
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

function getCustomizationUri(obj: unknown): vscode.Uri | undefined {
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
    toUri(arg.uri)
    ?? toUri(arg.resourceUri)
    ?? toUri(arg.item?.uri)
    ?? toUri(arg.item?.resourceUri)
  );
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel('Chat Customizations Evaluations');
  telemetryLogger = createExtensionTelemetryLogger(context);
  context.subscriptions.push(telemetryLogger);
  analysisStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  analysisStatusBarItem.name = 'Chat Customizations Evaluations Analysis Status';
  context.subscriptions.push(analysisStatusBarItem);
  logTelemetryUsage('extension/activate', {
    workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
  });

  initializeWaza({
    extensionContext,
    outputChannel,
    getCustomizationUri,
    logTelemetryUsage,
    logTelemetryError,
  });

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    updateAnalysisStatusBar();
  }));

  outputChannel.appendLine(`[Activation] Extension path: ${context.extensionPath}`);

  // Path to the server module (bundled for VSIX, parent dir for development)
  const bundledServer = context.asAbsolutePath(path.join('out', 'server.js'));
  const devServer = context.asAbsolutePath(path.join('..', 'out', 'server.js'));
  const serverModule = fs.existsSync(bundledServer) ? bundledServer : devServer;

  outputChannel.appendLine(`[Activation] Server module: ${serverModule} (exists: ${fs.existsSync(serverModule)})`);

  // Debug options for the server
  const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

  // Server options - run the server module
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };

  // Client options
  const clientOptions: LanguageClientOptions = {
    // Register the server for prompt documents
    documentSelector: [
      { scheme: 'file', language: 'prompt' },
      { scheme: 'file', language: 'chatagent' },
      { scheme: 'file', language: 'skill' },
      { scheme: 'file', language: 'instructions' },
      { scheme: 'file', language: 'markdown', pattern: '**/AGENTS.md' },
    ],
    synchronize: {
      // Notify the server about file changes to prompt files
      fileEvents: [
        vscode.workspace.createFileSystemWatcher('**/*{prompt.md, agent.md, instructions.md, SKILL.md, AGENTS.md}')
      ],
    },
    outputChannel,
  };

  // Create the language client
  client = new LanguageClient(
    'chatCustomizationsEvaluations',
    'Chat Customizations Evaluations',
    serverOptions,
    clientOptions
  );

  // Show a popup dialog when the server notifies content is stale
  client.onNotification('chatCustomizationsEvaluations/contentStale', (_params: { uri: string }) => {
    logTelemetryUsage('analysis/contentStaleNotificationShown');
    void vscode.window.showInformationMessage('Content is stale. Run Analyze to update diagnostics.');
  });

  // Register the LLM proxy handler — the server will send requests here
  client.onRequest(LLMRequestType, async (request: LLMProxyRequest): Promise<LLMProxyResponse> => {
    markLLMRequestStart();
    outputChannel.appendLine('[LLM Proxy] Received request from server');
    try {
      const result = await handleLLMProxyRequest(request);
      if (result.error) {
        outputChannel.appendLine(`[LLM Proxy] Error: ${result.error}`);
      } else {
        outputChannel.appendLine(`[LLM Proxy] Success (${result.text.length} chars)`);
      }
      return result;
    } finally {
      markLLMRequestDone();
    }
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('chatCustomizationsEvaluations.analyzePrompt', async () => {
      logTelemetryUsage('command/analyzePrompt', { source: 'activeEditor' });
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        logTelemetryUsage('command/analyzePrompt/result', { outcome: 'noActiveEditor' });
        return;
      }
      if (pendingAnalysisUris.has(editor.document.uri.toString())) {
        logTelemetryUsage('command/analyzePrompt/result', { outcome: 'alreadyRunning' });
        return;
      }

      const analyzeRequest: AnalyzeRequest = {
        uri: editor.document.uri.toString(),
        customDiagnostics: getCustomDiagnostics(),
      };

      // Check if analysis is already fresh and show a message instead of rerunning
      const currentSnapshot = await getCurrentAnalysisSnapshot(editor.document.uri, analyzeRequest.customDiagnostics);
      if (currentSnapshot.isFresh) {
        if (currentSnapshot.diagnostics.length > 0) {
          await focusExistingDiagnostics(editor.document.uri);
          logTelemetryUsage('command/analyzePrompt/result', {
            outcome: 'alreadyCurrentWithDiagnostics',
            resultCount: currentSnapshot.diagnostics.length,
            customDiagnosticsCount: analyzeRequest.customDiagnostics?.length ?? 0,
          });
          vscode.window.showInformationMessage('Analysis is already up to date.');
          return;
        }
        await vscode.window.showTextDocument(currentSnapshot.document, { preview: false, preserveFocus: false });
        logTelemetryUsage('command/analyzePrompt/result', {
          outcome: 'alreadyCurrentNoIssues',
          resultCount: currentSnapshot.resultCount ?? 0,
          customDiagnosticsCount: analyzeRequest.customDiagnostics?.length ?? 0,
        });
        void vscode.window.showInformationMessage('Analysis is already up to date: no issues found.');
        return;
      }

      beginAnalysis(editor.document.uri.toString());
      markAnalysisStage('Submitting analysis request...');
      try {
        // Send request to server to trigger full analysis
        const result = await client.sendRequest<{ duration: number; resultCount: number }>('chatCustomizationsEvaluations/analyze', analyzeRequest);
        recordAnalysisSnapshot(editor.document, analyzeRequest.customDiagnostics, result.resultCount);
        logTelemetryUsage('command/analyzePrompt/result', {
          outcome: 'success',
          resultCount: result.resultCount,
          durationMs: result.duration,
          customDiagnosticsCount: analyzeRequest.customDiagnostics?.length ?? 0,
        });
        await completeAnalysis(editor.document.uri, result);
      } catch (error) {
        logTelemetryError('command/analyzePrompt/result', error, { outcome: 'failed' });
        void vscode.window.showErrorMessage('Prompt analysis failed. See output for details.');
      }
    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.fixDiagnostics', async () => {
      logTelemetryUsage('command/fixDiagnostics');
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'noActiveEditor' });
        return;
      }

      const targetUri = editor.document.uri;
      const initialText = editor.document.getText();
      const diagnostics = getExtensionDiagnostics(targetUri)
        .slice()
        .sort((a, b) => {
          if (a.range.start.line !== b.range.start.line) {
            return a.range.start.line - b.range.start.line;
          }
          return a.range.start.character - b.range.start.character;
        });

      if (diagnostics.length === 0) {
        logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'noDiagnostics' });
        void vscode.window.showInformationMessage('No diagnostics found for the active file. Run Analyze first.');
        return;
      }

      // Keep the target file focused so the chat skill has the correct file context.
      await vscode.window.showTextDocument(editor.document, { preview: false, preserveFocus: false });

      const query = buildFixDiagnosticsChatQuery(targetUri, diagnostics);
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query,
        isPartialQuery: false,
      });

      const hasImprovements = await waitForDocumentImprovements(targetUri, initialText, FIX_DIAGNOSTICS_IMPROVEMENT_TIMEOUT_MS);
      if (!hasImprovements) {
        logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'noChangesDetected' });
        return;
      }

      const skillContext = resolveSkillContext({ uri: targetUri });
      if (!skillContext) {
        logTelemetryUsage('command/fixDiagnostics/result', { outcome: 'noSkillContext' });
        return;
      }

      await handlePostFixDiagnosticsFlow(skillContext);
      logTelemetryUsage('command/fixDiagnostics/result', {
        outcome: 'success',
        diagnosticsCount: diagnostics.length,
      });
    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.analyzePromptFromCustomization', async (obj) => {
      logTelemetryUsage('command/analyzePromptFromCustomization');
      outputChannel.appendLine(`customization obj : ${JSON.stringify(obj)}`);
      const uri = getCustomizationUri(obj);
      if (!uri) {
        outputChannel.appendLine('[Analyze Prompt From Customization] Missing URI in command arguments');
        logTelemetryUsage('command/analyzePromptFromCustomization/result', { outcome: 'missingUri' });
        void vscode.window.showWarningMessage('Unable to analyze prompt: no URI was provided by the customization item.');
        return;
      }

      const analyzeRequest: AnalyzeRequest = {
        uri: uri.toString(),
        customDiagnostics: getCustomDiagnostics(),
      };

      const currentSnapshot = await getCurrentAnalysisSnapshot(uri, analyzeRequest.customDiagnostics);
      if (currentSnapshot.isFresh) {
        if (currentSnapshot.diagnostics.length > 0) {
          await focusExistingDiagnostics(uri);
          logTelemetryUsage('command/analyzePromptFromCustomization/result', {
            outcome: 'alreadyCurrentWithDiagnostics',
            resultCount: currentSnapshot.diagnostics.length,
            customDiagnosticsCount: analyzeRequest.customDiagnostics?.length ?? 0,
          });
          vscode.window.showInformationMessage('Analysis is already up to date.');
          return;
        }
        await vscode.window.showTextDocument(currentSnapshot.document, { preview: false, preserveFocus: false });
        logTelemetryUsage('command/analyzePromptFromCustomization/result', {
          outcome: 'alreadyCurrentNoIssues',
          resultCount: currentSnapshot.resultCount ?? 0,
          customDiagnosticsCount: analyzeRequest.customDiagnostics?.length ?? 0,
        });
        vscode.window.showInformationMessage('Analysis is already up to date: no issues found.');
        return;
      }

      beginAnalysis(uri.toString());
      markAnalysisStage('Submitting analysis request...');
      try {
        const result = await client.sendRequest<{ duration: number; resultCount: number }>('chatCustomizationsEvaluations/analyze', analyzeRequest);
        recordAnalysisSnapshot(currentSnapshot.document, analyzeRequest.customDiagnostics, result.resultCount);
        await vscode.window.showTextDocument(currentSnapshot.document, { preview: false, preserveFocus: false });

        await completeAnalysis(uri, result);
        logTelemetryUsage('command/analyzePromptFromCustomization/result', {
          outcome: 'success',
          resultCount: result.resultCount,
          durationMs: result.duration,
          customDiagnosticsCount: analyzeRequest.customDiagnostics?.length ?? 0,
        });

        // Update context key based on the active editor
        updateHasDiagnosticsContext();
      } catch (error) {
        logTelemetryError('command/analyzePromptFromCustomization/result', error, { outcome: 'failed' });
        void vscode.window.showErrorMessage('Prompt analysis failed. See output for details.');
      }

    }),
  );
  context.subscriptions.push(...registerWazaCommands(context));
  // Track diagnostics to toggle button between "Analyze Prompt" and "Fix Diagnostics"
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      for (const uri of e.uris) {
        const diagnostics = getExtensionDiagnostics(uri);
        if (diagnostics.length > 0) {
          urisWithDiagnostics.add(uri.toString());
        } else {
          urisWithDiagnostics.delete(uri.toString());
        }

        if (pendingAnalysisUris.has(uri.toString())) {
          markDiagnosticsFound(uri, diagnostics.length);
        }
      }
      // Update context key based on the active editor
      updateHasDiagnosticsContext();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateHasDiagnosticsContext();
    })
  );

  // Invalidate cached model when available models change
  if (vscode.lm && vscode.lm.onDidChangeChatModels) {
    context.subscriptions.push(
      vscode.lm.onDidChangeChatModels(() => {
        outputChannel.appendLine('[LLM Proxy] Models changed, clearing cache');
        cachedModel = undefined;
        modelSelectionPromise = undefined;
      })
    );
  }

  // Start the client
  client.start().then(() => {
    outputChannel.appendLine('[Activation] Language server started successfully');
    logTelemetryUsage('extension/languageServerStart', { outcome: 'success' });
  }).catch((err: Error) => {
    outputChannel.appendLine(`[Activation] Language server failed to start: ${err.message}`);
    logTelemetryError('extension/languageServerStart', err, { outcome: 'failed' });
    outputChannel.show(true);
  });

  console.log('Chat Customizations Evaluations extension activated');
}

function updateHasDiagnosticsContext(): void {
  const editor = vscode.window.activeTextEditor;
  const hasDiagnostics = editor ? urisWithDiagnostics.has(editor.document.uri.toString()) : false;
  vscode.commands.executeCommand('setContext', 'chatCustomizationsEvaluations.hasDiagnostics', hasDiagnostics);
}

function getExtensionDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter(
    d => d.source?.startsWith('chat-customizations-evaluations')
  );
}

function diagnosticCodeToString(code: vscode.Diagnostic['code']): string {
  if (code === undefined) {
    return 'n/a';
  }

  if (typeof code === 'string' || typeof code === 'number') {
    return String(code);
  }

  return String(code.value);
}

function buildFixDiagnosticsChatQuery(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): string {
  const payload = diagnostics.map((diagnostic) => {
    const startLine = diagnostic.range.start.line + 1;
    const endLine = diagnostic.range.end.line + 1;
    return [
      `- line: ${startLine}${endLine !== startLine ? `-${endLine}` : ''}`,
      `  code: ${diagnosticCodeToString(diagnostic.code)}`,
      `  severity: ${vscode.DiagnosticSeverity[diagnostic.severity] ?? 'Unknown'}`,
      `  message: ${diagnostic.message}`,
      `  suggestion: ${typeof diagnostic.message === 'string' ? diagnostic.message : 'n/a'}`,
    ].join('\n');
  }).join('\n');

  return [
    '/fix-customization-evaluation-diagnostics',
    `Target file: ${uri.fsPath}`,
    'Use ONLY the diagnostics below for this target file. Do not lint or rewrite the skill file itself.',
    'Diagnostics:',
    payload,
  ].join('\n\n');
}

async function notifyAndFocusProblems(uri: vscode.Uri, resultCount: number, filename: string, durationSuffix = ''): Promise<void> {
  const message = `Analysis of ${filename} complete${durationSuffix}: ${formatIssueSummary(resultCount)}.`;

  void (async () => {
    const action = await vscode.window.showInformationMessage(message, ACTION_SHOW_PROBLEMS, ACTION_FIX_DIAGNOSTICS);
    if (action === ACTION_SHOW_PROBLEMS) {
      await vscode.commands.executeCommand('workbench.actions.view.problems');
    } else if (action === ACTION_FIX_DIAGNOSTICS) {
      await vscode.commands.executeCommand('chatCustomizationsEvaluations.fixDiagnostics');
    }
  })();

  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
  const firstDiagnostic = getExtensionDiagnostics(uri)
    .slice()
    .sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) {
        return a.range.start.line - b.range.start.line;
      }
      return a.range.start.character - b.range.start.character;
    })[0];

  editor.selection = new vscode.Selection(firstDiagnostic.range.start, firstDiagnostic.range.start);
  editor.revealRange(firstDiagnostic.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function focusExistingDiagnostics(uri: vscode.Uri): Promise<boolean> {
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  const firstDiagnostic = getExtensionDiagnostics(uri)
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

function getCustomDiagnostics(): CustomDiagnosticConfig[] | undefined {
  const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
  const diagnostics = configuration.get<CustomDiagnosticConfig[]>('customDiagnostics', []);
  return diagnostics.length > 0 ? diagnostics : undefined;
}

function getWazaCommand(): string {
  const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
  return configuration.get<string>('waza.command', 'waza');
}

function getManagedWazaBinaryPath(): string {
  const fileName = process.platform === 'win32' ? 'waza.exe' : 'waza';
  return path.join(extensionContext.globalStorageUri.fsPath, 'bin', fileName);
}

function resolveSkillContext(obj: unknown): SkillContext | undefined {
  const uri = getCustomizationUri(obj) ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== 'file') {
    return undefined;
  }

  const skillFilePath = findSkillFilePath(uri.fsPath);
  if (!skillFilePath) {
    return undefined;
  }

  const skillDirPath = path.dirname(skillFilePath);
  const skillName = path.basename(skillDirPath);
  const workspaceRoot = inferSkillProjectRoot(uri, skillDirPath);

  return {
    uri,
    skillFilePath,
    skillDirPath,
    skillName,
    workspaceRoot,
  };
}

function inferSkillProjectRoot(uri: vscode.Uri, skillDirPath: string): string {
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

function findSkillFilePath(startPath: string): string | undefined {
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

function findEvalPath(context: SkillContext): string | undefined {
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
  outputChannel.appendLine(`[Waza] Looking for eval.yaml for ${context.skillName}`);
  for (const candidate of ordered) {
    outputChannel.appendLine(`[Waza] Eval candidate: ${candidate}`);
    if (fs.existsSync(candidate)) {
      outputChannel.appendLine(`[Waza] Using eval file: ${candidate}`);
      return candidate;
    }
  }

  return undefined;
}

function resolveWazaScaffoldCwd(context: SkillContext): string {
  const skillsDir = path.dirname(context.skillDirPath);
  if (path.basename(skillsDir) === 'skills') {
    // For layouts like `<root>/skills/<skill>/SKILL.md` (including hidden roots
    // such as `.claude/skills/...`), run from `<root>` so waza can resolve the
    // canonical `skills/<name>/SKILL.md` candidate.
    return path.dirname(skillsDir);
  }

  // For standalone layouts, run from the parent of the skill directory so
  // `<skill-name>/SKILL.md` is directly resolvable.
  return skillsDir;
}

function isWazaSkillLookupError(output: string): boolean {
  const lower = output.toLowerCase();
  return lower.includes('finding skill') && lower.includes('not found in workspace');
}

async function runWazaScaffoldViaTempWorkspace(context: SkillContext, scaffoldRoot: string): Promise<CommandResult> {
  const tempBase = path.join(extensionContext.globalStorageUri.fsPath, 'tmp-scaffold');
  await fs.promises.mkdir(tempBase, { recursive: true });

  const tempRoot = await fs.promises.mkdtemp(path.join(tempBase, 'waza-'));
  const tempSkillDir = path.join(tempRoot, 'skills', context.skillName);
  const targetEvalPath = path.join(scaffoldRoot, 'evals', context.skillName, 'eval.yaml');

  try {
    await fs.promises.mkdir(tempSkillDir, { recursive: true });
    await fs.promises.copyFile(context.skillFilePath, path.join(tempSkillDir, 'SKILL.md'));

    outputChannel.appendLine(`[Waza] Temp scaffold root: ${tempRoot}`);
    outputChannel.appendLine(`[Waza] Target eval output: ${targetEvalPath}`);

    return await runWazaCommand(
      ['new', 'eval', context.skillName, '--output', targetEvalPath],
      tempRoot,
      WAZA_CREATE_TIMEOUT_MS,
    );
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
}

function findLocalWazaRepo(startDir: string): string | undefined {
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

function shouldFallbackToLocalGo(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes('spawn') && lower.includes('enoent')
  ) || lower.includes('command not found') || lower.includes('executable file not found');
}

function isWazaUnavailableResult(result: CommandResult): boolean {
  if (result.exitCode === 0) {
    return false;
  }

  const output = `${result.stderr}\n${result.stdout}`;
  const lower = output.toLowerCase();
  return shouldFallbackToLocalGo(output) || lower.includes('go is not available on path for local fallback');
}

async function showWazaInstallPrompt(message: string): Promise<boolean> {
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

async function runWazaCommand(args: string[], cwd: string, timeoutMs?: number): Promise<CommandResult> {
  const configuredCommand = getWazaCommand();
  let result = await runCommand(configuredCommand, args, cwd, timeoutMs);

  if (result.exitCode === 0 || !shouldFallbackToLocalGo(result.stderr)) {
    return result;
  }

  const managedBinary = getManagedWazaBinaryPath();
  if (managedBinary !== configuredCommand && fs.existsSync(managedBinary)) {
    outputChannel.appendLine(`[Waza] Falling back to downloaded binary at ${managedBinary}`);
    result = await runCommand(managedBinary, args, cwd, timeoutMs);
    if (result.exitCode === 0 || !shouldFallbackToLocalGo(result.stderr)) {
      return result;
    }
  }

  const goAvailable = await isCommandAvailable('go');
  if (!goAvailable) {
    return {
      stdout: result.stdout,
      stderr: `${result.stderr}\nGo is not available on PATH for local fallback. Run "Chat Customizations Evaluations: Download Waza Binary" to install waza for this extension.`.trim(),
      exitCode: 1,
    };
  }

  const localWazaRepo = findLocalWazaRepo(cwd);
  if (!localWazaRepo) {
    return result;
  }

  outputChannel.appendLine(`[Waza] Falling back to local repo via go run in ${localWazaRepo}`);
  result = await runCommand('go', ['run', './cmd/waza', ...args], localWazaRepo, timeoutMs);
  return result;
}

async function isCommandAvailable(command: string): Promise<boolean> {
  const probe = await runCommand(command, ['--version'], extensionContext.globalStorageUri.fsPath, 5_000);
  return !shouldFallbackToLocalGo(probe.stderr);
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs?: number): Promise<CommandResult> {
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

function waitForDocumentImprovements(uri: vscode.Uri, initialText: string, timeoutMs: number): Promise<boolean> {
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

async function handlePostFixDiagnosticsFlow(context: SkillContext): Promise<void> {
  const evalPath = findEvalPath(context);
  if (evalPath) {
    await handleExistingEvalAfterFix(context, evalPath);
    return;
  }

  await handleMissingEvalAfterFix(context);
}

async function handleExistingEvalAfterFix(context: SkillContext, evalPath: string): Promise<void> {
  if (getAlwaysRunEvalsAfterFixDiagnostics()) {
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
    await setAlwaysRunEvalsAfterFixDiagnostics(true);
    await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaRunEval', { uri: context.uri });
    return;
  }

  if (action === runNow) {
    await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaRunEval', { uri: context.uri });
  }
}

async function handleMissingEvalAfterFix(context: SkillContext): Promise<void> {
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

  const ensured = await ensureWazaInstalled(context.workspaceRoot);
  if (!ensured) {
    return;
  }

  const summary = await createWazaEvalScaffold(context);
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

function getAlwaysRunEvalsAfterFixDiagnostics(): boolean {
  const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
  return configuration.get<boolean>('waza.alwaysRunAfterFixDiagnostics', false);
}

async function setAlwaysRunEvalsAfterFixDiagnostics(value: boolean): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
  await configuration.update('waza.alwaysRunAfterFixDiagnostics', value, vscode.ConfigurationTarget.Global);
}

async function ensureWazaInstalled(cwd: string): Promise<boolean> {
  const probe = await runWazaCommand(['--version'], cwd, 10_000);
  if (probe.exitCode === 0) {
    return true;
  }

  outputChannel.appendLine('[Waza] waza command unavailable; prompting for binary installation.');
  const installRequested = await showWazaInstallPrompt('waza is not installed or not available. Install the binary now?');
  if (!installRequested) {
    return false;
  }

  const postInstallProbe = await runWazaCommand(['--version'], cwd, 10_000);
  if (postInstallProbe.exitCode === 0) {
    return true;
  }

  void vscode.window.showErrorMessage('waza is still unavailable after installation attempt. See "Chat Customizations Evaluations" output for details.');
  return false;
}

async function createWazaEvalScaffold(context: SkillContext): Promise<EvalScaffoldSummary | undefined> {
  const scaffoldCwd = resolveWazaScaffoldCwd(context);
  outputChannel.show(true);
  outputChannel.appendLine(`[Waza] Creating eval scaffold for ${context.skillName}`);
  outputChannel.appendLine(`[Waza] Command: ${getWazaCommand()} new eval ${context.skillName}`);
  outputChannel.appendLine(`[Waza] CWD: ${scaffoldCwd}`);

  const result = await runWazaCommand(
    ['new', 'eval', context.skillName],
    scaffoldCwd,
    WAZA_CREATE_TIMEOUT_MS,
  );

  let finalResult = result;
  let usedTemporaryWorkspaceFallback = false;
  const resultText = `${result.stderr}\n${result.stdout}`;
  if (result.exitCode !== 0 && isWazaSkillLookupError(resultText)) {
    outputChannel.appendLine('[Waza] Workspace skill lookup failed; retrying with temporary canonical workspace...');
    finalResult = await runWazaScaffoldViaTempWorkspace(context, scaffoldCwd);
    usedTemporaryWorkspaceFallback = true;
  }

  if (finalResult.exitCode !== 0) {
    logTelemetryUsage('waza/createEvalScaffold/result', {
      outcome: 'failed',
      usedTemporaryWorkspaceFallback,
    });
    outputChannel.appendLine(`[Waza] eval scaffold failed\n${finalResult.stderr || finalResult.stdout}`);

    if (isWazaUnavailableResult(finalResult)) {
      await showWazaInstallPrompt('waza is not installed or not available. Install the binary now?');
      return undefined;
    }

    void vscode.window.showErrorMessage('Failed to create waza eval scaffold. See "Chat Customizations Evaluations" output for details.');
    return undefined;
  }

  outputChannel.appendLine(`[Waza] eval scaffold created for ${context.skillName}\n${finalResult.stdout}`);

  const evalPath = findEvalPath(context);
  if (!evalPath) {
    logTelemetryUsage('waza/createEvalScaffold/result', {
      outcome: 'missingEvalAfterSuccess',
      usedTemporaryWorkspaceFallback,
    });
    return undefined;
  }

  const createdFiles = collectEvalScaffoldFiles(evalPath);
  logTelemetryUsage('waza/createEvalScaffold/result', {
    outcome: 'success',
    usedTemporaryWorkspaceFallback,
    createdFileCount: createdFiles.length,
  });
  return { evalPath, createdFiles };
}

function collectEvalScaffoldFiles(evalPath: string): string[] {
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

/**
 * Handle LLM proxy requests from the language server using vscode.lm API.
 * This lets the extension use the user's Copilot subscription instead of requiring API keys.
 */
async function selectModel(): Promise<vscode.LanguageModelChat | undefined> {
  if (cachedModel) {
    return cachedModel;
  }

  // If another call is already selecting, wait for it
  if (modelSelectionPromise) {
    return modelSelectionPromise;
  }

  modelSelectionPromise = doSelectModel();
  try {
    return await modelSelectionPromise;
  } finally {
    modelSelectionPromise = undefined;
  }
}

async function doSelectModel(): Promise<vscode.LanguageModelChat | undefined> {
  if (!vscode.lm || !vscode.lm.selectChatModels) {
    return undefined;
  }

  const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
  const userModel = configuration.get<string>('model', '').trim();

  if (userModel) {
    markAnalysisStageWithRequestCount(`Looking for user-selected model: ${userModel}`);
    outputChannel.appendLine(`[LLM Proxy] Looking for user-selected model: ${userModel}`);
    const models = await vscode.lm.selectChatModels({ family: userModel });
    outputChannel.appendLine(`[LLM Proxy] User model matches found: ${models.length}`);
    if (models.length > 0) {
      cachedModel = models[0];
      markAnalysisStageWithRequestCount(`Using user-selected model: ${cachedModel.name}`);
      outputChannel.appendLine(`[LLM Proxy] Using user-selected model: ${cachedModel.name} (${cachedModel.vendor}/${cachedModel.family})`);
      return cachedModel;
    }
    markAnalysisStageWithRequestCount(`User model not found, falling back to default selection...`);
  }

  markAnalysisStageWithRequestCount('Discovering Copilot models (claude-sonnet-4.6)...');
  outputChannel.appendLine('[LLM Proxy] Selecting chat models...');

  let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'claude-sonnet-4.6' });
  outputChannel.appendLine(`[LLM Proxy] claude-sonnet-4.6 models found: ${models.length}`);

  if (models.length === 0) {
    markAnalysisStageWithRequestCount('No claude-sonnet-4.6 model found, trying any Copilot model...');
    models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    outputChannel.appendLine(`[LLM Proxy] Any Copilot models found: ${models.length}`);
  }

  if (models.length === 0) {
    markAnalysisStageWithRequestCount('No Copilot-only match, trying all available models...');
    models = await vscode.lm.selectChatModels();
    outputChannel.appendLine(`[LLM Proxy] Any models found: ${models.length}`);
  }

  if (models.length === 0) {
    markAnalysisStageWithRequestCount('No model available.');
    return undefined;
  }

  cachedModel = models[0];
  markAnalysisStageWithRequestCount(`Using model: ${cachedModel.name}`);
  outputChannel.appendLine(`[LLM Proxy] Using model: ${cachedModel.name} (${cachedModel.vendor}/${cachedModel.family})`);
  return cachedModel;
}

const LLM_REQUEST_TIMEOUT_MS = 30_000;
const WAZA_CREATE_TIMEOUT_MS = 30_000;
const FIX_DIAGNOSTICS_IMPROVEMENT_TIMEOUT_MS = 5 * 60_000;

async function handleLLMProxyRequest(request: LLMProxyRequest): Promise<LLMProxyResponse> {
  const cts = new vscode.CancellationTokenSource();
  const timeout = setTimeout(() => cts.cancel(), LLM_REQUEST_TIMEOUT_MS);
  try {
    markAnalysisStageWithRequestCount('Preparing Copilot request payload...');
    const model = await selectModel();

    if (!model) {
      return { text: '{}', error: 'No language models available — sign in to GitHub Copilot' };
    }

    // Build messages
    const messages = [
      vscode.LanguageModelChatMessage.User(request.systemPrompt + '\n\n' + request.prompt),
    ];

    // Send the request
    markAnalysisStageWithRequestCount('Sending request to Copilot...');
    const response = await model.sendRequest(messages, {}, cts.token);

    // Collect the streamed response
    markAnalysisStageWithRequestCount('Streaming Copilot response...');
    let text = '';
    let chunkCount = 0;
    for await (const part of response.text) {
      text += part;
      chunkCount += 1;
      if (chunkCount <= 3 || chunkCount % 10 === 0) {
        markAnalysisStageWithRequestCount(`Streaming Copilot response (chunk ${chunkCount})...`);
      }
    }

    markAnalysisStageWithRequestCount('Processing Copilot response...');

    return { text };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    outputChannel.appendLine(`[LLM Proxy] Error: ${message}`);
    return { text: '{}', error: `vscode.lm request failed: ${message}` };
  } finally {
    clearTimeout(timeout);
    cts.dispose();
  }
}

export function deactivate(): Thenable<void> | undefined {
  if (statusBarCompletionTimer) {
    clearTimeout(statusBarCompletionTimer);
  }
  logTelemetryUsage('extension/deactivate');
  telemetryLogger?.dispose();
  if (!client) {
    return undefined;
  }
  return client.stop();
}
