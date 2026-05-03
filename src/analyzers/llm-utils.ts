import { TextDocument } from 'vscode-languageserver-textdocument';

/**
 * Extract JSON from an LLM response that may be wrapped in markdown code fences.
 */
export function extractJSON<T>(text: string): T {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : text.trim();
  return JSON.parse(jsonStr) as T;
}

/**
 * Find the location of a piece of text in the document, returning line and column offsets.
 */
export function findTextRange(
  doc: TextDocument,
  text: string,
): { line: number; startChar: number; endChar: number } {
  if (!text) return { line: 0, startChar: 0, endChar: doc.getText().split('\n')[0]?.length || 0 };

  const lines = doc.getText().split('\n');
  const lowerText = text.toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    const col = lines[i].toLowerCase().indexOf(lowerText);
    if (col !== -1) {
      return { line: i, startChar: col, endChar: col + text.length };
    }
  }

  const words = lowerText.split(/\s+/).filter(w => w.length > 3).slice(0, 5);
  for (let i = 0; i < lines.length; i++) {
    const lowerLine = lines[i].toLowerCase();
    for (const word of words) {
      const col = lowerLine.indexOf(word);
      if (col !== -1) {
        return { line: i, startChar: col, endChar: col + word.length };
      }
    }
  }

  return { line: 0, startChar: 0, endChar: lines[0]?.length || 0 };
}
