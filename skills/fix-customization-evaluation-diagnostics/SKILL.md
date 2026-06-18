---
name: fix-customization-evaluation-diagnostics
description: Fixes diagnostics reported by the Chat Customizations Evaluations extension on the active prompt file. Reads the current diagnostics from the editor and applies suggested improvements.
---

# Implement suggestions

## Purpose

Fix issues found by the Chat Customizations Evaluations analyzer in prompt, agent, skill, and instruction files. The diagnostics include contradictions, ambiguities, persona conflicts, cognitive load issues, and coverage gaps.

## Usage

This skill is invoked automatically when the user clicks the "Implement suggestions" button in the editor title bar. It receives the diagnostics as context and rewrites the affected sections of the file to resolve them.

This skill can also be called directly by the user. In that case search for the diagnostics from the Chat Customizations Evaluations extension and apply the fixes.

## Instructions

- You will either receive a list of diagnostics from the Chat Customizations Evaluations extension or be called without diagnostics. 
- If you receive a list of diagnostics from the Chat Customizations Evaluations extension, then each diagnostic will includes a line number, code, message, and optionally a suggestion.
- If you are called without diagnostics, you should search and find diagnostics from the Chat Customizations Evaluations extension yourself.
- For each diagnostic, apply the fix directly to the file content. Use the suggestion if one is provided; otherwise, use your judgment to resolve the issue.
- Preserve the overall structure, tone, and intent of the prompt file. Only change what is necessary to resolve the diagnostics.
- If two diagnostics conflict with each other, prefer the fix that keeps the prompt clearer and more consistent.
- Directly edit the file content to apply the fixes.
- Do NOT add new instructions or sections that were not in the original file.
- Do NOT remove instructions unless a diagnostic specifically calls for it (e.g., contradictions).
