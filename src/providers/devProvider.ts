import * as path from 'path';
import * as vscode from 'vscode';
import { MIME_TYPES } from '../constants';
import { DevNode } from '../nodes/devNode';
import { toPathKey } from '../utils/pathKey';

// Tree provider for the "Development Area" custom file shortlist.
const DEV_MIME = MIME_TYPES.devTree;

export class DevProvider
    implements vscode.TreeDataProvider<DevNode>, vscode.TreeDragAndDropController<DevNode>
{
    readonly dropMimeTypes = [MIME_TYPES.uriList];
    readonly dragMimeTypes = [DEV_MIME];

    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    private items: vscode.Uri[] = [];

    refresh(): void {
        this.changeEmitter.fire();
    }

    clear(): void {
        this.items = [];
        this.refresh();
    }

    getTreeItem(element: DevNode): vscode.TreeItem {
        return element;
    }

    getChildren(): DevNode[] {
        return [...this.items]
            .sort((a, b) =>
                path.basename(a.fsPath).localeCompare(path.basename(b.fsPath), undefined, {
                    sensitivity: 'base'
                })
            )
            .map(uri => new DevNode(uri));
    }

    toggle(uri: vscode.Uri): void {
        const index = this.items.findIndex(item => item.fsPath === uri.fsPath);
        if (index >= 0) {
            this.items.splice(index, 1);
        } else {
            this.items.push(uri);
        }

        this.items = uniqueUris(this.items);
        this.refresh();
    }

    remove(uri: vscode.Uri): void {
        this.items = this.items.filter(item => item.fsPath !== uri.fsPath);
        this.refresh();
    }

    async handleDrop(_target: DevNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        const uriList = dataTransfer.get(MIME_TYPES.uriList);
        if (!uriList) {
            return;
        }

        const dropped = (await uriList.asString())
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('#'))
            .map(line => vscode.Uri.parse(line));

        this.items = uniqueUris([...this.items, ...dropped]);
        this.refresh();
    }

    handleDrag(source: readonly DevNode[], dataTransfer: vscode.DataTransfer): void {
        dataTransfer.set(
            DEV_MIME,
            new vscode.DataTransferItem(JSON.stringify(source.map(node => node.uri.toString())))
        );
    }

    getWorkspaceItems(): string[] {
        return this.items.map(item => item.fsPath);
    }

    applyWorkspaceItems(entries: string[]): void {
        this.items = uniqueUris(entries.map(entry => vscode.Uri.file(entry)));
        this.refresh();
    }
}

function uniqueUris(items: vscode.Uri[]): vscode.Uri[] {
    // Deduplicate paths in a cross-platform-safe way.
    const seen = new Set<string>();
    const deduped: vscode.Uri[] = [];

    for (const uri of items) {
        const key = toPathKey(uri.fsPath);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(uri);
    }

    return deduped;
}
