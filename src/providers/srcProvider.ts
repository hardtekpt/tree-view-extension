import * as path from 'path';
import * as vscode from 'vscode';
import { getSourcePath } from '../config';
import { SrcNode } from '../nodes/srcNode';
import { existsDir, listEntriesSorted } from '../utils/fileSystem';

// Read-only tree provider for browsing source files under <basePath>/src.
export class SrcProvider implements vscode.TreeDataProvider<SrcNode> {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    refresh(): void {
        this.changeEmitter.fire();
    }

    getTreeItem(element: SrcNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SrcNode): SrcNode[] {
        const root = element?.uri.fsPath ?? getSourcePath();
        if (!root || !existsDir(root)) {
            return [];
        }

        return listEntriesSorted(root).map(name => new SrcNode(vscode.Uri.file(path.join(root, name))));
    }
}
