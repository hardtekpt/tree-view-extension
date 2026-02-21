import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getBasePath } from '../config';
import { FILE_NAMES, FOLDER_NAMES } from '../constants';

// Canonical on-disk location for a workspace snapshot under basePath.
export function getWorkspaceConfigPath(basePath: string): string {
    return path.join(basePath, FOLDER_NAMES.toolkitStateDir, FILE_NAMES.workspaceConfig);
}

export function getDefaultWorkspaceConfigPath(basePath: string): string {
    return getWorkspaceConfigPath(basePath);
}

// Pick the initial location used by save/load dialogs.
export async function getInitialWorkspaceUri(): Promise<vscode.Uri | undefined> {
    const basePath = getBasePath();
    if (basePath) {
        try {
            const dir = path.join(basePath, FOLDER_NAMES.toolkitStateDir);
            fs.mkdirSync(dir, { recursive: true });
            return vscode.Uri.file(path.join(dir, FILE_NAMES.workspaceConfig));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showWarningMessage(`Could not initialize workspace config folder: ${message}`);
            return undefined;
        }
    }

    const firstWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (firstWorkspaceFolder) {
        return vscode.Uri.joinPath(firstWorkspaceFolder, FILE_NAMES.workspaceConfig);
    }

    return undefined;
}

// Show a save dialog for workspace snapshots.
export async function pickWorkspaceToSave(defaultUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const fallbackUri = defaultUri ?? (await getInitialWorkspaceUri());
    return vscode.window.showSaveDialog({
        defaultUri: fallbackUri,
        filters: { 'Workspace Config': ['json'] },
        saveLabel: 'Save Workspace Config'
    });
}

// Show an open dialog for workspace snapshots.
export async function pickWorkspaceToLoad(defaultUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const fallbackUri = defaultUri ?? (await getInitialWorkspaceUri());
    const picked = await vscode.window.showOpenDialog({
        defaultUri: fallbackUri ? vscode.Uri.file(path.dirname(fallbackUri.fsPath)) : undefined,
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'Workspace Config': ['json'] },
        openLabel: 'Load Workspace Config'
    });

    return picked?.[0];
}
