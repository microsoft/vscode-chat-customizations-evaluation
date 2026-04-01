# Chat Customizations Evaluations

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Language Server Protocol implementation for analyzing and improving AI prompt files. Works with `.prompt.md`, `.agent.md`, and `.instructions.md` files — providing LLM-powered semantic analysis directly in VS Code.

## Features

### LLM-Powered Analysis (via GitHub Copilot)

- **Contradiction Detection** — Finds logical, behavioral, and format conflicts
- **Semantic Ambiguity** — Ambiguity analysis with rewrite suggestions
- **Persona Consistency** — Detects conflicting personality traits and tone drift
- **Cognitive Load Assessment** — Warns about overly complex prompts with too many nested conditions
- **Semantic Coverage** — Identifies gaps in intent handling and missing error paths
- **Composition Conflict Analysis** — Detects conflicts between a prompt and other prompt files it imports via markdown links

### Editor Integration

- **Editor Title Bar** — Analyze Prompt button appears when editing prompt files
- **Command Palette** — `Chat Customizations Evaluations: Analyze Prompt` command
- **Problems Panel** — All diagnostics appear in the standard VS Code Problems panel with precise line and column locations

## Supported File Types

| Pattern | Type |
|---|---|
| `*.prompt.md` | Prompt |
| `*.agent.md` | Agent |
| `*.instructions.md` | Instructions |

## Installation

```bash
git clone https://github.com/microsoft/vscode-chat-customizations-evaluation.git
cd vscode-chat-customizations-evaluation
npm install
npm run build
```

Then press `F5` in VS Code to launch the Extension Development Host.

## Usage

1. Open any supported prompt file in VS Code
2. Run **Chat Customizations Evaluations: Analyze Prompt** from the command palette or click the beaker icon in the editor title bar
3. View results in the **Problems panel** (`Ctrl+Shift+M` / `Cmd+Shift+M`)

LLM analysis requires **GitHub Copilot** — no API keys needed. Just sign in to GitHub Copilot in VS Code.

### Commands

| Command | Description |
|---------|-------------|
| `Chat Customizations Evaluations: Analyze Prompt` | Run full LLM-powered analysis on the active file |

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `chatCustomizationsEvaluations.enable` | `true` | Enable/disable the extension |
| `chatCustomizationsEvaluations.trace.server` | `off` | Trace communication between VS Code and the language server |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Prompt Document                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    LLM Analysis                             │
│                                                             │
│  • Contradictions & persona consistency                     │
│  • Ambiguity & cognitive load                               │
│  • Coverage gaps & missing error handling                   │
│  • Composition conflicts (cross-file)                       │
│                                                             │
│  Triggered: manually via command                            │
│  Powered by: GitHub Copilot (vscode.lm API)                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Diagnostics → Problems Panel                   │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
src/
├── server.ts              # Server entry point, diagnostics
├── types.ts               # Shared TypeScript types and interfaces
├── analyzers/
│   └── llm.ts             # LLM-powered analysis (all diagnostic categories)
└── __tests__/
    └── llm.test.ts        # LLM analyzer tests

client/
├── src/extension.ts       # VS Code extension activation, LLM proxy
└── package.json           # Extension manifest
```

## Development

```bash
npm run compile      # Build server only
npm run build        # Build server + client
npm test             # Run tests (vitest)
npx vitest           # Run tests in watch mode
npm run lint         # Run ESLint
```

Press `F5` in VS Code to launch the Extension Development Host for manual testing.

## License

MIT
