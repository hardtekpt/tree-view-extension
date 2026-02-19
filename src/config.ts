import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_ROOT, DEFAULTS, FOLDER_NAMES, SETTINGS_KEYS } from './constants';

// Centralized access to extension settings.
function config() {
    return vscode.workspace.getConfiguration(CONFIG_ROOT);
}

export function getBasePath(): string | undefined {
    const settingsBasePath = config().get<string>(SETTINGS_KEYS.basePath)?.trim();
    if (getForceSettingsBasePath()) {
        return settingsBasePath ? settingsBasePath : undefined;
    }

    const workspaceBasePath = getFirstWorkspaceFolderPath();
    if (workspaceBasePath) {
        return workspaceBasePath;
    }

    return settingsBasePath ? settingsBasePath : undefined;
}

export function getSourcePath(): string | undefined {
    const base = getBasePath();
    return base ? path.join(base, FOLDER_NAMES.sourceRoot) : undefined;
}

export function getScenarioPath(): string | undefined {
    const base = getBasePath();
    return base ? path.join(base, FOLDER_NAMES.scenariosRoot) : undefined;
}

export function getPythonCommand(): string {
    return config().get<string>(SETTINGS_KEYS.pythonCommand, DEFAULTS.pythonCommand);
}

export function getRunCommandTemplate(): string {
    return config().get<string>(SETTINGS_KEYS.runCommandTemplate, DEFAULTS.runCommandTemplate);
}

export function getForceSettingsBasePath(): boolean {
    return config().get<boolean>(SETTINGS_KEYS.forceSettingsBasePath, DEFAULTS.forceSettingsBasePath);
}

export function getScenarioConfigsFolderName(): string {
    return sanitizeFolderName(
        config().get<string>(SETTINGS_KEYS.scenarioConfigsFolderName, DEFAULTS.scenarioConfigsFolderName),
        DEFAULTS.scenarioConfigsFolderName
    );
}

export function getScenarioIoFolderName(): string {
    return sanitizeFolderName(
        config().get<string>(SETTINGS_KEYS.scenarioIoFolderName, DEFAULTS.scenarioIoFolderName),
        DEFAULTS.scenarioIoFolderName
    );
}

function sanitizeFolderName(value: string | undefined, fallback: string): string {
    const cleaned = (value ?? '').trim().replace(/[\\/]+/g, '');
    return cleaned.length > 0 ? cleaned : fallback;
}

function getFirstWorkspaceFolderPath(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }
    return folder.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}
