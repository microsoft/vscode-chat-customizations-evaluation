import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as https from 'https';
import * as vscode from 'vscode';
import type { GitHubRelease, WazaAssetTarget } from './wazaTypes';

interface WazaBinaryManagerDependencies {
    getExtensionContext: () => vscode.ExtensionContext;
    getOutputChannel: () => vscode.OutputChannel;
}

export class WazaBinaryManager {

    constructor(private readonly deps: WazaBinaryManagerDependencies) { }

    getManagedWazaBinaryPath(): string {
        const extensionContext = this.deps.getExtensionContext();
        const fileName = process.platform === 'win32' ? 'waza.exe' : 'waza';
        return path.join(extensionContext.globalStorageUri.fsPath, 'bin', fileName);
    }

    async downloadAndInstallWazaBinary(reportProgress?: (message: string) => void): Promise<string> {
        const extensionContext = this.deps.getExtensionContext();
        const outputChannel = this.deps.getOutputChannel();
        const report = (message: string): void => {
            reportProgress?.(message);
            outputChannel.appendLine(`[Waza] ${message}`);
        };

        report('Detecting platform and latest release...');
        const target = this.detectWazaAssetTarget();
        const tag = await this.fetchLatestWazaTag();
        const binaryUrl = `https://github.com/microsoft/waza/releases/download/${tag}/${target.fileName}`;
        const checksumsUrl = `https://github.com/microsoft/waza/releases/download/${tag}/checksums.txt`;

        const installDir = path.join(extensionContext.globalStorageUri.fsPath, 'bin');
        const binaryPath = path.join(installDir, target.os === 'windows' ? 'waza.exe' : 'waza');
        const tempDir = path.join(extensionContext.globalStorageUri.fsPath, 'tmp');
        const tempBinaryPath = path.join(tempDir, target.fileName);
        const tempChecksumsPath = path.join(tempDir, 'checksums.txt');

        await fs.promises.mkdir(installDir, { recursive: true });
        await fs.promises.mkdir(tempDir, { recursive: true });

        outputChannel.appendLine(`[Waza] Target platform: ${target.os}/${target.arch}`);
        outputChannel.appendLine(`[Waza] Release tag: ${tag}`);

        report(`Downloading ${target.fileName}...`);
        await this.downloadFile(binaryUrl, tempBinaryPath);

        report('Downloading checksums...');
        await this.downloadFile(checksumsUrl, tempChecksumsPath);

        report('Verifying checksum...');
        await this.verifyChecksum(tempBinaryPath, tempChecksumsPath, target.fileName);

        report('Installing binary...');
        await fs.promises.copyFile(tempBinaryPath, binaryPath);
        if (target.os !== 'windows') {
            await fs.promises.chmod(binaryPath, 0o755);
        }

        report('Download complete.');

        return binaryPath;
    }

    private detectWazaAssetTarget(): WazaAssetTarget {
        let os: WazaAssetTarget['os'];
        switch (process.platform) {
            case 'darwin':
                os = 'darwin';
                break;
            case 'linux':
                os = 'linux';
                break;
            case 'win32':
                os = 'windows';
                break;
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }

        let arch: WazaAssetTarget['arch'];
        switch (process.arch) {
            case 'x64':
                arch = 'amd64';
                break;
            case 'arm64':
                arch = 'arm64';
                break;
            default:
                throw new Error(`Unsupported architecture: ${process.arch}`);
        }

        const fileName = os === 'windows' ? `waza-${os}-${arch}.exe` : `waza-${os}-${arch}`;
        return { os, arch, fileName };
    }

    private async fetchLatestWazaTag(): Promise<string> {
        const url = 'https://api.github.com/repos/microsoft/waza/releases';
        const payload = await this.httpGetText(url, {
            'User-Agent': 'vscode-chat-customizations-evaluation',
            Accept: 'application/vnd.github+json',
        });

        let releases: GitHubRelease[];
        try {
            releases = JSON.parse(payload) as GitHubRelease[];
        } catch {
            throw new Error('Could not parse GitHub releases response');
        }

        const tag = releases.find((r) => typeof r.tag_name === 'string' && r.tag_name.startsWith('v'))?.tag_name;
        if (!tag) {
            throw new Error('Could not determine latest Waza release tag');
        }

        return tag;
    }

    private async downloadFile(url: string, destinationPath: string): Promise<void> {
        const data = await this.httpGetBuffer(url, {
            'User-Agent': 'vscode-chat-customizations-evaluation',
            Accept: 'application/octet-stream',
        });
        await fs.promises.writeFile(destinationPath, data);
    }

    private async verifyChecksum(binaryPath: string, checksumsPath: string, fileName: string): Promise<void> {
        const checksums = await fs.promises.readFile(checksumsPath, 'utf8');
        const checksumLine = checksums.split(/\r?\n/).find((line) => line.trim().endsWith(` ${fileName}`));
        if (!checksumLine) {
            throw new Error(`No checksum found for ${fileName}`);
        }

        const expected = checksumLine.trim().split(/\s+/)[0].toLowerCase();
        const actual = createHash('sha256').update(await fs.promises.readFile(binaryPath)).digest('hex').toLowerCase();
        if (expected !== actual) {
            throw new Error('Checksum verification failed');
        }
    }

    private async httpGetText(url: string, headers?: Record<string, string>): Promise<string> {
        const buffer = await this.httpGetBuffer(url, headers);
        return buffer.toString('utf8');
    }

    private httpGetBuffer(url: string, headers?: Record<string, string>, redirectCount = 0): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            if (redirectCount > 5) {
                reject(new Error('Too many HTTP redirects'));
                return;
            }

            const request = https.get(url, { headers }, (response) => {
                const status = response.statusCode ?? 0;
                const location = response.headers.location;

                if (status >= 300 && status < 400 && location) {
                    response.resume();
                    const redirected = new URL(location, url).toString();
                    this.httpGetBuffer(redirected, headers, redirectCount + 1).then(resolve, reject);
                    return;
                }

                if (status < 200 || status >= 300) {
                    const chunks: Buffer[] = [];
                    response.on('data', (chunk: Buffer) => chunks.push(chunk));
                    response.on('end', () => {
                        const body = Buffer.concat(chunks).toString('utf8');
                        reject(new Error(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`));
                    });
                    return;
                }

                const chunks: Buffer[] = [];
                response.on('data', (chunk: Buffer) => chunks.push(chunk));
                response.on('end', () => resolve(Buffer.concat(chunks)));
            });

            request.on('error', reject);
        });
    }
}
