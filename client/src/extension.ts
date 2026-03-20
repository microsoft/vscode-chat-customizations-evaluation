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

const LLMRequestType = new RequestType<LLMProxyRequest, LLMProxyResponse, void>('promptLSP/llmRequest');

let client: LanguageClient;
let outputChannel: vscode.OutputChannel;
let cachedModel: vscode.LanguageModelChat | undefined;
let modelSelectionPromise: Promise<vscode.LanguageModelChat | undefined> | undefined;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Prompt LSP');

  // Path to the server module (bundled for VSIX, parent dir for development)
  const bundledServer = context.asAbsolutePath(path.join('out', 'server.js'));
  const devServer = context.asAbsolutePath(path.join('..', 'out', 'server.js'));
  const serverModule = fs.existsSync(bundledServer) ? bundledServer : devServer;

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
      { scheme: 'file', pattern: '**/*.system.md' },
      { scheme: 'file', pattern: '**/*.agent.md' },
      { scheme: 'file', pattern: '**/*.prompt' },
      // Custom instructions
      { scheme: 'file', pattern: '**/*.instructions.md' },
      { scheme: 'file', pattern: '**/.github/copilot-instructions.md' },
      { scheme: 'file', pattern: '**/AGENTS.md' },
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
        vscode.workspace.createFileSystemWatcher('**/*.{prompt.md,system.md,agent.md,prompt,instructions.md}'),
        vscode.workspace.createFileSystemWatcher('**/skills/**/SKILL.md'),
        vscode.workspace.createFileSystemWatcher('**/AGENTS.md'),
        vscode.workspace.createFileSystemWatcher('**/.github/copilot-instructions.md'),
      ],
    },
    outputChannel,
  };

  // Create the language client
  client = new LanguageClient(
    'promptLSP',
    'Prompt LSP',
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
    vscode.commands.registerCommand('promptLSP.analyzePrompt', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        // Send notification to server to trigger full analysis
        client.sendNotification('promptLSP/analyze', { uri: editor.document.uri.toString() });
        vscode.window.showInformationMessage('Running prompt analysis (including LLM)...');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('promptLSP.noop', () => undefined)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('promptLSP.showTokenCount', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        try {
          const count = await client.sendRequest<number>('promptLSP/tokenCount', {
            uri: editor.document.uri.toString(),
          });
          vscode.window.showInformationMessage(
            `Token count: ${count} (${editor.document.getText().length} characters)`
          );
        } catch {
          const text = editor.document.getText();
          const estimatedTokens = Math.ceil(text.length / 4);
          vscode.window.showInformationMessage(
            `Estimated tokens: ~${estimatedTokens} (${text.length} characters)`
          );
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('promptLSP.clearCache', () => {
      // Send notification to server to clear cache
      client.sendNotification('promptLSP/clearCache');
      vscode.window.showInformationMessage('Analysis cache cleared.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('promptLSP.fixAllDiagnostics', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const uri = editor.document.uri;
      const allDiagnostics = vscode.languages.getDiagnostics(uri);

      // Analyzers and codes excluded from fixing
      const excludedAnalyzers = ['frontmatter-validation', 'variable-validation'];
      const excludedCodes = new Set([
        'llm-disabled', 'llm-error',
        'composition-unresolved', 'composition-missing',
        'undefined-variable', 'empty-variable',
      ]);

      const fixable = allDiagnostics.filter((d) => {
        if (!d.source?.startsWith('prompt-lsp')) return false;
        const analyzer = d.source.match(/\(([^)]+)\)/)?.[1];
        if (analyzer && excludedAnalyzers.includes(analyzer)) return false;
        const code = typeof d.code === 'object' ? String(d.code.value) : String(d.code ?? '');
        if (excludedCodes.has(code)) return false;
        return true;
      });

      if (fixable.length === 0) {
        vscode.window.showInformationMessage('No fixable diagnostics found in this file.');
        return;
      }

      const diagnosticInfo = fixable.map((d) => ({
        code: typeof d.code === 'object' ? String(d.code.value) : String(d.code ?? ''),
        message: d.message,
        line: d.range.start.line,
      }));

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fixing diagnostics...', cancellable: false },
        async () => {
          try {
            const result = await client.sendRequest<{ text: string | null; error?: string }>(
              'promptLSP/fixDiagnostics',
              { uri: uri.toString(), diagnostics: diagnosticInfo },
            );

            if (result.error) {
              vscode.window.showErrorMessage(`Fix failed: ${result.error}`);
              return;
            }

            if (result.text) {
              const edit = new vscode.WorkspaceEdit();
              const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(editor.document.getText().length),
              );
              edit.replace(uri, fullRange, result.text);
              await vscode.workspace.applyEdit(edit);
              vscode.window.showInformationMessage(`Fixed ${fixable.length} diagnostic(s). Use undo to revert.`);
            }
          } catch (err) {
            vscode.window.showErrorMessage(`Fix failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
          }
        },
      );
    })
  );

  // Create status bar item for token count
  const tokenStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  tokenStatusBar.command = 'promptLSP.showTokenCount';
  context.subscriptions.push(tokenStatusBar);

  // Update token count on active editor change
  let tokenUpdateTimer: ReturnType<typeof setTimeout> | undefined;

  // Dispose the debounce timer on deactivation
  context.subscriptions.push({ dispose: () => { if (tokenUpdateTimer) clearTimeout(tokenUpdateTimer); } });

  const updateTokenCount = () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && isPromptDocument(editor.document)) {
      const text = editor.document.getText();
      const estimatedTokens = Math.ceil(text.length / 4);
      tokenStatusBar.text = `$(symbol-number) ~${estimatedTokens} tokens`;
      tokenStatusBar.tooltip = 'Estimated token count (click for details)';
      tokenStatusBar.show();

      // Debounced accurate token count via LSP
      if (tokenUpdateTimer) clearTimeout(tokenUpdateTimer);
      const editorUri = editor.document.uri.toString();
      tokenUpdateTimer = setTimeout(async () => {
        try {
          const count = await client.sendRequest<number>('promptLSP/tokenCount', {
            uri: editorUri,
          });
          if (vscode.window.activeTextEditor?.document.uri.toString() === editorUri) {
            tokenStatusBar.text = `$(symbol-number) ${count} tokens`;
            tokenStatusBar.tooltip = 'Token count via tiktoken (click for details)';
          }
        } catch {
          // Server not ready or request failed, keep estimate
        }
      }, 300);
    } else {
      tokenStatusBar.hide();
    }
  };

  // Notify server of active document changes (LLM analysis only runs on active file)
  const notifyActiveDocument = (editor: vscode.TextEditor | undefined) => {
    if (editor && client.isRunning()) {
      client.sendNotification('promptLSP/activeDocumentChanged', { uri: editor.document.uri.toString() });
    }
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateTokenCount();
      notifyActiveDocument(editor);
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (vscode.window.activeTextEditor?.document === e.document) {
        updateTokenCount();
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
    // Send initial active document after client is ready
    notifyActiveDocument(vscode.window.activeTextEditor);
  });

  // Initial update
  updateTokenCount();

  console.log('Prompt LSP extension activated');
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

function isPromptDocument(document: vscode.TextDocument): boolean {
  const fileName = document.fileName.toLowerCase();
  const baseName = fileName.split(/[\/]/).pop() || '';
  return (
    document.languageId === 'prompt' ||
    fileName.endsWith('.prompt.md') ||
    fileName.endsWith('.system.md') ||
    fileName.endsWith('.agent.md') ||
    fileName.endsWith('.prompt') ||
    fileName.endsWith('.instructions.md') ||
    baseName === 'agents.md' ||
    baseName === 'copilot-instructions.md' ||
    isSkillMarkdown(fileName)
  );
}

function isSkillMarkdown(fileName: string): boolean {
  if (!fileName.endsWith('.md')) return false;
  return /(^|[\/])\.?(github|claude)[\/]skills[\/]/.test(fileName) ||
         /(^|[\/])skills[\/]/.test(fileName);
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
