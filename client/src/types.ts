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

export interface AnalysisState {
  startedAt: number;
  stage: string;
  llmRequestsInFlight: number;
}

export interface AnalysisSnapshot {
  fingerprint: string;
  resultCount: number;
}

export interface CustomDiagnosticConfig {
  name: string;
  description: string;
}

export interface AnalyzeRequest {
  uri: string;
  customDiagnostics?: CustomDiagnosticConfig[];
  previousDiagnosticMessages?: string[];
}

export interface SkillContext {
  uri: vscode.Uri;
  skillFilePath: string;
  skillDirPath: string;
  skillName: string;
  workspaceRoot: string;
}

export interface EvalScaffoldSummary {
  evalPath: string;
  createdFiles: string[];
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type TelemetryData = Record<string, string | number | boolean | undefined>;