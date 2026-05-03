import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMAnalyzer } from '../analyzers/llm';
import { TextDocument } from 'vscode-languageserver-textdocument';

describe('LLMAnalyzer', () => {
  let analyzer: LLMAnalyzer;

  beforeEach(() => {
    analyzer = new LLMAnalyzer();
  });

  describe('isAvailable', () => {
    it('should return false when no proxy is set', () => {
      expect(analyzer.isAvailable()).toBe(false);
    });

    it('should return true after proxy is set', () => {
      analyzer.setProxyFn(async () => ({ text: '{}' }));
      expect(analyzer.isAvailable()).toBe(true);
    });
  });

  describe('analyze without proxy', () => {
    it('should return hint when LLM is not available', async () => {
      const doc = makeDoc('You are a helpful assistant.');
      const results = await analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('llm-disabled');
      expect(results[0].severity).toBe('hint');
    });
  });

  describe('extractJSON', () => {
    // Access private method for direct testing
    const extract = (text: string) => (analyzer as any).extractJSON(text);

    it('should parse plain JSON', () => {
      const result = extract('{"issues": []}');
      expect(result).toEqual({ issues: [] });
    });

    it('should parse code-fenced JSON with language tag', () => {
      const result = extract('```json\n{"issues": []}\n```');
      expect(result).toEqual({ issues: [] });
    });

    it('should parse code-fenced JSON without language tag', () => {
      const result = extract('```\n{"key": "value"}\n```');
      expect(result).toEqual({ key: 'value' });
    });

    it('should throw on invalid JSON', () => {
      expect(() => extract('not json at all')).toThrow();
    });

    it('should handle JSON with surrounding whitespace', () => {
      const result = extract('  \n{"ok": true}\n  ');
      expect(result).toEqual({ ok: true });
    });

    it('should handle nested objects', () => {
      const result = extract('{"a": {"b": [1, 2, 3]}}');
      expect(result).toEqual({ a: { b: [1, 2, 3] } });
    });
  });

  describe('findTextRange', () => {
    const find = (doc: TextDocument, text: string) =>
      (analyzer as any).findTextRange(doc, text);

    it('should find exact match with column offsets', () => {
      const doc = makeDoc('first line\nsecond line\nthird line');
      const r = find(doc, 'second line');
      expect(r.line).toBe(1);
      expect(r.startChar).toBe(0);
      expect(r.endChar).toBe('second line'.length);
    });

    it('should find partial match with column offsets', () => {
      const doc = makeDoc('the quick brown fox\njumps over\nthe lazy dog');
      const r = find(doc, 'brown fox');
      expect(r.line).toBe(0);
      expect(r.startChar).toBe('the quick '.length);
      expect(r.endChar).toBe('the quick brown fox'.length);
    });

    it('should return line 0 full line when no match found', () => {
      const doc = makeDoc('hello world');
      const r = find(doc, 'nonexistent text that does not appear');
      expect(r.line).toBe(0);
      expect(r.startChar).toBe(0);
      expect(r.endChar).toBe('hello world'.length);
    });

    it('should be case-insensitive', () => {
      const doc = makeDoc('Hello World\nGoodbye');
      const r = find(doc, 'hello world');
      expect(r.line).toBe(0);
      expect(r.startChar).toBe(0);
      expect(r.endChar).toBe('hello world'.length);
    });

    it('should handle empty text', () => {
      const doc = makeDoc('hello');
      const r = find(doc, '');
      expect(r.line).toBe(0);
    });

    it('should fall back to word-level partial match with column offsets', () => {
      const doc = makeDoc('line one\nline two with important word\nline three');
      const r = find(doc, 'important word in a different sentence');
      expect(r.line).toBe(1);
      expect(r.startChar).toBe('line two with '.length);
      expect(r.endChar).toBe('line two with '.length + 'important'.length);
    });
  });

  describe('analyze with mock proxy', () => {
    it('should handle valid contradiction response', async () => {
      const mockProxy = vi.fn().mockResolvedValue({
        text: JSON.stringify({
          contradictions: [{
            instruction1: 'Be concise',
            instruction2: 'Provide detailed explanations',
            severity: 'warning',
            explanation: 'These conflict',
          }],
          ambiguity_issues: [],
          persona_issues: [],
          cognitive_load: { issues: [], overall_complexity: 'low' },
          coverage_analysis: {},
        }),
      });
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('Be concise.\nProvide detailed explanations.');
      const results = await analyzer.analyze(doc);
      const contradictions = results.filter(r => r.code === 'contradiction');
      expect(contradictions.length).toBeGreaterThan(0);
      // Verify line numbers resolved correctly
      expect(contradictions[0].range.start.line).toBe(0); // "Be concise" on line 0
    });

    it('should handle empty LLM responses gracefully', async () => {
      const mockProxy = vi.fn().mockResolvedValue({ text: '{}' });
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('Simple prompt.');
      const results = await analyzer.analyze(doc);
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle malformed JSON responses gracefully', async () => {
      const mockProxy = vi.fn().mockResolvedValue({ text: 'not valid json at all' });
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('Simple prompt.');
      const results = await analyzer.analyze(doc);
      // Individual analyzers silently skip bad JSON
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle proxy errors gracefully', async () => {
      const mockProxy = vi.fn().mockResolvedValue({ text: '{}', error: 'Model unavailable' });
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('Simple prompt.');
      const results = await analyzer.analyze(doc);
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle proxy rejection gracefully', async () => {
      const mockProxy = vi.fn().mockRejectedValue(new Error('Network error'));
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('Simple prompt.');
      const results = await analyzer.analyze(doc);
      // Should not throw unhandled
      expect(Array.isArray(results)).toBe(true);
    });

    it('should produce persona inconsistency results', async () => {
      const mockProxy = vi.fn().mockResolvedValue({
        text: JSON.stringify({
          contradictions: [],
          ambiguity_issues: [],
          persona_issues: [{
            description: 'Tone conflict',
            trait1: 'helpful',
            trait2: 'sarcastic',
            severity: 'warning',
            suggestion: 'Pick one tone',
          }],
          cognitive_load: { issues: [], overall_complexity: 'low' },
          coverage_analysis: {},
        }),
      });
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('You are a helpful assistant. Respond with sarcasm.');
      const results = await analyzer.analyze(doc);
      const persona = results.filter(r => r.code === 'persona-inconsistency');
      expect(persona.length).toBeGreaterThan(0);
    });

    it('should produce ambiguity results from LLM', async () => {
      const mockProxy = vi.fn().mockResolvedValue({
        text: JSON.stringify({
          contradictions: [],
          ambiguity_issues: [{
            text: 'be professional',
            type: 'term',
            severity: 'info',
            suggestion: 'Define what professional means',
          }],
          persona_issues: [],
          cognitive_load: { issues: [], overall_complexity: 'low' },
          coverage_analysis: {},
        }),
      });
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('Be professional in all responses.');
      const results = await analyzer.analyze(doc);
      const ambiguity = results.filter(r => r.code === 'ambiguity-llm');
      expect(ambiguity.length).toBeGreaterThan(0);
      // Verify findTextRange resolved the correct line (line 0 contains "be professional")
      expect(ambiguity[0].range.start.line).toBe(0);
    });

    it('should include custom diagnostics from custom diagnostics config', async () => {
      const mockProxy = vi.fn().mockResolvedValue({
        text: JSON.stringify({
          contradictions: [],
          ambiguity_issues: [],
          persona_issues: [],
          cognitive_load: { issues: [], overall_complexity: 'low' },
          coverage_analysis: {},
          custom_diagnostics: [{
            title: 'Output Schema Validation',
            description: 'The prompt does not define the expected JSON schema for output.',
            relevant_text: 'Return output as JSON.',
            severity: 'warning',
            suggestion: 'Add a full JSON schema with required fields and types.',
          }],
        }),
      });
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('Return output as JSON.');
      const customConfigs = [
        { name: 'Output Schema Validation', description: 'Flag missing explicit output schema requirements.' },
      ];
      const results = await analyzer.analyze(doc, customConfigs);
      const customDiagnostics = results.filter(r => r.code === 'custom-diagnostic');

      expect(customDiagnostics.length).toBeGreaterThan(0);
      expect(customDiagnostics[0].severity).toBe('warning');
      expect(customDiagnostics[0].range.start.line).toBe(0);
    });
  });

  describe('readLinkedPromptFiles', () => {
    it('should include linked agents.md support files', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-analyzer-'));

      try {
        const supportFile = path.join(tempDir, 'agents.md');
        fs.writeFileSync(supportFile, 'Support instructions');

        const doc = TextDocument.create(
          `file://${path.join(tempDir, 'test.prompt.md')}`,
          'prompt',
          1,
          '[support](./agents.md)'
        );

        const linkedFiles = await (analyzer as any).readLinkedPromptFiles(doc);

        expect(linkedFiles).toEqual([
          { target: './agents.md', content: 'Support instructions' },
        ]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});

function makeDoc(text: string): TextDocument {
  return TextDocument.create('file:///test.prompt.md', 'prompt', 1, text);
}
