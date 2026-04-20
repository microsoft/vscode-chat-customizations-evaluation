import { Range } from 'vscode-languageserver';

export interface AnalysisResult {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  range: Range;
  analyzer: string;
  suggestion?: string;
}

export interface LLMProxyRequest {
  prompt: string;
  systemPrompt: string;
}

export interface LLMProxyResponse {
  text: string;
  error?: string;
}

export type LLMProxyFn = (request: LLMProxyRequest) => Promise<LLMProxyResponse>;

// Typed LLM response shapes for extractJSON
export interface LLMContradictionResponse {
  contradictions?: {
    instruction1: string;
    instruction2: string;
    severity: 'error' | 'warning';
    explanation: string;
    line1_estimate?: number;
    line2_estimate?: number;
  }[];
}

export interface LLMAmbiguityResponse {
  issues?: {
    text: string;
    type: 'quantifier' | 'reference' | 'term' | 'scope' | 'other';
    severity: 'warning' | 'info';
    problem: string;
    suggestion: string;
  }[];
}

export interface LLMPersonaResponse {
  issues?: {
    description: string;
    trait1: string;
    trait2: string;
    relevant_text: string;
    severity: 'warning' | 'info';
    suggestion: string;
  }[];
}

export interface LLMCognitiveLoadResponse {
  issues?: {
    type: string;
    description: string;
    relevant_text: string;
    severity: 'warning' | 'info';
    suggestion: string;
  }[];
  overall_complexity?: 'low' | 'medium' | 'high' | 'very-high';
}

export interface LLMCoverageResponse {
  coverage_analysis?: {
    coverage_gaps?: { gap: string; relevant_text: string; impact: 'high' | 'medium' | 'low'; suggestion: string }[];
    missing_error_handling?: { scenario: string; relevant_text: string; suggestion: string }[];
    overall_coverage?: 'comprehensive' | 'adequate' | 'limited' | 'minimal';
  };
}

/** Combined LLM response for single-call analysis. */
export interface LLMCombinedAnalysisResponse {
  contradictions?: LLMContradictionResponse['contradictions'];
  ambiguity_issues?: LLMAmbiguityResponse['issues'];
  persona_issues?: LLMPersonaResponse['issues'];
  cognitive_load?: {
    issues?: LLMCognitiveLoadResponse['issues'];
    overall_complexity?: LLMCognitiveLoadResponse['overall_complexity'];
  };
  coverage_analysis?: LLMCoverageResponse['coverage_analysis'];
  composition_conflicts?: {
    summary: string;
    instruction1: string;
    instruction2: string;
    severity: 'error' | 'warning';
    suggestion: string;
  }[];
}
