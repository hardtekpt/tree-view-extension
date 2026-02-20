import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getBasePath } from '../config';
import { STORAGE_KEYS } from '../constants';
import { DevProvider } from '../providers/devProvider';
import { ScenarioProvider } from '../providers/scenarioProvider';
import { ScenarioWorkspaceState } from '../providers/scenario/types';
import { ComponentViewWorkspaceState, TreeViewWorkspaceState } from './treeViewState';
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

const DEFAULT_COMPONENT_VIEWS: ComponentViewWorkspaceState = {
    devAreaVisible: true,
    srcExplorerVisible: true,
    scenarioExplorerVisible: true,
    programInfoVisible: true,
    configInspectorVisible: false
};

export class WorkspaceManager {
    private activeWorkspaceConfigPath?: string;

    constructor(
        private readonly state: vscode.Memento,
        private readonly devProvider: DevProvider,
        private readonly scenarioProvider: ScenarioProvider,
        private readonly getTreeViewState: () => TreeViewWorkspaceState,
        private readonly applyTreeViewState: (state: TreeViewWorkspaceState) => Promise<void>
    ) {}

    initialize(): Promise<void> {
        return this.initializeAsync();
    }

    save(): Promise<void> {
        return this.saveWithPicker();
    }

    load(): Promise<void> {
        return this.loadWithPicker();
    }

    async reset(): Promise<void> {
        this.devProvider.clear();
        this.scenarioProvider.applyWorkspaceState(this.createEmptyScenarioWorkspaceState());
        await this.applyTreeViewState(this.createEmptyTreeViewState());

        const targetPath = this.resolveActiveWorkspacePath();
        if (targetPath) {
            await this.setActiveWorkspaceConfigPath(targetPath);
            this.writeWorkspaceConfig(targetPath, this.createCurrentConfig());
        }

        void vscode.window.showInformationMessage('Workspace configuration has been reset.');
    }

    persistActiveWorkspace(): void {
        const targetPath = this.resolveActiveWorkspacePath();
        if (!targetPath) {
            return;
        }

        this.writeWorkspaceConfig(targetPath, this.createCurrentConfig());
    }

    private async saveWithPicker(): Promise<void> {
        const activePath = this.resolveActiveWorkspacePath();
        const selected = await pickWorkspaceToSave(activePath ? vscode.Uri.file(activePath) : undefined);
        if (!selected) {
            return;
        }

        this.writeWorkspaceConfig(selected.fsPath, this.createCurrentConfig());
        await this.setActiveWorkspaceConfigPath(selected.fsPath);
        void vscode.window.showInformationMessage(`Workspace configuration saved to ${selected.fsPath}`);
    }

    private async loadWithPicker(): Promise<void> {
        const activePath = this.resolveActiveWorkspacePath();
        const selected = await pickWorkspaceToLoad(activePath ? vscode.Uri.file(activePath) : undefined);
        if (!selected) {
            return;
        }

        await this.loadFromPath(selected.fsPath, true);
    }

    private async initializeAsync(): Promise<void> {
        const defaultWorkspacePath = this.getDefaultWorkspacePath();
        if (!defaultWorkspacePath) {
            return;
        }

        const lastUsedPath = this.state.get<string>(STORAGE_KEYS.lastWorkspaceConfigPath);
        const candidatePath = lastUsedPath && fs.existsSync(lastUsedPath) ? lastUsedPath : defaultWorkspacePath;

        if (await this.tryLoadFromPath(candidatePath, false)) {
            return;
        }

        if (candidatePath !== defaultWorkspacePath && (await this.tryLoadFromPath(defaultWorkspacePath, false))) {
            await this.setActiveWorkspaceConfigPath(defaultWorkspacePath);
            return;
        }

        this.writeWorkspaceConfig(defaultWorkspacePath, this.createCurrentConfig());
        await this.setActiveWorkspaceConfigPath(defaultWorkspacePath);
    }

    private async loadFromPath(workspacePath: string, announce: boolean): Promise<void> {
        const parsed = this.readWorkspaceConfig(workspacePath);
        await this.applyConfig(parsed);
        await this.setActiveWorkspaceConfigPath(workspacePath);
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
        this.scenarioProvider.applyWorkspaceState(this.normalizeScenarioState(parsed.scenario));
        await this.applyTreeViewState(this.normalizeTreeViewState(parsed.treeViews));
    }

    private normalizeScenarioState(state: Partial<ScenarioWorkspaceState> | undefined): ScenarioWorkspaceState {
        return {
            filter: state?.filter ?? '',
            scenarioSortMode: state?.scenarioSortMode ?? 'name',
            pinnedScenarios: state?.pinnedScenarios ?? [],
            pinnedIoRuns: state?.pinnedIoRuns ?? [],
            runSortByScenario: state?.runSortByScenario ?? {},
            tagCatalog: state?.tagCatalog ?? [],
            runTagsByPath: state?.runTagsByPath ?? {},
            runFilterTagIdsByScenario: state?.runFilterTagIdsByScenario ?? {},
            globalRunFlags: state?.globalRunFlags ?? '',
            sudoExecutionByScenario: state?.sudoExecutionByScenario ?? {}
        };
    }

    private normalizeTreeViewState(state: Partial<TreeViewWorkspaceState> | undefined): TreeViewWorkspaceState {
        return {
            srcExplorerExpanded: state?.srcExplorerExpanded ?? [],
            scenarioExplorerExpanded: state?.scenarioExplorerExpanded ?? [],
            componentViews: {
                devAreaVisible: state?.componentViews?.devAreaVisible ?? DEFAULT_COMPONENT_VIEWS.devAreaVisible,
                srcExplorerVisible: state?.componentViews?.srcExplorerVisible ?? DEFAULT_COMPONENT_VIEWS.srcExplorerVisible,
                scenarioExplorerVisible:
                    state?.componentViews?.scenarioExplorerVisible ?? DEFAULT_COMPONENT_VIEWS.scenarioExplorerVisible,
                programInfoVisible: state?.componentViews?.programInfoVisible ?? DEFAULT_COMPONENT_VIEWS.programInfoVisible,
                configInspectorVisible:
                    state?.componentViews?.configInspectorVisible ?? DEFAULT_COMPONENT_VIEWS.configInspectorVisible
            }
        };
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

    private createEmptyTreeViewState(): TreeViewWorkspaceState {
        return {
            srcExplorerExpanded: [],
            scenarioExplorerExpanded: [],
            componentViews: { ...DEFAULT_COMPONENT_VIEWS }
        };
    }

    private writeWorkspaceConfig(workspacePath: string, config: ToolkitWorkspaceConfig): void {
        fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
        fs.writeFileSync(workspacePath, JSON.stringify(config, null, 2));
    }

    private resolveActiveWorkspacePath(): string | undefined {
        if (this.activeWorkspaceConfigPath && fs.existsSync(this.activeWorkspaceConfigPath)) {
            return this.activeWorkspaceConfigPath;
        }

        this.activeWorkspaceConfigPath = undefined;
        const fromState = this.state.get<string>(STORAGE_KEYS.lastWorkspaceConfigPath);
        if (fromState && fs.existsSync(fromState)) {
            this.activeWorkspaceConfigPath = fromState;
            return fromState;
        }

        const defaultWorkspacePath = this.getDefaultWorkspacePath();
        if (!defaultWorkspacePath) {
            return undefined;
        }

        if (!fs.existsSync(defaultWorkspacePath)) {
            this.writeWorkspaceConfig(defaultWorkspacePath, this.createCurrentConfig());
        }

        this.activeWorkspaceConfigPath = defaultWorkspacePath;
        void this.state.update(STORAGE_KEYS.lastWorkspaceConfigPath, defaultWorkspacePath);
        return defaultWorkspacePath;
    }

    private getDefaultWorkspacePath(): string | undefined {
        const basePath = getBasePath();
        if (!basePath) {
            return undefined;
        }

        return getDefaultWorkspaceConfigPath(basePath);
    }

    private async setActiveWorkspaceConfigPath(workspacePath: string): Promise<void> {
        this.activeWorkspaceConfigPath = workspacePath;
        await this.state.update(STORAGE_KEYS.lastWorkspaceConfigPath, workspacePath);
    }
}
