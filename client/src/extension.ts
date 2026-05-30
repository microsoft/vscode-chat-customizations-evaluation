import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
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
} from './waza';
import {
  ACTION_ANALYZE_AGAIN, ACTION_INSTALL_WAZA_BINARY,
  ACTION_OPEN_WAZA_USER_GUIDE, NON_FIXABLE_DIAGNOSTIC_CODES,
  TELEMETRY_AUTH_TOKEN_ENV,
  TELEMETRY_ENDPOINT_ENV
} from './strings';
import type {
  AnalyzeRequest,
  CommandResult,
  CustomDiagnosticConfig, LLMProxyRequest,
  LLMProxyResponse,
  SkillContext,
  TelemetryData
} from './extensionTypes';
import { AnalysisCoordinator } from './analysisCoordinator';
import { ExtensionTelemetrySender } from './telemetry';

const LLMRequestType = new RequestType<LLMProxyRequest, LLMProxyResponse, void>('chatCustomizationsEvaluations/llmRequest');
const NON_FIXABLE_DIAGNOSTIC_CODE_SET = new Set<string>(NON_FIXABLE_DIAGNOSTIC_CODES);

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
      middleware: {
        handleDiagnostics: (uri, diagnostics, next) => {
          const uriKey = uri.toString();
          const pendingEdit = this.pendingDiagnosticEditsByUri.get(uriKey);
          const filteredDiagnostics = pendingEdit
            ? this.filterDiagnosticsForEdit(diagnostics, pendingEdit)
            : diagnostics;

          this.pendingDiagnosticEditsByUri.delete(uriKey);
          this.extensionDiagnosticCollection.set(uri, filteredDiagnostics);

          // Prevent duplicate display by routing diagnostics through the client-owned collection.
          next(uri, []);
        },
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
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.handleDocumentChangeForDiagnostics(event);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const uriKey = document.uri.toString();
        this.pendingDiagnosticEditsByUri.delete(uriKey);
        this.extensionDiagnosticCollection.delete(document.uri);
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

        await handlePostFixDiagnosticsFlow(skillContext);
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
