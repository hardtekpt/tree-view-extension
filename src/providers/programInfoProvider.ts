import * as path from 'path';
import * as vscode from 'vscode';
import { getBasePath, getPythonCommand } from '../config';
import { COMMANDS, DEFAULTS } from '../constants';
import { getProfileManager } from '../profile/profileManager';
import type { LastExecutionInfo, ScenarioProvider } from './scenarioProvider';
import { findPythonInBasePath } from './scenario/runtimeUtils';

type ProgramInfoSection = 'currentProfile' | 'currentProgram' | 'lastExecution';

class ProgramInfoItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        readonly section?: ProgramInfoSection
    ) {
        super(label, collapsibleState);
    }
}

export class ProgramInfoProvider implements vscode.TreeDataProvider<ProgramInfoItem>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<ProgramInfoItem | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly scenarioProvider: ScenarioProvider) {
        this.disposables.push(
            this.scenarioProvider.onDidChangeLastExecution(() => {
                this.refresh();
            })
        );
    }

    refresh(): void {
        this.emitter.fire(undefined);
    }

    dispose(): void {
        this.emitter.dispose();
        this.disposables.forEach(disposable => disposable.dispose());
    }

    getTreeItem(element: ProgramInfoItem): ProgramInfoItem {
        return element;
    }

    getChildren(element?: ProgramInfoItem): ProgramInfoItem[] {
        if (!element) {
            return [
                this.createSectionItem('Current Profile', 'currentProfile'),
                this.createSectionItem('Current Program', 'currentProgram'),
                this.createSectionItem('Last Execution', 'lastExecution')
            ];
        }

        if (element.section === 'currentProfile') {
            return this.getCurrentProfileItems();
        }

        if (element.section === 'currentProgram') {
            return this.getCurrentProgramItems();
        }

        if (element.section === 'lastExecution') {
            return this.getLastExecutionItems();
        }

        return [];
    }

    private createSectionItem(label: string, section: ProgramInfoSection | 'currentProfile'): ProgramInfoItem {
        const item = new ProgramInfoItem(label, vscode.TreeItemCollapsibleState.Expanded, section);
        item.contextValue = section === 'currentProfile' ? 'programInfoProfile' : 'programInfoSection';
        item.iconPath = new vscode.ThemeIcon(
            section === 'currentProgram' ? 'settings-gear' : section === 'lastExecution' ? 'history' : 'account'
        );
        return item;
    }

    private getCurrentProfileItems(): ProgramInfoItem[] {
        const profile = getProfileManager()?.getActiveProfile();
        if (!profile) {
            const emptyItem = new ProgramInfoItem('No active profile bound to this workspace.', vscode.TreeItemCollapsibleState.None);
            emptyItem.iconPath = new vscode.ThemeIcon('circle-slash');
            emptyItem.contextValue = 'programInfoProfile';
            return [emptyItem];
        }

        const nameItem = new ProgramInfoItem(`Name: ${profile.name}`, vscode.TreeItemCollapsibleState.None);
        nameItem.iconPath = new vscode.ThemeIcon('symbol-key');
        nameItem.contextValue = 'programInfoProfile';

        const idItem = new ProgramInfoItem(`ID: ${profile.id}`, vscode.TreeItemCollapsibleState.None);
        idItem.iconPath = new vscode.ThemeIcon('key');
        idItem.contextValue = 'programInfoProfile';
        idItem.command = {
            command: COMMANDS.copyTextValue,
            title: 'Copy Profile ID',
            arguments: [profile.id]
        };
        idItem.tooltip = `${profile.id}\nClick to copy`;

        const strategyItem = new ProgramInfoItem(
            `Python strategy: ${profile.pythonStrategy === 'fixedPath' ? 'Fixed path' : 'Auto venv'}`,
            vscode.TreeItemCollapsibleState.None
        );
        strategyItem.iconPath = new vscode.ThemeIcon('symbol-method');
        strategyItem.contextValue = 'programInfoProfile';

        const structureItem = new ProgramInfoItem(
            `Structure: ${profile.scenariosRoot}/<scenario>/{${profile.scenarioConfigsFolderName}, ${profile.scenarioIoFolderName}}`,
            vscode.TreeItemCollapsibleState.None
        );
        structureItem.iconPath = new vscode.ThemeIcon('folder-opened');
        structureItem.contextValue = 'programInfoProfile';
        structureItem.tooltip = `Scenarios root: ${profile.scenariosRoot}\nConfigs: ${profile.scenarioConfigsFolderName}\nOutputs: ${profile.scenarioIoFolderName}`;

        const commandItem = new ProgramInfoItem(
            `Run template: ${profile.runCommandTemplate}`,
            vscode.TreeItemCollapsibleState.None
        );
        commandItem.iconPath = new vscode.ThemeIcon('terminal-cmd');
        commandItem.contextValue = 'programInfoProfile';
        commandItem.command = {
            command: COMMANDS.copyTextValue,
            title: 'Copy Run Template',
            arguments: [profile.runCommandTemplate]
        };
        commandItem.tooltip = `${profile.runCommandTemplate}\nClick to copy`;

        const parserCountItem = new ProgramInfoItem(
            `Filename parsers: ${profile.outputFilenameParsers.length}`,
            vscode.TreeItemCollapsibleState.None
        );
        parserCountItem.iconPath = new vscode.ThemeIcon('symbol-struct');
        parserCountItem.contextValue = 'programInfoProfile';

        const updatedItem = new ProgramInfoItem(
            `Updated: ${new Date(profile.updatedAtMs).toLocaleString()}`,
            vscode.TreeItemCollapsibleState.None
        );
        updatedItem.iconPath = new vscode.ThemeIcon('clock');
        updatedItem.contextValue = 'programInfoProfile';

        return [nameItem, idItem, strategyItem, structureItem, commandItem, parserCountItem, updatedItem];
    }

    private getCurrentProgramItems(): ProgramInfoItem[] {
        const basePath = getBasePath();
        const activeProfile = getProfileManager()?.getActiveProfile();
        const venvPython = activeProfile?.pythonStrategy === 'autoVenv' && basePath ? findPythonInBasePath(basePath) : undefined;
        const pythonPath = getPythonCommand() || DEFAULTS.pythonCommand;
        const venvName = venvPython ? getVenvNameFromPythonPath(venvPython) : undefined;

        const baseItem = new ProgramInfoItem(
            `Base path: ${basePath ?? 'Not available'}`,
            vscode.TreeItemCollapsibleState.None
        );
        baseItem.iconPath = new vscode.ThemeIcon('folder-library');
        baseItem.tooltip = basePath ?? 'Open a folder in this VS Code window.';
        if (basePath) {
            baseItem.command = {
                command: COMMANDS.copyTextValue,
                title: 'Copy Base Path',
                arguments: [basePath]
            };
            baseItem.tooltip = `${basePath}\nClick to copy`;
        }

        const pythonItem = new ProgramInfoItem(
            `Python: ${pythonPath}`,
            vscode.TreeItemCollapsibleState.None
        );
        pythonItem.iconPath = new vscode.ThemeIcon('symbol-class');
        pythonItem.tooltip = `${pythonPath}\nClick to copy`;
        pythonItem.command = {
            command: COMMANDS.copyTextValue,
            title: 'Copy Python Path',
            arguments: [pythonPath]
        };

        const envLabel =
            activeProfile?.pythonStrategy === 'fixedPath'
                ? 'Environment: Fixed python path'
                : venvPython
                    ? `Environment: Virtual environment (${venvName ?? 'unknown'})`
                    : 'Environment: System Python fallback';
        const envItem = new ProgramInfoItem(envLabel, vscode.TreeItemCollapsibleState.None);
        envItem.iconPath = new vscode.ThemeIcon(venvPython ? 'vm' : 'terminal');
        envItem.tooltip = envLabel;

        return [baseItem, pythonItem, envItem];
    }

    private getLastExecutionItems(): ProgramInfoItem[] {
        const lastExecution = this.scenarioProvider.getLastExecutionInfo();
        if (!lastExecution) {
            const emptyItem = new ProgramInfoItem('No execution detected yet.', vscode.TreeItemCollapsibleState.None);
            emptyItem.iconPath = new vscode.ThemeIcon('circle-slash');
            return [emptyItem];
        }

        const scenarioItem = new ProgramInfoItem(
            `Scenario: ${lastExecution.scenarioName}`,
            vscode.TreeItemCollapsibleState.None
        );
        scenarioItem.iconPath = new vscode.ThemeIcon('folder');
        scenarioItem.tooltip = `${lastExecution.scenarioPath}\nClick to reveal in Explorer`;
        scenarioItem.command = {
            command: 'revealInExplorer',
            title: 'Reveal Scenario In Explorer',
            arguments: [vscode.Uri.file(lastExecution.scenarioPath)]
        };

        const runName = lastExecution.runName ?? 'Not found';
        const runItem = new ProgramInfoItem(`Run: ${runName}`, vscode.TreeItemCollapsibleState.None);
        runItem.iconPath = new vscode.ThemeIcon('output');
        if (lastExecution.runPath) {
            runItem.tooltip = `${lastExecution.runPath}\nClick to reveal in Explorer`;
            runItem.command = {
                command: 'revealInExplorer',
                title: 'Reveal Run Folder In Explorer',
                arguments: [vscode.Uri.file(lastExecution.runPath)]
            };
        } else {
            runItem.tooltip = 'Run folder could not be resolved from filesystem timestamps.';
        }

        const timestampItem = new ProgramInfoItem(
            `Updated: ${new Date(lastExecution.timestampMs).toLocaleString()}`,
            vscode.TreeItemCollapsibleState.None
        );
        timestampItem.iconPath = new vscode.ThemeIcon('clock');

        return [scenarioItem, runItem, timestampItem];
    }
}

function getVenvNameFromPythonPath(pythonPath: string): string | undefined {
    const normalized = path.normalize(pythonPath);
    const parent = path.basename(path.dirname(normalized)).toLowerCase();
    if (parent === 'bin' || parent === 'scripts') {
        return path.basename(path.dirname(path.dirname(normalized)));
    }
    return path.basename(path.dirname(normalized));
}
