import * as path from 'path';

// Normalize paths for stable map/set keys across platforms.
export function toPathKey(fsPath: string): string {
    const resolved = path.resolve(fsPath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
