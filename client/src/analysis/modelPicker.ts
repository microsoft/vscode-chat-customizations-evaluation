import * as vscode from 'vscode';

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

        const configured = vscode.workspace.getConfiguration('chatCustomizationsEvaluations').get<string>('model', '').trim();
        if (configured) {
            const userSelected = await this.selectFirstModel(
                () => vscode.lm.selectChatModels({ family: configured }),
                'User model matches',
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
