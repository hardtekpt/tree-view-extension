import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getBasePath } from '../config';
import { DevProvider } from '../providers/devProvider';
import { ScenarioProvider } from '../providers/scenarioProvider';
import { ScenarioWorkspaceState } from '../providers/scenario/types';
import { TreeViewWorkspaceState } from './treeViewState';

// Shape persisted in <basePath>/.scenario-toolkit/workspace.json.
export interface ToolkitWorkspaceConfig {
    version: 1;
    devArea: string[];
    scenario: ScenarioWorkspaceState;
    treeViews: TreeViewWorkspaceState;
}

export class WorkspaceManager {
    constructor(
        private readonly devProvider: DevProvider,
        private readonly scenarioProvider: ScenarioProvider,
        private readonly getTreeViewState: () => TreeViewWorkspaceState,
        private readonly applyTreeViewState: (state: TreeViewWorkspaceState) => Promise<void>
    ) {}

    save(): void {
        // Persist both development area and scenario explorer state.
        void this.saveWithPicker();
    }

    load(): void {
        // Restore persisted extension state into providers.
        void this.loadWithPicker();
    }

    reset(): void {
        // Reset in-memory state to a clean baseline.
        this.devProvider.clear();
        this.scenarioProvider.applyWorkspaceState({
            filter: '',
            scenarioSortMode: 'name',
            pinnedScenarios: [],
            pinnedIoRuns: [],
            runSortByScenario: {},
            tagCatalog: [],
            runTagsByPath: {},
                runFilterTagIdsByScenario: {}
            });
        void this.applyTreeViewState({
            srcExplorerExpanded: [],
            scenarioExplorerExpanded: []
        });

        // Remove persisted file if present.
        const basePath = getBasePath();
        if (basePath) {
            const workspacePath = getWorkspaceConfigPath(basePath);
            if (fs.existsSync(workspacePath)) {
                fs.rmSync(workspacePath, { force: true });
            }
        }

        void vscode.window.showInformationMessage('Workspace configuration has been reset.');
    }

    private async saveWithPicker(): Promise<void> {
        const selected = await pickWorkspaceToSave();
        if (!selected) {
            return;
        }

        const config: ToolkitWorkspaceConfig = {
            version: 1,
            devArea: this.devProvider.getWorkspaceItems(),
            scenario: this.scenarioProvider.getWorkspaceState(),
            treeViews: this.getTreeViewState()
        };

        fs.mkdirSync(path.dirname(selected.fsPath), { recursive: true });
        fs.writeFileSync(selected.fsPath, JSON.stringify(config, null, 2));
        void vscode.window.showInformationMessage(`Workspace configuration saved to ${selected.fsPath}`);
    }

    private async loadWithPicker(): Promise<void> {
        const selected = await pickWorkspaceToLoad();
        if (!selected) {
            return;
        }

        try {
            const raw = fs.readFileSync(selected.fsPath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<ToolkitWorkspaceConfig>;

            this.devProvider.applyWorkspaceItems(Array.isArray(parsed.devArea) ? parsed.devArea : []);
            this.scenarioProvider.applyWorkspaceState({
                filter: parsed.scenario?.filter ?? '',
                scenarioSortMode: parsed.scenario?.scenarioSortMode ?? 'name',
                pinnedScenarios: parsed.scenario?.pinnedScenarios ?? [],
                pinnedIoRuns: parsed.scenario?.pinnedIoRuns ?? [],
                runSortByScenario: parsed.scenario?.runSortByScenario ?? {},
                tagCatalog: parsed.scenario?.tagCatalog ?? [],
                runTagsByPath: parsed.scenario?.runTagsByPath ?? {},
                runFilterTagIdsByScenario: parsed.scenario?.runFilterTagIdsByScenario ?? {}
            });
            await this.applyTreeViewState({
                srcExplorerExpanded: parsed.treeViews?.srcExplorerExpanded ?? [],
                scenarioExplorerExpanded: parsed.treeViews?.scenarioExplorerExpanded ?? []
            });

            void vscode.window.showInformationMessage(`Workspace configuration loaded from ${selected.fsPath}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Could not load workspace configuration: ${message}`);
        }
    }
}

function getWorkspaceConfigPath(basePath: string): string {
    return path.join(basePath, '.scenario-toolkit', 'workspace.json');
}

async function getInitialWorkspaceUri(): Promise<vscode.Uri | undefined> {
    const basePath = getBasePath();
    if (basePath) {
        const dir = path.join(basePath, '.scenario-toolkit');
        fs.mkdirSync(dir, { recursive: true });
        return vscode.Uri.file(path.join(dir, 'workspace.json'));
    }

    const firstWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (firstWorkspaceFolder) {
        return vscode.Uri.joinPath(firstWorkspaceFolder, 'workspace.json');
    }

    return undefined;
}

async function pickWorkspaceToSave(): Promise<vscode.Uri | undefined> {
    const defaultUri = await getInitialWorkspaceUri();
    return vscode.window.showSaveDialog({
        defaultUri,
        filters: { 'Workspace Config': ['json'] },
        saveLabel: 'Save Workspace Config'
    });
}

async function pickWorkspaceToLoad(): Promise<vscode.Uri | undefined> {
    const defaultUri = await getInitialWorkspaceUri();
    const picked = await vscode.window.showOpenDialog({
        defaultUri: defaultUri ? vscode.Uri.file(path.dirname(defaultUri.fsPath)) : undefined,
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'Workspace Config': ['json'] },
        openLabel: 'Load Workspace Config'
    });

    return picked?.[0];
}
