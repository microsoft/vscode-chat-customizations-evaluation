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
const pendingAnalysisUris = new Set<string>();
const analysisStatesByUri = new Map<string, AnalysisState>();
let analysisStatusBarItem: vscode.StatusBarItem | undefined;

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
    analysisStatusBarItem.hide();
    return;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
  const activeState = activeUri ? analysisStatesByUri.get(activeUri) : undefined;
  const fallbackState = activeState ?? analysisStatesByUri.values().next().value as AnalysisState;
  const scope = runningCount > 1 ? ` (${runningCount} files)` : '';

  analysisStatusBarItem.text = `$(sync~spin) Analyze: ${fallbackState.stage}${scope}`;
  analysisStatusBarItem.tooltip = 'Chat Customizations Evaluations analysis in progress';
  analysisStatusBarItem.show();
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

async function completeAnalysis(uri: vscode.Uri, result: { duration: number; resultCount: number }): Promise<void> {
  const uriKey = uri.toString();
  const state = analysisStatesByUri.get(uriKey);
  if (state?.resolveProgress) {
    state.resolveProgress();
  }
  pendingAnalysisUris.delete(uriKey);
  analysisStatesByUri.delete(uriKey);
  updateAnalysisStatusBar();

  const durationText = state ? ` in ${formatDurationMs(result.duration)}` : '';
  if (result.resultCount === 0) {
    void vscode.window.showInformationMessage(`Analysis complete${durationText}: no issues found.`);
    return;
  }

  await notifyAndFocusProblems(uri, result.resultCount, durationText);
}
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

interface EvalScaffoldSummary {
  evalPath: string;
  createdFiles: string[];
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
  analysisStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  analysisStatusBarItem.name = 'Chat Customizations Evaluations Analysis Status';
  context.subscriptions.push(analysisStatusBarItem);

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
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const analyzeRequest: AnalyzeRequest = {
          uri: editor.document.uri.toString(),
          customDiagnostics: getCustomDiagnostics(),
        };

        beginAnalysis(editor.document.uri.toString());
        markAnalysisStage('Submitting analysis request...');
        // Send notification to server to trigger full analysis
        const result = client.sendRequest<{ duration: number; resultCount: number }>('chatCustomizationsEvaluations/analyze', analyzeRequest);
        await completeAnalysis(editor.document.uri, await result);
      }
    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.fixDiagnostics', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const targetUri = editor.document.uri;
      const initialText = editor.document.getText();
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: '/fix-customization-evaluation-diagnostics',
        isPartialQuery: false,
      });

      const hasImprovements = await waitForDocumentImprovements(targetUri, initialText, FIX_DIAGNOSTICS_IMPROVEMENT_TIMEOUT_MS);
      if (!hasImprovements) {
        return;
      }

      const skillContext = resolveSkillContext({ uri: targetUri });
      if (!skillContext) {
        return;
      }

      await handlePostFixDiagnosticsFlow(skillContext);
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

      beginAnalysis(uri.toString());
      markAnalysisStage('Submitting analysis request...');
      const result = client.sendRequest<{ duration: number; resultCount: number }>('chatCustomizationsEvaluations/analyze', analyzeRequest);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      
      await completeAnalysis(uri, await result);

      // Update context key based on the active editor
      updateHasDiagnosticsContext();

    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.wazaCreateEval', async (obj) => {
      const context = resolveSkillContext(obj);
      if (!context) {
        void vscode.window.showWarningMessage('Open a SKILL.md file (or select a customization item) to create an eval scaffold.');
        return;
      }

      const scaffold = await createWazaEvalScaffold(context);
      if (!scaffold) {
        return;
      }

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

      await runWazaEvaluationForContext(context, evalPath);
    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.wazaRunEvalFromFile', async () => {
      const editor = vscode.window.activeTextEditor;
      outputChannel.appendLine(`[Waza] wazaRunEvalFromFile called`);
      outputChannel.appendLine(`[Waza] Editor: ${editor ? 'exists' : 'null'}`);
      if (editor) {
        outputChannel.appendLine(`[Waza] Document fileName: ${editor.document.fileName}`);
        outputChannel.appendLine(`[Waza] Ends with eval.yaml: ${editor.document.fileName.endsWith('eval.yaml')}`);
      }

      if (!editor || !editor.document.fileName.endsWith('eval.yaml')) {
        void vscode.window.showWarningMessage('This command requires an eval.yaml file to be active.');
        return;
      }

      const evalUri = editor.document.uri;
      const evalDir = path.dirname(evalUri.fsPath);
      outputChannel.appendLine(`[Waza] Eval URI fsPath: ${evalUri.fsPath}`);
      outputChannel.appendLine(`[Waza] Eval dir: ${evalDir}`);

      // Find the skill directory by looking for SKILL.md
      const skillFilePath = findSkillFilePathFromEvalDir(evalDir);
      if (!skillFilePath) {
        outputChannel.appendLine(`[Waza] Could not find SKILL.md`);
        void vscode.window.showWarningMessage('Could not find SKILL.md associated with this eval.yaml file.');
        return;
      }

      const skillDirPath = path.dirname(skillFilePath);
      const skillName = path.basename(skillDirPath);
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(evalUri);
      const workspaceRoot = workspaceFolder?.uri.fsPath || path.dirname(skillDirPath);

      const context: SkillContext = {
        uri: evalUri,
        skillFilePath,
        skillDirPath,
        skillName,
        workspaceRoot,
      };

      await runWazaEvaluationForContext(context, evalUri.fsPath);
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

function getExtensionDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter(
    d => d.source?.startsWith('chat-customizations-evaluations')
  );
}

async function notifyAndFocusProblems(uri: vscode.Uri, resultCount: number, durationSuffix = ''): Promise<void> {
  void vscode.window.showInformationMessage(`Analysis complete${durationSuffix}: ${formatIssueSummary(resultCount)}.`);

  await vscode.commands.executeCommand('workbench.actions.view.problems');
  await vscode.commands.executeCommand('workbench.action.problems.focus');
  await vscode.commands.executeCommand('list.focusFirst');
  await vscode.commands.executeCommand('list.select');

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

async function runWazaEvaluationForContext(context: SkillContext, evalPath: string): Promise<void> {
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

function findSkillFilePathFromEvalDir(evalDir: string): string | undefined {
  // eval.yaml is typically at: <root>/evals/<skill-name>/eval.yaml
  // or <root>/.claude/evals/<skill-name>/eval.yaml
  // SKILL.md is typically at: <root>/skills/<skill-name>/SKILL.md
  // or <root>/.claude/skills/<skill-name>/SKILL.md

  // Extract the skill name from the eval directory (last component)
  const skillName = path.basename(evalDir);
  outputChannel.appendLine(`[Waza] Extracted skill name: ${skillName}`);

  // Start from eval directory and search upwards
  let current = evalDir;
  while (true) {
    // Look for SKILL.md directly (for standalone skills)
    const directCandidate = path.join(current, 'SKILL.md');
    outputChannel.appendLine(`[Waza] Searching for SKILL.md at: ${directCandidate}`);
    if (fs.existsSync(directCandidate)) {
      outputChannel.appendLine(`[Waza] Found SKILL.md at: ${directCandidate}`);
      return directCandidate;
    }

    // Look for skills directory at this level, then the skill subdirectory
    const evalsIndex = current.indexOf('/evals/');
    if (evalsIndex !== -1) {
      const beforeEvals = current.substring(0, evalsIndex);
      const skillsPath = path.join(beforeEvals, 'skills', skillName, 'SKILL.md');
      outputChannel.appendLine(`[Waza] Searching in parallel skills dir: ${skillsPath}`);
      if (fs.existsSync(skillsPath)) {
        outputChannel.appendLine(`[Waza] Found SKILL.md at: ${skillsPath}`);
        return skillsPath;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      outputChannel.appendLine(`[Waza] Reached filesystem root, no SKILL.md found`);
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

  outputChannel.appendLine('[Waza] waza command unavailable; downloading managed binary.');

  try {
    const installPath = await downloadAndInstallWazaBinary();
    const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
    await configuration.update('waza.command', installPath, vscode.ConfigurationTarget.Global);
    outputChannel.appendLine(`[Waza] Installed managed binary at ${installPath}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    outputChannel.appendLine(`[Waza] Failed to install managed binary: ${message}`);
    void vscode.window.showErrorMessage(`Failed to install waza binary: ${message}`);
    return false;
  }
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
  const resultText = `${result.stderr}\n${result.stdout}`;
  if (result.exitCode !== 0 && isWazaSkillLookupError(resultText)) {
    outputChannel.appendLine('[Waza] Workspace skill lookup failed; retrying with temporary canonical workspace...');
    finalResult = await runWazaScaffoldViaTempWorkspace(context, scaffoldCwd);
  }

  if (finalResult.exitCode !== 0) {
    outputChannel.appendLine(`[Waza] eval scaffold failed\n${finalResult.stderr || finalResult.stdout}`);
    void vscode.window.showErrorMessage('Failed to create waza eval scaffold. See "Chat Customizations Evaluations" output for details.');
    return undefined;
  }

  outputChannel.appendLine(`[Waza] eval scaffold created for ${context.skillName}\n${finalResult.stdout}`);

  const evalPath = findEvalPath(context);
  if (!evalPath) {
    return undefined;
  }

  const createdFiles = collectEvalScaffoldFiles(evalPath);
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

  markAnalysisStageWithRequestCount('Discovering Copilot models (gpt-4o)...');
  outputChannel.appendLine('[LLM Proxy] Selecting chat models...');

  let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
  outputChannel.appendLine(`[LLM Proxy] gpt-4o models found: ${models.length}`);

  if (models.length === 0) {
    markAnalysisStageWithRequestCount('No gpt-4o model found, trying any Copilot model...');
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
  if (!client) {
    return undefined;
  }
  return client.stop();
}
