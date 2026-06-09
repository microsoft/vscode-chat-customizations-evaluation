---
name: analyze-prompt
description: Runs Chat Customizations Evaluations analysis for the active customization file and summarizes the findings from the Problems panel.
---

# Analyze Prompt

## Purpose

Run Chat Customizations Evaluations analysis on the active customization file and report what was found.

## Usage

Invoke this skill from Copilot Chat using /analyze-prompt while a supported customization file is open.

## Instructions

- Confirm there is an active editor with a supported customization file.
- Run the VS Code command `chatCustomizationsEvaluations.analyzePromptDirect`.
- Wait for analysis to finish.
- Read diagnostics for the active file from the Problems panel and summarize them. 
