import * as path from 'path';
import * as vscode from 'vscode';

type FileIcon = vscode.ThemeIcon | undefined;

// Return optional icon overrides for file nodes in tree views.
// Returning undefined lets VS Code render the same file icons used in Explorer via resourceUri.
export function getFileIcon(fsPath: string): FileIcon {
    const ext = path.extname(fsPath).toLowerCase();
    void ext;
    return undefined;
}
