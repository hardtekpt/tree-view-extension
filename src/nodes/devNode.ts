import * as path from 'path';
import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import { getFileIcon } from '../utils/treeIcons';

// Tree item used in the Development Area list.
export class DevNode extends vscode.TreeItem {
    constructor(public readonly uri: vscode.Uri) {
        super(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None);

        this.resourceUri = uri;
        this.contextValue = 'devFile';
        this.iconPath = getFileIcon(uri.fsPath);
        this.command = {
            command: COMMANDS.openFile,
            title: 'Open File',
            arguments: [uri]
        };
    }
}
