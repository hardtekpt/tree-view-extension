import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as vscode from 'vscode';
import {
    getBasePath,
    getOutputFilenameParsers,
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
import { parseFilenameWithParsers, ParsedFilenameMetadata } from './scenario/filenameMetadata';
import { createTagId, formatTagChip, normalizeColor, normalizeTag } from './scenario/tagUtils';
import { findScenarioRoot, matchRunTagFilter, sortEntries } from './scenario/treeUtils';
import { RunTagDefinition, ScenarioRunSortMode, ScenarioWorkspaceState, SortMode } from './scenario/types';

type DebugRunTarget =
    | { kind: 'program'; program: string; args: string[] }
    | { kind: 'module'; module: string; args: string[] };

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

export interface ParsedOutputFileMetadata extends ParsedFilenameMetadata {
    filePath: string;
    relativePath: string;
    fileName: string;
}

export interface ParsedOutputFolderMetadata extends ParsedFilenameMetadata {
    folderPath: string;
    relativePath: string;
    folderName: string;
}

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
    private readonly outputMetadataCache = new Map<
        string,
        { mtimeMs: number; metadata?: ParsedFilenameMetadata }
    >();

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
        if (!existsDir(runPath)) {
            return [];
        }
        const parsers = getOutputFilenameParsers();
        if (parsers.length === 0) {
            return [];
        }

        const files = this.listFilesRecursively(runPath);
        const results: ParsedOutputFileMetadata[] = [];
        for (const filePath of files) {
            const metadata = this.getOrParseOutputMetadata(filePath, parsers, 'file');
            if (!metadata) {
                continue;
            }
            results.push({
                ...metadata,
                filePath,
                fileName: path.basename(filePath),
                relativePath: path.relative(runPath, filePath)
            });
        }
        return results;
    }

    getParsedOutputFolderMetadataForRun(runPath: string): ParsedOutputFolderMetadata[] {
        if (!existsDir(runPath)) {
            return [];
        }
        const parsers = getOutputFilenameParsers();
        if (parsers.length === 0) {
            return [];
        }

        const folders = this.listFoldersRecursively(runPath);
        const results: ParsedOutputFolderMetadata[] = [];
        for (const folderPath of folders) {
            const metadata = this.getOrParseOutputMetadata(folderPath, parsers, 'folder');
            if (!metadata) {
                continue;
            }
            results.push({
                ...metadata,
                folderPath,
                folderName: path.basename(folderPath),
                relativePath: path.relative(runPath, folderPath)
            });
        }
        return results;
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
        // Serialize provider state into the single workspace configuration snapshot.
        return {
            filter: this.filter,
            scenarioSortMode: this.scenarioSortMode,
            pinnedScenarios: [...this.pinnedScenarios],
            pinnedIoRuns: [...this.pinnedIoRuns],
            runSortByScenario: Object.fromEntries(this.runSortByScenario.entries()),
            tagCatalog: [...this.tagCatalog.values()],
            runTagsByPath: Object.fromEntries(this.runTagsByPath.entries()),
            runFilterTagIdsByScenario: Object.fromEntries(this.runFilterTagIdsByScenario.entries()),
            globalRunFlags: this.globalRunFlags,
            sudoExecutionByScenario: Object.fromEntries(this.sudoExecutionByScenario.entries())
        };
    }

    // Apply a previously saved workspace snapshot to in-memory provider state.
    applyWorkspaceState(next: ScenarioWorkspaceState): void {
        // Rehydrate all provider state from persisted workspace configuration.
        this.filter = next.filter ?? '';
        this.scenarioSortMode = next.scenarioSortMode ?? 'name';
        this.pinnedScenarios.clear();
        for (const item of next.pinnedScenarios ?? []) {
            this.pinnedScenarios.add(toPathKey(item));
        }
        this.pinnedIoRuns.clear();
        for (const item of next.pinnedIoRuns ?? []) {
            this.pinnedIoRuns.add(toPathKey(item));
        }

        this.runSortByScenario.clear();
        for (const [key, mode] of Object.entries(next.runSortByScenario ?? {})) {
            this.runSortByScenario.set(toPathKey(key), mode);
        }
        this.tagCatalog.clear();
        for (const tag of next.tagCatalog ?? []) {
            if (!tag?.id || !tag.label) {
                continue;
            }
            this.tagCatalog.set(tag.id, normalizeTag(tag));
        }

        this.runTagsByPath.clear();
        for (const [runPath, tagIds] of Object.entries(next.runTagsByPath ?? {})) {
            const filteredIds = (tagIds ?? []).filter(tagId => this.tagCatalog.has(tagId));
            if (filteredIds.length > 0) {
                this.runTagsByPath.set(toPathKey(runPath), filteredIds);
            }
        }

        this.runFilterTagIdsByScenario.clear();
        for (const [scenarioPath, tagIds] of Object.entries(next.runFilterTagIdsByScenario ?? {})) {
            const filteredIds = (tagIds ?? []).filter(tagId => this.tagCatalog.has(tagId));
            if (filteredIds.length > 0) {
                this.runFilterTagIdsByScenario.set(toPathKey(scenarioPath), filteredIds);
            }
        }
        this.globalRunFlags = normalizeRunFlags(next.globalRunFlags ?? '');
        this.sudoExecutionByScenario.clear();
        for (const [scenarioPath, enabled] of Object.entries(next.sudoExecutionByScenario ?? {})) {
            if (enabled) {
                this.sudoExecutionByScenario.set(toPathKey(scenarioPath), true);
            }
        }

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
        const context = await this.buildScenarioRunContext(uri);
        if (!context) {
            return;
        }

        const args = [...context.invocation.pythonArgs, ...context.extraFlags];
        const effectiveCommand = context.useSudo ? 'sudo' : context.python;
        const effectiveArgs = context.useSudo ? ['-n', context.python, ...args] : args;
        const commandLine = [effectiveCommand, ...effectiveArgs].map(quoteIfNeeded).join(' ');

        const terminal = vscode.window.createTerminal({
            name: `Scenario Run: ${context.scenarioName}`,
            cwd: context.basePath
        });
        terminal.show(true);
        terminal.sendText(commandLine, true);

        this.updateLastExecutionFromFilesystem();
    }

    // Run scenario with VS Code debugger using an ephemeral Python launch configuration.
    async runWithDebugger(uri: vscode.Uri): Promise<void> {
        const context = await this.buildScenarioRunContext(uri);
        if (!context) {
            return;
        }

        if (context.useSudo) {
            const debugpyReady = await this.ensureDebugpyAvailable(context.python, context.basePath);
            if (!debugpyReady) {
                return;
            }

            const port = await this.allocateDebugPort();
            const debugArgs = [
                '-m',
                'debugpy',
                '--listen',
                `127.0.0.1:${port}`,
                '--wait-for-client',
                ...context.invocation.pythonArgs,
                ...context.extraFlags
            ];
            this.output.appendLine(
                `[run-debug-sudo] sudo -n ${[context.python, ...debugArgs].map(quoteIfNeeded).join(' ')}`
            );

            const child = this.spawnLoggedProcess('sudo', ['-n', context.python, ...debugArgs], context.basePath);
            if (!child) {
                void vscode.window.showErrorMessage('Scenario debug run failed: could not start process.');
                return;
            }
            this.watchProcessExit(child, '[debug-sudo-exit]', 'Scenario debug process exited with code', context);

            const ready = await this.waitForDebugServer(port, 10000);
            if (!ready) {
                child.kill();
                void vscode.window.showErrorMessage('Timed out waiting for sudo debug server to start.');
                return;
            }

            const started = await vscode.debug.startDebugging(undefined, {
                type: 'python',
                request: 'attach',
                name: `Run Scenario (sudo): ${context.scenarioName}`,
                connect: { host: '127.0.0.1', port },
                pathMappings: [{ localRoot: context.basePath, remoteRoot: context.basePath }],
                justMyCode: false
            });
            if (!started) {
                child.kill();
                void vscode.window.showErrorMessage('Could not attach debugger for this sudo scenario run.');
            }
            return;
        }

        const debugConfiguration: vscode.DebugConfiguration = {
            type: 'python',
            request: 'launch',
            name: `Run Scenario: ${context.scenarioName}`,
            cwd: context.basePath,
            python: context.python,
            console: 'integratedTerminal',
            justMyCode: false
        };
        if (context.invocation.debugTarget.kind === 'program') {
            debugConfiguration.program = context.invocation.debugTarget.program;
            debugConfiguration.args = [...context.invocation.debugTarget.args, ...context.extraFlags];
        } else {
            debugConfiguration.module = context.invocation.debugTarget.module;
            debugConfiguration.args = [...context.invocation.debugTarget.args, ...context.extraFlags];
        }

        const started = await vscode.debug.startDebugging(undefined, debugConfiguration);
        if (!started) {
            void vscode.window.showErrorMessage('Could not start debugger for this scenario.');
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
        child.on('close', code => {
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

    private async buildScenarioRunContext(uri: vscode.Uri): Promise<ScenarioRunContext | undefined> {
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

        const useSudo = await this.resolveSudoUsage(basePath, uri.fsPath);
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

    private async resolveSudoUsage(basePath: string, scenarioPath: string): Promise<boolean | undefined> {
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

    private allocateDebugPort(): Promise<number> {
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            server.listen(0, '127.0.0.1', () => {
                const address = server.address();
                if (!address || typeof address === 'string') {
                    server.close();
                    reject(new Error('Could not allocate debug port.'));
                    return;
                }
                const port = address.port;
                server.close(error => (error ? reject(error) : resolve(port)));
            });
            server.on('error', reject);
        });
    }

    private waitForDebugServer(port: number, timeoutMs: number): Promise<boolean> {
        const start = Date.now();

        return new Promise(resolve => {
            const tryConnect = (): void => {
                const socket = net.connect({ host: '127.0.0.1', port }, () => {
                    socket.end();
                    resolve(true);
                });

                socket.on('error', () => {
                    socket.destroy();
                    if (Date.now() - start >= timeoutMs) {
                        resolve(false);
                        return;
                    }
                    setTimeout(tryConnect, 150);
                });
            };

            tryConnect();
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

    private async ensureDebugpyAvailable(pythonPath: string, basePath: string): Promise<boolean> {
        const hasDebugpy = await this.pythonCanImportModule(pythonPath, 'debugpy', basePath);
        if (hasDebugpy) {
            return true;
        }

        const choice = await vscode.window.showWarningMessage(
            `The selected Python environment is missing 'debugpy'. Install it now for sudo debugging?`,
            'Install',
            'Cancel'
        );
        if (choice !== 'Install') {
            return false;
        }

        const installed = await this.installDebugpy(pythonPath, basePath);
        if (!installed) {
            void vscode.window.showErrorMessage(`Could not install debugpy in '${pythonPath}'.`);
            return false;
        }

        const nowAvailable = await this.pythonCanImportModule(pythonPath, 'debugpy', basePath);
        if (!nowAvailable) {
            void vscode.window.showErrorMessage(`debugpy still not available in '${pythonPath}' after install.`);
            return false;
        }

        return true;
    }

    private pythonCanImportModule(pythonPath: string, moduleName: string, basePath: string): Promise<boolean> {
        return new Promise(resolve => {
            const child = spawn(pythonPath, ['-c', `import ${moduleName}`], { cwd: basePath });
            child.on('error', () => resolve(false));
            child.on('close', code => resolve(code === 0));
        });
    }

    private installDebugpy(pythonPath: string, basePath: string): Promise<boolean> {
        this.output.appendLine(`[debugpy-install] ${pythonPath} -m pip install debugpy`);
        return new Promise(resolve => {
            const child = spawn(pythonPath, ['-m', 'pip', 'install', 'debugpy'], { cwd: basePath });
            child.stdout.on('data', chunk => this.output.append(String(chunk)));
            child.stderr.on('data', chunk => this.output.append(String(chunk)));
            child.on('error', () => resolve(false));
            child.on('close', code => resolve(code === 0));
        });
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

    private watchProcessExit(
        child: ChildProcessWithoutNullStreams,
        logPrefix: string,
        nonZeroWarningPrefix: string,
        context?: ScenarioRunContext
    ): void {
        child.on('close', code => {
            this.output.appendLine(`${logPrefix} code=${code ?? 'unknown'}`);
            this.output.show(true);
            if (context) {
                this.updateLastExecutionFromFilesystem();
            }
            if (code !== 0) {
                void vscode.window.showWarningMessage(`${nonZeroWarningPrefix} ${code ?? 'unknown'}.`);
            }
        });
    }

    private updateLastExecutionFromFilesystem(): void {
        const nextInfo = this.findLastExecutionFromFilesystem();
        this.lastExecutionInfo = nextInfo;
        this.lastExecutionEmitter.fire(nextInfo);
    }

    private findLastExecutionFromFilesystem(): LastExecutionInfo | undefined {
        const scenariosRoot = getScenarioPath();
        if (!scenariosRoot) {
            return undefined;
        }

        if (!existsDir(scenariosRoot)) {
            return undefined;
        }

        const scenarioNames = listEntriesSorted(scenariosRoot).filter(name => existsDir(path.join(scenariosRoot, name)));
        let newestScenarioName: string | undefined;
        let newestRunPath: string | undefined;
        let newestTimestamp = -1;

        for (const scenarioName of scenarioNames) {
            const scenarioPath = path.join(scenariosRoot, scenarioName);
            const candidate = this.findLatestRunCandidateForScenario(scenarioPath);
            if (!candidate) {
                continue;
            }
            if (candidate.timestampMs > newestTimestamp) {
                newestTimestamp = candidate.timestampMs;
                newestScenarioName = scenarioName;
                newestRunPath = candidate.runPath;
            }
        }

        if (!newestScenarioName) {
            return undefined;
        }

        return {
            scenarioName: newestScenarioName,
            scenarioPath: path.join(scenariosRoot, newestScenarioName),
            runPath: newestRunPath,
            runName: newestRunPath ? path.basename(newestRunPath) : undefined,
            timestampMs: newestTimestamp
        };
    }

    private findLatestRunCandidateForScenario(
        scenarioPath: string
    ): { runPath?: string; timestampMs: number } | undefined {
        const ioPath = path.join(scenarioPath, getScenarioIoFolderName());
        if (!existsDir(ioPath)) {
            return undefined;
        }

        const latestPath = this.findLatestPathRecursive(ioPath);
        if (!latestPath) {
            return undefined;
        }

        const relative = path.relative(ioPath, latestPath);
        const runFolder = relative.split(path.sep)[0];
        if (!runFolder) {
            return undefined;
        }

        let stat: fs.Stats;
        try {
            stat = fs.statSync(latestPath);
        } catch {
            return undefined;
        }

        return {
            runPath: path.join(ioPath, runFolder),
            timestampMs: stat.mtimeMs
        };
    }

    private findLatestPathRecursive(rootPath: string): string | undefined {
        let latestPath: string | undefined;
        let latestMtime = -1;

        const visit = (currentPath: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(currentPath, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const entryPath = path.join(currentPath, entry.name);
                let stat: fs.Stats;
                try {
                    stat = fs.statSync(entryPath);
                } catch {
                    continue;
                }

                if (stat.mtimeMs > latestMtime) {
                    latestMtime = stat.mtimeMs;
                    latestPath = entryPath;
                }

                if (entry.isDirectory()) {
                    visit(entryPath);
                }
            }
        };

        visit(rootPath);
        return latestPath;
    }

    private getOrParseOutputMetadata(
        filePath: string,
        parsers: ReturnType<typeof getOutputFilenameParsers>,
        entryType: 'file' | 'folder'
    ): ParsedFilenameMetadata | undefined {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(filePath);
        } catch {
            return undefined;
        }

        const cacheKey = toPathKey(filePath);
        const cached = this.outputMetadataCache.get(cacheKey);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
            return cached.metadata;
        }

        const metadata = parseFilenameWithParsers(filePath, parsers, entryType);
        this.outputMetadataCache.set(cacheKey, { mtimeMs: stat.mtimeMs, metadata });
        return metadata;
    }

    private listFilesRecursively(rootPath: string): string[] {
        const files: string[] = [];
        const visit = (currentPath: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(currentPath, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const entryPath = path.join(currentPath, entry.name);
                if (entry.isDirectory()) {
                    visit(entryPath);
                    continue;
                }
                files.push(entryPath);
            }
        };
        visit(rootPath);
        return files;
    }

    private listFoldersRecursively(rootPath: string): string[] {
        const folders: string[] = [];
        const visit = (currentPath: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(currentPath, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (!entry.isDirectory()) {
                    continue;
                }
                const entryPath = path.join(currentPath, entry.name);
                folders.push(entryPath);
                visit(entryPath);
            }
        };
        visit(rootPath);
        return folders;
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
        const pinned = this.state.get<string[]>(SCENARIO_STORAGE_KEYS.pinnedScenarios, []);
        for (const item of pinned) {
            this.pinnedScenarios.add(toPathKey(item));
        }
        const pinnedRuns = this.state.get<string[]>(SCENARIO_STORAGE_KEYS.pinnedIoRuns, []);
        for (const item of pinnedRuns) {
            this.pinnedIoRuns.add(toPathKey(item));
        }
        const catalog = this.state.get<RunTagDefinition[]>(SCENARIO_STORAGE_KEYS.tagCatalog, []);
        for (const tag of catalog) {
            if (!tag?.id || !tag.label) {
                continue;
            }
            this.tagCatalog.set(tag.id, normalizeTag(tag));
        }
        const runTags = this.state.get<Record<string, string[]>>(SCENARIO_STORAGE_KEYS.runTagsByPath, {});
        for (const [runPath, tagIds] of Object.entries(runTags)) {
            const ids = (tagIds ?? []).filter(tagId => this.tagCatalog.has(tagId));
            if (ids.length > 0) {
                this.runTagsByPath.set(toPathKey(runPath), ids);
            }
        }
        const filterByScenario = this.state.get<Record<string, string[]>>(
            SCENARIO_STORAGE_KEYS.runFilterTagIdsByScenario,
            {}
        );
        for (const [scenarioPath, tagIds] of Object.entries(filterByScenario)) {
            const filteredIds = (tagIds ?? []).filter(tagId => this.tagCatalog.has(tagId));
            if (filteredIds.length > 0) {
                this.runFilterTagIdsByScenario.set(toPathKey(scenarioPath), filteredIds);
            }
        }
        this.globalRunFlags = normalizeRunFlags(this.state.get<string>(SCENARIO_STORAGE_KEYS.globalRunFlags, ''));
        const sudoByScenario = this.state.get<Record<string, boolean>>(SCENARIO_STORAGE_KEYS.sudoExecutionByScenario, {});
        this.sudoExecutionByScenario.clear();
        for (const [scenarioPath, enabled] of Object.entries(sudoByScenario)) {
            if (enabled) {
                this.sudoExecutionByScenario.set(toPathKey(scenarioPath), true);
            }
        }

        this.scenarioSortMode = this.state.get<SortMode>(SCENARIO_STORAGE_KEYS.scenarioSort, 'name');
        const byScenario = this.state.get<Record<string, ScenarioRunSortMode>>(
            SCENARIO_STORAGE_KEYS.runSortByScenario,
            {}
        );
        for (const [key, mode] of Object.entries(byScenario)) {
            this.runSortByScenario.set(toPathKey(key), mode);
        }
    }

    private applyScenarioHover(node: ScenarioNode): void {
        const scenarioPath = node.scenarioRootPath ?? node.uri.fsPath;
        const scenarioName = path.basename(scenarioPath);
        const sudoEnabled = this.isSudoEnabledForScenario(scenarioPath);
        const scenarioFilter = this.filter ? this.filter : 'None';
        const runSortMode = this.runSortByScenario.get(toPathKey(scenarioPath)) ?? 'recent';
        const activeRunTagFilter = this.formatTagFilterForScenario(scenarioPath);
        const runFlags = this.globalRunFlags ? this.globalRunFlags : 'None';

        node.tooltip = [
            `Scenario: ${scenarioName}`,
            `Sudo: ${sudoEnabled ? 'Enabled' : 'Disabled'}`,
            `Run flags: ${runFlags}`,
            `Scenario filter: ${scenarioFilter}`,
            `Scenario sort: ${this.formatSortMode(this.scenarioSortMode)}`,
            `Run sort: ${this.formatSortMode(runSortMode)}`,
            `Run tag filter: ${activeRunTagFilter}`
        ].join('\n');
    }

    private applyIoFolderHover(node: ScenarioNode): void {
        const scenarioPath = node.scenarioRootPath ?? node.uri.fsPath;
        const scenarioName = path.basename(scenarioPath);
        const runSortMode = this.runSortByScenario.get(toPathKey(scenarioPath)) ?? 'recent';
        const activeRunTagFilter = this.formatTagFilterForScenario(scenarioPath);
        const runFlags = this.globalRunFlags ? this.globalRunFlags : 'None';

        node.tooltip = [
            `Scenario: ${scenarioName}`,
            `Folder: ${getScenarioIoFolderName()}`,
            `Run sort: ${this.formatSortMode(runSortMode)}`,
            `Run tag filter: ${activeRunTagFilter}`,
            `Sudo: ${this.isSudoEnabledForScenario(scenarioPath) ? 'Enabled' : 'Disabled'}`,
            `Run flags: ${runFlags}`
        ].join('\n');
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
        node.tooltip = [
            `Run: ${runName}`,
            `Scenario: ${scenarioName}`,
            `Tags: ${tags.length > 0 ? tags.map(tag => tag.label).join(', ') : 'None'}`,
            `Active run tag filter: ${this.formatTagFilterForScenario(scenarioPath)}`,
            `Sudo: ${this.isSudoEnabledForScenario(scenarioPath) ? 'Enabled' : 'Disabled'}`,
            `Run flags: ${runFlags}`,
            `Run sort: ${this.formatSortMode(runSortMode)}`,
            `Scenario filter: ${this.filter ? this.filter : 'None'}`
        ].join('\n');
    }

    private formatTagFilterForScenario(scenarioPath: string): string {
        const selectedIds = this.runFilterTagIdsByScenario.get(toPathKey(scenarioPath)) ?? [];
        if (selectedIds.length === 0) {
            return 'None';
        }

        const labels = selectedIds
            .map(tagId => this.tagCatalog.get(tagId)?.label)
            .filter((label): label is string => Boolean(label));
        return labels.length > 0 ? labels.join(', ') : 'None';
    }

    private formatSortMode(mode: SortMode | ScenarioRunSortMode): string {
        return mode === 'recent' ? 'Most recent' : 'Name';
    }

    private persistTagState(): void {
        void this.state.update(SCENARIO_STORAGE_KEYS.tagCatalog, [...this.tagCatalog.values()]);
        void this.state.update(SCENARIO_STORAGE_KEYS.runTagsByPath, Object.fromEntries(this.runTagsByPath.entries()));
        void this.state.update(
            SCENARIO_STORAGE_KEYS.runFilterTagIdsByScenario,
            Object.fromEntries(this.runFilterTagIdsByScenario.entries())
        );
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
        const defaults: Array<Omit<RunTagDefinition, 'id'>> = [
            { label: 'success', color: '#4CAF50', icon: 'check' },
            { label: 'failed', color: '#F44336', icon: 'error' },
            { label: 'reviewed', color: '#2196F3', icon: 'eye' }
        ];

        let changed = false;
        for (const definition of defaults) {
            const exists = [...this.tagCatalog.values()].some(
                tag => tag.label.toLowerCase() === definition.label.toLowerCase()
            );
            if (exists) {
                continue;
            }

            const id = createTagId(definition.label, this.tagCatalog);
            this.tagCatalog.set(id, normalizeTag({ id, ...definition }));
            changed = true;
        }

        if (changed) {
            this.persistTagState();
        }
    }

    private getOrCreateDefaultTag(tagLabel: 'success' | 'failed'): RunTagDefinition | undefined {
        const existing = [...this.tagCatalog.values()].find(tag => tag.label.toLowerCase() === tagLabel);
        if (existing) {
            return existing;
        }

        const definition =
            tagLabel === 'success'
                ? { label: 'success', color: '#4CAF50', icon: 'check' }
                : { label: 'failed', color: '#F44336', icon: 'error' };

        const id = createTagId(definition.label, this.tagCatalog);
        const tag = normalizeTag({ id, ...definition });
        this.tagCatalog.set(id, tag);
        this.persistTagState();
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
