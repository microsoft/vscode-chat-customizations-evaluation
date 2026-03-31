import { PromptDocument, AnalysisResult, TokenInfo } from '../types';
import { encoding_for_model, TiktokenModel } from 'tiktoken';

export class StaticAnalyzer {
  private ambiguousQuantifiers = ['a few', 'some', 'sometimes', 'occasionally', 'often', 'many', 'several', 'various', 'numerous'];
  
  private vagueTerms = ['appropriate', 'professional', 'good', 'bad', 'nice', 'proper', 'suitable', 'reasonable', 'adequate'];

  private quantifierSuggestions: Record<string, string> = {
    'a few': '2-3',
    'some': 'specific',
    'sometimes': 'in specific cases',
    'occasionally': 'in ~10% of cases',
    'often': 'in most cases',
    'many': '10+',
    'several': '5-7',
    'various': 'the following specific',
    'numerous': '10+',
  };

  // Tiktoken encoders cached per model
  private encoders: Map<string, ReturnType<typeof encoding_for_model>> = new Map();

  /**
   * Free all cached tiktoken WASM encoders to release native memory.
   */
  dispose(): void {
    for (const encoder of this.encoders.values()) {
      encoder.free();
    }
    this.encoders.clear();
  }

  /**
   * Get accurate token count using tiktoken
   */
  getTokenCount(text: string, model: string = 'gpt-4'): number {
    try {
      // Map model to tiktoken model name
      let tiktokenModel: TiktokenModel = 'gpt-4';
      if (model.includes('gpt-3.5')) {
        tiktokenModel = 'gpt-3.5-turbo';
      } else if (model.includes('gpt-4')) {
        tiktokenModel = 'gpt-4';
      }
      let encoder = this.encoders.get(tiktokenModel);
      if (!encoder) {
        encoder = encoding_for_model(tiktokenModel);
        this.encoders.set(tiktokenModel, encoder);
      }
      return encoder.encode(text).length;
    } catch {
      // Fallback to estimation
      return Math.ceil(text.length / 4);
    }
  }

  /**
   * Get detailed token info for sections
   */
  getTokenInfo(doc: PromptDocument, targetModel?: string): TokenInfo {
    const totalTokens = this.getTokenCount(doc.text, targetModel);
    const sections = new Map<string, number>();
    const sectionTokens: number[] = [];
    
    // Calculate tokens per section
    for (const section of doc.sections) {
      const sectionText = doc.lines.slice(section.startLine, section.endLine + 1).join('\n');
      const count = this.getTokenCount(sectionText, targetModel);
      sectionTokens.push(count);
      sections.set(section.name, count);
    }

    return { totalTokens, sections, sectionTokens };
  }

  analyze(doc: PromptDocument): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // Run all static analyzers
    results.push(...this.analyzeAmbiguity(doc));

    return results;
  }

  // Ambiguity Detection (Tier 1)
  private analyzeAmbiguity(doc: PromptDocument): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    doc.lines.forEach((line, lineIndex) => {
      const lowerLine = line.toLowerCase();

      // Check for ambiguous quantifiers
      for (const quantifier of this.ambiguousQuantifiers) {
        const regex = new RegExp(`\\b${quantifier}\\b`, 'gi');
        let match;
        while ((match = regex.exec(line)) !== null) {
          results.push({
            code: 'ambiguous-quantifier',
            message: `Ambiguous quantifier: "${match[0]}". The model may interpret this inconsistently. Consider specifying exact values.`,
            severity: 'info',
            range: {
              start: { line: lineIndex, character: match.index },
              end: { line: lineIndex, character: match.index + match[0].length },
            },
            analyzer: 'ambiguity-detection',
            suggestion: this.quantifierSuggestions[match[0].toLowerCase()],
          });
        }
      }

      // Check for vague terms
      for (const term of this.vagueTerms) {
        const regex = new RegExp(`\\bbe ${term}\\b|\\bin a ${term}\\b`, 'gi');
        let match;
        while ((match = regex.exec(line)) !== null) {
          results.push({
            code: 'vague-term',
            message: `Vague term: "${match[0]}". Consider defining what this means specifically for your use case.`,
            severity: 'info',
            range: {
              start: { line: lineIndex, character: match.index },
              end: { line: lineIndex, character: match.index + match[0].length },
            },
            analyzer: 'ambiguity-detection',
          });
        }
      }

      // Check for unresolved references
      const unresolvedPatterns = [
        /\b(mentioned|described|shown|listed|given)\s+(above|below|earlier|previously|before)\b/gi,
        /\bthe\s+(above|below|following|preceding)\s+(format|example|instructions?|rules?|guidelines?)\b/gi,
        /\bsee\s+(above|below)\b/gi,
        /\bas\s+(mentioned|described|stated)\b/gi,
      ];

      for (const pattern of unresolvedPatterns) {
        let match;
        while ((match = pattern.exec(line)) !== null) {
          results.push({
            code: 'unresolved-reference',
            message: `Potentially unresolved reference: "${match[0]}". Ensure the referenced content exists and is clear.`,
            severity: 'info',
            range: {
              start: { line: lineIndex, character: match.index },
              end: { line: lineIndex, character: match.index + match[0].length },
            },
            analyzer: 'ambiguity-detection',
          });
        }
      }
    });

    return results;
  }
}
