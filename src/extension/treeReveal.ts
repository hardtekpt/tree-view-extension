import * as vscode from 'vscode';

// Replay previously expanded paths after a workspace snapshot load.
export async function revealExpandedPaths<T>(
    treeView: vscode.TreeView<T>,
    paths: string[],
    resolveNode: (fsPath: string) => T | undefined
): Promise<void> {
    const sorted = [...paths].sort((a, b) => a.length - b.length);
    for (const fsPath of sorted) {
        const node = resolveNode(fsPath);
        if (!node) {
            continue;
        }
        try {
            await treeView.reveal(node, { expand: true, focus: false, select: false });
        } catch {
            // Ignore nodes that no longer exist.
        }
    }
}
