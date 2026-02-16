import * as vscode from 'vscode';
import { GLOB_PATTERNS } from '../constants';

type RefreshFunction = () => void;

// Manage lifecycle of file-system watchers used by source/scenario providers.
export function createWatchers(refreshSrc: RefreshFunction, refreshScenarios: RefreshFunction) {
    let watchers: vscode.Disposable[] = [];

    const disposeAll = () => {
        for (const watcher of watchers) {
            watcher.dispose();
        }
        watchers = [];
    };

    const createWatcher = (basePath: string, refresh: RefreshFunction): vscode.FileSystemWatcher => {
        const pattern = new vscode.RelativePattern(basePath, GLOB_PATTERNS.allFiles);
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);

        watcher.onDidCreate(refresh);
        watcher.onDidChange(refresh);
        watcher.onDidDelete(refresh);

        return watcher;
    };

    const rebuild = (sourcePath?: string, scenarioPath?: string) => {
        disposeAll();

        if (sourcePath) {
            watchers.push(createWatcher(sourcePath, refreshSrc));
        }

        if (scenarioPath) {
            watchers.push(createWatcher(scenarioPath, refreshScenarios));
        }
    };

    return {
        rebuild,
        attach(context: vscode.ExtensionContext) {
            context.subscriptions.push({ dispose: disposeAll });
        }
    };
}
