import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { resolveAnalysisDocument } from '../documentResolver';

describe('resolveAnalysisDocument', () => {
  it('returns open document when available', () => {
    const uri = 'file:///workspace/test.prompt.md';
    const openDoc = TextDocument.create(uri, 'prompt', 3, 'open document text');

    const result = resolveAnalysisDocument(uri, (targetUri) => {
      return targetUri === uri ? openDoc : undefined;
    });

    expect(result).toBe(openDoc);
    expect(result?.getText()).toBe('open document text');
  });

  it('falls back to file system when document is not open', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-evals-'));
    const filePath = path.join(tempDir, 'test1.prompt.md');
    const content = 'fallback file content';
    fs.writeFileSync(filePath, content, 'utf8');

    try {
      const uri = pathToFileURL(filePath).toString();
      const result = resolveAnalysisDocument(uri, () => undefined);

      expect(result).toBeDefined();
      expect(result?.uri).toBe(uri);
      expect(result?.getText()).toBe(content);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns undefined when uri cannot be loaded', () => {
    const missingUri = pathToFileURL('/tmp/does-not-exist-chat-evals.prompt.md').toString();
    const result = resolveAnalysisDocument(missingUri, () => undefined);
    expect(result).toBeUndefined();
  });
});