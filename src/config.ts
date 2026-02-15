import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_ROOT } from './constants';

// Centralized access to extension settings.
function config() {
    return vscode.workspace.getConfiguration(CONFIG_ROOT);
}

export function getBasePath(): string | undefined {
    const value = config().get<string>('basePath')?.trim();
    return value ? value : undefined;
}

export function getSourcePath(): string | undefined {
    const base = getBasePath();
    return base ? path.join(base, 'src') : undefined;
}

export function getScenarioPath(): string | undefined {
    const base = getBasePath();
    return base ? path.join(base, 'scenarios') : undefined;
}

export function getPythonCommand(): string {
    return config().get<string>('pythonCommand', 'python');
}

export function getRunScript(): string {
    return config().get<string>('runScript', 'run.py');
}
