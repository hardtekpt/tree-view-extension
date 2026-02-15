import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { VIEW_IDS } from '../constants';
import { applyXmlParameterUpdates, extractXmlParameters, readXmlFile, XmlParameter } from './xmlParameters';

type IncomingMessage =
    | { type: 'ready' }
    | { type: 'update'; id: string; value: string }
    | { type: 'togglePin'; id: string };

const PINNED_CONFIG_PARAMETERS_KEY = 'scenarioToolkit.pinnedConfigParameters';

// Webview shown in the sidebar for editing XML configs in a human-readable table.
export class ConfigInspectorProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private configsFolder?: vscode.Uri;
    private watcher?: vscode.FileSystemWatcher;
    private ignoreFsEventsUntil = 0;
    private readonly pinnedParameterIds = new Set<string>();

    constructor(private readonly context: vscode.ExtensionContext) {
        const saved = context.workspaceState.get<string[]>(PINNED_CONFIG_PARAMETERS_KEY, []);
        for (const id of saved) {
            this.pinnedParameterIds.add(id);
        }
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true };
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
            await vscode.commands.executeCommand(`workbench.view.extension.${VIEW_IDS.toolkitContainer}`);
        } catch {}

        // Focus command can vary by VS Code version; treat failures as non-fatal.
        const focusCommands = [
            `${VIEW_IDS.configInspector}.focus`,
            'workbench.action.focusSideBar'
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
            .filter(name => name.toLowerCase().endsWith('.xml'))
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
        void this.context.workspaceState.update(PINNED_CONFIG_PARAMETERS_KEY, [...this.pinnedParameterIds]);
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

        const pattern = new vscode.RelativePattern(this.configsFolder.fsPath, '**/*.xml');
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
        return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 10px; }
    button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 4px 10px; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--vscode-editorWidget-border); text-align: left; padding: 6px 4px; }
    input { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px; }
    .muted { opacity: .8; margin-bottom: 8px; }
    .pin-btn { background: transparent; border: none; cursor: pointer; color: inherit; padding: 0 4px; }
  </style>
</head>
<body>
  <div id="meta" class="muted"></div>
  <div id="message" class="muted"></div>
  <div class="toolbar">
    <input id="fileFilter" placeholder="Filter by file..." />
    <input id="paramFilter" placeholder="Filter by parameter..." />
    <button id="clearFilters" title="Clear filters">Clear</button>
  </div>
  <table id="table">
    <thead>
      <tr>
        <th></th>
        <th>File</th>
        <th>Parameter</th>
        <th>Value</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const tbody = document.querySelector('tbody');
    const meta = document.getElementById('meta');
    const message = document.getElementById('message');
    const fileFilter = document.getElementById('fileFilter');
    const paramFilter = document.getElementById('paramFilter');
    const clearFilters = document.getElementById('clearFilters');
    const state = { rows: [], pinnedIds: new Set() };

    function render(payload) {
      state.rows = payload.rows || [];
      state.pinnedIds = new Set(payload.pinnedIds || []);
      meta.textContent = payload.folderName ? 'Editing: ' + payload.folderName : '';
      message.textContent = payload.message || '';
      renderRows();
    }

    function renderRows() {
      const fileTerm = (fileFilter.value || '').trim().toLowerCase();
      const paramTerm = (paramFilter.value || '').trim().toLowerCase();
      tbody.innerHTML = '';
      const sortedRows = [...state.rows].sort((a, b) => {
        const aPinned = state.pinnedIds.has(a.id);
        const bPinned = state.pinnedIds.has(b.id);
        if (aPinned !== bPinned) {
          return aPinned ? -1 : 1;
        }
        const fileCmp = a.fileName.localeCompare(b.fileName);
        if (fileCmp !== 0) {
          return fileCmp;
        }
        return a.parameterPath.localeCompare(b.parameterPath);
      });

      for (const row of sortedRows) {
        if (fileTerm && !row.fileName.toLowerCase().includes(fileTerm)) {
          continue;
        }
        if (paramTerm && !row.parameterPath.toLowerCase().includes(paramTerm)) {
          continue;
        }
        const tr = document.createElement('tr');
        const pin = state.pinnedIds.has(row.id) ? '📌' : '📍';
        tr.innerHTML = '<td><button class="pin-btn" data-id="' + escapeHtml(row.id) + '" title="Toggle pin">' + pin + '</button></td><td>' + escapeHtml(row.fileName) + '</td><td>' + escapeHtml(row.parameterPath) + '</td>';
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.value = row.value;
        input.dataset.id = row.id;
        td.appendChild(input);
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
    }

    function escapeHtml(value) {
      return value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',\"'\":'&#39;'}[c]));
    }

    let pending = new Map();
    let timer = null;
    function flush() {
      for (const [id, value] of pending.entries()) {
        vscode.postMessage({ type: 'update', id, value });
      }
      pending.clear();
      timer = null;
    }

    document.addEventListener('input', event => {
      const input = event.target;
      if (!input || input.tagName !== 'INPUT') {
        return;
      }

      if (input.id === 'fileFilter' || input.id === 'paramFilter') {
        renderRows();
        return;
      }

      pending.set(input.dataset.id, input.value);
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(flush, 200);
    });

    document.addEventListener('click', event => {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains('pin-btn')) {
        return;
      }
      const id = target.dataset.id;
      if (!id) {
        return;
      }
      vscode.postMessage({ type: 'togglePin', id });
    });

    clearFilters.addEventListener('click', () => {
      fileFilter.value = '';
      paramFilter.value = '';
      renderRows();
    });

    window.addEventListener('message', event => render(event.data));
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
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
