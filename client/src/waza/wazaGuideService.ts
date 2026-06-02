import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class WazaGuideService {

    constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly outputChannel: vscode.OutputChannel,
    ) {
    }

    async openGuide(fileName: string, fallbackContent: string, missingGuideLogLine: string): Promise<void> {
        const guidePath = this.resolveGuidePath(fileName);
        let guideUri: vscode.Uri;

        if (guidePath) {
            guideUri = vscode.Uri.file(guidePath);
        } else {
            this.outputChannel.appendLine(missingGuideLogLine);
            guideUri = await this.writeFallbackGuide(fileName, fallbackContent);
        }

        await vscode.commands.executeCommand('markdown.showPreview', guideUri);
    }

    private async writeFallbackGuide(fileName: string, fallbackContent: string): Promise<vscode.Uri> {
        const fallbackGuideDirectory = vscode.Uri.joinPath(this.extensionContext.globalStorageUri, 'fallback-guides');
        await vscode.workspace.fs.createDirectory(fallbackGuideDirectory);

        const fallbackGuideUri = vscode.Uri.joinPath(fallbackGuideDirectory, fileName);
        await vscode.workspace.fs.writeFile(fallbackGuideUri, Buffer.from(fallbackContent, 'utf8'));
        return fallbackGuideUri;
    }

    private resolveGuidePath(fileName: string): string | undefined {
        const candidates = [
            path.join('docs', fileName),
            path.join('..', 'docs', fileName),
        ];

        for (const candidate of candidates) {
            const absolutePath = this.extensionContext.asAbsolutePath(candidate);
            if (fs.existsSync(absolutePath)) {
                return absolutePath;
            }
        }

        return undefined;
    }
}
