import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FILE_NAMES, VENV_PATHS } from '../../constants';
import { existsDir, existsFile } from '../../utils/fileSystem';

// Keep command logging readable when arguments include spaces.
export function quoteIfNeeded(value: string): string {
    return /\s/.test(value) ? `"${value}"` : value;
}

// Normalize user-entered flags into a stable single-line representation.
export function normalizeRunFlags(value: string): string {
    return value.trim().replace(/\s+/g, ' ');
}

// Parse shell-like arguments while preserving quoted segments.
export function parseCommandLineArgs(value: string): string[] {
    const text = value.trim();
    if (!text) {
        return [];
    }

    const args: string[] = [];
    let current = '';
    let quote: '"' | "'" | undefined;
    let escaping = false;

    for (const char of text) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }

        if (char === '\\') {
            escaping = true;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = undefined;
            } else {
                current += char;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current.length > 0) {
                args.push(current);
                current = '';
            }
            continue;
        }

        current += char;
    }

    if (escaping) {
        current += '\\';
    }
    if (current.length > 0) {
        args.push(current);
    }

    return args;
}

// Read mtime defensively for sorting when files may disappear mid-refresh.
export function getMtimeMs(filePath: string): number {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}

// Locate a Python venv interpreter in the base path root (non-recursive).
export function findPythonInBasePath(basePath: string): string | undefined {
    // Support both "<basePath> is venv root" and "<basePath>/<venvDir>" layouts.
    const rootCandidate = resolvePythonInVenvRoot(basePath);
    if (rootCandidate) {
        return rootCandidate;
    }

    const preferredDirs = ['.venv', 'venv', 'env'];
    for (const dirName of preferredDirs) {
        const pythonPath = resolvePythonInVenvRoot(path.join(basePath, dirName));
        if (pythonPath) {
            return pythonPath;
        }
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(basePath, { withFileTypes: true });
    } catch {
        return undefined;
    }

    for (const entry of entries) {
        if (preferredDirs.includes(entry.name)) {
            continue;
        }
        const candidatePath = path.join(basePath, entry.name);
        if (!existsDir(candidatePath)) {
            continue;
        }
        const pythonPath = resolvePythonInVenvRoot(candidatePath);
        if (pythonPath) {
            return pythonPath;
        }
    }

    return undefined;
}

// Validate a virtual environment folder by marker + interpreter, with heuristic fallback.
export function resolvePythonInVenvRoot(venvRoot: string): string | undefined {
    const marker = path.join(venvRoot, FILE_NAMES.venvMarker);
    const hasMarker = existsFile(marker);
    const unixPython = path.join(venvRoot, VENV_PATHS.unixBinDir, VENV_PATHS.unixPython);
    const unixPython3 = path.join(venvRoot, VENV_PATHS.unixBinDir, 'python3');
    const windowsPython = path.join(venvRoot, VENV_PATHS.windowsScriptsDir, VENV_PATHS.windowsPythonExe);

    const candidates = process.platform === 'win32'
        ? [windowsPython, unixPython, unixPython3]
        : [unixPython, unixPython3, windowsPython];
    const interpreter = candidates.find(candidate => existsFile(candidate));
    if (!interpreter) {
        return undefined;
    }

    if (hasMarker) {
        return interpreter;
    }

    const hasActivateScript =
        existsFile(path.join(venvRoot, VENV_PATHS.unixBinDir, 'activate')) ||
        existsFile(path.join(venvRoot, VENV_PATHS.windowsScriptsDir, 'activate')) ||
        existsFile(path.join(venvRoot, VENV_PATHS.windowsScriptsDir, 'activate.bat'));
    if (!hasActivateScript) {
        return undefined;
    }

    return interpreter;
}

// Rename with retries + copy/remove fallback for transient Windows locks.
export async function renamePathWithFallback(sourcePath: string, targetPath: string): Promise<void> {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            fs.renameSync(sourcePath, targetPath);
            return;
        } catch (error) {
            const code = getErrorCode(error);
            if ((code !== 'EPERM' && code !== 'EBUSY') || attempt === maxAttempts) {
                break;
            }
            await delay(120 * attempt);
        }
    }

    if (existsDir(sourcePath)) {
        fs.cpSync(sourcePath, targetPath, { recursive: true });
        fs.rmSync(sourcePath, { recursive: true, force: true });
        return;
    }

    fs.renameSync(sourcePath, targetPath);
}

// Stable detached screen session naming for logs + user attach command.
export function buildScreenSessionName(scenarioName: string): string {
    const normalized = scenarioName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const suffix = Date.now().toString(36);
    return `scn_${normalized}_${suffix}`;
}

// Update configuration safely in both workspace and single-file windows.
export async function safeUpdateConfiguration(
    config: vscode.WorkspaceConfiguration,
    key: string,
    value: unknown
): Promise<void> {
    try {
        await config.update(key, value, getPreferredConfigTarget());
    } catch {
        await config.update(key, value, vscode.ConfigurationTarget.Global);
    }
}

function getErrorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error && 'code' in error) {
        const value = (error as { code?: unknown }).code;
        return typeof value === 'string' ? value : undefined;
    }
    return undefined;
}

function getPreferredConfigTarget(): vscode.ConfigurationTarget {
    return vscode.workspace.workspaceFile || (vscode.workspace.workspaceFolders?.length ?? 0) > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
