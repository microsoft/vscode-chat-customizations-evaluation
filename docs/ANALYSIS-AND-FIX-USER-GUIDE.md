# Analysis and Fix User Guide

This guide explains how the extension analyzes customization files, how diagnostics are produced, and how the Implement suggestions flow applies improvements.

## What This Covers

- Manual analysis from the command palette and editor actions.
- How LLM analysis categories map to diagnostics in Problems.
- What happens when you run Implement suggestions.
- What happens after fixes are applied (optional waza eval flow).

## Supported Files

Analysis and fix workflows are available when editing chat customization content such as prompt, agent, skill, and instructions files (including AGENTS.md in supported contexts).

## Analyze Workflow

Run one of these commands:

- Chat Customizations Evaluations: Analyze
- Chat Customizations Evaluations: Analyze (from customization item)

When analysis starts, the extension runs this flow:

1. Collect active file URI and configured custom diagnostics (`chatCustomizationsEvaluations.customDiagnostics`).
2. Check whether analysis is already up to date for the exact current text + custom diagnostics config.
3. If already up to date:
   - If issues exist, focus existing diagnostics.
   - If no issues exist, show a no-issues message.
4. If not up to date, send an analyze request to the language server.
5. The language server runs LLM analysis and converts results to standard diagnostics.
6. Diagnostics are published to VS Code Problems.

## Analysis Categories

The LLM analyzer performs a combined semantic pass for:

- Contradictions
- Ambiguity
- Persona consistency
- Cognitive load
- Semantic coverage (including missing error handling)
- Custom diagnostics (if configured)

It also runs a composition-conflict pass to detect conflicts between a file and linked/imported customization content.

## How Diagnostics Are Created

Each finding is converted into a VS Code diagnostic with:

- Severity (`error`, `warning`, `info`, or `hint`)
- Source (`chat-customizations-evaluations` with analyzer name)
- Range (line/column location)
- Code (diagnostic kind, such as contradiction or ambiguity)
- Optional suggestion payload

These diagnostics appear in the Problems panel and drive the editor action button state.

## Stale Diagnostics Behavior

After analysis completes, diagnostics represent the analyzed snapshot. On the next content edit to that file, the extension marks results as stale and prompts the user to re-run analysis.

## Implement suggestions Workflow

Run:

- Chat Customizations Evaluations: Implement suggestions

The fix flow works as follows:

1. Read diagnostics for the active file and sort by line/column.
2. If no diagnostics exist, prompt to run analysis first.
3. Open Copilot Chat with the skill command `/fix-customization-evaluation-diagnostics`.
4. Pass a structured diagnostics list to the skill (line, code, severity, message).
5. Wait for file edits; if no change is detected before timeout, stop the flow.

The fix skill is instructed to:

- Use only provided diagnostics for the target file.
- Apply direct fixes in-place.
- Preserve overall structure and intent.
- Avoid unrelated rewrites.

## After Fixes: Optional Eval Step

If fixes were applied and the file belongs to a skill context:

1. The extension looks for a waza eval file (`wazaEval.yaml`, with legacy `eval.yaml` support).
2. If found, it can run waza eval immediately (or persist an always-run preference).
3. If missing, it offers to scaffold evals and optionally run them.

This gives a tight loop: analyze -> fix -> validate.

## Configuration That Affects This Flow

- `chatCustomizationsEvaluations.customDiagnostics`: Adds extra LLM checks.
- `chatCustomizationsEvaluations.model`: Preferred model for analysis.
- `chatCustomizationsEvaluations.waza.command`: waza command path.
- `chatCustomizationsEvaluations.waza.alwaysRunAfterFixDiagnostics`: Auto-run eval after successful fixes.

## Practical Tips

- Re-run analysis after any substantial edit; snapshot freshness is text-based.
- Keep custom diagnostics specific and testable to improve fix quality.
- Treat Implement suggestions as a targeted rewrite pass, not a full refactor pass.
- Use waza evals to confirm behavior after applying fixes.