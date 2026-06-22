import type * as vscode from 'vscode';

export interface LLMProxyRequest {
  prompt: string;
  systemPrompt: string;
  uri: string;
}

export interface LLMProxyResponse {
  text: string;
  error?: string;
}

export interface CustomDiagnosticConfig {
  name: string;
  description: string;
}

export interface AnalyzeRequest {
  uri: string;
  previousDiagnosticMessages?: string[];
}

export interface SkillContext {
  uri: vscode.Uri;
  skillFilePath: string;
  skillDirPath: string;
  skillName: string;
  workspaceRoot: string;
}

export interface AnalysisDocumentSnapshot {
  diagnostics: readonly vscode.Diagnostic[];
  document: vscode.TextDocument;
  isFresh: boolean;
};