import * as vscode from 'vscode';
import { getScenarioPath, getSourcePath } from './config';
import { VIEW_IDS } from './constants';
import { registerCommands } from './commands/registerCommands';
import { DevProvider } from './providers/devProvider';
import { ScenarioProvider } from './providers/scenarioProvider';
import { SrcProvider } from './providers/srcProvider';
import { WorkspaceManager } from './workspace/workspaceManager';

// Extension entrypoint: compose providers, views, commands, and watchers.
export function activate(context: vscode.ExtensionContext): void {
    const devProvider = new DevProvider();
    const srcProvider = new SrcProvider();
    const scenarioProvider = new ScenarioProvider(context.workspaceState);
    const workspaceManager = new WorkspaceManager(devProvider, scenarioProvider);

    const devTree = vscode.window.createTreeView(VIEW_IDS.devArea, {
        treeDataProvider: devProvider,
        showCollapseAll: true,
        dragAndDropController: devProvider
    });

    const srcTree = vscode.window.createTreeView(VIEW_IDS.srcExplorer, {
        treeDataProvider: srcProvider,
        showCollapseAll: true
    });

    const scenarioTree = vscode.window.createTreeView(VIEW_IDS.scenarioExplorer, {
        treeDataProvider: scenarioProvider,
        showCollapseAll: true
    });

    context.subscriptions.push(devTree, srcTree, scenarioTree, scenarioProvider);

    const watcherState = createWatchers(srcProvider.refresh.bind(srcProvider), scenarioProvider.refresh.bind(scenarioProvider));
    watcherState.attach(context);

    const refreshToolkit = () => {
        watcherState.rebuild();
        srcProvider.refresh();
        scenarioProvider.refresh();
    };

    registerCommands(context, { devProvider, scenarioProvider }, {
        refreshToolkit,
        saveWorkspace: () => workspaceManager.save(),
        loadWorkspace: () => workspaceManager.load(),
        resetWorkspace: () => workspaceManager.reset()
    });

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('scenarioToolkit')) {
                return;
            }

            refreshToolkit();
        })
    );
}

export function deactivate(): void {}

type RefreshFunction = () => void;

// Create/rebuild filesystem watchers whenever relevant config changes.
function createWatchers(refreshSrc: RefreshFunction, refreshScenarios: RefreshFunction) {
    let watchers: vscode.Disposable[] = [];

    const disposeAll = () => {
        for (const watcher of watchers) {
            watcher.dispose();
        }
        watchers = [];
    };

    const createWatcher = (basePath: string, refresh: RefreshFunction): vscode.FileSystemWatcher => {
        const pattern = new vscode.RelativePattern(basePath, '**/*');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);

        watcher.onDidCreate(refresh);
        watcher.onDidChange(refresh);
        watcher.onDidDelete(refresh);

        return watcher;
    };

    const rebuild = () => {
        disposeAll();

        const sourcePath = getSourcePath();
        if (sourcePath) {
            watchers.push(createWatcher(sourcePath, refreshSrc));
        }

        const scenarioPath = getScenarioPath();
        if (scenarioPath) {
            watchers.push(createWatcher(scenarioPath, refreshScenarios));
        }
    };

    rebuild();

    return {
        rebuild,
        attach(context: vscode.ExtensionContext) {
            context.subscriptions.push({ dispose: disposeAll });
        }
    };
}
