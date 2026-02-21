import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as vscode from 'vscode';
import {
    getBasePath,
    getPythonCommand,
    getRunCommandTemplate,
    getScenarioConfigsFolderName,
    getScenarioIoFolderName,
    getScenarioPath
} from '../config';
import { DEFAULTS, FILE_EXTENSIONS, FOLDER_NAMES, PYTHON_CONFIG_ROOT, PYTHON_DEFAULT_INTERPRETER_PATH_KEY } from '../constants';
import { ScenarioNode } from '../nodes/scenarioNode';
import { existsDir, uniquePath, listEntriesSorted } from '../utils/fileSystem';
import { toPathKey } from '../utils/pathKey';
import { SCENARIO_STORAGE_KEYS } from './scenario/storageKeys';
import {
    buildScreenSessionName,
    normalizeRunFlags,
    parseCommandLineArgs,
    quoteIfNeeded,
    renamePathWithFallback,
    safeUpdateConfiguration
} from './scenario/runtimeUtils';
import { createTagId, formatTagChip, normalizeColor, normalizeTag } from './scenario/tagUtils';
import { findScenarioRoot, matchRunTagFilter, sortEntries } from './scenario/treeUtils';
import { RunTagDefinition, ScenarioRunSortMode, ScenarioWorkspaceState, SortMode } from './scenario/types';
import {
    buildScenarioConfigurationName,
    createScenarioDebugLaunchConfiguration,
    DebugRunTarget,
    SCENARIO_TOOLKIT_DEBUG_ID
} from './scenario/debugLaunch';
import { findLastScenarioExecution } from './scenario/lastExecutionFinder';
import { buildIoFolderTooltip, buildIoRunTooltip, buildScenarioTooltip, formatTagFilter } from './scenario/tooltipBuilder';
import {
    OutputMetadataResolver,
    ParsedOutputFileMetadata,
    ParsedOutputFolderMetadata
} from './scenario/outputMetadataResolver';
import {
    applyScenarioWorkspaceState,
    ensureDefaultRunTags,
    getOrCreateDefaultRunTag,
    loadScenarioStateFromMemento,
    persistScenarioTagState,
    snapshotScenarioWorkspaceState
} from './scenario/stateStore';

const TERMINAL_COMMAND_DELAY_MS = 300;

interface ScenarioRunInvocation {
    pythonArgs: string[];
    debugTarget: DebugRunTarget;
}

interface ScenarioRunContext {
    basePath: string;
    python: string;
    scenarioName: string;
    invocation: ScenarioRunInvocation;
    extraFlags: string[];
    useSudo: boolean;
}

export interface LastExecutionInfo {
    scenarioName: string;
    scenarioPath: string;
    runPath?: string;
    runName?: string;
    exitCode?: number;
    timestampMs: number;
}
export type { ParsedOutputFileMetadata, ParsedOutputFolderMetadata };

// Main provider for scenarios, run outputs, and run tagging workflows.
export class ScenarioProvider implements vscode.TreeDataProvider<ScenarioNode> {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private readonly lastExecutionEmitter = new vscode.EventEmitter<LastExecutionInfo | undefined>();
    readonly onDidChangeLastExecution = this.lastExecutionEmitter.event;

    private filter = '';
    private readonly output = vscode.window.createOutputChannel('Scenario Toolkit');
    private readonly pinnedScenarios = new Set<string>();
    private readonly pinnedIoRuns = new Set<string>();
    private scenarioSortMode: SortMode = 'name';
    private readonly runSortByScenario = new Map<string, ScenarioRunSortMode>();
    private readonly tagCatalog = new Map<string, RunTagDefinition>();
    private readonly runTagsByPath = new Map<string, string[]>();
    private readonly runFilterTagIdsByScenario = new Map<string, string[]>();
    private globalRunFlags = '';
    private readonly sudoExecutionByScenario = new Map<string, boolean>();
    private lastExecutionInfo?: LastExecutionInfo;
    private readonly outputMetadataResolver = new OutputMetadataResolver();

    constructor(private readonly state: vscode.Memento) {
        this.loadState();
        this.ensureDefaultTags();
        this.updateLastExecutionFromFilesystem();
    }

    refresh(): void {
        this.updateLastExecutionFromFilesystem();
        this.changeEmitter.fire();
    }

    getParsedOutputMetadataForRun(runPath: string): ParsedOutputFileMetadata[] {
        return this.outputMetadataResolver.getParsedOutputMetadataForRun(runPath);
    }

    getParsedOutputFolderMetadataForRun(runPath: string): ParsedOutputFolderMetadata[] {
        return this.outputMetadataResolver.getParsedOutputFolderMetadataForRun(runPath);
    }

    async syncPythonInterpreterForBasePath(): Promise<void> {
        const basePath = getBasePath();
        const pythonPath = basePath && existsDir(basePath) ? getPythonCommand() : DEFAULTS.pythonCommand;
        await this.updatePythonConfiguration(pythonPath);
    }

    dispose(): void {
        this.output.dispose();
        this.lastExecutionEmitter.dispose();
    }

    getLastExecutionInfo(): LastExecutionInfo | undefined {
        return this.lastExecutionInfo;
    }

    setFilter(value: string): void {
        this.filter = value.trim().toLowerCase();
        this.refresh();
    }

    // Snapshot current provider state into the workspace JSON payload.
    getWorkspaceState(): ScenarioWorkspaceState {
        return snapshotScenarioWorkspaceState(
            {
                pinnedScenarios: this.pinnedScenarios,
                pinnedIoRuns: this.pinnedIoRuns,
                runSortByScenario: this.runSortByScenario,
                tagCatalog: this.tagCatalog,
                runTagsByPath: this.runTagsByPath,
                runFilterTagIdsByScenario: this.runFilterTagIdsByScenario,
                sudoExecutionByScenario: this.sudoExecutionByScenario
            },
            {
                filter: this.filter,
                scenarioSortMode: this.scenarioSortMode,
                globalRunFlags: this.globalRunFlags
            }
        );
    }

    // Apply a previously saved workspace snapshot to in-memory provider state.
    applyWorkspaceState(next: ScenarioWorkspaceState): void {
        const scalars = applyScenarioWorkspaceState(next, {
            pinnedScenarios: this.pinnedScenarios,
            pinnedIoRuns: this.pinnedIoRuns,
            runSortByScenario: this.runSortByScenario,
            tagCatalog: this.tagCatalog,
            runTagsByPath: this.runTagsByPath,
            runFilterTagIdsByScenario: this.runFilterTagIdsByScenario,
            sudoExecutionByScenario: this.sudoExecutionByScenario
        });
        this.filter = scalars.filter;
        this.scenarioSortMode = scalars.scenarioSortMode;
        this.globalRunFlags = scalars.globalRunFlags;

        void this.state.update(SCENARIO_STORAGE_KEYS.pinnedScenarios, [...this.pinnedScenarios]);
        void this.state.update(SCENARIO_STORAGE_KEYS.pinnedIoRuns, [...this.pinnedIoRuns]);
        void this.state.update(SCENARIO_STORAGE_KEYS.scenarioSort, this.scenarioSortMode);
        void this.state.update(
            SCENARIO_STORAGE_KEYS.runSortByScenario,
            Object.fromEntries(this.runSortByScenario.entries())
        );
        void this.state.update(SCENARIO_STORAGE_KEYS.tagCatalog, [...this.tagCatalog.values()]);
        void this.state.update(SCENARIO_STORAGE_KEYS.runTagsByPath, Object.fromEntries(this.runTagsByPath.entries()));
        void this.state.update(
            SCENARIO_STORAGE_KEYS.runFilterTagIdsByScenario,
            Object.fromEntries(this.runFilterTagIdsByScenario.entries())
        );
        void this.state.update(SCENARIO_STORAGE_KEYS.globalRunFlags, this.globalRunFlags);
        void this.state.update(
            SCENARIO_STORAGE_KEYS.sudoExecutionByScenario,
            Object.fromEntries(this.sudoExecutionByScenario.entries())
        );
        this.refresh();
    }

    // Configure global flags injected into every scenario run command.
    async setGlobalRunFlags(): Promise<void> {
        const currentFlags = this.globalRunFlags;
        const entered = await vscode.window.showInputBox({
            value: currentFlags,
            prompt: 'Global command-line flags for all scenarios',
            placeHolder: '<-c> <-p> <-f>"',
            ignoreFocusOut: true
        });

        if (entered === undefined) {
            return;
        }

        const normalized = normalizeRunFlags(entered);
        this.globalRunFlags = normalized;
        void this.state.update(SCENARIO_STORAGE_KEYS.globalRunFlags, this.globalRunFlags);
        this.refresh();
    }

    async toggleSudoExecution(target: { uri: vscode.Uri }): Promise<void> {
        const scenarioPath = this.resolveScenarioPathFromTarget(target.uri);
        if (!scenarioPath) {
            return;
        }
        const enabled = !this.isSudoEnabledForScenario(scenarioPath);
        await this.setSudoExecutionForScenario(vscode.Uri.file(scenarioPath), enabled);
    }

    // Scenario and io-run pinning share one command and branch by node type.
    toggleScenarioPin(target: { uri: vscode.Uri; type?: string }): void {
        const type = target.type;
        const uri = target.uri;
        const key = toPathKey(uri.fsPath);

        if (type === 'ioRun') {
            if (this.pinnedIoRuns.has(key)) {
                this.pinnedIoRuns.delete(key);
            } else {
                this.pinnedIoRuns.add(key);
            }
            void this.state.update(SCENARIO_STORAGE_KEYS.pinnedIoRuns, [...this.pinnedIoRuns]);
        } else {
            if (this.pinnedScenarios.has(key)) {
                this.pinnedScenarios.delete(key);
            } else {
                this.pinnedScenarios.add(key);
            }
            void this.state.update(SCENARIO_STORAGE_KEYS.pinnedScenarios, [...this.pinnedScenarios]);
        }

        this.refresh();
    }

    toggleScenarioSortMode(): void {
        this.scenarioSortMode = this.scenarioSortMode === 'name' ? 'recent' : 'name';
        void this.state.update(SCENARIO_STORAGE_KEYS.scenarioSort, this.scenarioSortMode);
        void vscode.window.showInformationMessage(
            `Scenario sort: ${this.scenarioSortMode === 'name' ? 'Name' : 'Most recent'}`
        );
        this.refresh();
    }

    toggleRunSortModeForScenario(target: { uri: vscode.Uri; scenarioRootPath?: string }): void {
        const rootPath = target.scenarioRootPath ?? target.uri.fsPath;
        const key = toPathKey(rootPath);
        const current = this.runSortByScenario.get(key) ?? 'recent';
        const next: ScenarioRunSortMode = current === 'name' ? 'recent' : 'name';

        this.runSortByScenario.set(key, next);
        void this.state.update(
            SCENARIO_STORAGE_KEYS.runSortByScenario,
            Object.fromEntries(this.runSortByScenario.entries())
        );
        void vscode.window.showInformationMessage(
            `${path.basename(rootPath)} run sort: ${next === 'name' ? 'Name' : 'Most recent'}`
        );
        this.refresh();
    }

    async manageRunTags(target: { uri: vscode.Uri }): Promise<void> {
        const runKey = toPathKey(target.uri.fsPath);
        const tags = [...this.tagCatalog.values()];
        if (tags.length === 0) {
            void vscode.window.showInformationMessage('No tags defined. Create tags first.');
            return;
        }

        const current = new Set(this.runTagsByPath.get(runKey) ?? []);
        const picked = await vscode.window.showQuickPick(
            tags.map(tag => ({
                label: tag.label,
                description: `${tag.icon ? `$(${tag.icon}) ` : ''}${tag.color}`,
                picked: current.has(tag.id),
                tagId: tag.id
            })),
            {
                canPickMany: true,
                placeHolder: 'Select tags for this output run'
            }
        );

        if (!picked) {
            return;
        }

        const next = picked.map(item => item.tagId);
        if (next.length === 0) {
            this.runTagsByPath.delete(runKey);
        } else {
            this.runTagsByPath.set(runKey, next);
        }
        void this.state.update(SCENARIO_STORAGE_KEYS.runTagsByPath, Object.fromEntries(this.runTagsByPath.entries()));
        this.refresh();
    }

    clearRunTags(target: { uri: vscode.Uri }): void {
        this.runTagsByPath.delete(toPathKey(target.uri.fsPath));
        void this.state.update(SCENARIO_STORAGE_KEYS.runTagsByPath, Object.fromEntries(this.runTagsByPath.entries()));
        this.refresh();
    }

    applyStaticTag(target: { uri: vscode.Uri }, tagLabel: 'success' | 'failed'): void {
        const tag = this.getOrCreateDefaultTag(tagLabel);
        if (!tag) {
            return;
        }

        const runKey = toPathKey(target.uri.fsPath);
        const current = new Set(this.runTagsByPath.get(runKey) ?? []);
        if (current.has(tag.id)) {
            current.delete(tag.id);
        } else {
            current.add(tag.id);
        }

        const next = [...current];
        if (next.length === 0) {
            this.runTagsByPath.delete(runKey);
        } else {
            this.runTagsByPath.set(runKey, next);
        }

        void this.state.update(SCENARIO_STORAGE_KEYS.runTagsByPath, Object.fromEntries(this.runTagsByPath.entries()));
        this.refresh();
    }

    async manageTagCatalog(): Promise<void> {
        const choice = await vscode.window.showQuickPick(
            [
                { label: 'Create Tag', value: 'create' },
                { label: 'Edit Tag', value: 'edit' },
                { label: 'Delete Tag', value: 'delete' }
            ],
            { placeHolder: 'Manage tag catalog' }
        );

        if (!choice) {
            return;
        }

        if (choice.value === 'create') {
            await this.createTag();
            return;
        }

        if (choice.value === 'edit') {
            await this.editTag();
            return;
        }

        await this.deleteTag();
    }

    async createTag(): Promise<void> {
        const label = (await vscode.window.showInputBox({ prompt: 'Tag label' }))?.trim();
        if (!label) {
            return;
        }

        const id = createTagId(label, this.tagCatalog);
        const color = normalizeColor((await vscode.window.showInputBox({
            prompt: 'Tag color (hex, optional)',
            value: '#4CAF50'
        })) ?? '#4CAF50');
        const icon = ((await vscode.window.showInputBox({
            prompt: 'Codicon name (optional)',
            placeHolder: 'bookmark'
        })) ?? '').trim();

        this.tagCatalog.set(id, normalizeTag({ id, label, color, icon: icon || undefined }));
        this.persistTagState();
        this.refresh();
    }

    async editTag(): Promise<void> {
        const selected = await this.pickTag('Select a tag to edit');
        if (!selected) {
            return;
        }

        const tag = this.tagCatalog.get(selected.id);
        if (!tag) {
            return;
        }

        const label = (await vscode.window.showInputBox({
            prompt: 'Tag label',
            value: tag.label
        }))?.trim();

        if (!label) {
            return;
        }

        const color = normalizeColor((await vscode.window.showInputBox({
            prompt: 'Tag color',
            value: tag.color
        })) ?? tag.color);
        const icon = ((await vscode.window.showInputBox({
            prompt: 'Codicon name (optional)',
            value: tag.icon ?? ''
        })) ?? '').trim();

        this.tagCatalog.set(tag.id, normalizeTag({ ...tag, label, color, icon: icon || undefined }));
        this.persistTagState();
        this.refresh();
    }

    async deleteTag(): Promise<void> {
        const selected = await this.pickTag('Select a tag to delete');
        if (!selected) {
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            `Delete tag '${selected.label}'? It will be removed from all runs.`,
            { modal: true },
            'Delete'
        );

        if (confirmation !== 'Delete') {
            return;
        }

        this.tagCatalog.delete(selected.id);
        for (const [runKey, tagIds] of this.runTagsByPath.entries()) {
            const filtered = tagIds.filter(tagId => tagId !== selected.id);
            if (filtered.length === 0) {
                this.runTagsByPath.delete(runKey);
            } else {
                this.runTagsByPath.set(runKey, filtered);
            }
        }
        for (const [scenarioKey, tagIds] of this.runFilterTagIdsByScenario.entries()) {
            const filtered = tagIds.filter(tagId => tagId !== selected.id);
            if (filtered.length === 0) {
                this.runFilterTagIdsByScenario.delete(scenarioKey);
            } else {
                this.runFilterTagIdsByScenario.set(scenarioKey, filtered);
            }
        }
        this.persistTagState();
        this.refresh();
    }

    async filterRunsByTags(target: { uri: vscode.Uri; scenarioRootPath?: string }): Promise<void> {
        if (this.tagCatalog.size === 0) {
            void vscode.window.showInformationMessage('No tags defined.');
            return;
        }

        const scenarioKey = toPathKey(target.scenarioRootPath ?? target.uri.fsPath);
        const currentFilter = this.runFilterTagIdsByScenario.get(scenarioKey) ?? [];
        const picked = await vscode.window.showQuickPick(
            [...this.tagCatalog.values()].map(tag => ({
                label: tag.label,
                description: `${tag.icon ? `$(${tag.icon}) ` : ''}${tag.color}`,
                picked: currentFilter.includes(tag.id),
                tagId: tag.id
            })),
            {
                canPickMany: true,
                placeHolder: 'Filter runs by tags (empty selection clears filter)'
            }
        );

        if (!picked) {
            return;
        }

        const next = picked.map(item => item.tagId);
        if (next.length === 0) {
            this.runFilterTagIdsByScenario.delete(scenarioKey);
        } else {
            this.runFilterTagIdsByScenario.set(scenarioKey, next);
        }
        void this.state.update(
            SCENARIO_STORAGE_KEYS.runFilterTagIdsByScenario,
            Object.fromEntries(this.runFilterTagIdsByScenario.entries())
        );
        this.refresh();
    }

    getTreeItem(element: ScenarioNode): vscode.TreeItem {
        return element;
    }

    getParent(element: ScenarioNode): ScenarioNode | undefined {
        if (element.type === 'scenario') {
            return undefined;
        }

        const scenariosRoot = getScenarioPath();
        if (!scenariosRoot) {
            return undefined;
        }

        const parentPath = path.dirname(element.uri.fsPath);
        if (parentPath === element.uri.fsPath || parentPath === scenariosRoot) {
            return undefined;
        }

        return this.nodeFromPath(parentPath);
    }

    // Build scenario tree nodes and metadata from filesystem + persisted state.
    getChildren(element?: ScenarioNode): ScenarioNode[] {
        // Root level shows scenario directories.
        const scenariosRoot = getScenarioPath();
        if (!scenariosRoot || !existsDir(scenariosRoot)) {
            return [];
        }

        if (!element) {
            // Scenario list with search filter + pin priority.
            return sortEntries(
                scenariosRoot,
                listEntriesSorted(scenariosRoot).filter(name => name.toLowerCase().includes(this.filter)),
                this.scenarioSortMode
            )
                .map(name => path.join(scenariosRoot, name))
                .filter(full => existsDir(full))
                .map(full => {
                    const normalized = toPathKey(full);
                    const isPinned = this.pinnedScenarios.has(normalized);
                    const isSudoEnabled = this.isSudoEnabledForScenario(full);
                    const runSortMode = this.runSortByScenario.get(normalized) ?? 'recent';
                    const node = new ScenarioNode(
                        vscode.Uri.file(full),
                        'scenario',
                        vscode.TreeItemCollapsibleState.Collapsed,
                        undefined,
                        isPinned,
                        full,
                        runSortMode,
                        isSudoEnabled
                    );
                    this.applyScenarioHover(node);
                    return node;
                })
                .sort((a, b) => {
                    if (a.isPinned !== b.isPinned) {
                        return a.isPinned ? -1 : 1;
                    }
                    return 0;
                });
        }

        if (element.type === 'scenario') {
            // Scenario node expands into logical top-level folders.
            const configsFolderName = getScenarioConfigsFolderName();
            const ioFolderName = getScenarioIoFolderName();
            const configsPath = path.join(element.uri.fsPath, configsFolderName);
            const ioPath = path.join(element.uri.fsPath, ioFolderName);
            const children: ScenarioNode[] = [];

            if (existsDir(configsPath)) {
                children.push(
                    new ScenarioNode(
                        vscode.Uri.file(configsPath),
                        'configsFolder',
                        vscode.TreeItemCollapsibleState.Collapsed,
                        configsFolderName,
                        false,
                        element.scenarioRootPath ?? element.uri.fsPath
                    )
                );
            }

            if (existsDir(ioPath)) {
                const ioNode = new ScenarioNode(
                    vscode.Uri.file(ioPath),
                    'ioFolder',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    ioFolderName,
                    false,
                    element.scenarioRootPath ?? element.uri.fsPath
                );
                this.applyIoFolderHover(ioNode);
                children.push(
                    ioNode
                );
            }

            if (children.length === 0) {
                children.push(
                    new ScenarioNode(
                        element.uri,
                        'status',
                        vscode.TreeItemCollapsibleState.None,
                        'No configs/io folder found',
                        false,
                        element.scenarioRootPath ?? element.uri.fsPath
                    )
                );
            }

            return children;
        }

        if (!existsDir(element.uri.fsPath)) {
            return [];
        }

        const names =
            path.basename(element.uri.fsPath).toLowerCase() === getScenarioIoFolderName().toLowerCase()
                ? sortEntries(
                    element.uri.fsPath,
                    fs.readdirSync(element.uri.fsPath),
                    this.runSortByScenario.get(
                        toPathKey(element.scenarioRootPath ?? element.uri.fsPath)
                    ) ?? 'recent',
                    false
                )
                : listEntriesSorted(element.uri.fsPath);
        // io-folder children get extra metadata (tags, pin, per-scenario filtering).
        const isIoFolder = element.type === 'ioFolder';
        const nodes = names.map(name => {
            const full = path.join(element.uri.fsPath, name);
            const isDir = existsDir(full);
            const key = toPathKey(full);
            const isPinned = isIoFolder ? this.pinnedIoRuns.has(key) : false;
            const node = new ScenarioNode(
                vscode.Uri.file(full),
                isIoFolder ? 'ioRun' : isDir ? 'folder' : 'file',
                isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                undefined,
                isPinned,
                element.scenarioRootPath
            );

            if (isIoFolder) {
                this.applyIoRunDetails(node, element.scenarioRootPath ?? element.uri.fsPath);
            }

            return node;
        });

        if (!isIoFolder) {
            return nodes;
        }

        const scenarioKey = toPathKey(element.scenarioRootPath ?? element.uri.fsPath);
        const filtered = nodes.filter(node =>
            matchRunTagFilter(this.runTagsByPath, this.runFilterTagIdsByScenario, toPathKey(node.uri.fsPath), scenarioKey)
        );
        return filtered.sort((a, b) => {
            if (a.isPinned !== b.isPinned) {
                return a.isPinned ? -1 : 1;
            }

            return 0;
        });
    }

    // Resolve an existing path into a typed scenario tree node for reveal operations.
    nodeFromPath(fsPath: string): ScenarioNode | undefined {
        const scenariosRoot = getScenarioPath();
        if (!scenariosRoot) {
            return undefined;
        }

        if (!existsDir(fsPath)) {
            return undefined;
        }

        const normalizedRoot = toPathKey(scenariosRoot);
        const normalizedPath = toPathKey(fsPath);
        if (!normalizedPath.startsWith(`${normalizedRoot}${path.sep}`)) {
            return undefined;
        }

        const parentPath = path.dirname(fsPath);
        if (toPathKey(parentPath) === normalizedRoot) {
            const isPinned = this.pinnedScenarios.has(normalizedPath);
            const isSudoEnabled = this.isSudoEnabledForScenario(fsPath);
            const runSortMode = this.runSortByScenario.get(normalizedPath) ?? 'recent';
            const node = new ScenarioNode(
                vscode.Uri.file(fsPath),
                'scenario',
                vscode.TreeItemCollapsibleState.Collapsed,
                undefined,
                isPinned,
                fsPath,
                runSortMode,
                isSudoEnabled
            );
            this.applyScenarioHover(node);
            return node;
        }

        const scenarioRootPath = findScenarioRoot(fsPath, scenariosRoot);
        if (!scenarioRootPath) {
            return undefined;
        }

        const baseName = path.basename(fsPath).toLowerCase();
        const ioFolderName = getScenarioIoFolderName().toLowerCase();
        const configsFolderName = getScenarioConfigsFolderName().toLowerCase();
        if (baseName === ioFolderName) {
            const ioNode = new ScenarioNode(
                vscode.Uri.file(fsPath),
                'ioFolder',
                vscode.TreeItemCollapsibleState.Collapsed,
                getScenarioIoFolderName(),
                false,
                scenarioRootPath
            );
            this.applyIoFolderHover(ioNode);
            return ioNode;
        }

        if (baseName === configsFolderName) {
            return new ScenarioNode(
                vscode.Uri.file(fsPath),
                'configsFolder',
                vscode.TreeItemCollapsibleState.Collapsed,
                getScenarioConfigsFolderName(),
                false,
                scenarioRootPath
            );
        }

        const ioPath = path.join(scenarioRootPath, getScenarioIoFolderName());
        const isInsideIo = toPathKey(fsPath).startsWith(`${toPathKey(ioPath)}${path.sep}`);
        const isPinnedRun = isInsideIo ? this.pinnedIoRuns.has(normalizedPath) : false;

        const node = new ScenarioNode(
            vscode.Uri.file(fsPath),
            isInsideIo ? 'ioRun' : 'folder',
            vscode.TreeItemCollapsibleState.Collapsed,
            undefined,
            isPinnedRun,
            scenarioRootPath
        );
        if (isInsideIo) {
            this.applyIoRunDetails(node, scenarioRootPath);
        }
        return node;
    }

    // Run scenario immediately in the local process.
    async run(uri: vscode.Uri): Promise<void> {
        const context = await this.buildScenarioRunContext(uri, false);
        if (!context) {
            return;
        }

        const args = [...context.invocation.pythonArgs, ...context.extraFlags];
        const effectiveCommand = context.useSudo ? 'sudo' : context.python;
        const effectiveArgs = context.useSudo ? [context.python, ...args] : args;
        const commandLine = [effectiveCommand, ...effectiveArgs].map(quoteIfNeeded).join(' ');

        const terminal = vscode.window.createTerminal({
            name: `Scenario Run: ${context.scenarioName}`,
            cwd: context.basePath
        });
        terminal.show(true);
        await delayMs(TERMINAL_COMMAND_DELAY_MS);
        terminal.sendText(commandLine, true);

        this.updateLastExecutionFromFilesystem();
    }

    // Run scenario via a launch.json configuration (create/update per scenario first).
    async runWithDebugger(uri: vscode.Uri): Promise<void> {
        const context = await this.buildScenarioRunContext(uri, false);
        if (!context) {
            return;
        }
        const configured = await this.ensureScenarioDebugLaunchConfiguration(context);
        if (!configured) {
            return;
        }

        if (context.useSudo) {
            this.output.appendLine(`[run-debug] sudo enabled for scenario '${context.scenarioName}'.`);
        }

        const started = await vscode.debug.startDebugging(
            configured.workspaceFolder,
            configured.configurationName
        );
        if (!started) {
            // Fallback to the resolved configuration object in case launch-by-name cannot resolve immediately.
            const fallbackStarted = await vscode.debug.startDebugging(
                configured.workspaceFolder,
                configured.debugConfiguration
            );
            if (!fallbackStarted) {
                void vscode.window.showErrorMessage(
                    `Could not start debugger for scenario '${context.scenarioName}' from launch.json.`
                );
            }
            return;
        }
    }

    // Run scenario in a detached GNU screen session for long-running jobs.
    async runInDetachedScreen(uri: vscode.Uri): Promise<void> {
        const context = await this.buildScenarioRunContext(uri);
        if (!context) {
            return;
        }

        if (process.platform === 'win32') {
            void vscode.window.showWarningMessage('Detached screen sessions are not available on Windows.');
            return;
        }

        const sessionName = buildScreenSessionName(context.scenarioName);
        const screenArgs = ['-dmS', sessionName, context.python, ...context.invocation.pythonArgs, ...context.extraFlags];
        const effectiveCommand = context.useSudo ? 'sudo' : 'screen';
        const effectiveArgs = context.useSudo ? ['-n', 'screen', ...screenArgs] : screenArgs;

        this.output.appendLine(`[run-screen] ${effectiveCommand} ${effectiveArgs.map(quoteIfNeeded).join(' ')}`);

        const child = this.spawnLoggedProcess(effectiveCommand, effectiveArgs, context.basePath);
        if (!child) {
            void vscode.window.showErrorMessage('Failed to start detached screen session: could not start process.');
            return;
        }
        child.on('close', (code: number | null) => {
            this.output.appendLine(`[run-screen-exit] code=${code ?? 'unknown'}`);
            this.output.show(true);
            this.updateLastExecutionFromFilesystem();
            if (code === 0) {
                void vscode.window.showInformationMessage(
                    `Scenario started in detached screen session '${sessionName}'. Attach with: screen -r ${sessionName}`
                );
                return;
            }

            void vscode.window.showWarningMessage(
                `Could not start detached screen session (exit ${code ?? 'unknown'}). Is 'screen' installed?`
            );
        });
    }

    private async buildScenarioRunContext(
        uri: vscode.Uri,
        requireAuthenticatedSudo = true
    ): Promise<ScenarioRunContext | undefined> {
        const basePath = getBasePath();
        if (!basePath || !existsDir(basePath)) {
            void vscode.window.showWarningMessage('No active program profile for this workspace. Create or bind a profile first.');
            return undefined;
        }

        const python = await this.configurePythonFromLocalVenv(basePath);
        const scenarioName = path.basename(uri.fsPath);
        const invocation = this.buildScenarioRunInvocation(basePath, scenarioName);
        if (!invocation) {
            return undefined;
        }

        const useSudo = await this.resolveSudoUsage(basePath, uri.fsPath, requireAuthenticatedSudo);
        if (useSudo === undefined) {
            return undefined;
        }

        return {
            basePath,
            python,
            scenarioName,
            invocation,
            extraFlags: parseCommandLineArgs(this.globalRunFlags),
            useSudo
        };
    }

    private async resolveSudoUsage(
        basePath: string,
        scenarioPath: string,
        requireAuthenticatedSudo: boolean
    ): Promise<boolean | undefined> {
        if (!this.isSudoEnabledForScenario(scenarioPath)) {
            return false;
        }

        if (process.platform === 'win32') {
            this.sudoExecutionByScenario.delete(toPathKey(scenarioPath));
            void this.state.update(
                SCENARIO_STORAGE_KEYS.sudoExecutionByScenario,
                Object.fromEntries(this.sudoExecutionByScenario.entries())
            );
            void vscode.window.showWarningMessage('Sudo is not available on Windows.');
            return false;
        }

        if (!requireAuthenticatedSudo) {
            return true;
        }

        const authenticated = await this.ensureSudoSession(basePath);
        return authenticated ? true : undefined;
    }

    private async ensureSudoSession(basePath: string): Promise<boolean> {
        if (await this.hasActiveSudoSession(basePath)) {
            return true;
        }

        const password = await vscode.window.showInputBox({
            prompt: 'Enter sudo password for scenario execution',
            password: true,
            ignoreFocusOut: true
        });
        if (password === undefined) {
            return false;
        }

        const validated = await this.validateSudoPassword(basePath, password);
        if (!validated) {
            void vscode.window.showErrorMessage('Sudo authentication failed. Execution cancelled.');
            return false;
        }
        return true;
    }

    private hasActiveSudoSession(basePath: string): Promise<boolean> {
        return new Promise(resolve => {
            const child = spawn('sudo', ['-n', 'true'], { cwd: basePath });
            child.on('error', () => resolve(false));
            child.on('close', code => resolve(code === 0));
        });
    }

    private validateSudoPassword(basePath: string, password: string): Promise<boolean> {
        return new Promise(resolve => {
            const child = spawn('sudo', ['-S', '-v'], { cwd: basePath, stdio: ['pipe', 'pipe', 'pipe'] });
            child.stdin.write(`${password}\n`);
            child.stdin.end();
            child.on('error', () => resolve(false));
            child.on('close', code => resolve(code === 0));
        });
    }

    private buildScenarioRunInvocation(
        basePath: string,
        scenarioName: string
    ): ScenarioRunInvocation | undefined {
        const template = getRunCommandTemplate().trim();
        if (!template.includes('<scenario_name>')) {
            void vscode.window.showWarningMessage(
                `Set a valid run command template in the active program profile (must include '<scenario_name>').`
            );
            return undefined;
        }

        const expanded = template.replace(/<scenario_name>/g, scenarioName);
        const parts = parseCommandLineArgs(expanded);
        if (parts.length === 0) {
            void vscode.window.showWarningMessage(
                'Set a valid run command template in the active program profile.'
            );
            return undefined;
        }

        if (parts[0] === '-m') {
            const moduleName = parts[1];
            if (!moduleName) {
                void vscode.window.showWarningMessage(
                    'Set a valid module-style run command template in the active program profile.'
                );
                return undefined;
            }
            const moduleArgs = parts.slice(2);
            return {
                pythonArgs: ['-m', moduleName, ...moduleArgs],
                debugTarget: { kind: 'module', module: moduleName, args: moduleArgs }
            };
        }

        const [programToken, ...args] = parts;
        const program = path.isAbsolute(programToken) ? programToken : path.join(basePath, programToken);
        return {
            pythonArgs: [program, ...args],
            debugTarget: { kind: 'program', program, args }
        };
    }

    private spawnLoggedProcess(
        command: string,
        args: string[],
        cwd: string
    ): ChildProcessWithoutNullStreams | undefined {
        try {
            const child = spawn(command, args, { cwd });
            child.stdout.on('data', chunk => this.output.append(String(chunk)));
            child.stderr.on('data', chunk => this.output.append(String(chunk)));
            child.on('error', error => {
                this.output.appendLine(`[error] ${error.message}`);
            });
            return child;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`[error] ${message}`);
            return undefined;
        }
    }

    private async ensureScenarioDebugLaunchConfiguration(
        context: ScenarioRunContext
    ): Promise<
        { workspaceFolder: vscode.WorkspaceFolder; configurationName: string; debugConfiguration: vscode.DebugConfiguration } | undefined
    > {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(context.basePath));
        if (!workspaceFolder) {
            void vscode.window.showWarningMessage(
                'Could not determine workspace folder for this scenario. Open the program folder in VS Code first.'
            );
            return undefined;
        }

        const configurationName = buildScenarioConfigurationName(context.scenarioName);
        const launchConfig = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
        const existing = launchConfig.get<vscode.DebugConfiguration[]>('configurations', []);
        const desired = createScenarioDebugLaunchConfiguration({
            basePath: context.basePath,
            python: context.python,
            scenarioName: context.scenarioName,
            useSudo: context.useSudo,
            debugTarget: context.invocation.debugTarget,
            extraArgs: context.extraFlags,
            configurationName
        });

        const index = existing.findIndex(configuration => {
            const byId = configuration['scenarioToolkitId'] === SCENARIO_TOOLKIT_DEBUG_ID;
            const byScenario = configuration['scenarioToolkitScenario'] === context.scenarioName;
            return (byId && byScenario) || configuration.name === configurationName;
        });

        const nextConfigurations = [...existing];
        if (index >= 0) {
            nextConfigurations[index] = desired;
        } else {
            nextConfigurations.push(desired);
        }

        await launchConfig.update('configurations', nextConfigurations, vscode.ConfigurationTarget.WorkspaceFolder);
        return { workspaceFolder, configurationName, debugConfiguration: desired };
    }

    private updateLastExecutionFromFilesystem(): void {
        const scenariosRoot = getScenarioPath();
        const nextInfo = scenariosRoot ? findLastScenarioExecution(scenariosRoot, getScenarioIoFolderName()) : undefined;
        this.lastExecutionInfo = nextInfo;
        this.lastExecutionEmitter.fire(nextInfo);
    }

    // Detect venv interpreter and keep toolkit/python extension settings aligned.
    private async configurePythonFromLocalVenv(basePath: string): Promise<string> {
        const pythonPath = existsDir(basePath) ? getPythonCommand() : DEFAULTS.pythonCommand;
        await this.updatePythonConfiguration(pythonPath);
        return pythonPath;
    }

    private async updatePythonConfiguration(pythonPath: string): Promise<void> {
        const pythonExtensionConfig = vscode.workspace.getConfiguration(PYTHON_CONFIG_ROOT);
        const currentInterpreter = pythonExtensionConfig.get<string>(PYTHON_DEFAULT_INTERPRETER_PATH_KEY);
        if (currentInterpreter !== pythonPath) {
            await safeUpdateConfiguration(pythonExtensionConfig, PYTHON_DEFAULT_INTERPRETER_PATH_KEY, pythonPath);
        }
    }

    // Duplicate scenario folder while intentionally clearing copied output runs.
    duplicate(uri: vscode.Uri): void {
        const destination = uniquePath(`${uri.fsPath}_copy`);
        fs.cpSync(uri.fsPath, destination, { recursive: true });

        // Keep duplicated scenarios clean by clearing inherited run outputs.
        const duplicatedIoPath = path.join(destination, getScenarioIoFolderName());
        if (fs.existsSync(duplicatedIoPath)) {
            fs.rmSync(duplicatedIoPath, { recursive: true, force: true });
            fs.mkdirSync(duplicatedIoPath, { recursive: true });
        }
        this.refresh();
    }

    // Rename scenario folder and migrate all persisted state keys to new path.
    async rename(uri: vscode.Uri): Promise<void> {
        const currentName = path.basename(uri.fsPath);
        const enteredName = await vscode.window.showInputBox({
            value: currentName,
            prompt: 'New scenario name'
        });

        const nextName = enteredName?.trim();
        if (!nextName || nextName === currentName) {
            return;
        }

        const target = path.join(path.dirname(uri.fsPath), nextName);
        if (fs.existsSync(target)) {
            void vscode.window.showErrorMessage(`Cannot rename. '${nextName}' already exists.`);
            return;
        }

        try {
            await renamePathWithFallback(uri.fsPath, target);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Could not rename scenario: ${message}`);
            return;
        }

        const previousKey = toPathKey(uri.fsPath);
        const nextKey = toPathKey(target);

        if (this.pinnedScenarios.delete(previousKey)) {
            this.pinnedScenarios.add(nextKey);
            void this.state.update(SCENARIO_STORAGE_KEYS.pinnedScenarios, [...this.pinnedScenarios]);
        }

        if (this.runSortByScenario.has(previousKey)) {
            const value = this.runSortByScenario.get(previousKey);
            this.runSortByScenario.delete(previousKey);
            if (value) {
                this.runSortByScenario.set(nextKey, value);
            }
            void this.state.update(
                SCENARIO_STORAGE_KEYS.runSortByScenario,
                Object.fromEntries(this.runSortByScenario.entries())
            );
        }

        if (this.runFilterTagIdsByScenario.has(previousKey)) {
            const value = this.runFilterTagIdsByScenario.get(previousKey);
            this.runFilterTagIdsByScenario.delete(previousKey);
            if (value && value.length > 0) {
                this.runFilterTagIdsByScenario.set(nextKey, value);
            }
            void this.state.update(
                SCENARIO_STORAGE_KEYS.runFilterTagIdsByScenario,
                Object.fromEntries(this.runFilterTagIdsByScenario.entries())
            );
        }

        let pinnedRunsChanged = false;
        for (const runKey of [...this.pinnedIoRuns]) {
            if (runKey.startsWith(`${previousKey}${path.sep}`)) {
                const suffix = runKey.slice(previousKey.length);
                this.pinnedIoRuns.delete(runKey);
                this.pinnedIoRuns.add(`${nextKey}${suffix}`);
                pinnedRunsChanged = true;
            }
        }
        if (pinnedRunsChanged) {
            void this.state.update(SCENARIO_STORAGE_KEYS.pinnedIoRuns, [...this.pinnedIoRuns]);
        }

        let runTagsChanged = false;
        for (const [runKey, tagIds] of [...this.runTagsByPath.entries()]) {
            if (runKey.startsWith(`${previousKey}${path.sep}`)) {
                const suffix = runKey.slice(previousKey.length);
                this.runTagsByPath.delete(runKey);
                this.runTagsByPath.set(`${nextKey}${suffix}`, tagIds);
                runTagsChanged = true;
            }
        }
        if (runTagsChanged) {
            void this.state.update(SCENARIO_STORAGE_KEYS.runTagsByPath, Object.fromEntries(this.runTagsByPath.entries()));
        }

        this.refresh();
    }

    // Delete scenario folder and remove all state entries scoped to that scenario.
    async delete(uri: vscode.Uri): Promise<void> {
        const scenarioName = path.basename(uri.fsPath);
        const confirmation = await vscode.window.showWarningMessage(
            `Delete scenario '${scenarioName}'?`,
            { modal: true },
            'Delete'
        );

        if (confirmation !== 'Delete') {
            return;
        }

        fs.rmSync(uri.fsPath, { recursive: true, force: true });
        const key = toPathKey(uri.fsPath);
        this.pinnedScenarios.delete(key);
        this.runSortByScenario.delete(key);
        for (const runKey of [...this.pinnedIoRuns]) {
            if (runKey === key || runKey.startsWith(`${key}${path.sep}`)) {
                this.pinnedIoRuns.delete(runKey);
            }
        }
        for (const runKey of [...this.runTagsByPath.keys()]) {
            if (runKey === key || runKey.startsWith(`${key}${path.sep}`)) {
                this.runTagsByPath.delete(runKey);
            }
        }
        void this.state.update(SCENARIO_STORAGE_KEYS.pinnedScenarios, [...this.pinnedScenarios]);
        void this.state.update(SCENARIO_STORAGE_KEYS.pinnedIoRuns, [...this.pinnedIoRuns]);
        void this.state.update(SCENARIO_STORAGE_KEYS.runTagsByPath, Object.fromEntries(this.runTagsByPath.entries()));
        void this.state.update(
            SCENARIO_STORAGE_KEYS.runSortByScenario,
            Object.fromEntries(this.runSortByScenario.entries())
        );
        this.refresh();
    }

    async renameIoRun(uri: vscode.Uri): Promise<void> {
        const currentName = path.basename(uri.fsPath);
        const enteredName = await vscode.window.showInputBox({
            value: currentName,
            prompt: 'New output run name'
        });

        const nextName = enteredName?.trim();
        if (!nextName || nextName === currentName) {
            return;
        }

        const target = path.join(path.dirname(uri.fsPath), nextName);
        if (fs.existsSync(target)) {
            void vscode.window.showErrorMessage(`Cannot rename. '${nextName}' already exists.`);
            return;
        }

        fs.renameSync(uri.fsPath, target);
        const prevKey = toPathKey(uri.fsPath);
        const nextKey = toPathKey(target);
        if (this.pinnedIoRuns.has(prevKey)) {
            this.pinnedIoRuns.delete(prevKey);
            this.pinnedIoRuns.add(nextKey);
            void this.state.update(SCENARIO_STORAGE_KEYS.pinnedIoRuns, [...this.pinnedIoRuns]);
        }

        const tags = this.runTagsByPath.get(prevKey);
        if (tags) {
            this.runTagsByPath.delete(prevKey);
            this.runTagsByPath.set(nextKey, tags);
            void this.state.update(SCENARIO_STORAGE_KEYS.runTagsByPath, Object.fromEntries(this.runTagsByPath.entries()));
        }
        this.refresh();
    }

    async deleteIoRun(uri: vscode.Uri): Promise<void> {
        const runName = path.basename(uri.fsPath);
        const confirmation = await vscode.window.showWarningMessage(
            `Delete output run '${runName}'?`,
            { modal: true },
            'Delete'
        );

        if (confirmation !== 'Delete') {
            return;
        }

        fs.rmSync(uri.fsPath, { recursive: true, force: true });
        const key = toPathKey(uri.fsPath);
        this.pinnedIoRuns.delete(key);
        this.runTagsByPath.delete(key);
        void this.state.update(SCENARIO_STORAGE_KEYS.pinnedIoRuns, [...this.pinnedIoRuns]);
        void this.state.update(SCENARIO_STORAGE_KEYS.runTagsByPath, Object.fromEntries(this.runTagsByPath.entries()));
        this.refresh();
    }

    async openIoRunLog(uri: vscode.Uri): Promise<void> {
        if (!existsDir(uri.fsPath)) {
            void vscode.window.showWarningMessage('Selected output run is not a folder.');
            return;
        }

        const entries = fs
            .readdirSync(uri.fsPath)
            .filter(name => name.toLowerCase().endsWith(FILE_EXTENSIONS.log))
            .map(name => path.join(uri.fsPath, name));

        if (entries.length === 0) {
            void vscode.window.showWarningMessage(`No ${FILE_EXTENSIONS.log} file found in '${path.basename(uri.fsPath)}'.`);
            return;
        }

        if (entries.length === 1) {
            await vscode.window.showTextDocument(vscode.Uri.file(entries[0]));
            return;
        }

        const picked = await vscode.window.showQuickPick(entries.map(file => path.basename(file)), {
            placeHolder: 'Select a log file to open'
        });

        if (!picked) {
            return;
        }

        await vscode.window.showTextDocument(vscode.Uri.file(path.join(uri.fsPath, picked)));
    }

    private loadState(): void {
        const scalars = loadScenarioStateFromMemento(this.state, {
            pinnedScenarios: this.pinnedScenarios,
            pinnedIoRuns: this.pinnedIoRuns,
            runSortByScenario: this.runSortByScenario,
            tagCatalog: this.tagCatalog,
            runTagsByPath: this.runTagsByPath,
            runFilterTagIdsByScenario: this.runFilterTagIdsByScenario,
            sudoExecutionByScenario: this.sudoExecutionByScenario
        });
        this.filter = scalars.filter;
        this.scenarioSortMode = scalars.scenarioSortMode;
        this.globalRunFlags = scalars.globalRunFlags;
    }

    private applyScenarioHover(node: ScenarioNode): void {
        const scenarioPath = node.scenarioRootPath ?? node.uri.fsPath;
        const scenarioName = path.basename(scenarioPath);
        const sudoEnabled = this.isSudoEnabledForScenario(scenarioPath);
        const scenarioFilter = this.filter ? this.filter : 'None';
        const runSortMode = this.runSortByScenario.get(toPathKey(scenarioPath)) ?? 'recent';
        const activeRunTagFilter = this.formatTagFilterForScenario(scenarioPath);
        const runFlags = this.globalRunFlags ? this.globalRunFlags : 'None';

        node.tooltip = buildScenarioTooltip({
            scenarioName,
            sudoEnabled,
            runFlags,
            scenarioFilter,
            scenarioSortMode: this.scenarioSortMode,
            runSortMode,
            activeRunTagFilter
        });
    }

    private applyIoFolderHover(node: ScenarioNode): void {
        const scenarioPath = node.scenarioRootPath ?? node.uri.fsPath;
        const scenarioName = path.basename(scenarioPath);
        const runSortMode = this.runSortByScenario.get(toPathKey(scenarioPath)) ?? 'recent';
        const activeRunTagFilter = this.formatTagFilterForScenario(scenarioPath);
        const runFlags = this.globalRunFlags ? this.globalRunFlags : 'None';

        node.tooltip = buildIoFolderTooltip({
            scenarioName,
            folderName: getScenarioIoFolderName(),
            runSortMode,
            activeRunTagFilter,
            sudoEnabled: this.isSudoEnabledForScenario(scenarioPath),
            runFlags
        });
    }

    private applyIoRunDetails(node: ScenarioNode, scenarioPath: string): void {
        const runName = path.basename(node.uri.fsPath);
        const scenarioName = path.basename(scenarioPath);
        const runKey = toPathKey(node.uri.fsPath);
        const tagIds = this.runTagsByPath.get(runKey) ?? [];
        const tags = tagIds
            .map(tagId => this.tagCatalog.get(tagId))
            .filter((tag): tag is RunTagDefinition => Boolean(tag));
        if (tags.length > 0) {
            node.description = tags.map(tag => formatTagChip(tag)).join(' ');
        }

        const runSortMode = this.runSortByScenario.get(toPathKey(scenarioPath)) ?? 'recent';
        const runFlags = this.globalRunFlags ? this.globalRunFlags : 'None';
        node.tooltip = buildIoRunTooltip({
            runName,
            scenarioName,
            tags,
            activeRunTagFilter: this.formatTagFilterForScenario(scenarioPath),
            sudoEnabled: this.isSudoEnabledForScenario(scenarioPath),
            runFlags,
            runSortMode,
            scenarioFilter: this.filter ? this.filter : 'None'
        });
    }

    private formatTagFilterForScenario(scenarioPath: string): string {
        const selectedIds = this.runFilterTagIdsByScenario.get(toPathKey(scenarioPath)) ?? [];
        return formatTagFilter(selectedIds, this.tagCatalog);
    }

    private persistTagState(): void {
        persistScenarioTagState(this.state, {
            tagCatalog: this.tagCatalog,
            runTagsByPath: this.runTagsByPath,
            runFilterTagIdsByScenario: this.runFilterTagIdsByScenario
        });
    }

    private async pickTag(placeHolder: string): Promise<RunTagDefinition | undefined> {
        const tags = [...this.tagCatalog.values()];
        if (tags.length === 0) {
            void vscode.window.showInformationMessage('No tags available.');
            return undefined;
        }

        const picked = await vscode.window.showQuickPick(
            tags.map(tag => ({
                label: tag.label,
                description: `${tag.icon ? `$(${tag.icon}) ` : ''}${tag.color}`,
                id: tag.id
            })),
            { placeHolder }
        );

        if (!picked) {
            return undefined;
        }

        return this.tagCatalog.get(picked.id);
    }

    private ensureDefaultTags(): void {
        if (ensureDefaultRunTags({ tagCatalog: this.tagCatalog })) {
            this.persistTagState();
        }
    }

    private getOrCreateDefaultTag(tagLabel: 'success' | 'failed'): RunTagDefinition | undefined {
        const existingCount = this.tagCatalog.size;
        const tag = getOrCreateDefaultRunTag(tagLabel, { tagCatalog: this.tagCatalog });
        if (this.tagCatalog.size > existingCount) {
            this.persistTagState();
        }
        return tag;
    }

    private isSudoEnabledForScenario(scenarioPath: string): boolean {
        return this.sudoExecutionByScenario.get(toPathKey(scenarioPath)) === true;
    }

    private async setSudoExecutionForScenario(uri: vscode.Uri, enabled: boolean): Promise<void> {
        const scenarioRootPath = this.resolveScenarioPathFromTarget(uri);
        if (!scenarioRootPath) {
            return;
        }

        if (enabled && process.platform === 'win32') {
            void vscode.window.showWarningMessage('Sudo is not available on Windows.');
            return;
        }

        const key = toPathKey(scenarioRootPath);
        if (enabled) {
            this.sudoExecutionByScenario.set(key, true);
        } else {
            this.sudoExecutionByScenario.delete(key);
        }

        await this.state.update(
            SCENARIO_STORAGE_KEYS.sudoExecutionByScenario,
            Object.fromEntries(this.sudoExecutionByScenario.entries())
        );
        void vscode.window.showInformationMessage(
            `${path.basename(scenarioRootPath)}: sudo ${enabled ? 'enabled' : 'disabled'}`
        );
        this.refresh();
    }

    private resolveScenarioPathFromTarget(uri: vscode.Uri): string | undefined {
        const scenariosRoot = getScenarioPath();
        if (!scenariosRoot) {
            return undefined;
        }
        return (
            findScenarioRoot(uri.fsPath, scenariosRoot) ??
            (existsDir(uri.fsPath) && toPathKey(path.dirname(uri.fsPath)) === toPathKey(scenariosRoot) ? uri.fsPath : undefined)
        );
    }
}

function delayMs(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
