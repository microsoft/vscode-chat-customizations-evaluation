import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as https from 'https';
import * as vscode from 'vscode';

export type TelemetryData = Record<string, string | number | boolean | undefined>;

export interface SkillContext {
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

interface WazaDependencies {
  extensionContext: vscode.ExtensionContext;
  outputChannel: vscode.OutputChannel;
  getCustomizationUri: (obj: unknown) => vscode.Uri | undefined;
  logTelemetryUsage: (eventName: string, data?: TelemetryData) => void;
  logTelemetryError: (eventName: string, error: unknown, data?: TelemetryData) => void;
}

let deps: WazaDependencies | undefined;

const WAZA_CREATE_TIMEOUT_MS = 30_000;
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

export function initializeWaza(wazaDeps: WazaDependencies): void {
  deps = wazaDeps;
}

function requireDeps(): WazaDependencies {
  if (!deps) {
    throw new Error('Waza module is not initialized');
  }

  return deps;
}

export function registerWazaCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('chatCustomizationsEvaluations.wazaCreateEval', async (obj) => {
      const { logTelemetryUsage } = requireDeps();
      logTelemetryUsage('command/wazaCreateEval');
      const skillContext = resolveSkillContext(obj);
      if (!skillContext) {
        logTelemetryUsage('command/wazaCreateEval/result', { outcome: 'noSkillContext' });
        void vscode.window.showWarningMessage('Open a SKILL.md file (or select a customization item) to create an eval scaffold.');
        return;
      }

      const scaffold = await createWazaEvalScaffold(skillContext);
      if (!scaffold) {
        logTelemetryUsage('command/wazaCreateEval/result', { outcome: 'failed' });
        return;
      }

      logTelemetryUsage('command/wazaCreateEval/result', { outcome: 'success' });
      void vscode.window.showInformationMessage(`Created waza eval scaffold for ${skillContext.skillName}.`);
    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.wazaRunEval', async (obj) => {
      const { logTelemetryUsage } = requireDeps();
      logTelemetryUsage('command/wazaRunEval');
      const skillContext = resolveSkillContext(obj);
      if (!skillContext) {
        logTelemetryUsage('command/wazaRunEval/result', { outcome: 'noSkillContext' });
        void vscode.window.showWarningMessage('Open a SKILL.md file (or select a customization item) to run waza evaluation.');
        return;
      }

      const evalPath = findEvalPath(skillContext);
      if (!evalPath) {
        logTelemetryUsage('command/wazaRunEval/result', { outcome: 'missingEval' });
        const action = await vscode.window.showWarningMessage(
          `No eval.yaml found for ${skillContext.skillName}.`,
          'Create Eval'
        );

        if (action === 'Create Eval') {
          await vscode.commands.executeCommand('chatCustomizationsEvaluations.wazaCreateEval', obj);
        }
        return;
      }

      await runWazaEvaluationForContext(skillContext, evalPath);
    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.wazaRunEvalFromFile', async () => {
      const { outputChannel, logTelemetryUsage } = requireDeps();
      logTelemetryUsage('command/wazaRunEvalFromFile');
      const editor = vscode.window.activeTextEditor;
      outputChannel.appendLine('[Waza] wazaRunEvalFromFile called');
      outputChannel.appendLine(`[Waza] Editor: ${editor ? 'exists' : 'null'}`);
      if (editor) {
        outputChannel.appendLine(`[Waza] Document fileName: ${editor.document.fileName}`);
        outputChannel.appendLine(`[Waza] Ends with eval.yaml: ${editor.document.fileName.endsWith('eval.yaml')}`);
      }

      if (!editor || !editor.document.fileName.endsWith('eval.yaml')) {
        logTelemetryUsage('command/wazaRunEvalFromFile/result', { outcome: 'invalidActiveFile' });
        void vscode.window.showWarningMessage('This command requires an eval.yaml file to be active.');
        return;
      }

      const evalUri = editor.document.uri;
      const evalDir = path.dirname(evalUri.fsPath);
      outputChannel.appendLine(`[Waza] Eval URI fsPath: ${evalUri.fsPath}`);
      outputChannel.appendLine(`[Waza] Eval dir: ${evalDir}`);

      const skillFilePath = findSkillFilePathFromEvalDir(evalDir);
      if (!skillFilePath) {
        outputChannel.appendLine('[Waza] Could not find SKILL.md');
        logTelemetryUsage('command/wazaRunEvalFromFile/result', { outcome: 'missingSkillFile' });
        void vscode.window.showWarningMessage('Could not find SKILL.md associated with this eval.yaml file.');
        return;
      }

      const skillDirPath = path.dirname(skillFilePath);
      const skillName = path.basename(skillDirPath);
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(evalUri);
      const workspaceRoot = workspaceFolder?.uri.fsPath || path.dirname(skillDirPath);

      const skillContext: SkillContext = {
        uri: evalUri,
        skillFilePath,
        skillDirPath,
        skillName,
        workspaceRoot,
      };

      await runWazaEvaluationForContext(skillContext, evalUri.fsPath);
    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.wazaDownloadBinary', async () => {
      const { outputChannel, logTelemetryUsage, logTelemetryError } = requireDeps();
      logTelemetryUsage('command/wazaDownloadBinary');
      try {
        outputChannel.show(true);
        outputChannel.appendLine('[Waza] Downloading latest waza binary...');

        const installPath = await downloadAndInstallWazaBinary();
        const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
        await configuration.update('waza.command', installPath, vscode.ConfigurationTarget.Global);

        outputChannel.appendLine(`[Waza] Installed to ${installPath}`);
        logTelemetryUsage('command/wazaDownloadBinary/result', { outcome: 'success' });
        void vscode.window.showInformationMessage(`waza binary downloaded and configured: ${installPath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        outputChannel.appendLine(`[Waza] Download failed: ${message}`);
        logTelemetryError('command/wazaDownloadBinary/result', error, { outcome: 'failed' });
        void vscode.window.showErrorMessage(`Failed to download waza binary: ${message}`);
      }
    }),
    vscode.commands.registerCommand('chatCustomizationsEvaluations.openWazaUserGuide', async () => {
      const { extensionContext, outputChannel, logTelemetryUsage } = requireDeps();
      logTelemetryUsage('command/openWazaUserGuide');
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
    }),
  ];
}

export function resolveSkillContext(obj: unknown): SkillContext | undefined {
  const { getCustomizationUri } = requireDeps();
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

export async function handlePostFixDiagnosticsFlow(context: SkillContext): Promise<void> {
  const evalPath = findEvalPath(context);
  if (evalPath) {
    await handleExistingEvalAfterFix(context, evalPath);
    return;
  }

  await handleMissingEvalAfterFix(context);
}

function getWazaCommand(): string {
  const configuration = vscode.workspace.getConfiguration('chatCustomizationsEvaluations');
  return configuration.get<string>('waza.command', 'waza');
}

function getManagedWazaBinaryPath(): string {
  const { extensionContext } = requireDeps();
  const fileName = process.platform === 'win32' ? 'waza.exe' : 'waza';
  return path.join(extensionContext.globalStorageUri.fsPath, 'bin', fileName);
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
  const { outputChannel } = requireDeps();
  const skillName = path.basename(evalDir);
  outputChannel.appendLine(`[Waza] Extracted skill name: ${skillName}`);

  let current = evalDir;
  while (true) {
    const directCandidate = path.join(current, 'SKILL.md');
    outputChannel.appendLine(`[Waza] Searching for SKILL.md at: ${directCandidate}`);
    if (fs.existsSync(directCandidate)) {
      outputChannel.appendLine(`[Waza] Found SKILL.md at: ${directCandidate}`);
      return directCandidate;
    }

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
      outputChannel.appendLine('[Waza] Reached filesystem root, no SKILL.md found');
      return undefined;
    }
    current = parent;
  }
}

function findEvalPath(context: SkillContext): string | undefined {
  const { outputChannel } = requireDeps();
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

  outputChannel.appendLine(`[Waza] Looking for eval.yaml for ${context.skillName}`);
  for (const candidate of candidates) {
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
    return path.dirname(skillsDir);
  }

  return skillsDir;
}

function isWazaSkillLookupError(output: string): boolean {
  const lower = output.toLowerCase();
  return lower.includes('finding skill') && lower.includes('not found in workspace');
}

async function runWazaScaffoldViaTempWorkspace(context: SkillContext, scaffoldRoot: string): Promise<CommandResult> {
  const { extensionContext, outputChannel } = requireDeps();
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
  const { extensionContext, outputChannel } = requireDeps();
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
    Accept: 'application/vnd.github+json',
  });

  let releases: GitHubRelease[];
  try {
    releases = JSON.parse(payload) as GitHubRelease[];
  } catch {
    throw new Error('Could not parse GitHub releases response');
  }

  const tag = releases.find((r) => typeof r.tag_name === 'string' && r.tag_name.startsWith('v'))?.tag_name;
  if (!tag) {
    throw new Error('Could not determine latest waza release tag');
  }

  return tag;
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
  const data = await httpGetBuffer(url, {
    'User-Agent': 'vscode-chat-customizations-evaluation',
    Accept: 'application/octet-stream',
  });
  await fs.promises.writeFile(destinationPath, data);
}

async function verifyChecksum(binaryPath: string, checksumsPath: string, fileName: string): Promise<void> {
  const checksums = await fs.promises.readFile(checksumsPath, 'utf8');
  const checksumLine = checksums.split(/\r?\n/).find((line) => line.trim().endsWith(` ${fileName}`));
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
  const { outputChannel } = requireDeps();
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
  return runCommand('go', ['run', './cmd/waza', ...args], localWazaRepo, timeoutMs);
}

async function isCommandAvailable(command: string): Promise<boolean> {
  const { extensionContext } = requireDeps();
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

async function runWazaEvaluationForContext(context: SkillContext, evalPath: string): Promise<void> {
  const { extensionContext, outputChannel, logTelemetryUsage } = requireDeps();
  outputChannel.show(true);
  outputChannel.appendLine(`[Waza] Running evaluation for ${context.skillName}`);
  logTelemetryUsage('waza/runEval/start');

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
    logTelemetryUsage('waza/runEval/result', { outcome: 'failed' });
    void vscode.window.showErrorMessage('waza evaluation failed. See "Chat Customizations Evaluations" output for details.');
    return;
  }

  const resultsFileExists = fs.existsSync(resultsFile);
  const resultsUri = vscode.Uri.file(resultsFile);

  if (resultsFileExists) {
    const fileUri = resultsUri.toString();
    outputChannel.appendLine(`[Waza] Results saved to: ${fileUri}`);

    const action = await vscode.window.showInformationMessage(
      `waza evaluation completed for ${context.skillName}.`,
      'View Results'
    );

    if (action === 'View Results') {
      const document = await vscode.workspace.openTextDocument(resultsUri);
      await vscode.window.showTextDocument(document, { preview: false });
    }
    logTelemetryUsage('waza/runEval/result', {
      outcome: 'success',
      resultsFileCreated: true,
    });
  } else {
    logTelemetryUsage('waza/runEval/result', {
      outcome: 'success',
      resultsFileCreated: false,
    });
    void vscode.window.showInformationMessage(`waza evaluation completed for ${context.skillName}.`);
  }
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
    .map((file) => path.relative(context.workspaceRoot, file))
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
  const { outputChannel } = requireDeps();
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
  const { outputChannel, logTelemetryUsage } = requireDeps();
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
