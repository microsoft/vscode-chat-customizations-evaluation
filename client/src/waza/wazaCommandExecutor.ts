import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import type { CommandResult } from './wazaTypes';

interface WazaCommandExecutorDependencies {
    getOutputChannel: () => vscode.OutputChannel;
    getWazaCommand: () => string;
    getManagedWazaBinaryPath: () => string;
    getExtensionStoragePath: () => string;
}

export class WazaCommandExecutor {

    constructor(private readonly deps: WazaCommandExecutorDependencies) {
    }

    async runWazaCommand(args: string[], cwd: string, timeoutMs?: number): Promise<CommandResult> {
        const configuredCommand = this.deps.getWazaCommand();
        let result = await this.runCommand(configuredCommand, args, cwd, timeoutMs);

        if (result.exitCode === 0 || !this.shouldFallbackToLocalGo(result.stderr)) {
            return result;
        }

        const managedBinary = this.deps.getManagedWazaBinaryPath();
        if (managedBinary !== configuredCommand && fs.existsSync(managedBinary)) {
            this.deps.getOutputChannel().appendLine(`[Waza] Falling back to downloaded binary at ${managedBinary}`);
            result = await this.runCommand(managedBinary, args, cwd, timeoutMs);
            if (result.exitCode === 0 || !this.shouldFallbackToLocalGo(result.stderr)) {
                return result;
            }
        }

        const goAvailable = await this.isCommandAvailable('go');
        if (!goAvailable) {
            return {
                stdout: result.stdout,
                stderr: `${result.stderr}\nGo is not available on PATH for local fallback. Run "Chat Customizations Evaluations: Download Waza Binary" to install waza for this extension.`.trim(),
                exitCode: 1,
            };
        }

        const localWazaRepo = this.findLocalWazaRepo(cwd);
        if (!localWazaRepo) {
            return result;
        }

        this.deps.getOutputChannel().appendLine(`[Waza] Falling back to local repo via go run in ${localWazaRepo}`);
        return this.runCommand('go', ['run', './cmd/waza', ...args], localWazaRepo, timeoutMs);
    }

    private findLocalWazaRepo(startDir: string): string | undefined {
        let current = startDir;
        while (true) {
            const repoCandidate = path.join(current, 'waza');
            const mainPath = path.join(repoCandidate, 'cmd', 'waza', 'main.go');
            if (fs.existsSync(mainPath)) {
                return repoCandidate;
            }

            const parent = path.dirname(current);
            if (parent === current) {
                return undefined;
            }
            current = parent;
        }
    }

    private shouldFallbackToLocalGo(stderr: string): boolean {
        const lower = stderr.toLowerCase();
        return (
            lower.includes('spawn') && lower.includes('enoent')
        ) || lower.includes('command not found') || lower.includes('executable file not found');
    }

    private async isCommandAvailable(command: string): Promise<boolean> {
        const probe = await this.runCommand(command, ['--version'], this.deps.getExtensionStoragePath(), 5_000);
        return !this.shouldFallbackToLocalGo(probe.stderr);
    }

    private runCommand(command: string, args: string[], cwd: string, timeoutMs?: number): Promise<CommandResult> {
        return new Promise((resolve) => {
            const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            let timeout: NodeJS.Timeout | undefined;

            if (timeoutMs) {
                timeout = setTimeout(() => {
                    child.kill();
                }, timeoutMs);
            }

            child.stdout.on('data', (chunk: Buffer) => {
                stdout += chunk.toString('utf8');
            });

            child.stderr.on('data', (chunk: Buffer) => {
                stderr += chunk.toString('utf8');
            });

            child.on('error', (error) => {
                if (timeout) {
                    clearTimeout(timeout);
                }
                resolve({
                    stdout,
                    stderr: `${stderr}\n${error.message}`.trim(),
                    exitCode: 1,
                });
            });

            child.on('close', (code) => {
                if (timeout) {
                    clearTimeout(timeout);
                }
                resolve({ stdout, stderr, exitCode: code ?? 1 });
            });
        });
    }
}
