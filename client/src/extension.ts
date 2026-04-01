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

let client: LanguageClient;
let outputChannel: vscode.OutputChannel;
let cachedModel: vscode.LanguageModelChat | undefined;
let modelSelectionPromise: Promise<vscode.LanguageModelChat | undefined> | undefined;

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
      // Core prompt file types
      { scheme: 'file', pattern: '**/*.prompt.md' },
      { scheme: 'file', pattern: '**/*.agent.md' },
      { scheme: 'file', pattern: '**/*.prompt' },
      // Custom instructions
      { scheme: 'file', pattern: '**/*.instructions.md' },
      // Skills (Agent Skills standard + Claude legacy)
      { scheme: 'file', language: 'markdown', pattern: '**/.github/skills/**/SKILL.md' },
      { scheme: 'file', language: 'markdown', pattern: '**/.claude/skills/**/SKILL.md' },
      { scheme: 'file', language: 'markdown', pattern: '**/skills/**/*.md' },
      // Prompt folders
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
        // Send notification to server to trigger full analysis
        client.sendNotification('chatCustomizationsEvaluations/analyze', { uri: editor.document.uri.toString() });
        vscode.window.showInformationMessage('Running prompt analysis...');
      }
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
