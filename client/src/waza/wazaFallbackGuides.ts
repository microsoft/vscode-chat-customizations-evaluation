export const WAZA_USER_GUIDE_FALLBACK = `# Waza User Guide

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

\`waza run <wazaEval.yaml> --context-dir <skill-dir> --output <results-file.json>\`

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

### wazaEval.yaml pseudo structure

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

### wazaEval.yaml possible fields

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

export const ANALYSIS_AND_FIX_USER_GUIDE_FALLBACK = `# Analysis and Fix User Guide

This guide explains how analysis and diagnostics fixing work in Chat Customizations Evaluations.

## Analyze

- Run Chat Customizations Evaluations: Analyze from the command palette.
- The extension runs LLM analysis and publishes diagnostics to the Problems panel.

## Implement suggestions

- Run Chat Customizations Evaluations: Implement suggestions.
- The extension sends current diagnostics to the fix skill and applies targeted edits.

## Full Guide

The packaged guide file was not found, so this fallback is shown. In source check:

- docs/ANALYSIS-AND-FIX-USER-GUIDE.md
`;