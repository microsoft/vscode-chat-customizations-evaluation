import * as vscode from 'vscode';
import * as https from 'https';
import { TELEMETRY_AUTH_TOKEN_ENV, TELEMETRY_ENDPOINT_ENV } from './strings';
import type { TelemetryData } from './types';

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

export class TelemetryWrapper {

    private logger: vscode.TelemetryLogger | undefined;

    constructor(
        private readonly outputChannel: vscode.OutputChannel,
    ) { }

    initialize(context: vscode.ExtensionContext): void {
        const endpoint = process.env[TELEMETRY_ENDPOINT_ENV];
        const authToken = process.env[TELEMETRY_AUTH_TOKEN_ENV];
        if (!endpoint) {
            this.outputChannel.appendLine(
                `[Telemetry] ${TELEMETRY_ENDPOINT_ENV} is not set; telemetry events will be collected by VS Code but not exported by this extension sender.`
            );
        }
        const extensionVersion = String(context.extension.packageJSON.version ?? 'unknown');
        const sender = new ExtensionTelemetrySender(endpoint, authToken, extensionVersion, this.outputChannel);
        this.logger = vscode.env.createTelemetryLogger(sender, {
            additionalCommonProperties: {
                extensionVersion,
            },
        });
    }

    dispose(): void {
        this.logger?.dispose();
        this.logger = undefined;
    }

    logTelemetryUsage(eventName: string, data?: TelemetryData): void {
        this.logger?.logUsage(eventName, data);
    }

    logTelemetryError(eventName: string, error: unknown, data?: TelemetryData): void {
        this.logger?.logError(eventName, {
            ...data,
            errorMessage: error instanceof Error ? error.message : String(error),
        });
    }
}