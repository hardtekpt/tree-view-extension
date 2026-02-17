import * as fs from 'fs';
import * as path from 'path';
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
        openRunAnalysis: (uri: vscode.Uri) => void;
    }
): void {
    const { devProvider, scenarioProvider } = providers;
    const { refreshToolkit, saveWorkspace, loadWorkspace, resetWorkspace, openConfigInspector, openRunAnalysis } = callbacks;
    let copiedSourcePath: string | undefined;

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.openFile, openFile),
        vscode.commands.registerCommand(COMMANDS.copyFileSystemItem, (arg: MaybeNodeArg) => {
            const uri = asUri(arg);
            if (!uri || !fs.existsSync(uri.fsPath)) {
                return;
            }
            copiedSourcePath = uri.fsPath;
            void vscode.window.showInformationMessage(`Copied: ${copiedSourcePath}`);
        }),
        vscode.commands.registerCommand(COMMANDS.pasteFileSystemItem, (arg: MaybeNodeArg) => {
            const uri = asUri(arg);
            if (!uri || !copiedSourcePath || !fs.existsSync(copiedSourcePath)) {
                return;
            }

            const targetPath = uri.fsPath;
            const destinationDir =
                fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()
                    ? targetPath
                    : path.dirname(targetPath);
            if (!fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) {
                void vscode.window.showErrorMessage('Invalid paste destination.');
                return;
            }

            const destinationPath = path.join(destinationDir, path.basename(copiedSourcePath));
            if (destinationPath === copiedSourcePath || destinationPath.startsWith(`${copiedSourcePath}${path.sep}`)) {
                void vscode.window.showErrorMessage('Cannot paste into the same path or its child.');
                return;
            }
            if (fs.existsSync(destinationPath)) {
                void vscode.window.showErrorMessage(`Destination already exists: ${destinationPath}`);
                return;
            }

            try {
                const stat = fs.statSync(copiedSourcePath);
                if (stat.isDirectory()) {
                    fs.cpSync(copiedSourcePath, destinationPath, { recursive: true });
                } else {
                    fs.cpSync(copiedSourcePath, destinationPath);
                }
                refreshToolkit();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`Paste failed: ${message}`);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.deleteFileSystemItem, async (arg: MaybeNodeArg) => {
            const uri = asUri(arg);
            if (!uri || !fs.existsSync(uri.fsPath)) {
                return;
            }
            const targetPath = uri.fsPath;
            const targetName = path.basename(targetPath);
            const confirm = await vscode.window.showWarningMessage(
                `Delete '${targetName}'?`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') {
                return;
            }

            try {
                const stat = fs.statSync(targetPath);
                fs.rmSync(targetPath, { recursive: stat.isDirectory(), force: true });
                devProvider.remove(uri);
                refreshToolkit();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`Delete failed: ${message}`);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.copyFileSystemPath, async (arg: MaybeNodeArg) => {
            const uri = asUri(arg);
            if (!uri) {
                return;
            }
            await vscode.env.clipboard.writeText(uri.fsPath);
            void vscode.window.showInformationMessage(`Copied path: ${uri.fsPath}`);
        }),
        vscode.commands.registerCommand(COMMANDS.toggleDev, (arg: MaybeUriArg) => {
            const uri = asUri(arg);
            if (uri) {
                devProvider.toggle(uri);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.runScenario, (node: WithUri) => scenarioProvider.run(node.uri)),
        vscode.commands.registerCommand(COMMANDS.runScenarioDebug, (node: WithUri) =>
            scenarioProvider.runWithDebugger(node.uri)
        ),
        vscode.commands.registerCommand(COMMANDS.runScenarioScreen, (node: WithUri) =>
            scenarioProvider.runInDetachedScreen(node.uri)
        ),
        vscode.commands.registerCommand(COMMANDS.toggleSudoExecution, (arg: MaybeNodeArg) => {
            const node = asNodeArg(arg);
            if (node) {
                void scenarioProvider.toggleSudoExecution(node);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.setGlobalRunFlags, () => scenarioProvider.setGlobalRunFlags()),
        vscode.commands.registerCommand(COMMANDS.duplicateScenario, (node: WithUri) =>
            scenarioProvider.duplicate(node.uri)
        ),
        vscode.commands.registerCommand(COMMANDS.renameScenario, (node: WithUri) => scenarioProvider.rename(node.uri)),
        vscode.commands.registerCommand(COMMANDS.deleteScenario, (node: WithUri) => scenarioProvider.delete(node.uri)),
        vscode.commands.registerCommand(COMMANDS.renameRun, (node: WithUri) => scenarioProvider.renameIoRun(node.uri)),
        vscode.commands.registerCommand(COMMANDS.deleteRun, (node: WithUri) => scenarioProvider.deleteIoRun(node.uri)),
        vscode.commands.registerCommand(COMMANDS.analyzeRun, (node: WithUri) => openRunAnalysis(node.uri)),
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
