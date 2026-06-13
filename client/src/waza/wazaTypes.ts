import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LLMProxyRequest, LLMProxyResponse } from '../types';

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
    logTelemetryUsage: (eventName: string, data?: TelemetryData) => void;
    logTelemetryError: (eventName: string, error: unknown, data?: TelemetryData) => void;
}

/**
 * Walk up from startPath looking for SKILL.md.
 * Returns the first SKILL.md found, or undefined if none found.
 */
export function findSkillFilePath(startPath: string): string | undefined {
    const stat = fs.statSync(startPath, { throwIfNoEntry: false });
    let current = stat?.isDirectory() ? startPath : path.dirname(startPath);

    while (true) {
        const candidate = path.join(current, 'SKILL.md');
        if (fs.existsSync(candidate)) {
            return candidate;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}

/**
 * Infer the project root directory for a skill given its URI and skill directory path.
 * Tries workspace folder, then checks if parent dir is 'skills', then falls back to skill dir.
 */
export function inferSkillProjectRoot(uri: vscode.Uri, skillDirPath: string): string {
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    if (workspaceRoot) {
        return workspaceRoot;
    }

    const skillsDir = path.dirname(skillDirPath);
    if (path.basename(skillsDir) === 'skills') {
        return path.dirname(skillsDir);
    }

    return skillDirPath;
}
