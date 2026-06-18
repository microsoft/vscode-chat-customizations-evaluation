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
  initializeWaza,
  registerWazaCommands,
} from './waza/waza';
import {
  ACTION_FIX_DIAGNOSTICS, NON_FIXABLE_DIAGNOSTIC_CODES,
  TELEMETRY_AUTH_TOKEN_ENV,
  TELEMETRY_ENDPOINT_ENV
} from './strings';
import type {
  LLMProxyRequest,
  LLMProxyResponse,
  SkillContext,
  TelemetryData
} from './types';
import { findSkillFilePath, inferSkillProjectRoot } from './waza/wazaUtils';
import { AnalysisCoordinator } from './analysisCoordinator';
import { FixDiagnosticsCoordinator } from './fixDiagnosticsCoordinator';
import { ExtensionTelemetrySender } from './telemetry';
import { UrlResolver } from './urlResolver';
import { ModelPicker } from './modelPicker';

const LLMRequestType = new RequestType<LLMProxyRequest, LLMProxyResponse, void>('chatCustomizationsEvaluations/llmRequest');
const NON_FIXABLE_DIAGNOSTIC_CODE_SET = new Set<string>(NON_FIXABLE_DIAGNOSTIC_CODES);

class ExtensionRuntime {

  private static readonly LLM_REQUEST_TIMEOUT_MS = 30_000;

  private client: LanguageClient | undefined;
  private outputChannel!: vscode.OutputChannel;
  private modelPicker!: ModelPicker;
  private extensionContext!: vscode.ExtensionContext;
  private telemetryLogger: vscode.TelemetryLogger | undefined;
  private analysisCoordinator!: AnalysisCoordinator;
  private fixDiagnosticsCoordinator!: FixDiagnosticsCoordinator;
  private extensionDiagnosticCollection!: vscode.DiagnosticCollection;
  private readonly urlResolver = new UrlResolver();
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
    this.registerCodeActionProvider(context);
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
      (request) => this.client!.sendRequest<{ duration: number; resultCount: number }>('chatCustomizationsEvaluations/analyze', request),
    );
    this.analysisCoordinator.initialize(context);
    this.fixDiagnosticsCoordinator = new FixDiagnosticsCoordinator({
      getDiagnosticsForUri: (uri) => this.getExtensionDiagnostics(uri),
      isNonFixableDiagnostic: (diagnostic) => this.isNonFixableDiagnostic(diagnostic),
      clearDiagnosticsForUri: (uri) => this.extensionDiagnosticCollection.set(uri, []),
      resolveSkillContextForUri: (uri) => this.resolveSkillContext({ uri }),
      logTelemetryUsage: (eventName, data) => this.logTelemetryUsage(eventName, data),
    });
    this.modelPicker = new ModelPicker(this.outputChannel);

    this.telemetryLogger = this.createExtensionTelemetryLogger(context);
    context.subscriptions.push(this.telemetryLogger);
    this.logTelemetryUsage('extension/activate', { workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0 });
  }

  private initializeWazaRuntime(): void {
    initializeWaza({
      extensionContext: this.extensionContext,
      outputChannel: this.outputChannel,
      getCustomizationUri: (obj) => this.urlResolver.getCustomizationUri(obj),
      requestLLM: async (request) => this.handleLLMProxyRequest(request),
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
        { scheme: 'vscode-userdata', language: 'prompt' },
        { scheme: 'vscode-userdata', language: 'chatagent' },
        { scheme: 'vscode-userdata', language: 'skill' },
        { scheme: 'vscode-userdata', language: 'instructions' },
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
    this.client.onRequest(LLMRequestType, async (request: LLMProxyRequest): Promise<LLMProxyResponse> => {
      this.outputChannel.appendLine('[LLM Proxy] Received request from server');
      try {
        const result = await this.handleLLMProxyRequest(request);
        if (result.error) {
          this.outputChannel.appendLine(`[LLM Proxy] Error: ${result.error}`);
        } else {
          this.outputChannel.appendLine(`[LLM Proxy] Success (${result.text.length} chars)`);
        }
        return result;
      } catch (error) {
        this.outputChannel.appendLine(`[LLM Proxy] Unexpected error: ${error}`);
        throw error;
      }
    });
  }

  private registerCodeActionProvider(context: vscode.ExtensionContext): void {
    const documentSelector: vscode.DocumentSelector = [
      { scheme: 'file', language: 'prompt' },
      { scheme: 'file', language: 'chatagent' },
      { scheme: 'file', language: 'skill' },
      { scheme: 'file', language: 'instructions' },
      { scheme: 'file', language: 'markdown', pattern: '**/AGENTS.md' },
      { scheme: 'vscode-userdata', language: 'prompt' },
      { scheme: 'vscode-userdata', language: 'chatagent' },
      { scheme: 'vscode-userdata', language: 'skill' },
      { scheme: 'vscode-userdata', language: 'instructions' },
    ];

    this.outputChannel.appendLine('[Code Actions] Registering code action provider');
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(documentSelector, {
        provideCodeActions: (document, range) => this.provideCodeActions(document, range),
      }, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
    );
  }

  private provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection): vscode.CodeAction[] {
    const allDiagnostics = this.getExtensionDiagnostics(document.uri);
    const fixableDiagnostics = allDiagnostics.filter(
      d => !this.isNonFixableDiagnostic(d) && this.rangesOverlap(d.range, range),
    );
    if (fixableDiagnostics.length === 0) {
      return [];
    }

    return fixableDiagnostics.map(diagnostic => {
      const action = new vscode.CodeAction(ACTION_FIX_DIAGNOSTICS, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.command = {
        command: 'chatCustomizationsEvaluations.fixDiagnostics',
        title: ACTION_FIX_DIAGNOSTICS,
        arguments: [[diagnostic]],
      };
      return action;
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
        this.analysisCoordinator?.handleDocumentClosed(document.uri);
      }),
    );
  }

  private registerModelHandlers(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.lm.onDidChangeChatModels(() => {
        this.modelPicker.clearCache();
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

  private registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('chatCustomizationsEvaluations.analyzePromptUsingSlashCommand', async (obj) => this.handleAnalyzePromptUsingSlashCommand(obj)),
      vscode.commands.registerCommand('chatCustomizationsEvaluations.analyzePrompt', async (obj) => this.analysisCoordinator.handleAnalyzePromptCommand({
        candidateUri: this.urlResolver.getCustomizationUri(obj),
        logTelemetryUsage: (eventName, data) => this.logTelemetryUsage(eventName, data),
        logTelemetryError: (eventName, error, data) => this.logTelemetryError(eventName, error, data)
      })),
      vscode.commands.registerCommand('chatCustomizationsEvaluations.fixDiagnostics', async (diagnostics?: vscode.Diagnostic[]) => this.fixDiagnosticsCoordinator.handleFixDiagnosticsCommand(diagnostics)),
      vscode.commands.registerCommand('chatCustomizationsEvaluations.analyzePromptFromCustomization', async (obj) => this.handleAnalyzePromptFromCustomizationCommand(obj)),
    );
  }

  private async handleAnalyzePromptUsingSlashCommand(obj?: unknown): Promise<void> {
    this.logTelemetryUsage('command/analyzePromptUsingSlashCommand');
    const uri = this.urlResolver.getCustomizationUri(obj) ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      this.logTelemetryUsage('command/analyzePromptUsingSlashCommand/result', { outcome: 'noActiveEditor' });
      return;
    }
    await this.openAnalyzePromptChat(uri);
    this.logTelemetryUsage('command/analyzePromptUsingSlashCommand/result', { outcome: 'openedChat' });
  }

  private async handleAnalyzePromptFromCustomizationCommand(obj: unknown): Promise<void> {
    this.logTelemetryUsage('command/analyzePromptFromCustomization');
    this.outputChannel.appendLine(`customization obj : ${JSON.stringify(obj)}`);
    const uri = this.urlResolver.getCustomizationUri(obj);
    if (!uri) {
      this.outputChannel.appendLine('[Analyze Prompt From Customization] Missing URI in command arguments');
      this.logTelemetryUsage('command/analyzePromptFromCustomization/result', { outcome: 'missingUri' });
      void vscode.window.showWarningMessage('Unable to analyze prompt: no URI was provided by the customization item.');
      return;
    }

    await this.openAnalyzePromptChat(uri);
    this.logTelemetryUsage('command/analyzePromptFromCustomization/result', { outcome: 'openedChat' });
  }

  private async openAnalyzePromptChat(targetUri?: vscode.Uri): Promise<void> {
    if (targetUri) {
      const document = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    }
    await vscode.commands.executeCommand('workbench.action.chat.newChat');
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: `/analyze-prompt ${targetUri?.toString() ?? ''}`,
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
    this.analysisCoordinator?.handleDocumentContentChanged(uri);
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

  private resolveSkillContext(obj: unknown): SkillContext | undefined {
    const uri = this.urlResolver.getCustomizationUri(obj) ?? vscode.window.activeTextEditor?.document.uri;
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

  private async handleLLMProxyRequest(request: LLMProxyRequest): Promise<LLMProxyResponse> {
    const cts = new vscode.CancellationTokenSource();
    const timeout = setTimeout(() => cts.cancel(), ExtensionRuntime.LLM_REQUEST_TIMEOUT_MS);
    try {
      const model = await this.modelPicker.selectModel();

      if (!model) {
        return { text: '{}', error: 'No language models available - sign in to GitHub Copilot' };
      } else {
        this.outputChannel.appendLine(`[LLM Proxy] Selected model: ${model.name} (${model.vendor}/${model.family})`);
      }

      const messages = this.buildLLMProxyMessages(request);

      const response = await model.sendRequest(messages, {}, cts.token);

      const text = await this.collectStreamedResponseText(response);

      if (!text.trim()) {
        const error = 'Language model returned an empty response.';
        this.outputChannel.appendLine(`[LLM Proxy] Error: ${error}`);
        return { text: '', error };
      }
      return { text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`[LLM Proxy] Error: ${message}`);
      return { text: '', error: `vscode.lm request failed: ${message}` };
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
  ): Promise<string> {

    let text = '';
    for await (const part of response.text) {
      text += part;
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
