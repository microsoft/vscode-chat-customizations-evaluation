import * as vscode from 'vscode';
import * as https from 'https';

export class ExtensionTelemetrySender implements vscode.TelemetrySender {

    constructor(
        private readonly endpoint: string | undefined,
        private readonly authToken: string | undefined,
        private readonly extensionVersion: string,
        private readonly outputChannel: vscode.OutputChannel,
    ) { }

    sendEventData(eventName: string, data?: Record<string, unknown>): void {
        this.postPayload('usage', eventName, data);
    }

    sendErrorData(error: Error, data?: Record<string, unknown>): void {
        this.postPayload('error', 'extension/error', {
            ...data,
            errorName: error.name,
            errorMessage: error.message,
        });
    }

    private postPayload(kind: 'usage' | 'error', eventName: string, data?: Record<string, unknown>): void {
        if (!this.endpoint) {
            return;
        }

        const body = JSON.stringify({
            kind,
            eventName,
            extensionVersion: this.extensionVersion,
            timestamp: new Date().toISOString(),
            data,
        });

        const request = https.request(this.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
            },
        }, (response) => {
            response.resume();
        });

        request.on('error', (error) => {
            this.outputChannel.appendLine(`[Telemetry] Failed to send telemetry: ${error.message}`);
        });

        request.write(body);
        request.end();
    }
}