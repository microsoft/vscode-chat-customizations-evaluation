import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisCoordinator } from '../src/analysis/analysisCoordinator';
import { commands, window, workspace } from './vscode';

const uri = {
  fsPath: '/workspace/copilot-instructions.md',
  path: '/workspace/copilot-instructions.md',
  toString: () => 'file:///workspace/copilot-instructions.md',
};

const document = {
  uri,
  getText: () => '# Instructions',
};

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 1 },
};

function createDiagnostic(code: string) {
  return {
    code,
    message: code === 'llm-error' ? 'LLM analysis failed' : 'Use clearer instructions',
    range,
  };
}

function createCoordinator(diagnostics: ReturnType<typeof createDiagnostic>[]) {
  const diagnosticsManager = {
    getDiagnosticsForUri: vi.fn(() => diagnostics),
    hasErrorDiagnostics: vi.fn((diagnostic: ReturnType<typeof createDiagnostic>) =>
      diagnostic.code === 'llm-error' || diagnostic.code === 'llm-parse-error'),
  };
  const context = { subscriptions: [] };
  const client = { sendRequest: vi.fn() };
  const outputChannel = { appendLine: vi.fn() };
  const coordinator = new AnalysisCoordinator(
    context as never,
    diagnosticsManager as never,
    client as never,
    outputChannel as never,
  );
  return { coordinator, diagnosticsManager, client };
}

describe('AnalysisCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.activeTextEditor = undefined;
    workspace.openTextDocument.mockResolvedValue(document);
    window.showTextDocument.mockResolvedValue({
      selection: undefined,
      revealRange: vi.fn(),
    });
    window.withProgress.mockImplementation(
      async (
        _options: unknown,
        task: (progress: { report: ReturnType<typeof vi.fn> }) => Promise<unknown>,
      ) => task({ report: vi.fn() }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries a fresh analysis when the existing diagnostic is an LLM error', async () => {
    const { coordinator, client } = createCoordinator([createDiagnostic('llm-error')]);
    client.sendRequest.mockResolvedValue({ duration: 1, resultCount: 1 });
    coordinator.recordAnalysisSnapshot(document as never);

    await coordinator.runAnalyzeWorkflow(uri as never);

    expect(client.sendRequest).toHaveBeenCalledWith(
      'chatCustomizationsEvaluations/analyze',
      expect.objectContaining({
        uri: uri.toString(),
        previousDiagnosticMessages: undefined,
      }),
    );
    expect(window.showInformationMessage).not.toHaveBeenCalledWith('Analysis is already up to date.');
    coordinator.dispose();
  });

  it('reuses a fresh analysis when the existing diagnostic is fixable', async () => {
    const { coordinator, client } = createCoordinator([createDiagnostic('semantic-coverage')]);
    coordinator.recordAnalysisSnapshot(document as never);

    await coordinator.runAnalyzeWorkflow(uri as never);

    expect(client.sendRequest).not.toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalledWith('Analysis is already up to date.');
    coordinator.dispose();
  });

  it('hides Implement suggestions when only an LLM error diagnostic exists', () => {
    const { coordinator } = createCoordinator([createDiagnostic('llm-error')]);
    window.activeTextEditor = { document: { uri } };

    coordinator.handleDiagnosticsChanged([uri as never]);

    expect(commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'chatCustomizationsEvaluations.hasDiagnostics',
      false,
    );
    coordinator.dispose();
  });

  it('hides Implement suggestions when an LLM error accompanies a valid finding', () => {
    const { coordinator } = createCoordinator([
      createDiagnostic('llm-error'),
      createDiagnostic('semantic-coverage'),
    ]);
    window.activeTextEditor = { document: { uri } };

    coordinator.handleDiagnosticsChanged([uri as never]);

    expect(commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'chatCustomizationsEvaluations.hasDiagnostics',
      false,
    );
    coordinator.dispose();
  });

  it('keeps Implement suggestions available for a successful analysis', () => {
    const { coordinator } = createCoordinator([createDiagnostic('semantic-coverage')]);
    window.activeTextEditor = { document: { uri } };

    coordinator.handleDiagnosticsChanged([uri as never]);

    expect(commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'chatCustomizationsEvaluations.hasDiagnostics',
      true,
    );
    coordinator.dispose();
  });

  it('does not cache an analysis that returned an LLM error', async () => {
    const deliveredDiagnostics: ReturnType<typeof createDiagnostic>[] = [];
    const { coordinator, client } = createCoordinator(deliveredDiagnostics);
    client.sendRequest.mockImplementation(async () => {
      deliveredDiagnostics.push(createDiagnostic('llm-error'));
      return { duration: 1, resultCount: 1 };
    });
    const internalCoordinator = coordinator as unknown as {
      executeAnalyzeRequest: (
        targetUri: unknown,
        snapshot: { document: unknown; diagnostics: unknown[]; isFresh: boolean },
        previousDiagnostics: string[] | undefined,
      ) => Promise<void>;
      previousDiagnosticsByUri: Map<string, string[]>;
    };

    await internalCoordinator.executeAnalyzeRequest(
      uri,
      { document, diagnostics: [], isFresh: false },
      undefined,
    );

    const snapshot = await coordinator.getCurrentAnalysisSnapshot(uri as never);
    expect(snapshot.isFresh).toBe(false);
    expect(internalCoordinator.previousDiagnosticsByUri.has(uri.toString())).toBe(false);
    coordinator.dispose();
  });

  it('does not accumulate previous diagnostics when an LLM error accompanies a valid finding', async () => {
    const deliveredDiagnostics: ReturnType<typeof createDiagnostic>[] = [];
    const { coordinator, client } = createCoordinator(deliveredDiagnostics);
    client.sendRequest.mockImplementation(async () => {
      deliveredDiagnostics.push(
        createDiagnostic('llm-error'),
        createDiagnostic('semantic-coverage'),
      );
      return { duration: 1, resultCount: 2 };
    });
    const internalCoordinator = coordinator as unknown as {
      executeAnalyzeRequest: (
        targetUri: unknown,
        snapshot: { document: unknown; diagnostics: unknown[]; isFresh: boolean },
        previousDiagnostics: string[] | undefined,
      ) => Promise<void>;
      previousDiagnosticsByUri: Map<string, string[]>;
    };

    await internalCoordinator.executeAnalyzeRequest(
      uri,
      { document, diagnostics: [], isFresh: false },
      undefined,
    );

    expect(internalCoordinator.previousDiagnosticsByUri.has(uri.toString())).toBe(false);
    coordinator.dispose();
  });

  it('accumulates fixable findings after a successful analysis', async () => {
    const deliveredDiagnostics: ReturnType<typeof createDiagnostic>[] = [];
    const { coordinator, client } = createCoordinator(deliveredDiagnostics);
    client.sendRequest.mockImplementation(async () => {
      deliveredDiagnostics.push(createDiagnostic('semantic-coverage'));
      return { duration: 1, resultCount: 1 };
    });
    const internalCoordinator = coordinator as unknown as {
      executeAnalyzeRequest: (
        targetUri: unknown,
        snapshot: { document: unknown; diagnostics: unknown[]; isFresh: boolean },
        previousDiagnostics: string[] | undefined,
      ) => Promise<void>;
      previousDiagnosticsByUri: Map<string, string[]>;
    };

    await internalCoordinator.executeAnalyzeRequest(
      uri,
      { document, diagnostics: [], isFresh: false },
      undefined,
    );

    expect(internalCoordinator.previousDiagnosticsByUri.get(uri.toString())).toEqual([
      'Use clearer instructions',
    ]);
    coordinator.dispose();
  });
});
