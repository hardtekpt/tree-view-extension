import * as path from 'path';
import * as vscode from 'vscode';
import { COMMANDS } from '../constants';

// Node types used by the scenario explorer tree.
export type ScenarioNodeType = 'scenario' | 'folder' | 'ioFolder' | 'ioRun' | 'file' | 'status';
export type ScenarioRunSortMode = 'name' | 'recent';

// Tree item model shared across scenario folders, runs, and files.
export class ScenarioNode extends vscode.TreeItem {
    public readonly isPinned: boolean;
    public readonly scenarioRootPath?: string;

    constructor(
        public readonly uri: vscode.Uri,
        public readonly type: ScenarioNodeType,
        collapsibleState: vscode.TreeItemCollapsibleState,
        label?: string,
        isPinned = false,
        scenarioRootPath?: string,
        _runSortMode?: ScenarioRunSortMode
    ) {
        super(label ?? path.basename(uri.fsPath), collapsibleState);

        this.isPinned = isPinned;
        this.scenarioRootPath = scenarioRootPath;
        this.resourceUri = uri;
        this.contextValue = type;

        if (type === 'file') {
            this.iconPath = new vscode.ThemeIcon('symbol-file');
            this.command = {
                command: COMMANDS.openFile,
                title: 'Open File',
                arguments: [uri]
            };
            return;
        }

        if (type === 'ioRun') {
            if (isPinned) {
                this.iconPath = new vscode.ThemeIcon('pinned');
            } else {
                this.iconPath =
                    collapsibleState === vscode.TreeItemCollapsibleState.None
                        ? new vscode.ThemeIcon('symbol-file')
                        : new vscode.ThemeIcon('folder');
            }

            if (collapsibleState === vscode.TreeItemCollapsibleState.None) {
                this.command = {
                    command: COMMANDS.openFile,
                    title: 'Open File',
                    arguments: [uri]
                };
            }
            return;
        }

        if (type === 'status') {
            this.iconPath = new vscode.ThemeIcon('info');
            return;
        }

        if (type === 'scenario') {
            if (isPinned) {
                this.iconPath = new vscode.ThemeIcon('pinned');
            }
            return;
        }

        this.iconPath = new vscode.ThemeIcon('folder');
    }
}
