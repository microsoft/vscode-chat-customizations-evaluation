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
const WAZA_USER_GUIDE_FALLBACK = `# Waza User Guide

This guide explains how to use waza from the Chat Customizations Evaluations extension.

## What Is Waza?

Waza is a CLI for evaluating AI customizations (skills, agents, prompts, and instructions) using structured eval suites.

With this extension, you can:
- Create a starter eval scaffold for a customization.
- Run the eval and save the results to a JSON file.
- Open and review the saved results.
- Download and configure a local waza binary.

## Main Commands

- Chat Customizations Evaluations: Create Waza Eval Scaffold
- Chat Customizations Evaluations: Run Waza Evaluation
- Chat Customizations Evaluations: Download Waza Binary
- Chat Customizations Evaluations: Open Waza User Guide

## Typical Flow

1. Open a customization file (for example, SKILL.md).
2. Run Create Waza Eval Scaffold.
3. Review generated eval files and tasks.
4. Run Waza Evaluation.
5. Open results from the notification action or output panel link.

## Run Command Used By Extension

\`waza run <eval.yaml> --context-dir <skill-dir> --output <results-file.json>\`

## Grader Types (From Waza Docs)

Based on \`waza/docs/graders\`, documented grader types are:

- \`action_sequence\`
- \`behavior\`
- \`code\`
- \`diff\`
- \`file\`
- \`human\` (not implemented)
- \`human_calibration\` (not implemented)
- \`json_schema\`
- \`llm\` (not implemented)
- \`llm_comparison\` (not implemented)
- \`program\`
- \`prompt\`
- \`script\` (not implemented)
- \`skill_invocation\`
- \`text\`
- \`tool_calls\` (not implemented)
- \`tool_constraint\`
- \`trigger\`

Use implemented grader types for real runs. Not-implemented graders fail at runtime.

Examples:

### \`action_sequence\`

\`\`\`yaml
- type: action_sequence
  name: deployment-workflow
  config:
    matching_mode: in_order_match
    expected_actions:
      - "bash"
      - "edit"
      - "bash"
      - "report_progress"
\`\`\`

### \`behavior\`

\`\`\`yaml
- type: behavior
  name: token-budget
  config:
    max_tokens: 20000
    max_duration_ms: 120000
    max_tool_calls: 10
\`\`\`

### \`code\`

\`\`\`yaml
- type: code
  name: has-output
  config:
    assertions:
      - "len(output) > 20"
\`\`\`

### \`diff\`

\`\`\`yaml
- type: diff
  name: expected-config-edits
  config:
    expected_files:
      - path: "src/config.json"
        snapshot: "snapshots/config.json"
      - path: "README.md"
        contains:
          - "+## Installation"
          - "-pip install"
\`\`\`

### \`file\`

\`\`\`yaml
- type: file
  name: report-file-created
  config:
    must_exist:
      - "artifacts/report.json"
\`\`\`

### \`json_schema\`

\`\`\`yaml
- type: json_schema
  name: valid-structured-output
  config:
    schema:
      type: object
      required: ["summary", "confidence"]
      properties:
        summary:
          type: string
        confidence:
          type: number
\`\`\`

### \`program\`

\`\`\`yaml
- type: program
  name: custom-policy-checks
  config:
    command: "bash"
    args: ["./validators/check-output.sh"]
    timeout: 60
\`\`\`

### \`prompt\`

\`\`\`yaml
- type: prompt
  name: quality-judge
  config:
    model: gpt-4o-mini
    prompt: |
      Evaluate task completion quality.
      If requirements are met, call set_waza_grade_pass.
      Otherwise call set_waza_grade_fail with reasons.
\`\`\`

### \`skill_invocation\`

\`\`\`yaml
- type: skill_invocation
  name: orchestration-flow
  config:
    required_skills:
      - "azure-prepare"
      - "azure-deploy"
    mode: in_order
    allow_extra: true
\`\`\`

### \`text\`

\`\`\`yaml
- type: text
  name: no-runtime-errors
  config:
    regex_not_match:
      - "(?i)error|exception|traceback"
\`\`\`

### \`tool_constraint\`

\`\`\`yaml
- type: tool_constraint
  name: tool-guardrails
  config:
    expect_tools:
      - tool: "bash"
        command_pattern: "azd\\s+up"
    reject_tools:
      - tool: "bash"
        command_pattern: "rm\\s+-rf"
\`\`\`

### \`trigger\`

\`\`\`yaml
- type: trigger
  name: deploy-trigger
  config:
    skill_path: "skills/my-skill/SKILL.md"
    mode: positive
    threshold: 0.6
\`\`\`

## References

### eval.yaml pseudo structure

\`\`\`yaml
name: my-skill-eval
description: Behavior-focused evaluation for my skill.
skill: my-skill
version: "1.0"
config:
  trials_per_task: 1
  timeout_seconds: 300
  parallel: false
  executor: copilot-sdk
  model: claude-sonnet-4.6
metrics:
  - name: task_completion
    weight: 0.7
    threshold: 0.8
  - name: efficiency
    weight: 0.3
    threshold: 0.7
graders:
  - type: behavior
    name: token-budget
    config:
      max_tokens: 20000
      max_duration_ms: 120000
tasks:
  - "tasks/*.yaml"
\`\`\`

### eval.yaml possible fields

- \`name\`: Eval suite name shown in results.
- \`description\`: Human-readable purpose of this eval.
- \`skill\`: Target skill/customization name.
- \`version\`: Spec/version label for your suite.
- \`config\`: Runtime settings block for execution.
- \`config.trials_per_task\`: Number of runs per task.
- \`config.timeout_seconds\`: Per-task hard timeout.
- \`config.parallel\`: Run tasks concurrently when true.
- \`config.executor\`: Engine type (for example \`copilot-sdk\` or \`mock\`).
- \`config.model\`: Default model used for execution.
- \`config.workers\`: Max parallel workers.
- \`config.fail_fast\`: Stop after first hard failure.
- \`config.max_attempts\`: Retry attempts for failures.
- \`config.judge_model\`: Separate model for judging.
- \`config.skill_directories\`: Extra skill search paths.
- \`config.required_skills\`: Skills required to run.
- \`config.disabled_skills\`: Skills disabled for this run.
- \`config.mcp_servers\`: MCP server config map.
- \`metrics\`: List of metric definitions.
- \`metrics[].name\`: Metric identifier.
- \`metrics[].weight\`: Relative score contribution.
- \`metrics[].threshold\`: Pass expectation for that metric.
- \`metrics[].description\`: Metric intent.
- \`graders\`: Global validators applied to every task.
- \`graders[].type\`: Documented kinds: \`action_sequence\`, \`behavior\`, \`code\`, \`diff\`, \`file\`, \`human\` (not implemented), \`human_calibration\` (not implemented), \`json_schema\`, \`llm\` (not implemented), \`llm_comparison\` (not implemented), \`program\`, \`prompt\`, \`script\` (not implemented), \`skill_invocation\`, \`text\`, \`tool_calls\` (not implemented), \`tool_constraint\`, \`trigger\`.
- \`graders[].name\`: Unique grader identifier in results.
- \`graders[].config\`: Type-specific grader configuration block.
- \`tasks\`: Glob paths to task YAML files.
- \`hooks\`: Optional lifecycle commands.
- \`inputs\`: Global templated input variables.
- \`tasks_from\`: External file path for task definitions.
- \`range\`: Run only task index slice \`[start, end]\`.
- \`baseline\`: Enable baseline comparison mode.

### task YAML pseudo structure

\`\`\`yaml
id: positive-trigger-001
name: Positive Trigger 1
description: Ensure the skill triggers and produces expected behavior.
tags:
  - trigger
  - happy-path
inputs:
  prompt: "Generate a Python function normalize_email(email: str) -> str"
  files:
    - path: fixtures/sample.py
  context:
    scenario: basic
expected:
  should_trigger: true
  output_contains:
    - "normalize_email"
  output_not_contains:
    - "as an ai"
  behavior:
    max_tool_calls: 0
graders:
  - type: text
    name: has-python-shape
    config:
      regex_match:
        - "(?i)def\\s+normalize_email\\s*\\("
\`\`\`

### task YAML possible fields

- \`id\`: Unique task identifier used in output JSON.
- \`name\`: Task display name shown in reports.
- \`description\`: What the task is testing.
- \`tags\`: Labels for filtering and grouping.
- \`group\`: Optional group name in summaries.
- \`enabled\`: When false, task is skipped.
- \`inputs\`: Prompt and optional context/files for the run.
- \`inputs.prompt\`: Main user prompt.
- \`inputs.context\`: Structured key/value context.
- \`inputs.files\`: Fixture files copied into workspace.
- \`expected\`: High-level expectations.
- \`expected.should_trigger\`: Whether skill should trigger.
- \`expected.output_contains\`: Strings that must appear.
- \`expected.output_not_contains\`: Strings that must not appear.
- \`expected.outcomes\`: Expected semantic outcomes.
- \`expected.behavior\`: Behavior limits such as tool calls/duration.
- \`graders\`: Task-specific validators.
- \`graders[].type\`: Same supported types as eval-level graders.
- \`graders[].name\`: Task-level grader identifier.
- \`graders[].config\`: Type-specific task grader config.
- \`hooks\`: Optional per-task lifecycle commands.

## Notes

- The extension writes one results file per run (timestamped).
- Results files are JSON and can be diffed or archived.
`;

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

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface WazaAssetTarget {
  os: 'linux' | 'darwin' | 'windows';
  arch: 'amd64' | 'arm64';
  fileName: string;
}

interface GitHubRelease {
  tag_name?: string;
}

let client: LanguageClient;
let outputChannel: vscode.OutputChannel;
let cachedModel: vscode.LanguageModelChat | undefined;
let modelSelectionPromise: Promise<vscode.LanguageModelChat | undefined> | undefined;
let extensionContext: vscode.ExtensionContext;

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
    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.wazaCreateEval', async (obj) => {
      const context = resolveSkillContext(obj);
      if (!context) {
        void vscode.window.showWarningMessage('Open a SKILL.md file (or select a customization item) to create an eval scaffold.');
        return;
      }

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
      const resultText = `${result.stderr}\n${result.stdout}`;
      if (result.exitCode !== 0 && isWazaSkillLookupError(resultText)) {
        outputChannel.appendLine('[Waza] Workspace skill lookup failed; retrying with temporary canonical workspace...');
        finalResult = await runWazaScaffoldViaTempWorkspace(context, scaffoldCwd);
      }

      if (finalResult.exitCode !== 0) {
        outputChannel.appendLine(`[Waza] eval scaffold failed\n${finalResult.stderr || finalResult.stdout}`);
        void vscode.window.showErrorMessage('Failed to create waza eval scaffold. See "Chat Customizations Evaluations" output for details.');
        return;
      }

      outputChannel.appendLine(`[Waza] eval scaffold created for ${context.skillName}\n${finalResult.stdout}`);
      void vscode.window.showInformationMessage(`Created waza eval scaffold for ${context.skillName}.`);
    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.wazaRunEval', async (obj) => {
      const context = resolveSkillContext(obj);
      if (!context) {
        void vscode.window.showWarningMessage('Open a SKILL.md file (or select a customization item) to run waza evaluation.');
        return;
      }

      const evalPath = findEvalPath(context);
      if (!evalPath) {
        const action = await vscode.window.showWarningMessage(
          `No eval.yaml found for ${context.skillName}.`,
          'Create Eval'
        );

        if (action === 'Create Eval') {
          await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaCreateEval', obj);
        }
        return;
      }

      outputChannel.show(true);
      outputChannel.appendLine(`[Waza] Running evaluation for ${context.skillName}`);

      // Create a results directory for this evaluation
      const resultsDir = path.join(extensionContext.globalStorageUri.fsPath, 'results');
      await fs.promises.mkdir(resultsDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const resultsFile = path.join(resultsDir, `${context.skillName}-${timestamp}.json`);

      outputChannel.appendLine(`[Waza] Command: ${getWazaCommand()} run ${evalPath} --context-dir ${context.skillDirPath} --output ${resultsFile}`);

      const result = await runWazaCommand(
        ['run', evalPath, '--context-dir', context.skillDirPath, '--output', resultsFile],
        context.workspaceRoot,
      );

      if (result.stdout) {
        outputChannel.appendLine(result.stdout);
      }
      if (result.stderr) {
        outputChannel.appendLine(result.stderr);
      }

      if (result.exitCode !== 0) {
        void vscode.window.showErrorMessage('waza evaluation failed. See "Chat Customizations Evaluations" output for details.');
        return;
      }

      // Check if results file was created
      const resultsFileExists = fs.existsSync(resultsFile);
      const resultsUri = vscode.Uri.file(resultsFile);

      if (resultsFileExists) {
        // Format as clickable file URI with proper encoding
        const fileUri = resultsUri.toString();
        outputChannel.appendLine(`[Waza] Results saved to: ${fileUri}`);

        // Show notification with action to open results
        const action = await vscode.window.showInformationMessage(
          `waza evaluation completed for ${context.skillName}.`,
          'View Results'
        );

        if (action === 'View Results') {
          const document = await vscode.workspace.openTextDocument(resultsUri);
          await vscode.window.showTextDocument(document, { preview: false });
        }
      } else {
        void vscode.window.showInformationMessage(`waza evaluation completed for ${context.skillName}.`);
      }
    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.wazaDownloadBinary', async () => {
      try {
        outputChannel.show(true);
        outputChannel.appendLine('[Waza] Downloading latest waza binary...');

        const installPath = await downloadAndInstallWazaBinary();
        const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
        await configuration.update('waza.command', installPath, vscode.ConfigurationTarget.Global);

        outputChannel.appendLine(`[Waza] Installed to ${installPath}`);
        void vscode.window.showInformationMessage(`waza binary downloaded and configured: ${installPath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        outputChannel.appendLine(`[Waza] Download failed: ${message}`);
        void vscode.window.showErrorMessage(`Failed to download waza binary: ${message}`);
      }
    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.openWazaUserGuide', async () => {
      const guidePath = extensionContext.asAbsolutePath(path.join('docs', 'WAZA-USER-GUIDE.md'));
      let document: vscode.TextDocument;

      if (fs.existsSync(guidePath)) {
        const guideUri = vscode.Uri.file(guidePath);
        document = await vscode.workspace.openTextDocument(guideUri);
      } else {
        outputChannel.appendLine('[Waza] Guide file not found in extension package; opening built-in fallback guide.');
        document = await vscode.workspace.openTextDocument({
          content: WAZA_USER_GUIDE_FALLBACK,
          language: 'markdown',
        });
      }

      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
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

function detectWazaAssetTarget(): WazaAssetTarget {
  let os: WazaAssetTarget['os'];
  switch (process.platform) {
    case 'darwin':
      os = 'darwin';
      break;
    case 'linux':
      os = 'linux';
      break;
    case 'win32':
      os = 'windows';
      break;
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }

  let arch: WazaAssetTarget['arch'];
  switch (process.arch) {
    case 'x64':
      arch = 'amd64';
      break;
    case 'arm64':
      arch = 'arm64';
      break;
    default:
      throw new Error(`Unsupported architecture: ${process.arch}`);
  }

  const fileName = os === 'windows' ? `waza-${os}-${arch}.exe` : `waza-${os}-${arch}`;
  return { os, arch, fileName };
}

async function downloadAndInstallWazaBinary(): Promise<string> {
  const target = detectWazaAssetTarget();
  const tag = await fetchLatestWazaTag();
  const binaryUrl = `https://github.com/microsoft/waza/releases/download/${tag}/${target.fileName}`;
  const checksumsUrl = `https://github.com/microsoft/waza/releases/download/${tag}/checksums.txt`;

  const installDir = path.join(extensionContext.globalStorageUri.fsPath, 'bin');
  const binaryPath = path.join(installDir, target.os === 'windows' ? 'waza.exe' : 'waza');
  const tempDir = path.join(extensionContext.globalStorageUri.fsPath, 'tmp');
  const tempBinaryPath = path.join(tempDir, target.fileName);
  const tempChecksumsPath = path.join(tempDir, 'checksums.txt');

  await fs.promises.mkdir(installDir, { recursive: true });
  await fs.promises.mkdir(tempDir, { recursive: true });

  outputChannel.appendLine(`[Waza] Target platform: ${target.os}/${target.arch}`);
  outputChannel.appendLine(`[Waza] Release tag: ${tag}`);
  await downloadFile(binaryUrl, tempBinaryPath);
  await downloadFile(checksumsUrl, tempChecksumsPath);

  await verifyChecksum(tempBinaryPath, tempChecksumsPath, target.fileName);
  await fs.promises.copyFile(tempBinaryPath, binaryPath);
  if (target.os !== 'windows') {
    await fs.promises.chmod(binaryPath, 0o755);
  }

  return binaryPath;
}

async function fetchLatestWazaTag(): Promise<string> {
  const url = 'https://api.github.com/repos/microsoft/waza/releases';
  const payload = await httpGetText(url, {
    'User-Agent': 'vscode-chat-customizations-evaluation',
    'Accept': 'application/vnd.github+json',
  });

  let releases: GitHubRelease[];
  try {
    releases = JSON.parse(payload) as GitHubRelease[];
  } catch {
    throw new Error('Could not parse GitHub releases response');
  }

  const tag = releases.find(r => typeof r.tag_name === 'string' && r.tag_name.startsWith('v'))?.tag_name;
  if (!tag) {
    throw new Error('Could not determine latest waza release tag');
  }

  return tag;
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
  const data = await httpGetBuffer(url, {
    'User-Agent': 'vscode-chat-customizations-evaluation',
    'Accept': 'application/octet-stream',
  });
  await fs.promises.writeFile(destinationPath, data);
}

async function verifyChecksum(binaryPath: string, checksumsPath: string, fileName: string): Promise<void> {
  const checksums = await fs.promises.readFile(checksumsPath, 'utf8');
  const checksumLine = checksums.split(/\r?\n/).find(line => line.trim().endsWith(` ${fileName}`));
  if (!checksumLine) {
    throw new Error(`No checksum found for ${fileName}`);
  }

  const expected = checksumLine.trim().split(/\s+/)[0].toLowerCase();
  const actual = createHash('sha256').update(await fs.promises.readFile(binaryPath)).digest('hex').toLowerCase();
  if (expected !== actual) {
    throw new Error('Checksum verification failed');
  }
}

async function httpGetText(url: string, headers?: Record<string, string>): Promise<string> {
  const buffer = await httpGetBuffer(url, headers);
  return buffer.toString('utf8');
}

function httpGetBuffer(url: string, headers?: Record<string, string>, redirectCount = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many HTTP redirects'));
      return;
    }

    const request = https.get(url, { headers }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;

      if (status >= 300 && status < 400 && location) {
        response.resume();
        const redirected = new URL(location, url).toString();
        httpGetBuffer(redirected, headers, redirectCount + 1).then(resolve, reject);
        return;
      }

      if (status < 200 || status >= 300) {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          reject(new Error(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`));
        });
        return;
      }

      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });

    request.on('error', reject);
  });
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
const WAZA_CREATE_TIMEOUT_MS = 30_000;

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
