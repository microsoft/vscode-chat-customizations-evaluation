import * as vscode from 'vscode';

interface ConfiguredModelSelector {
    vendor?: string;
    family?: string;
}

export class ModelPicker {

    private cachedModel: vscode.LanguageModelChat | undefined;
    private modelSelectionPromise: Promise<vscode.LanguageModelChat | undefined> | undefined;

    constructor(private outputChannel: vscode.OutputChannel) { }

    public clearCache(): void {
        this.cachedModel = undefined;
        this.modelSelectionPromise = undefined;
    }

    public async selectModel(): Promise<vscode.LanguageModelChat | undefined> {
        if (this.cachedModel) {
            return this.cachedModel;
        }
        if (this.modelSelectionPromise) {
            return this.modelSelectionPromise;
        }
        this.modelSelectionPromise = this.pickModel();
        try {
            const model = await this.modelSelectionPromise;
            if (!model) {
                return undefined;
            }
            this.cachedModel = model;
            this.outputChannel.appendLine(`[LLM Proxy] Using model: ${model.name} (${model.vendor}/${model.family})`);
            return model;
        } finally {
            this.modelSelectionPromise = undefined;
        }
    }

    private async pickModel(): Promise<vscode.LanguageModelChat | undefined> {
        if (!vscode.lm.selectChatModels) {
            return undefined;
        }

        const configured = vscode.workspace.getConfiguration('chatCustomizationsEvaluations').get<string>('model', '');
        const selector = this.parseConfiguredModel(configured);
        if (selector) {
            const label = selector.vendor
                ? `User model matches (${selector.vendor}/${selector.family ?? '*'})`
                : 'User model matches';
            const userSelected = await this.selectFirstModel(
                () => vscode.lm.selectChatModels(selector),
                label,
            );
            if (userSelected) {
                return userSelected;
            }
            this.log('User model not found, falling back to default selection...');
        }

        this.outputChannel.appendLine('[LLM Proxy] Selecting chat models...');

        const claude = await this.selectFirstModel(
            () => vscode.lm.selectChatModels({ vendor: 'copilot', family: 'claude-sonnet-4.6' }),
            'claude-sonnet-4.6 models',
        );
        if (claude) {
            return claude;
        }

        const anyCopilot = await this.selectFirstModel(
            () => vscode.lm.selectChatModels({ vendor: 'copilot' }),
            'Any Copilot models',
        );
        if (anyCopilot) {
            return anyCopilot;
        }

        return this.selectFirstModel(() => vscode.lm.selectChatModels(), 'Any models');
    }

    /**
     * Parses the `chatCustomizationsEvaluations.model` setting.
     * Accepts a bare family (`claude-sonnet-5`) or a vendor-scoped
     * `vendor:family` value (`copilot:claude-sonnet-5`). A trailing empty
     * family (`copilot:`) selects any model from that vendor.
     */
    private parseConfiguredModel(configured: string): ConfiguredModelSelector | undefined {
        const trimmed = configured.trim();
        if (!trimmed) {
            return undefined;
        }

        const separatorIndex = trimmed.indexOf(':');
        if (separatorIndex === -1) {
            return { family: trimmed };
        }

        const vendor = trimmed.slice(0, separatorIndex).trim();
        const family = trimmed.slice(separatorIndex + 1).trim();
        if (!vendor) {
            return family ? { family } : undefined;
        }

        return family ? { vendor, family } : { vendor };
    }

    private async selectFirstModel(
        query: () => Thenable<readonly vscode.LanguageModelChat[]>,
        label: string,
    ): Promise<vscode.LanguageModelChat | undefined> {
        const models = await query();
        this.outputChannel.appendLine(`[LLM Proxy] ${label} found: ${models.length}`);
        return models[0];
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[LLM Proxy] ${message}`);
    }
}
