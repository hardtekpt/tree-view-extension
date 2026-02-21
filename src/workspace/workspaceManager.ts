import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getBasePath } from '../config';
import { STORAGE_KEYS } from '../constants';
import { DevProvider } from '../providers/devProvider';
import { ScenarioProvider } from '../providers/scenarioProvider';
import { ScenarioWorkspaceState } from '../providers/scenario/types';
import { asBoolean, asBooleanRecord, asStringArray, isJsonRecord, JsonRecord } from '../utils/json';
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
            this.writeWorkspaceConfigOrThrow(targetPath, this.createCurrentConfig());
        }

        void vscode.window.showInformationMessage('Workspace configuration has been reset.');
    }

    persistActiveWorkspace(): void {
        const targetPath = this.resolveActiveWorkspacePath();
        if (!targetPath) {
            return;
        }

        try {
            this.writeWorkspaceConfigOrThrow(targetPath, this.createCurrentConfig());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Could not persist workspace configuration: ${message}`);
        }
    }

    private async saveWithPicker(): Promise<void> {
        const activePath = this.resolveActiveWorkspacePath();
        const selected = await pickWorkspaceToSave(activePath ? vscode.Uri.file(activePath) : undefined);
        if (!selected) {
            return;
        }

        this.writeWorkspaceConfigOrThrow(selected.fsPath, this.createCurrentConfig());
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

        this.writeWorkspaceConfigOrThrow(defaultWorkspacePath, this.createCurrentConfig());
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
        const parsed: unknown = JSON.parse(raw);
        return isJsonRecord(parsed) ? parsed as Partial<ToolkitWorkspaceConfig> : {};
    }

    private async applyConfig(parsed: Partial<ToolkitWorkspaceConfig>): Promise<void> {
        this.devProvider.applyWorkspaceItems(Array.isArray(parsed.devArea) ? parsed.devArea : []);
        this.scenarioProvider.applyWorkspaceState(this.normalizeScenarioState(parsed.scenario));
        await this.applyTreeViewState(this.normalizeTreeViewState(parsed.treeViews));
    }

    private normalizeScenarioState(state: Partial<ScenarioWorkspaceState> | undefined): ScenarioWorkspaceState {
        const raw = isJsonRecord(state) ? state : {};
        return {
            filter: typeof raw.filter === 'string' ? raw.filter : '',
            scenarioSortMode: raw.scenarioSortMode === 'recent' ? 'recent' : 'name',
            pinnedScenarios: asStringArray(raw.pinnedScenarios),
            pinnedIoRuns: asStringArray(raw.pinnedIoRuns),
            runSortByScenario: this.normalizeRunSortByScenario(raw.runSortByScenario),
            tagCatalog: this.normalizeTagCatalog(raw.tagCatalog),
            runTagsByPath: this.normalizeStringArrayMap(raw.runTagsByPath),
            runFilterTagIdsByScenario: this.normalizeStringArrayMap(raw.runFilterTagIdsByScenario),
            globalRunFlags: typeof raw.globalRunFlags === 'string' ? raw.globalRunFlags : '',
            sudoExecutionByScenario: asBooleanRecord(raw.sudoExecutionByScenario)
        };
    }

    private normalizeTreeViewState(state: Partial<TreeViewWorkspaceState> | undefined): TreeViewWorkspaceState {
        const raw = isJsonRecord(state) ? state : {};
        const componentViewsRaw: JsonRecord = isJsonRecord(raw.componentViews) ? raw.componentViews : {};
        return {
            srcExplorerExpanded: asStringArray(raw.srcExplorerExpanded),
            scenarioExplorerExpanded: asStringArray(raw.scenarioExplorerExpanded),
            componentViews: {
                devAreaVisible: asBoolean(componentViewsRaw.devAreaVisible, DEFAULT_COMPONENT_VIEWS.devAreaVisible),
                srcExplorerVisible: asBoolean(
                    componentViewsRaw.srcExplorerVisible,
                    DEFAULT_COMPONENT_VIEWS.srcExplorerVisible
                ),
                scenarioExplorerVisible: asBoolean(
                    componentViewsRaw.scenarioExplorerVisible,
                    DEFAULT_COMPONENT_VIEWS.scenarioExplorerVisible
                ),
                programInfoVisible: asBoolean(
                    componentViewsRaw.programInfoVisible,
                    DEFAULT_COMPONENT_VIEWS.programInfoVisible
                ),
                configInspectorVisible: asBoolean(
                    componentViewsRaw.configInspectorVisible,
                    DEFAULT_COMPONENT_VIEWS.configInspectorVisible
                )
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

    private writeWorkspaceConfigOrThrow(workspacePath: string, config: ToolkitWorkspaceConfig): void {
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
            this.writeWorkspaceConfigOrThrow(defaultWorkspacePath, this.createCurrentConfig());
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

    private normalizeRunSortByScenario(raw: unknown): ScenarioWorkspaceState['runSortByScenario'] {
        if (!isJsonRecord(raw)) {
            return {};
        }

        const result: ScenarioWorkspaceState['runSortByScenario'] = {};
        for (const [scenarioPath, mode] of Object.entries(raw)) {
            result[scenarioPath] = mode === 'recent' ? 'recent' : 'name';
        }
        return result;
    }

    private normalizeTagCatalog(raw: unknown): ScenarioWorkspaceState['tagCatalog'] {
        if (!Array.isArray(raw)) {
            return [];
        }

        const tags: ScenarioWorkspaceState['tagCatalog'] = [];
        for (const entry of raw) {
            if (
                isJsonRecord(entry) &&
                typeof entry.id === 'string' &&
                typeof entry.label === 'string' &&
                typeof entry.color === 'string' &&
                (entry.icon === undefined || typeof entry.icon === 'string') &&
                (entry.description === undefined || typeof entry.description === 'string')
            ) {
                tags.push({
                    id: entry.id,
                    label: entry.label,
                    color: entry.color,
                    icon: entry.icon,
                    description: entry.description
                });
            }
        }
        return tags;
    }

    private normalizeStringArrayMap(raw: unknown): Record<string, string[]> {
        if (!isJsonRecord(raw)) {
            return {};
        }

        const result: Record<string, string[]> = {};
        for (const [key, values] of Object.entries(raw)) {
            const normalized = asStringArray(values);
            if (normalized.length > 0) {
                result[key] = normalized;
            }
        }
        return result;
    }
}
