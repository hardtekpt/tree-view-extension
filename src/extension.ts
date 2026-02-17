import * as vscode from 'vscode';
import { getBasePath, getScenarioPath } from './config';
import { CONFIG_ROOT, TREE_COMMANDS, VIEW_IDS } from './constants';
import { registerCommands } from './commands/registerCommands';
import { ConfigInspectorProvider } from './configInspector/configInspectorProvider';
import { createWatchers } from './extension/watchers';
import { revealExpandedPaths } from './extension/treeReveal';
import { DevProvider } from './providers/devProvider';
import { ManageWorkspaceProvider } from './providers/manageWorkspaceProvider';
import { ScenarioProvider } from './providers/scenarioProvider';
import { SrcProvider } from './providers/srcProvider';
import { openRunAnalysisPanel } from './runAnalysis/runAnalysisPanel';
import { WorkspaceManager } from './workspace/workspaceManager';
import { TreeViewWorkspaceState } from './workspace/treeViewState';

// Extension entrypoint: compose providers, views, commands, and watchers.
export function activate(context: vscode.ExtensionContext): void {
    const manageWorkspaceProvider = new ManageWorkspaceProvider();
    const devProvider = new DevProvider();
    const srcProvider = new SrcProvider();
    const scenarioProvider = new ScenarioProvider(context.workspaceState);
    const configInspectorProvider = new ConfigInspectorProvider(context);
    const srcExpanded = new Set<string>();
    const scenarioExpanded = new Set<string>();

    const manageWorkspaceTree = vscode.window.createTreeView(VIEW_IDS.manageWorkspace, {
        treeDataProvider: manageWorkspaceProvider,
        showCollapseAll: false
    });

    const devTree = vscode.window.createTreeView(VIEW_IDS.devArea, {
        treeDataProvider: devProvider,
        showCollapseAll: true,
        dragAndDropController: devProvider
    });

    const srcTree = vscode.window.createTreeView(VIEW_IDS.srcExplorer, {
        treeDataProvider: srcProvider,
        showCollapseAll: true,
        dragAndDropController: srcProvider
    });

    const scenarioTree = vscode.window.createTreeView(VIEW_IDS.scenarioExplorer, {
        treeDataProvider: scenarioProvider,
        showCollapseAll: true
    });

    context.subscriptions.push(
        srcTree.onDidExpandElement(event => srcExpanded.add(event.element.uri.fsPath)),
        srcTree.onDidCollapseElement(event => srcExpanded.delete(event.element.uri.fsPath)),
        scenarioTree.onDidExpandElement(event => scenarioExpanded.add(event.element.uri.fsPath)),
        scenarioTree.onDidCollapseElement(event => scenarioExpanded.delete(event.element.uri.fsPath))
    );

    const getTreeViewState = (): TreeViewWorkspaceState => ({
        srcExplorerExpanded: [...srcExpanded],
        scenarioExplorerExpanded: [...scenarioExpanded]
    });

    const applyTreeViewState = async (state: TreeViewWorkspaceState): Promise<void> => {
        srcExpanded.clear();
        scenarioExpanded.clear();
        for (const item of state.srcExplorerExpanded ?? []) {
            srcExpanded.add(item);
        }
        for (const item of state.scenarioExplorerExpanded ?? []) {
            scenarioExpanded.add(item);
        }

        // Normalize UI before replaying expansion state.
        try {
            await vscode.commands.executeCommand(TREE_COMMANDS.collapseSrcExplorer);
        } catch {}
        try {
            await vscode.commands.executeCommand(TREE_COMMANDS.collapseScenarioExplorer);
        } catch {}

        await revealExpandedPaths(srcTree, [...srcExpanded], pathValue => srcProvider.nodeFromPath(pathValue));
        await revealExpandedPaths(scenarioTree, [...scenarioExpanded], pathValue =>
            scenarioProvider.nodeFromPath(pathValue)
        );
    };

    const workspaceManager = new WorkspaceManager(
        devProvider,
        scenarioProvider,
        getTreeViewState,
        applyTreeViewState
    );

    context.subscriptions.push(
        manageWorkspaceTree,
        devTree,
        srcTree,
        scenarioTree,
        scenarioProvider,
        vscode.window.registerWebviewViewProvider(VIEW_IDS.configInspector, configInspectorProvider)
    );

    const watcherState = createWatchers(srcProvider.refresh.bind(srcProvider), scenarioProvider.refresh.bind(scenarioProvider));
    watcherState.rebuild(getBasePath(), getScenarioPath());
    watcherState.attach(context);

    const refreshToolkit = () => {
        watcherState.rebuild(getBasePath(), getScenarioPath());
        srcProvider.refresh();
        scenarioProvider.refresh();
    };

    registerCommands(context, { devProvider, scenarioProvider }, {
        refreshToolkit,
        saveWorkspace: () => workspaceManager.save(),
        loadWorkspace: () => workspaceManager.load(),
        resetWorkspace: () => workspaceManager.reset(),
        openConfigInspector: uri => {
            void configInspectorProvider.openForConfigsFolder(uri);
        },
        openRunAnalysis: uri => {
            void openRunAnalysisPanel(uri);
        }
    });

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration(CONFIG_ROOT)) {
                return;
            }

            refreshToolkit();
        })
    );
}

export function deactivate(): void {}
