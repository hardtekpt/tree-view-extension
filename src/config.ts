import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_ROOT, DEFAULTS, FOLDER_NAMES, SETTINGS_KEYS } from './constants';

// Centralized access to extension settings.
function config() {
    return vscode.workspace.getConfiguration(CONFIG_ROOT);
}

export function getBasePath(): string | undefined {
    const value = config().get<string>(SETTINGS_KEYS.basePath)?.trim();
    return value ? value : undefined;
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
