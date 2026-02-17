import * as path from 'path';
import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import { existsDir, existsFile } from '../utils/fileSystem';
import { getFileIcon } from '../utils/treeIcons';

// Tree item for filesystem entries under the source explorer.
export class SrcNode extends vscode.TreeItem {
    public readonly isDirectory: boolean;

    constructor(public readonly uri: vscode.Uri) {
        const fsPath = uri.fsPath;
        const isDirectory = existsDir(fsPath);

        super(
            path.basename(fsPath),
            isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );

        this.isDirectory = isDirectory;
        this.resourceUri = uri;

        if (isDirectory) {
            this.contextValue = 'srcFolder';
            this.iconPath = new vscode.ThemeIcon('folder');
            return;
        }

        if (existsFile(fsPath)) {
            this.iconPath = getFileIcon(fsPath);
            this.contextValue = 'srcFile';
            this.command = {
                command: COMMANDS.openFile,
                title: 'Open File',
                arguments: [uri]
            };
        }
    }
}
