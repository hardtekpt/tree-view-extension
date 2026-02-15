import * as fs from 'fs';
import * as path from 'path';

// Safe filesystem helpers used by tree providers.
export function existsDir(fsPath: string): boolean {
    try {
        return fs.statSync(fsPath).isDirectory();
    } catch {
        return false;
    }
}

export function existsFile(fsPath: string): boolean {
    try {
        return fs.statSync(fsPath).isFile();
    } catch {
        return false;
    }
}

export function listEntriesSorted(fsPath: string): string[] {
    // Folders first, then alpha sort (case-insensitive).
    return fs
        .readdirSync(fsPath)
        .sort((a, b) => {
            const aPath = path.join(fsPath, a);
            const bPath = path.join(fsPath, b);

            const aDir = existsDir(aPath);
            const bDir = existsDir(bPath);

            if (aDir !== bDir) {
                return aDir ? -1 : 1;
            }

            return a.localeCompare(b, undefined, { sensitivity: 'base' });
        });
}

export function uniquePath(basePath: string): string {
    // Create a deterministic _2/_3/... suffix when needed.
    if (!fs.existsSync(basePath)) {
        return basePath;
    }

    let index = 2;
    while (true) {
        const candidate = `${basePath}_${index}`;
        if (!fs.existsSync(candidate)) {
            return candidate;
        }
        index += 1;
    }
}
