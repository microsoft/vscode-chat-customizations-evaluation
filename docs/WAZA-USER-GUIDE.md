# Waza User Guide

This guide explains how to use Waza from the Chat Customizations Evaluations extension.

If you want deeper details on Waza itself (schemas, graders, roadmap, releases), see: https://github.com/microsoft/waza

## What Is Waza?

Waza is a CLI for evaluating AI SKILL file customizations using structured eval suites.

With this extension, you can:
- Create a starter eval scaffold for a customization.
- Run the eval and save the results to a JSON file.
- Open and review the saved results.
- Download and configure a local Waza binary.

## Prerequisites

- VS Code with the Chat Customizations Evaluations extension installed:
   - Marketplace: https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-chat-customizations-evaluations
   - Extension ID: `ms-vscode.vscode-chat-customizations-evaluations`
- A customization file in your workspace (for example, SKILL.md).
- A working Waza command.

How to verify your Waza command is working:
1. Check your configured command in setting `chatCustomizationsEvaluations.waza.command` (default: `waza`).
2. In a terminal, run `waza --version` (or run the configured command with `--version`).
3. If it is missing, run VS Code command `Chat Customizations Evaluations: Download Waza Binary` and try again.

The extension tries these options in order:
1. The configured command from setting `chatCustomizationsEvaluations.waza.command`.
2. A binary downloaded by the extension.

## Typical End-User Flow

1. Open a customization file (for example, `skills/my-skill/SKILL.md`).
2. Run the VS Code command `Chat Customizations Evaluations: Create Waza Eval Scaffold` (or `Create Waza Eval Scaffold For SKILL File`, depending on build).
3. Review generated eval files and tasks.
4. Run the VS Code command `Chat Customizations Evaluations: Run Waza Evaluation` (or `Run Waza Evaluation For SKILL File`, depending on build).
5. Open results from the notification action or from the output panel link.

## Main Commands (Command Palette)

Open the Command Palette and run these commands:

- `Chat Customizations Evaluations: Open Waza User Guide`
   - Use when you want a quick reference for eval setup, run flow, and graders.
- `Chat Customizations Evaluations: Download Waza Binary`
   - Use when Waza is not on your PATH, or you want the extension to use a managed binary.
- `Chat Customizations Evaluations: Create Waza Eval Scaffold` (or `Create Waza Eval Scaffold For SKILL File`)
   - Use to generate starter eval files (`wazaEval.yaml` plus starter tasks) for the current skill/customization context.
- `Chat Customizations Evaluations: Run Waza Evaluation` (or `Run Waza Evaluation For SKILL File`)
   - Use to run the resolved eval suite and write a timestamped JSON results file.

## How Evaluation Works

When you run "Run Waza Evaluation", the extension does the following:

1. Resolves context from the active customization:
    - Finds the nearest supported customization context and resolves the related skill context.
    - In practice, this is anchored to the nearest `SKILL.md` discovered from the current file/context.
    - Determines skill name and workspace root.
2. Searches for a Waza eval file (`wazaEval.yaml`, with legacy `eval.yaml` support) in common locations.
3. Creates a timestamped results output file path in extension storage.
4. Runs Waza:

```bash
waza run <wazaEval.yaml> --context-dir <skill-dir> --output <results-file.json>
```

5. Streams stdout and stderr to the output channel.
6. If successful, shows:
   - A clickable file URI in output.
   - A notification with a "View Results" action.

## Grader Types (From Waza Docs)

Based on `waza/docs/graders`, the documented grader types are:

- `action_sequence`
- `behavior`
- `code`
- `diff`
- `file`
- `human` (not implemented)
- `human_calibration` (not implemented)
- `json_schema`
- `llm` (not implemented)
- `llm_comparison` (not implemented)
- `program`
- `prompt`
- `script` (not implemented)
- `skill_invocation`
- `text`
- `tool_calls` (not implemented)
- `tool_constraint`
- `trigger`

For current runs, use implemented grader types. If you use one marked "not implemented", Waza will fail to create or run that grader.

About availability plans for "not implemented" grader types:
- This extension does not define a release timeline for those grader implementations.
- For updates, track the Waza repository releases/issues: https://github.com/microsoft/waza

Examples:

### `action_sequence`

```yaml
- type: action_sequence
   name: deployment-workflow
   config:
      matching_mode: in_order_match
      expected_actions:
         - "bash"
         - "edit"
         - "bash"
         - "report_progress"
```

### `behavior`

```yaml
- type: behavior
   name: token-budget
   config:
      max_tokens: 20000
      max_duration_ms: 120000
      max_tool_calls: 10
```

### `code`

```yaml
- type: code
  name: has-output
  config:
    assertions:
      - "len(output) > 20"
```

### `diff`

```yaml
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
```

### `file`

```yaml
- type: file
   name: report-file-created
   config:
      must_exist:
         - "artifacts/report.json"
```

### `json_schema`

```yaml
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
```

### `program`

```yaml
- type: program
   name: custom-policy-checks
   config:
      command: "bash"
      args: ["./validators/check-output.sh"]
      timeout: 60
```

### `prompt`

```yaml
- type: prompt
   name: quality-judge
   config:
      model: gpt-4o-mini
      prompt: |
         Evaluate task completion quality.
         If requirements are met, call set_waza_grade_pass.
         Otherwise call set_waza_grade_fail with reasons.
```

### `skill_invocation`

```yaml
- type: skill_invocation
   name: orchestration-flow
   config:
      required_skills:
         - "azure-prepare"
         - "azure-deploy"
      mode: in_order
      allow_extra: true
```

### `text`

```yaml
- type: text
  name: no-runtime-errors
  config:
    regex_not_match:
      - "(?i)error|exception|traceback"
```

### `tool_constraint`

```yaml
- type: tool_constraint
   name: tool-guardrails
  config:
      expect_tools:
         - tool: "bash"
            command_pattern: "azd\\s+up"
      reject_tools:
         - tool: "bash"
            command_pattern: "rm\\s+-rf"
```

### `trigger`

```yaml
- type: trigger
   name: deploy-trigger
  config:
      skill_path: "skills/my-skill/SKILL.md"
      mode: positive
      threshold: 0.6
```

You can mix global graders in `wazaEval.yaml` with task-specific graders in each task file.

## References

### wazaEval.yaml pseudo structure

```yaml
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
      description: Overall completion quality target.
   - name: efficiency
      weight: 0.3
      threshold: 0.7
      description: Token/runtime quality target.

graders:
   - type: behavior
      name: token-budget
      config:
         max_tokens: 20000
         max_duration_ms: 120000

tasks:
   - "tasks/*.yaml"
```

### wazaEval.yaml possible fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Eval suite name shown in results. |
| `description` | No | Human-readable purpose of this eval. |
| `skill` | Yes | Target skill/customization name. |
| `version` | No | Spec/version label for your suite. |
| `config` | Yes | Runtime settings block for execution. |
| `config.trials_per_task` | Yes | Number of runs per task (higher = more stability data). |
| `config.timeout_seconds` | Yes | Per-task hard timeout. |
| `config.parallel` | No | Run tasks concurrently when true. |
| `config.executor` | Yes | Engine type (for example `copilot-sdk` or `mock`). |
| `config.model` | Yes | Default model used for execution. |
| `config.workers` | No | Max parallel workers when parallel mode is enabled. |
| `config.fail_fast` | No | Stop the run immediately after first hard failure. |
| `config.max_attempts` | No | Retry attempts for failed executions. |
| `config.judge_model` | No | Separate model for prompt/model-based judging. |
| `config.skill_directories` | No | Extra skill search paths used by executor/runtime. |
| `config.required_skills` | No | Skills that must be available before run starts. |
| `config.disabled_skills` | No | Skills disabled for this run (`["*"]` disables all). |
| `config.mcp_servers` | No | MCP server config map passed to runtime. |
| `metrics` | Yes | List of metric definitions (name, weight, threshold). |
| `metrics[].name` | Yes | Metric identifier (for example `task_completion`). |
| `metrics[].weight` | Yes | Relative contribution of this metric in final scoring. |
| `metrics[].threshold` | Yes | Pass expectation for that metric. |
| `metrics[].description` | No | Additional explanation for metric intent. |
| `graders` | No | Global validators applied to every task. |
| `graders[].type` | Yes | Grader kind. Documented: `action_sequence`, `behavior`, `code`, `diff`, `file`, `human` (not implemented), `human_calibration` (not implemented), `json_schema`, `llm` (not implemented), `llm_comparison` (not implemented), `program`, `prompt`, `script` (not implemented), `skill_invocation`, `text`, `tool_calls` (not implemented), `tool_constraint`, `trigger`. |
| `graders[].name` | Yes | Unique grader identifier in results JSON. |
| `graders[].config` | No | Type-specific grader configuration block. |
| `tasks` | Yes | Glob paths pointing to task YAML files. |
| `hooks` | No | Optional lifecycle shell commands (before/after run/task). |
| `inputs` | No | Global templated input variables for tasks. |
| `tasks_from` | No | External file path to load task definitions from. |
| `range` | No | Restrict run to task index slice `[start, end]`. |
| `baseline` | No | Enable baseline comparison mode where supported. |

### task YAML pseudo structure

```yaml
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
   outcomes:
      - type: task_completed
   behavior:
      max_tool_calls: 0

graders:
   - type: text
      name: has-python-shape
      config:
         regex_match:
            - "(?i)def\\s+normalize_email\\s*\\("
```

### task YAML possible fields

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Unique task identifier used in output JSON. |
| `name` | Yes | Task display name shown in reports. |
| `description` | No | What this task is testing. |
| `tags` | No | Labels for filtering/grouping. |
| `group` | No | Optional group name used in grouped summaries. |
| `enabled` | No | When false, task is skipped/ignored. |
| `inputs` | Yes | Prompt and optional context/files provided to model. |
| `inputs.prompt` | Yes | Main user prompt for this test. |
| `inputs.context` | No | Structured key/value context payload for the run. |
| `inputs.files` | No | Fixture files copied into run workspace. |
| `expected` | No | High-level expectations (triggering, content, behavior). |
| `expected.should_trigger` | No | Whether skill should trigger for this prompt. |
| `expected.output_contains` | No | Strings that must appear in final output. |
| `expected.output_not_contains` | No | Strings that must not appear in final output. |
| `expected.outcomes` | No | Expected semantic outcomes (task-specific semantics). |
| `expected.behavior` | No | Behavior limits such as tool calls/duration. |
| `graders` | No | Task-specific validators in addition to global graders. |
| `graders[].type` | Yes | Same documented types as eval-level graders (including the not-implemented entries). |
| `graders[].name` | Yes | Task-level grader identifier in output validations. |
| `graders[].config` | No | Type-specific grader configuration for this task only. |
| `hooks` | No | Per-task pre/post execution commands where supported. |

Tip: Put reusable checks in top-level `graders` in `wazaEval.yaml` and task-specific checks in each task file.

## Results File Location

Results are saved under the extension global storage path in a `results` folder.

Example filename:

- `my-skill-2026-05-05T13-39-38-888Z.json`

## Configuration

Use this setting to control which executable is used:

- `chatCustomizationsEvaluations.waza.command`

Examples:
- `waza`
- `/usr/local/bin/waza`
- `C:\\tools\\waza.exe`

## Troubleshooting

If you still need deeper Waza details, examples, or status updates, see https://github.com/microsoft/waza

### "No Waza eval file found"

Create an eval scaffold first with:
- Chat Customizations Evaluations: Create Waza Eval Scaffold

### "command not found" or spawn ENOENT

Use:
- Chat Customizations Evaluations: Download Waza Binary

Or set `chatCustomizationsEvaluations.waza.command` to a valid path.

### Evaluation failed

Open the output panel:
- View > Output
- Channel: Chat Customizations Evaluations

Read the exact Waza command, stderr, and fallback behavior logs.

## Notes

- The extension writes one results file per run (timestamped).
- Results files are JSON and can be diffed or archived.
- If the file exists, the output panel shows a clickable file URI you can open directly.
