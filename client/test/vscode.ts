import { vi } from 'vitest';

export const commands = {
  executeCommand: vi.fn(),
};

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: vi.fn(() => []),
  })),
  openTextDocument: vi.fn(),
};

export const window = {
  activeTextEditor: undefined as unknown,
  onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showTextDocument: vi.fn(),
  withProgress: vi.fn(),
};

export const ProgressLocation = {
  Notification: 15,
};

export const TextEditorRevealType = {
  InCenterIfOutsideViewport: 0,
};

export class Selection {
  constructor(
    public readonly anchor: unknown,
    public readonly active: unknown,
  ) {}
}
