import * as vscode from 'vscode';
import { getBasePath, getScenarioPath } from './config';
import { TREE_COMMANDS, VIEW_IDS, WORKBENCH_COMMANDS } from './constants';
import { registerCommands } from './commands/registerCommands';
import { ConfigInspectorProvider } from './configInspector/configInspectorProvider';
import { CsvDiffToolProvider } from './csvDiffTool/csvDiffToolProvider';
import { createWatchers } from './extension/watchers';
import { revealExpandedPaths } from './extension/treeReveal';
import { initializeProfileManager } from './profile/profileManager';
import { DevProvider } from './providers/devProvider';
import { ProgramInfoProvider } from './providers/programInfoProvider';
import { ScenarioProvider } from './providers/scenarioProvider';
import { SrcProvider } from './providers/srcProvider';
import { openRunAnalysisPanel } from './runAnalysis/runAnalysisPanel';
import { WorkspaceManager } from './workspace/workspaceManager';
import { ComponentViewWorkspaceState, TreeViewWorkspaceState } from './workspace/treeViewState';

// Extension entrypoint: compose providers, views, commands, and watchers.
export function activate(context: vscode.ExtensionContext): void {
    const profileManager = initializeProfileManager(context);
    const devProvider = new DevProvider();
    const srcProvider = new SrcProvider();
    const scenarioProvider = new ScenarioProvider(context.workspaceState);
    const programInfoProvider = new ProgramInfoProvider(scenarioProvider, context.workspaceState);
    const configInspectorProvider = new ConfigInspectorProvider(context);
    const csvDiffToolProvider = new CsvDiffToolProvider(handle => scenarioProvider.resolveTreeItemHandle(handle));
    const srcExpanded = new Set<string>();
    const scenarioExpanded = new Set<string>();
    let isApplyingTreeViewState = false;
    let isWorkspaceInitializationComplete = false;
    let isWorkspaceStateOperationInProgress = false;
    let isEnsuringProfileForVisibleToolkit = false;

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
        showCollapseAll: true,
        dragAndDropController: scenarioProvider
    });
    const programInfoTree = vscode.window.createTreeView(VIEW_IDS.programInfo, {
        treeDataProvider: programInfoProvider,
        showCollapseAll: false
    });
    let componentViewsState: ComponentViewWorkspaceState = {
        devAreaVisible: devTree.visible,
        srcExplorerVisible: srcTree.visible,
        scenarioExplorerVisible: scenarioTree.visible,
        programInfoVisible: programInfoTree.visible,
        configInspectorVisible: configInspectorProvider.isVisible()
    };

    context.subscriptions.push(
        srcTree.onDidExpandElement(event => srcExpanded.add(event.element.uri.fsPath)),
        srcTree.onDidCollapseElement(event => srcExpanded.delete(event.element.uri.fsPath)),
        scenarioTree.onDidExpandElement(event => scenarioExpanded.add(event.element.uri.fsPath)),
        scenarioTree.onDidCollapseElement(event => scenarioExpanded.delete(event.element.uri.fsPath))
    );

    const getTreeViewState = (): TreeViewWorkspaceState => ({
        srcExplorerExpanded: componentViewsState.srcExplorerVisible ? [...srcExpanded] : [],
        scenarioExplorerExpanded: [...scenarioExpanded],
        componentViews: { ...componentViewsState }
    });

    const isToolkitContainerVisible = (state: ComponentViewWorkspaceState): boolean =>
        state.devAreaVisible ||
        state.srcExplorerVisible ||
        state.scenarioExplorerVisible ||
        state.programInfoVisible ||
        state.configInspectorVisible;

    const applyTreeViewState = async (state: TreeViewWorkspaceState): Promise<void> => {
        isApplyingTreeViewState = true;
        const desiredSrcExpanded = state.componentViews?.srcExplorerVisible
            ? [...(state.srcExplorerExpanded ?? [])]
            : [];
        const desiredScenarioExpanded = [...(state.scenarioExplorerExpanded ?? [])];

        try {
            // Normalize UI before replaying expansion state.
            try {
                await vscode.commands.executeCommand(TREE_COMMANDS.collapseSrcExplorer);
            } catch {}
            try {
                await vscode.commands.executeCommand(TREE_COMMANDS.collapseScenarioExplorer);
            } catch {}

            await revealExpandedPaths(srcTree, desiredSrcExpanded, pathValue => srcProvider.nodeFromPath(pathValue));
            await revealExpandedPaths(scenarioTree, desiredScenarioExpanded, pathValue =>
                scenarioProvider.nodeFromPath(pathValue)
            );

            componentViewsState = { ...state.componentViews };
            const componentViews = componentViewsState;
            if (componentViews && Object.values(componentViews).some(Boolean)) {
                try {
                    await vscode.commands.executeCommand(
                        `${WORKBENCH_COMMANDS.showExtensionViewContainerPrefix}${VIEW_IDS.toolkitContainer}`
                    );
                } catch {}
            }
            if (componentViews?.configInspectorVisible) {
                try {
                    await vscode.commands.executeCommand(`${VIEW_IDS.configInspector}.focus`);
                } catch {}
            }
        } finally {
            // Reconcile sets to the intended restored state (collapse/reveal events can mutate them).
            srcExpanded.clear();
            scenarioExpanded.clear();
            for (const item of desiredSrcExpanded) {
                srcExpanded.add(item);
            }
            for (const item of desiredScenarioExpanded) {
                scenarioExpanded.add(item);
            }
            isApplyingTreeViewState = false;
        }
    };

    const workspaceManager = new WorkspaceManager(
        context.workspaceState,
        devProvider,
        scenarioProvider,
        getTreeViewState,
        applyTreeViewState
    );

    let defaultWorkspaceSaveTimer: NodeJS.Timeout | undefined;
    const scheduleDefaultWorkspaceSave = () => {
        if (
            isApplyingTreeViewState ||
            !isWorkspaceInitializationComplete ||
            isWorkspaceStateOperationInProgress
        ) {
            return;
        }
        if (defaultWorkspaceSaveTimer) {
            clearTimeout(defaultWorkspaceSaveTimer);
        }
        defaultWorkspaceSaveTimer = setTimeout(() => {
            workspaceManager.persistActiveWorkspace();
        }, 250);
    };

    const runWorkspaceStateOperation = async (action: () => Promise<void>): Promise<void> => {
        if (isWorkspaceStateOperationInProgress) {
            return;
        }
        isWorkspaceStateOperationInProgress = true;
        try {
            await action();
            programInfoProvider.refresh();
        } finally {
            isWorkspaceStateOperationInProgress = false;
        }
    };

    const runWithErrorHandling = async (action: () => Promise<void>, failurePrefix: string): Promise<void> => {
        try {
            await action();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`${failurePrefix}: ${message}`);
        }
    };

    const reinitializeWorkspaceState = async (): Promise<void> => {
        isWorkspaceInitializationComplete = false;
        await runWorkspaceStateOperation(() => workspaceManager.initialize());
        isWorkspaceInitializationComplete = true;
        programInfoProvider.refresh();
    };

    context.subscriptions.push(
        profileManager,
        devTree,
        srcTree,
        scenarioTree,
        programInfoTree,
        scenarioProvider,
        programInfoProvider,
        vscode.window.registerWebviewViewProvider(VIEW_IDS.configInspector, configInspectorProvider),
        vscode.window.registerWebviewViewProvider(VIEW_IDS.csvDiffTool, csvDiffToolProvider)
    );

    const watcherState = createWatchers(srcProvider.refresh.bind(srcProvider), scenarioProvider.refresh.bind(scenarioProvider));
    watcherState.rebuild(getBasePath(), getScenarioPath());
    watcherState.attach(context);

    const refreshToolkit = () => {
        watcherState.rebuild(getBasePath(), getScenarioPath());
        srcProvider.refresh();
        scenarioProvider.refresh();
        programInfoProvider.refresh();
        scheduleDefaultWorkspaceSave();
    };

    const syncPythonInterpreter = () => {
        void scenarioProvider.syncPythonInterpreterForBasePath().catch(error => {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showWarningMessage(`Could not update Python interpreter configuration: ${message}`);
        });
    };

    const ensureProfilePromptForVisibleToolkit = () => {
        if (!isWorkspaceInitializationComplete || isWorkspaceStateOperationInProgress) {
            return;
        }
        if (
            !devTree.visible &&
            !srcTree.visible &&
            !scenarioTree.visible &&
            !programInfoTree.visible &&
            !configInspectorProvider.isVisible()
        ) {
            return;
        }
        if (isEnsuringProfileForVisibleToolkit) {
            return;
        }

        isEnsuringProfileForVisibleToolkit = true;
        void runWithErrorHandling(async () => {
            const previousProfileId = profileManager.getActiveProfile()?.id;
            await profileManager.promptToCreateProfileIfMissing();
            const currentProfileId = profileManager.getActiveProfile()?.id;
            if (previousProfileId !== currentProfileId) {
                syncPythonInterpreter();
                await reinitializeWorkspaceState();
                refreshToolkit();
            }
        }, 'Could not initialize profile after opening Toolkit view').finally(() => {
            isEnsuringProfileForVisibleToolkit = false;
        });
    };

    const maybePromptWhenToolkitContainerOpens = (previousState: ComponentViewWorkspaceState) => {
        if (isToolkitContainerVisible(previousState) || !isToolkitContainerVisible(componentViewsState)) {
            return;
        }
        ensureProfilePromptForVisibleToolkit();
    };

    programInfoProvider.refresh();

    const saveWorkspace = () => {
        void runWorkspaceStateOperation(() => workspaceManager.save());
    };
    const loadWorkspace = () => {
        void runWorkspaceStateOperation(() => workspaceManager.load());
    };
    const resetWorkspace = () => {
        void runWorkspaceStateOperation(() => workspaceManager.reset());
    };

    registerCommands(context, { devProvider, scenarioProvider }, {
        refreshToolkit,
        saveWorkspace,
        loadWorkspace,
        resetWorkspace,
        openConfigInspector: uri => {
            void configInspectorProvider.openForConfigsFolder(uri);
        },
        openRunAnalysis: uri => {
            void openRunAnalysisPanel(uri, scenarioProvider);
        },
        profileManager
    });

    context.subscriptions.push(
        new vscode.Disposable(() => {
            if (defaultWorkspaceSaveTimer) {
                clearTimeout(defaultWorkspaceSaveTimer);
            }
        }),
        devProvider.onDidChangeTreeData(() => scheduleDefaultWorkspaceSave()),
        scenarioProvider.onDidChangeTreeData(() => scheduleDefaultWorkspaceSave()),
        srcTree.onDidExpandElement(() => scheduleDefaultWorkspaceSave()),
        srcTree.onDidCollapseElement(() => scheduleDefaultWorkspaceSave()),
        scenarioTree.onDidExpandElement(() => scheduleDefaultWorkspaceSave()),
        scenarioTree.onDidCollapseElement(() => scheduleDefaultWorkspaceSave()),
        devTree.onDidChangeVisibility(() => scheduleDefaultWorkspaceSave()),
        srcTree.onDidChangeVisibility(() => scheduleDefaultWorkspaceSave()),
        scenarioTree.onDidChangeVisibility(() => scheduleDefaultWorkspaceSave()),
        programInfoTree.onDidChangeVisibility(() => scheduleDefaultWorkspaceSave()),
        configInspectorProvider.onDidChangeVisibility(visible => {
            const previousState = { ...componentViewsState };
            componentViewsState.configInspectorVisible = visible;
            maybePromptWhenToolkitContainerOpens(previousState);
            scheduleDefaultWorkspaceSave();
        }),
        profileManager.onDidChangeActiveProfile(() => {
            void runWithErrorHandling(async () => {
                syncPythonInterpreter();
                await reinitializeWorkspaceState();
                refreshToolkit();
            }, 'Could not reload extension state after profile change');
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void runWithErrorHandling(async () => {
                await profileManager.handleWorkspaceFoldersChanged();
                syncPythonInterpreter();
                await reinitializeWorkspaceState();
                refreshToolkit();
            }, 'Could not reload extension state after workspace-folder change');
        })
    );

    context.subscriptions.push(
        devTree.onDidChangeVisibility(() => {
            const previousState = { ...componentViewsState };
            componentViewsState.devAreaVisible = devTree.visible;
            maybePromptWhenToolkitContainerOpens(previousState);
        }),
        srcTree.onDidChangeVisibility(() => {
            const previousState = { ...componentViewsState };
            componentViewsState.srcExplorerVisible = srcTree.visible;
            maybePromptWhenToolkitContainerOpens(previousState);
            if (!srcTree.visible) {
                srcExpanded.clear();
            }
        }),
        scenarioTree.onDidChangeVisibility(() => {
            const previousState = { ...componentViewsState };
            componentViewsState.scenarioExplorerVisible = scenarioTree.visible;
            maybePromptWhenToolkitContainerOpens(previousState);
        }),
        programInfoTree.onDidChangeVisibility(() => {
            const previousState = { ...componentViewsState };
            componentViewsState.programInfoVisible = programInfoTree.visible;
            maybePromptWhenToolkitContainerOpens(previousState);
        })
    );

    void runWithErrorHandling(async () => {
        await profileManager.initialize();
        syncPythonInterpreter();
        await reinitializeWorkspaceState();
        refreshToolkit();
    }, 'Could not initialize extension state');
}

export function deactivate(): void {}
