import { TextDocument } from 'vscode-languageserver-textdocument';

/**
 * Extract JSON from an LLM response that may be wrapped in markdown code fences
 * or contain leading/trailing non-JSON text.
 */
export function extractJSON<T>(text: string): T {
  const candidates = buildJSONCandidates(text);
  let lastError: unknown;

  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (!normalized) {
      continue;
    }

    try {
      return JSON.parse(normalized) as T;
    } catch (error) {
      lastError = error;
    }

    const repaired = repairCommonJSONIssues(normalized);
    if (repaired !== normalized) {
      try {
        return JSON.parse(repaired) as T;
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw (lastError instanceof Error ? lastError : new Error('JSON parse error'));
}

function buildJSONCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates: string[] = [];

  const pushCandidate = (value: string | undefined): void => {
    const normalized = value?.trim();
    if (!normalized || candidates.includes(normalized)) {
      return;
    }
    candidates.push(normalized);
  };

  pushCandidate(trimmed);

  const jsonFenced: string[] = [];
  const genericFenced: string[] = [];
  const fencePattern = /```([a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(trimmed)) !== null) {
    const language = (match[1] || '').toLowerCase();
    const content = match[2]?.trim();
    if (!content) {
      continue;
    }

    if (language === 'json') {
      jsonFenced.push(content);
    } else {
      genericFenced.push(content);
    }
  }

  for (const block of jsonFenced) {
    pushCandidate(block);
  }
  for (const block of genericFenced) {
    pushCandidate(block);
  }

  const snapshot = candidates.slice();
  for (const candidate of snapshot) {
    pushCandidate(extractBalancedJSONObject(candidate));
  }

  return candidates;
}

function extractBalancedJSONObject(value: string): string | undefined {
  const start = value.indexOf('{');
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < value.length; i++) {
    const ch = value[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === '{') {
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, i + 1);
      }
    }
  }

  return undefined;
}

function repairCommonJSONIssues(input: string): string {
  let result = input
    .replace(/\uFEFF/g, '')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');

  for (let i = 0; i < 4; i++) {
    const position = getParseErrorPosition(result);
    if (position === undefined || position <= 0 || position >= result.length) {
      break;
    }

    const previous = findPreviousNonWhitespace(result, position - 1);
    const current = findNextNonWhitespace(result, position);
    if (previous === undefined || current === undefined) {
      break;
    }

    const valueEnding = /[\]"0-9eElrtf}]/.test(previous);
    const valueStarting = /[[{"\-0-9tfn]/.test(current);
    if (!valueEnding || !valueStarting) {
      break;
    }

    result = result.slice(0, position) + ',' + result.slice(position);
  }

  return result;
}

function getParseErrorPosition(text: string): number | undefined {
  try {
    JSON.parse(text);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/position\s+(\d+)/i);
    if (!match) {
      return undefined;
    }

    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}

function findPreviousNonWhitespace(text: string, index: number): string | undefined {
  for (let i = index; i >= 0; i--) {
    if (!/\s/.test(text[i])) {
      return text[i];
    }
  }
  return undefined;
}

function findNextNonWhitespace(text: string, index: number): string | undefined {
  for (let i = index; i < text.length; i++) {
    if (!/\s/.test(text[i])) {
      return text[i];
    }
  }
  return undefined;
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
