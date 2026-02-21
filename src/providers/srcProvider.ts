import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getBasePath } from '../config';
import { MIME_TYPES } from '../constants';
import { SrcNode } from '../nodes/srcNode';
import { existsDir, listEntriesSorted } from '../utils/fileSystem';
import { toPathKey } from '../utils/pathKey';

const SRC_MIME = MIME_TYPES.srcTree;

// Tree provider for browsing and reorganizing files under configured <basePath>.
export class SrcProvider implements vscode.TreeDataProvider<SrcNode>, vscode.TreeDragAndDropController<SrcNode> {
    readonly dragMimeTypes = [SRC_MIME];
    readonly dropMimeTypes = [SRC_MIME, MIME_TYPES.uriList];

    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    refresh(): void {
        this.changeEmitter.fire();
    }

    getTreeItem(element: SrcNode): vscode.TreeItem {
        return element;
    }

    getParent(element: SrcNode): SrcNode | undefined {
        const basePath = getBasePath();
        if (!basePath) {
            return undefined;
        }

        const parentPath = path.dirname(element.uri.fsPath);
        if (parentPath === element.uri.fsPath || parentPath === basePath) {
            return undefined;
        }

        if (!existsDir(parentPath)) {
            return undefined;
        }

        return new SrcNode(vscode.Uri.file(parentPath));
    }

    getChildren(element?: SrcNode): SrcNode[] {
        const root = element?.uri.fsPath ?? getBasePath();
        if (!root || !existsDir(root)) {
            return [];
        }

        return listEntriesSorted(root).map(name => new SrcNode(vscode.Uri.file(path.join(root, name))));
    }

    nodeFromPath(fsPath: string): SrcNode | undefined {
        if (!fs.existsSync(fsPath)) {
            return undefined;
        }

        return new SrcNode(vscode.Uri.file(fsPath));
    }

    handleDrag(source: readonly SrcNode[], dataTransfer: vscode.DataTransfer): void {
        const uris = source.map(node => node.uri.toString());
        dataTransfer.set(SRC_MIME, new vscode.DataTransferItem(JSON.stringify(uris)));
        dataTransfer.set(MIME_TYPES.uriList, new vscode.DataTransferItem(uris.join('\r\n')));
    }

    async handleDrop(target: SrcNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        const sourceUris = await this.extractDroppedUris(dataTransfer);
        if (sourceUris.length === 0) {
            return;
        }

        const basePath = getBasePath();
        if (!basePath) {
            return;
        }

        const destinationDir = this.resolveDestinationDirectory(target, basePath);
        if (!existsDir(destinationDir)) {
            return;
        }

        for (const sourceUri of sourceUris) {
            const sourcePath = sourceUri.fsPath;
            const sourceKey = toPathKey(sourcePath);
            const destinationPath = path.join(destinationDir, path.basename(sourcePath));
            const destinationKey = toPathKey(destinationPath);

            // Ignore no-op or recursive moves.
            if (sourceKey === destinationKey || destinationKey.startsWith(`${sourceKey}${path.sep}`)) {
                continue;
            }

            if (fs.existsSync(destinationPath)) {
                void vscode.window.showErrorMessage(`Cannot move '${path.basename(sourcePath)}': destination exists.`);
                continue;
            }

            try {
                fs.renameSync(sourcePath, destinationPath);
            } catch (error) {
                const code = getErrorCode(error);

                // Cross-device fallback.
                if (code === 'EXDEV') {
                    try {
                        fs.cpSync(sourcePath, destinationPath, { recursive: true });
                        fs.rmSync(sourcePath, { recursive: true, force: true });
                    } catch (copyError) {
                        const message = copyError instanceof Error ? copyError.message : String(copyError);
                        void vscode.window.showErrorMessage(`Move failed: ${message}`);
                    }
                } else {
                    const message = error instanceof Error ? error.message : String(error);
                    void vscode.window.showErrorMessage(`Move failed: ${message}`);
                }
            }
        }

        this.refresh();
    }

    private resolveDestinationDirectory(target: SrcNode | undefined, basePath: string): string {
        if (!target) {
            return basePath;
        }

        return target.isDirectory ? target.uri.fsPath : path.dirname(target.uri.fsPath);
    }

    private async extractDroppedUris(dataTransfer: vscode.DataTransfer): Promise<vscode.Uri[]> {
        const custom = dataTransfer.get(SRC_MIME);
        if (custom) {
            try {
                const raw: unknown = JSON.parse(await custom.asString());
                if (Array.isArray(raw)) {
                    return raw
                        .filter((entry): entry is string => typeof entry === 'string')
                        .map(entry => vscode.Uri.parse(entry));
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showWarningMessage(`Could not parse dropped data: ${message}`);
            }
        }

        const uriList = dataTransfer.get(MIME_TYPES.uriList);
        if (!uriList) {
            return [];
        }

        return (await uriList.asString())
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('#'))
            .map(line => {
                try {
                    return vscode.Uri.parse(line);
                } catch {
                    return undefined;
                }
            })
            .filter((uri): uri is vscode.Uri => Boolean(uri));
    }
}

function getErrorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code?: unknown }).code;
        return typeof code === 'string' ? code : undefined;
    }
    return undefined;
}
