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

interface CustomDiagnosticConfig {
  name: string;
  description: string;
}

interface AnalyzeRequest {
  uri: string;
  customDiagnostics?: CustomDiagnosticConfig[];
}

let client: LanguageClient;
let outputChannel: vscode.OutputChannel;
let cachedModel: vscode.LanguageModelChat | undefined;
let modelSelectionPromise: Promise<vscode.LanguageModelChat | undefined> | undefined;

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
  outputChannel = vscode.window.createOutputChannel('Chat Customizations Evaluations');

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
      { scheme: 'file', language: 'agent' },
      { scheme: 'file', language: 'skill' },
      { scheme: 'file', language: 'instructions' },
      { scheme: 'file', language: 'markdown', pattern: '**/prompts/**/*.md' },
    ],
    synchronize: {
      // Notify the server about file changes to prompt files
      fileEvents: [
        vscode.workspace.createFileSystemWatcher('**/*.{prompt.md,agent.md,prompt,instructions.md}'),
        vscode.workspace.createFileSystemWatcher('**/skills/**/SKILL.md'),
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

  // Register the LLM proxy handler — the server will send requests here
  client.onRequest(LLMRequestType, async (request: LLMProxyRequest): Promise<LLMProxyResponse> => {
    outputChannel.appendLine('[LLM Proxy] Received request from server');
    const result = await handleLLMProxyRequest(request);
    if (result.error) {
      outputChannel.appendLine(`[LLM Proxy] Error: ${result.error}`);
    } else {
      outputChannel.appendLine(`[LLM Proxy] Success (${result.text.length} chars)`);
    }
    return result;
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('chatCustomizationsEvaluations.analyzePrompt', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const analyzeRequest: AnalyzeRequest = {
          uri: editor.document.uri.toString(),
          customDiagnostics: getCustomDiagnostics(),
        };

        // Send notification to server to trigger full analysis
        client.sendNotification('chatCustomizationsEvaluations/analyze', analyzeRequest);
        vscode.window.showInformationMessage('Running prompt analysis...');
      }
    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.fixDiagnostics', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: '/fix-customization-evaluation-diagnostics',
        isPartialQuery: false,
      });
    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.analyzePromptFromCustomization', async (obj) => {
      outputChannel.appendLine(`customization obj : ${JSON.stringify(obj)}`);
      const uri = getCustomizationUri(obj);
      if (!uri) {
        outputChannel.appendLine('[Analyze Prompt From Customization] Missing URI in command arguments');
        void vscode.window.showWarningMessage('Unable to analyze prompt: no URI was provided by the customization item.');
        return;
      }

      const analyzeRequest: AnalyzeRequest = {
        uri: uri.toString(),
        customDiagnostics: getCustomDiagnostics(),
      };

      client.sendNotification('chatCustomizationsEvaluations/analyze', analyzeRequest);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      void vscode.window.showInformationMessage('Running prompt analysis...');
    })
  );
  // Track diagnostics to toggle button between "Analyze Prompt" and "Fix Diagnostics"
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      for (const uri of e.uris) {
        const diagnostics = vscode.languages.getDiagnostics(uri).filter(
          d => d.source?.startsWith('chat-customizations-evaluations')
        );
        if (diagnostics.length > 0) {
          urisWithDiagnostics.add(uri.toString());
        } else {
          urisWithDiagnostics.delete(uri.toString());
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
  }).catch((err: Error) => {
    outputChannel.appendLine(`[Activation] Language server failed to start: ${err.message}`);
    outputChannel.show(true);
  });

  console.log('Chat Customizations Evaluations extension activated');
}

function updateHasDiagnosticsContext(): void {
  const editor = vscode.window.activeTextEditor;
  const hasDiagnostics = editor ? urisWithDiagnostics.has(editor.document.uri.toString()) : false;
  vscode.commands.executeCommand('setContext', 'chatCustomizationsEvaluations.hasDiagnostics', hasDiagnostics);
}

function getCustomDiagnostics(): CustomDiagnosticConfig[] | undefined {
  const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
  const diagnostics = configuration.get<CustomDiagnosticConfig[]>('customDiagnostics', []);
  return diagnostics.length > 0 ? diagnostics : undefined;
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

  outputChannel.appendLine('[LLM Proxy] Selecting chat models...');

  let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
  outputChannel.appendLine(`[LLM Proxy] gpt-4o models found: ${models.length}`);

  if (models.length === 0) {
    models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    outputChannel.appendLine(`[LLM Proxy] Any Copilot models found: ${models.length}`);
  }

  if (models.length === 0) {
    models = await vscode.lm.selectChatModels();
    outputChannel.appendLine(`[LLM Proxy] Any models found: ${models.length}`);
  }

  if (models.length === 0) {
    return undefined;
  }

  cachedModel = models[0];
  outputChannel.appendLine(`[LLM Proxy] Using model: ${cachedModel.name} (${cachedModel.vendor}/${cachedModel.family})`);
  return cachedModel;
}

const LLM_REQUEST_TIMEOUT_MS = 30_000;

async function handleLLMProxyRequest(request: LLMProxyRequest): Promise<LLMProxyResponse> {
  const cts = new vscode.CancellationTokenSource();
  const timeout = setTimeout(() => cts.cancel(), LLM_REQUEST_TIMEOUT_MS);
  try {
    const model = await selectModel();

    if (!model) {
      return { text: '{}', error: 'No language models available — sign in to GitHub Copilot' };
    }

    // Build messages
    const messages = [
      vscode.LanguageModelChatMessage.User(request.systemPrompt + '\n\n' + request.prompt),
    ];

    // Send the request
    const response = await model.sendRequest(messages, {}, cts.token);

    // Collect the streamed response
    let text = '';
    for await (const part of response.text) {
      text += part;
    }

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
  if (!client) {
    return undefined;
  }
  return client.stop();
}
