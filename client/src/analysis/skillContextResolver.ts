import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SkillContext } from './types';
import { UrlResolver } from './urlResolver';

export class SkillContextResolver {

  constructor(private readonly urlResolver: UrlResolver) { }

  resolveSkillContext(obj: unknown): SkillContext | undefined {
    const uri = this.urlResolver.getCustomizationUri(obj) ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      return undefined;
    }

    const skillFilePath = this.findSkillFilePath(uri.fsPath);
    if (!skillFilePath) {
      return undefined;
    }

    const skillDirPath = path.dirname(skillFilePath);
    const skillName = path.basename(skillDirPath);
    const workspaceRoot = this.inferSkillProjectRoot(uri, skillDirPath);

    return {
      uri,
      skillFilePath,
      skillDirPath,
      skillName,
      workspaceRoot,
    };
  }

  private inferSkillProjectRoot(uri: vscode.Uri, skillDirPath: string): string {
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

  private findSkillFilePath(startPath: string): string | undefined {
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
}
