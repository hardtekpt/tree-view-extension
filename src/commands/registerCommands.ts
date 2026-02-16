import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import { DevProvider } from '../providers/devProvider';
import { ScenarioProvider } from '../providers/scenarioProvider';
import { asNodeArg, asUri, MaybeNodeArg, MaybeUriArg, NodeArg, WithUri } from './commandArgs';

// Register every command in one place to keep activation minimal.
export function registerCommands(
    context: vscode.ExtensionContext,
    providers: { devProvider: DevProvider; scenarioProvider: ScenarioProvider },
    callbacks: {
        refreshToolkit: () => void;
        saveWorkspace: () => void;
        loadWorkspace: () => void;
        resetWorkspace: () => void;
        openConfigInspector: (uri: vscode.Uri) => void;
    }
): void {
    const { devProvider, scenarioProvider } = providers;
    const { refreshToolkit, saveWorkspace, loadWorkspace, resetWorkspace, openConfigInspector } = callbacks;

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.openFile, openFile),
        vscode.commands.registerCommand(COMMANDS.toggleDev, (arg: MaybeUriArg) => {
            const uri = asUri(arg);
            if (uri) {
                devProvider.toggle(uri);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.runScenario, (node: WithUri) => scenarioProvider.run(node.uri)),
        vscode.commands.registerCommand(COMMANDS.runScenarioSudo, (node: WithUri) =>
            scenarioProvider.run(node.uri, true)
        ),
        vscode.commands.registerCommand(COMMANDS.runScenarioScreen, (node: WithUri) =>
            scenarioProvider.runInDetachedScreen(node.uri)
        ),
        vscode.commands.registerCommand(COMMANDS.setGlobalRunFlags, () => scenarioProvider.setGlobalRunFlags()),
        vscode.commands.registerCommand(COMMANDS.duplicateScenario, (node: WithUri) =>
            scenarioProvider.duplicate(node.uri)
        ),
        vscode.commands.registerCommand(COMMANDS.renameScenario, (node: WithUri) => scenarioProvider.rename(node.uri)),
        vscode.commands.registerCommand(COMMANDS.deleteScenario, (node: WithUri) => scenarioProvider.delete(node.uri)),
        vscode.commands.registerCommand(COMMANDS.renameRun, (node: WithUri) => scenarioProvider.renameIoRun(node.uri)),
        vscode.commands.registerCommand(COMMANDS.deleteRun, (node: WithUri) => scenarioProvider.deleteIoRun(node.uri)),
        vscode.commands.registerCommand(COMMANDS.openRunLog, (node: WithUri) => scenarioProvider.openIoRunLog(node.uri)),
        vscode.commands.registerCommand(COMMANDS.manageRunTags, (node: WithUri) => scenarioProvider.manageRunTags(node)),
        vscode.commands.registerCommand(COMMANDS.clearRunTags, (node: WithUri) => scenarioProvider.clearRunTags(node)),
        vscode.commands.registerCommand(COMMANDS.applySuccessTag, (node: WithUri) =>
            scenarioProvider.applyStaticTag(node, 'success')
        ),
        vscode.commands.registerCommand(COMMANDS.applyFailedTag, (node: WithUri) =>
            scenarioProvider.applyStaticTag(node, 'failed')
        ),
        vscode.commands.registerCommand(COMMANDS.manageTagCatalog, () => scenarioProvider.manageTagCatalog()),
        vscode.commands.registerCommand(COMMANDS.createTag, () => scenarioProvider.createTag()),
        vscode.commands.registerCommand(COMMANDS.editTag, () => scenarioProvider.editTag()),
        vscode.commands.registerCommand(COMMANDS.deleteTag, () => scenarioProvider.deleteTag()),
        vscode.commands.registerCommand(COMMANDS.filterRunsByTag, (arg: MaybeNodeArg) => {
            const node = asNodeArg(arg);
            if (node) {
                void scenarioProvider.filterRunsByTags(node);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.toggleScenarioPin, (arg: MaybeNodeArg) => {
            const node = asNodeArg(arg);
            if (node) {
                scenarioProvider.toggleScenarioPin(node);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.filterScenario, async () => {
            const filter = await vscode.window.showInputBox({
                prompt: 'Scenario filter',
                placeHolder: 'Type a partial scenario name'
            });
            scenarioProvider.setFilter(filter ?? '');
        }),
        vscode.commands.registerCommand(COMMANDS.toggleScenarioSort, () => scenarioProvider.toggleScenarioSortMode()),
        vscode.commands.registerCommand(COMMANDS.openConfigInspector, (node: WithUri) => openConfigInspector(node.uri)),
        vscode.commands.registerCommand(COMMANDS.toggleRunSort, (arg: MaybeNodeArg) => {
            const node = asNodeArg(arg);
            if (node) {
                scenarioProvider.toggleRunSortModeForScenario(node);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.refreshToolkit, () => refreshToolkit()),
        vscode.commands.registerCommand(COMMANDS.saveWorkspace, () => saveWorkspace()),
        vscode.commands.registerCommand(COMMANDS.loadWorkspace, () => loadWorkspace()),
        vscode.commands.registerCommand(COMMANDS.resetWorkspace, () => resetWorkspace()),
        vscode.commands.registerCommand(COMMANDS.clearDevArea, () => devProvider.clear()),
        vscode.commands.registerCommand(COMMANDS.removeDevFile, (arg: MaybeUriArg) => {
            const uri = asUri(arg);
            if (uri) {
                devProvider.remove(uri);
            }
        })
    );
}

function openFile(uri: vscode.Uri): Thenable<vscode.TextEditor> {
    return vscode.window.showTextDocument(uri);
}
