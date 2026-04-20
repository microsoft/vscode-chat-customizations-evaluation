# Contributing to Chat Customizations Evaluations

Thank you for your interest in contributing to Chat Customizations Evaluations! This guide will help you get started.

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- [VS Code](https://code.visualstudio.com/) (for extension development)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/microsoft/vscode-chat-customizations-evaluation.git
cd vscode-chat-customizations-evaluation

# Install dependencies (also installs client dependencies)
npm install

# Build everything
npm run build

# Run tests
npm test
```

### Project Structure

```
chat-customizations-evaluations/
├── src/                    # Language server source
│   ├── server.ts           # Server entry point
│   ├── types.ts            # Shared type definitions
│   ├── analyzers/
│   │   └── llm.ts          # LLM-powered semantic analysis
│   └── __tests__/          # Unit tests
├── client/                 # VS Code extension client
│   ├── src/extension.ts    # Extension entry point
│   └── package.json        # Extension manifest & configuration
└── vitest.config.ts        # Test configuration
```

### Development Workflow

1. **Make changes** to the server (`src/`) or client (`client/src/`)
2. **Build** with `npm run build`
3. **Test** with `npm test`
4. **Debug** in VS Code by pressing `F5` (launches Extension Development Host)

### Running the Extension Locally

1. Open the project in VS Code
2. Press `F5` to launch the Extension Development Host
3. In the new VS Code window, open any `.prompt.md`, `.system.md`, or `.agent.md` file
4. Diagnostics will appear automatically

### Watch Mode

For faster iteration, use watch mode in separate terminals:

```bash
# Terminal 1: Watch server changes
npm run watch

# Terminal 2: Watch client changes
cd client && npm run watch
```

## Writing Tests

Tests live in `src/__tests__/` and use [Vitest](https://vitest.dev/).

```bash
# Run all tests
npm test

# Run tests in watch mode
npx vitest
```

When adding new analyzers or modifying existing ones, add corresponding tests that:

- Test both positive cases (issue detected) and negative cases (no false positives)
- Verify correct severity levels
- Check that suggestions are provided where applicable
- Validate correct range/position information

## Adding a New Analyzer

1. Add your analysis method to `src/analyzers/static.ts` (for static checks) or `src/analyzers/llm.ts` (for LLM-powered analysis)
2. Call your method from the `analyze()` function
3. Add tests in `src/__tests__/`
4. Document the new diagnostic code in `docs/SPEC.md`

## Code Style

- TypeScript strict mode is enabled
- Use descriptive variable and function names
- Add JSDoc comments for public APIs
- Keep analyzer methods focused on a single concern

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes with tests
4. Ensure `npm run build && npm test` passes
5. Submit a pull request

## Reporting Issues

When reporting bugs, please include:

- The prompt file content that triggers the issue
- Expected vs actual behavior
- Your VS Code and Node.js versions
