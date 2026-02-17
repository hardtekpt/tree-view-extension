import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getBasePath } from '../config';
import { STORAGE_KEYS } from '../constants';
import { DevProvider } from '../providers/devProvider';
import { ScenarioProvider } from '../providers/scenarioProvider';
import { ScenarioWorkspaceState } from '../providers/scenario/types';
import { TreeViewWorkspaceState } from './treeViewState';
import {
    getDefaultWorkspaceConfigPath,
    pickWorkspaceToLoad,
    pickWorkspaceToSave
} from './workspaceFilePicker';

// Shape persisted in <basePath>/.scenario-toolkit/workspace.json.
export interface ToolkitWorkspaceConfig {
    version: 1;
    devArea: string[];
    scenario: ScenarioWorkspaceState;
    treeViews: TreeViewWorkspaceState;
}

export class WorkspaceManager {
    constructor(
        private readonly state: vscode.Memento,
        private readonly devProvider: DevProvider,
        private readonly scenarioProvider: ScenarioProvider,
        private readonly getTreeViewState: () => TreeViewWorkspaceState,
        private readonly applyTreeViewState: (state: TreeViewWorkspaceState) => Promise<void>
    ) {}

    initialize(): void {
        void this.initializeAsync();
    }

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
        this.scenarioProvider.applyWorkspaceState(this.createEmptyScenarioWorkspaceState());
        void this.applyTreeViewState({
            srcExplorerExpanded: [],
            scenarioExplorerExpanded: []
        });

        const basePath = getBasePath();
        if (basePath) {
            const defaultWorkspacePath = getDefaultWorkspaceConfigPath(basePath);
            void this.state.update(STORAGE_KEYS.lastWorkspaceConfigPath, defaultWorkspacePath);
            this.writeWorkspaceConfig(defaultWorkspacePath, this.createCurrentConfig());
        }

        void vscode.window.showInformationMessage('Workspace configuration has been reset.');
    }

    persistDefaultWorkspace(): void {
        const basePath = getBasePath();
        if (!basePath) {
            return;
        }

        const defaultWorkspacePath = getDefaultWorkspaceConfigPath(basePath);
        this.writeWorkspaceConfig(defaultWorkspacePath, this.createCurrentConfig());
    }

    private async saveWithPicker(): Promise<void> {
        const selected = await pickWorkspaceToSave();
        if (!selected) {
            return;
        }

        this.writeWorkspaceConfig(selected.fsPath, this.createCurrentConfig());
        await this.state.update(STORAGE_KEYS.lastWorkspaceConfigPath, selected.fsPath);
        this.persistDefaultWorkspace();
        void vscode.window.showInformationMessage(`Workspace configuration saved to ${selected.fsPath}`);
    }

    private async loadWithPicker(): Promise<void> {
        const selected = await pickWorkspaceToLoad();
        if (!selected) {
            return;
        }

        await this.loadFromPath(selected.fsPath, true);
    }

    private async initializeAsync(): Promise<void> {
        const basePath = getBasePath();
        if (!basePath) {
            return;
        }

        const defaultWorkspacePath = getDefaultWorkspaceConfigPath(basePath);
        const lastUsedPath = this.state.get<string>(STORAGE_KEYS.lastWorkspaceConfigPath);
        const candidate = lastUsedPath ?? defaultWorkspacePath;
        const loaded = await this.tryLoadFromPath(candidate, false);
        if (loaded) {
            return;
        }

        if (candidate !== defaultWorkspacePath) {
            const fallbackLoaded = await this.tryLoadFromPath(defaultWorkspacePath, false);
            if (fallbackLoaded) {
                await this.state.update(STORAGE_KEYS.lastWorkspaceConfigPath, defaultWorkspacePath);
                return;
            }
        }

        this.persistDefaultWorkspace();
        await this.state.update(STORAGE_KEYS.lastWorkspaceConfigPath, defaultWorkspacePath);
    }

    private async loadFromPath(workspacePath: string, announce: boolean): Promise<void> {
        const parsed = this.readWorkspaceConfig(workspacePath);
        await this.applyConfig(parsed);
        await this.state.update(STORAGE_KEYS.lastWorkspaceConfigPath, workspacePath);
        this.persistDefaultWorkspace();
        if (announce) {
            void vscode.window.showInformationMessage(`Workspace configuration loaded from ${workspacePath}`);
        }
    }

    private async tryLoadFromPath(workspacePath: string, announce: boolean): Promise<boolean> {
        if (!fs.existsSync(workspacePath)) {
            return false;
        }

        try {
            await this.loadFromPath(workspacePath, announce);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Could not load workspace configuration: ${message}`);
            return false;
        }
    }

    private readWorkspaceConfig(workspacePath: string): Partial<ToolkitWorkspaceConfig> {
        const raw = fs.readFileSync(workspacePath, 'utf8');
        return JSON.parse(raw) as Partial<ToolkitWorkspaceConfig>;
    }

    private async applyConfig(parsed: Partial<ToolkitWorkspaceConfig>): Promise<void> {
        this.devProvider.applyWorkspaceItems(Array.isArray(parsed.devArea) ? parsed.devArea : []);
        this.scenarioProvider.applyWorkspaceState({
            filter: parsed.scenario?.filter ?? '',
            scenarioSortMode: parsed.scenario?.scenarioSortMode ?? 'name',
            pinnedScenarios: parsed.scenario?.pinnedScenarios ?? [],
            pinnedIoRuns: parsed.scenario?.pinnedIoRuns ?? [],
            runSortByScenario: parsed.scenario?.runSortByScenario ?? {},
            tagCatalog: parsed.scenario?.tagCatalog ?? [],
            runTagsByPath: parsed.scenario?.runTagsByPath ?? {},
            runFilterTagIdsByScenario: parsed.scenario?.runFilterTagIdsByScenario ?? {},
            globalRunFlags: parsed.scenario?.globalRunFlags ?? '',
            sudoExecutionByScenario: parsed.scenario?.sudoExecutionByScenario ?? {}
        });
        await this.applyTreeViewState({
            srcExplorerExpanded: parsed.treeViews?.srcExplorerExpanded ?? [],
            scenarioExplorerExpanded: parsed.treeViews?.scenarioExplorerExpanded ?? []
        });
    }

    private createCurrentConfig(): ToolkitWorkspaceConfig {
        return {
            version: 1,
            devArea: this.devProvider.getWorkspaceItems(),
            scenario: this.scenarioProvider.getWorkspaceState(),
            treeViews: this.getTreeViewState()
        };
    }

    private createEmptyScenarioWorkspaceState(): ScenarioWorkspaceState {
        return {
            filter: '',
            scenarioSortMode: 'name',
            pinnedScenarios: [],
            pinnedIoRuns: [],
            runSortByScenario: {},
            tagCatalog: [],
            runTagsByPath: {},
            runFilterTagIdsByScenario: {},
            globalRunFlags: '',
            sudoExecutionByScenario: {}
        };
    }

    private writeWorkspaceConfig(workspacePath: string, config: ToolkitWorkspaceConfig): void {
        fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
        fs.writeFileSync(workspacePath, JSON.stringify(config, null, 2));
    }
}
