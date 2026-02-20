import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import { ProfileManager } from '../profile/profileManager';
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
        profileManager: ProfileManager;
    }
): void {
    const { devProvider, scenarioProvider } = providers;
    const { refreshToolkit, saveWorkspace, loadWorkspace, resetWorkspace, openConfigInspector, openRunAnalysis, profileManager } = callbacks;
    let copiedSourcePath: string | undefined;

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.openFile, openFile),
        vscode.commands.registerCommand(COMMANDS.copyTextValue, async (value?: string) => {
            if (!value) {
                return;
            }
            await vscode.env.clipboard.writeText(value);
            void vscode.window.showInformationMessage(`Copied: ${value}`);
        }),
        vscode.commands.registerCommand(
            COMMANDS.openCurrentProfileSection,
            async (section?: 'runTemplate' | 'structure' | 'filenameParsers') => {
                const activeProfile = profileManager.getActiveProfile();
                if (!activeProfile) {
                    void vscode.window.showWarningMessage('No active profile bound to this workspace.');
                    return;
                }

                const profilesFileUri = profileManager.getProfilesFileUri();
                try {
                    await vscode.workspace.fs.createDirectory(profileManager.getStorageFolderUri());
                    try {
                        await vscode.workspace.fs.stat(profilesFileUri);
                    } catch {
                        await vscode.workspace.fs.writeFile(profilesFileUri, Buffer.from('{"version":1,"profiles":[]}\n', 'utf8'));
                    }

                    const document = await vscode.workspace.openTextDocument(profilesFileUri);
                    const editor = await vscode.window.showTextDocument(document, { preview: false });
                    const text = document.getText();

                    const profileIdNeedle = `"id": "${activeProfile.id}"`;
                    const profileIdIndex = text.indexOf(profileIdNeedle);
                    if (profileIdIndex < 0) {
                        return;
                    }

                    const fieldNeedles =
                        section === 'runTemplate'
                            ? ['"runCommandTemplate"']
                            : section === 'filenameParsers'
                                ? ['"outputFilenameParsers"']
                                : ['"scenariosRoot"', '"scenarioConfigsFolderName"', '"scenarioIoFolderName"'];

                    let fieldIndex = -1;
                    for (const needle of fieldNeedles) {
                        const index = text.indexOf(needle, profileIdIndex);
                        if (index >= 0 && (fieldIndex < 0 || index < fieldIndex)) {
                            fieldIndex = index;
                        }
                    }

                    const targetIndex = fieldIndex >= 0 ? fieldIndex : profileIdIndex;
                    const position = document.positionAt(targetIndex);
                    editor.selection = new vscode.Selection(position, position);
                    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    void vscode.window.showErrorMessage(`Could not open profile section: ${message}`);
                }
            }
        ),
        vscode.commands.registerCommand(COMMANDS.createProfile, async () => {
            await profileManager.createProfileForCurrentWorkspace();
            refreshToolkit();
        }),
        vscode.commands.registerCommand(COMMANDS.editCurrentProfile, async () => {
            await profileManager.editCurrentProfile();
            refreshToolkit();
        }),
        vscode.commands.registerCommand(COMMANDS.rebindCurrentWorkspace, async () => {
            await profileManager.rebindCurrentWorkspace();
            refreshToolkit();
        }),
        vscode.commands.registerCommand(COMMANDS.validateCurrentProfile, () => {
            const result = profileManager.validateActiveProfile();
            if (result.valid) {
                void vscode.window.showInformationMessage('Current profile structure is valid.');
                return;
            }
            void vscode.window.showWarningMessage(`Profile validation failed:\n${result.errors.join('\n')}`);
        }),
        vscode.commands.registerCommand(COMMANDS.openProfileStorage, async () => {
            try {
                const picked = await vscode.window.showQuickPick(
                    [
                        { label: 'programProfiles.json', uri: profileManager.getProfilesFileUri(), empty: '{"version":1,"profiles":[]}\n' },
                        { label: 'workspaceBindings.json', uri: profileManager.getBindingsFileUri(), empty: '{"version":1,"bindings":{}}\n' }
                    ],
                    { placeHolder: 'Open profile storage file' }
                );
                if (!picked) {
                    return;
                }

                await vscode.workspace.fs.createDirectory(profileManager.getStorageFolderUri());
                try {
                    await vscode.workspace.fs.stat(picked.uri);
                } catch {
                    await vscode.workspace.fs.writeFile(picked.uri, Buffer.from(picked.empty, 'utf8'));
                }

                const document = await vscode.workspace.openTextDocument(picked.uri);
                await vscode.window.showTextDocument(document, { preview: false });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`Could not open profile storage: ${message}`);
            }
        }),
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
        vscode.commands.registerCommand(COMMANDS.revealFileSystemItemInExplorer, async (arg: MaybeNodeArg) => {
            const uri = asUri(arg);
            if (!uri) {
                return;
            }

            try {
                await vscode.commands.executeCommand('revealInExplorer', uri);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`Could not reveal item in Explorer: ${message}`);
            }
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

async function openFile(uri: vscode.Uri): Promise<void> {
    try {
        await vscode.commands.executeCommand('vscode.open', uri, {
            preview: false
        });
    } catch {
        try {
            await vscode.window.showTextDocument(uri, { preview: false });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Could not open file: ${message}`);
        }
    }
}
