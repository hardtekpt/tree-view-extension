import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FILE_EXTENSIONS, GLOB_PATTERNS, STORAGE_KEYS, VIEW_IDS, WORKBENCH_COMMANDS } from '../constants';
import { getConfigInspectorHtml } from './webviewHtml';
import { applyXmlParameterUpdates, extractXmlParameters, readXmlFile, XmlParameter } from './xmlParameters';

type IncomingMessage =
    | { type: 'ready' }
    | { type: 'update'; id: string; value: string }
    | { type: 'togglePin'; id: string };

const CODICON_CSS_RELATIVE_PATH = ['node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'] as const;

// Webview shown in the sidebar for editing XML configs in a human-readable table.
export class ConfigInspectorProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private configsFolder?: vscode.Uri;
    private watcher?: vscode.FileSystemWatcher;
    private ignoreFsEventsUntil = 0;
    private readonly pinnedParameterIds = new Set<string>();

    constructor(private readonly context: vscode.ExtensionContext) {
        const saved = context.workspaceState.get<string[]>(STORAGE_KEYS.pinnedConfigParameters, []);
        for (const id of saved) {
            this.pinnedParameterIds.add(id);
        }
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, ...CODICON_CSS_RELATIVE_PATH.slice(0, -1))
            ]
        };
        view.webview.html = this.getHtml(view.webview);
        view.webview.onDidReceiveMessage((message: IncomingMessage) => {
            if (message.type === 'ready') {
                void this.postState();
                return;
            }
            if (message.type === 'update') {
                void this.saveUpdates([{ id: message.id, value: message.value }]);
                return;
            }
            if (message.type === 'togglePin') {
                this.toggleParameterPin(message.id);
            }
        });
    }

    async openForConfigsFolder(uri: vscode.Uri): Promise<void> {
        this.configsFolder = uri;
        this.rebuildWatcher();
        // Open the extension container first so the Config Inspector can be resolved.
        try {
            await vscode.commands.executeCommand(
                `${WORKBENCH_COMMANDS.showExtensionViewContainerPrefix}${VIEW_IDS.toolkitContainer}`
            );
        } catch {}

        // Focus command can vary by VS Code version; treat failures as non-fatal.
        const focusCommands = [
            `${VIEW_IDS.configInspector}.focus`,
            WORKBENCH_COMMANDS.focusSideBar
        ];
        for (const command of focusCommands) {
            try {
                await vscode.commands.executeCommand(command);
            } catch {}
        }

        // If the view is already resolved, refresh immediately.
        if (await this.waitForViewResolution()) {
            this.view?.show(false);
            await this.postState();
        } else {
            // Keep state cached; once the user opens Config Inspector, "ready" will populate it.
            void vscode.window.showInformationMessage(
                'Config folder selected. Open the "Config Inspector" view in Toolkit to edit XML parameters.'
            );
        }
    }

    private async postState(): Promise<void> {
        if (!this.view) {
            return;
        }
        const payload: ConfigInspectorPayload = {
            ...this.loadRows(),
            pinnedIds: [...this.pinnedParameterIds]
        };
        await this.view.webview.postMessage(payload);
    }

    private loadRows(): Omit<ConfigInspectorPayload, 'pinnedIds'> {
        if (!this.configsFolder) {
            return { rows: [], message: 'Select a scenario configs folder to start editing XML parameters.' };
        }

        if (!fs.existsSync(this.configsFolder.fsPath)) {
            return { rows: [], message: 'Configs folder does not exist anymore.' };
        }

        const xmlFiles = fs
            .readdirSync(this.configsFolder.fsPath)
            .filter(name => name.toLowerCase().endsWith(FILE_EXTENSIONS.xml))
            .map(name => path.join(this.configsFolder!.fsPath, name));

        const rows: XmlParameter[] = [];
        for (const filePath of xmlFiles) {
            const xmlText = readXmlFile(filePath);
            rows.push(...extractXmlParameters(xmlText, filePath));
        }

        return {
            folderName: path.basename(path.dirname(this.configsFolder.fsPath)),
            rows,
            message: rows.length === 0 ? 'No editable XML parameters found in this folder.' : undefined
        };
    }

    private toggleParameterPin(id: string): void {
        if (this.pinnedParameterIds.has(id)) {
            this.pinnedParameterIds.delete(id);
        } else {
            this.pinnedParameterIds.add(id);
        }
        void this.context.workspaceState.update(STORAGE_KEYS.pinnedConfigParameters, [...this.pinnedParameterIds]);
        void this.postState();
    }

    private async saveUpdates(updates: Array<{ id: string; value: string }>): Promise<void> {
        if (!this.configsFolder) {
            return;
        }

        const byFile = new Map<string, Map<string, string>>();
        for (const update of updates) {
            const split = update.id.split('::');
            const filePath = split[0];
            if (!filePath) {
                continue;
            }

            if (!byFile.has(filePath)) {
                byFile.set(filePath, new Map());
            }
            byFile.get(filePath)!.set(update.id, update.value);
        }

        try {
            this.ignoreFsEventsUntil = Date.now() + 250;
            for (const [filePath, fileUpdates] of byFile.entries()) {
                const current = readXmlFile(filePath);
                const next = applyXmlParameterUpdates(current, filePath, fileUpdates);
                fs.writeFileSync(filePath, next, 'utf8');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Failed to save XML updates: ${message}`);
        }
    }

    private rebuildWatcher(): void {
        this.watcher?.dispose();
        this.watcher = undefined;

        if (!this.configsFolder) {
            return;
        }

        const pattern = new vscode.RelativePattern(this.configsFolder.fsPath, GLOB_PATTERNS.xmlFiles);
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        const refresh = () => {
            if (Date.now() < this.ignoreFsEventsUntil) {
                return;
            }
            void this.postState();
        };

        watcher.onDidCreate(refresh);
        watcher.onDidChange(refresh);
        watcher.onDidDelete(refresh);
        this.watcher = watcher;
        this.context.subscriptions.push(watcher);
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = String(Date.now());
        const codiconCssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, ...CODICON_CSS_RELATIVE_PATH)
        );
        return getConfigInspectorHtml(nonce, String(codiconCssUri));
    }

    private async waitForViewResolution(): Promise<boolean> {
        if (this.view) {
            return true;
        }

        for (let i = 0; i < 10; i += 1) {
            await delay(50);
            if (this.view) {
                return true;
            }
        }

        return false;
    }
}

interface ConfigInspectorPayload {
    folderName?: string;
    rows: XmlParameter[];
    message?: string;
    pinnedIds: string[];
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
