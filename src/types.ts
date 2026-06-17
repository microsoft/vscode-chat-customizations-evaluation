import { Range } from 'vscode-languageserver';

export interface CustomDiagnosticConfig {
  name: string;
  description: string;
}

export interface AnalysisResult {
  code: string;
  message: string;
  range: Range;
  analyzer: string;
  suggestion?: string;
}

export interface LLMProxyRequest {
  prompt: string;
  systemPrompt: string;
  uri: string;
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
    explanation: string;
    line1_estimate?: number;
    line2_estimate?: number;
  }[];
}

export interface LLMAmbiguityResponse {
  issues?: {
    relevant_text: string;
    type: 'quantifier' | 'reference' | 'term' | 'scope' | 'other';
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
    suggestion: string;
  }[];
}

export interface LLMCognitiveLoadResponse {
  issues?: {
    type: string;
    description: string;
    relevant_text: string;
    suggestion: string;
  }[];
}

export interface LLMCoverageResponse {
  coverage_gaps?: { gap: string; relevant_text: string; impact: 'high' | 'medium' | 'low'; suggestion: string }[];
  missing_error_handling?: { scenario: string; relevant_text: string; suggestion: string }[];
}

/** Combined LLM response for single-call analysis. */
export interface LLMCombinedAnalysisResponse {
  contradictions?: LLMContradictionResponse['contradictions'];
  ambiguity_issues?: LLMAmbiguityResponse['issues'];
  persona_issues?: LLMPersonaResponse['issues'];
  cognitive_load?: LLMCognitiveLoadResponse['issues'];
  coverage_gaps?: LLMCoverageResponse['coverage_gaps'];
  missing_error_handling?: LLMCoverageResponse['missing_error_handling'];
  composition_conflicts?: {
    summary: string;
    instruction1: string;
    instruction2: string;
    suggestion: string;
  }[];
  custom_diagnostics?: {
    title: string;
    description: string;
    relevant_text: string;
    suggestion: string;
  }[];
  other_diagnostics?: {
    title: string;
    description: string;
    relevant_text: string;
    suggestion?: string;
  }[];
}
