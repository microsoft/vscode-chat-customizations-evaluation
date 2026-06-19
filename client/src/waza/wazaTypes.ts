import type * as vscode from 'vscode';
import type { LLMProxyRequest, LLMProxyResponse } from '../analysis/types';

export type TelemetryData = Record<string, string | number | boolean | undefined>;

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

export interface WazaAssetTarget {
    os: 'linux' | 'darwin' | 'windows';
    arch: 'amd64' | 'arm64';
    fileName: string;
}

export interface GitHubRelease {
    tag_name?: string;
}

export interface WazaDependencies {
    extensionContext: vscode.ExtensionContext;
    outputChannel: vscode.OutputChannel;
    getCustomizationUri: (obj: unknown) => vscode.Uri | undefined;
    requestLLM: (request: LLMProxyRequest) => Promise<LLMProxyResponse>;
}
