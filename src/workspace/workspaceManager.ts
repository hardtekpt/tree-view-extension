import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getBasePath } from '../config';
import { DevProvider } from '../providers/devProvider';
import { ScenarioProvider } from '../providers/scenarioProvider';
import { ScenarioWorkspaceState } from '../providers/scenario/types';

// Shape persisted in <basePath>/.scenario-toolkit/workspace.json.
export interface ToolkitWorkspaceConfig {
    version: 1;
    devArea: string[];
    scenario: ScenarioWorkspaceState;
}

export class WorkspaceManager {
    constructor(
        private readonly devProvider: DevProvider,
        private readonly scenarioProvider: ScenarioProvider
    ) {}

    save(): void {
        // Persist both development area and scenario explorer state.
        const basePath = getBasePath();
        if (!basePath) {
            void vscode.window.showWarningMessage('Set scenarioToolkit.basePath before saving workspace configuration.');
            return;
        }

        const workspacePath = getWorkspaceConfigPath(basePath);
        fs.mkdirSync(path.dirname(workspacePath), { recursive: true });

        const config: ToolkitWorkspaceConfig = {
            version: 1,
            devArea: this.devProvider.getWorkspaceItems(),
            scenario: this.scenarioProvider.getWorkspaceState()
        };

        fs.writeFileSync(workspacePath, JSON.stringify(config, null, 2));
        void vscode.window.showInformationMessage(`Workspace configuration saved to ${workspacePath}`);
    }

    load(): void {
        // Restore persisted extension state into providers.
        const basePath = getBasePath();
        if (!basePath) {
            void vscode.window.showWarningMessage('Set scenarioToolkit.basePath before loading workspace configuration.');
            return;
        }

        const workspacePath = getWorkspaceConfigPath(basePath);
        if (!fs.existsSync(workspacePath)) {
            void vscode.window.showWarningMessage(`Workspace configuration not found at ${workspacePath}`);
            return;
        }

        try {
            const raw = fs.readFileSync(workspacePath, 'utf8');
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

            void vscode.window.showInformationMessage(`Workspace configuration loaded from ${workspacePath}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Could not load workspace configuration: ${message}`);
        }
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
}

function getWorkspaceConfigPath(basePath: string): string {
    return path.join(basePath, '.scenario-toolkit', 'workspace.json');
}
