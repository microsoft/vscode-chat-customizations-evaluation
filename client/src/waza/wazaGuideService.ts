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
        let document: vscode.TextDocument;

        if (guidePath) {
            const guideUri = vscode.Uri.file(guidePath);
            document = await vscode.workspace.openTextDocument(guideUri);
        } else {
            this.outputChannel.appendLine(missingGuideLogLine);
            document = await vscode.workspace.openTextDocument({
                content: fallbackContent,
                language: 'markdown',
            });
        }

        await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
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
