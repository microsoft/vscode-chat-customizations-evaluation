import * as fs from 'fs';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import type { CommandResult } from './wazaTypes';

interface WazaCommandExecutorDependencies {
    getOutputChannel: () => vscode.OutputChannel;
    getWazaCommand: () => string;
    getManagedWazaBinaryPath: () => string;
    installManagedWazaBinary: () => Promise<void>;
}

export class WazaCommandExecutor {

    constructor(private readonly deps: WazaCommandExecutorDependencies) { }

    async runWazaCommand(args: string[], cwd: string, timeoutMs?: number): Promise<CommandResult> {
        const configuredCommand = this.deps.getWazaCommand();
        let result = await this.runCommand(configuredCommand, args, cwd, timeoutMs);
        if (result.exitCode === 0) {
            return result;
        }

        const managedBinary = this.deps.getManagedWazaBinaryPath();
        if (!fs.existsSync(managedBinary)) {
            this.deps.getOutputChannel().appendLine('[Waza] Managed binary not found; downloading it now.');
            await this.deps.installManagedWazaBinary();
            if (!fs.existsSync(managedBinary)) {
                return {
                    stdout: result.stdout,
                    stderr: [
                        result.stderr,
                        `Managed Waza binary was not found after download attempt: ${managedBinary}`,
                    ].filter(Boolean).join('\n'),
                    exitCode: 1,
                };
            }

            result = await this.runCommand(managedBinary, args, cwd, timeoutMs);

        }
        return result;
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
