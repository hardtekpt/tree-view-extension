import * as vscode from 'vscode';

// Empty view used to host shared workspace actions in its title toolbar.
export class ManageWorkspaceProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.TreeItem[] {
        return [];
    }
}
