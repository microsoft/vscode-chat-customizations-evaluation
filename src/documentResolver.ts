import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { TextDocument } from 'vscode-languageserver-textdocument';

export function resolveAnalysisDocument(
  uri: string,
  getOpenDocument: (targetUri: string) => TextDocument | undefined,
): TextDocument | undefined {
  const openDocument = getOpenDocument(uri);
  if (openDocument) {
    return openDocument;
  }

  try {
    const filePath = fileURLToPath(uri);
    const content = fs.readFileSync(filePath, 'utf8');
    return TextDocument.create(uri, 'markdown', 0, content);
  } catch {
    return undefined;
  }
}