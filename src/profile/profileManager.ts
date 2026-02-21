import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULTS, FOLDER_NAMES } from '../constants';
import { validateFilenameParser } from '../providers/scenario/filenameMetadata';
import { existsDir } from '../utils/fileSystem';
import { asStringArray, asStringRecord, isJsonRecord } from '../utils/json';
import { OutputFilenameParser, OutputFilenameParserField } from './profileTypes';

const PROFILES_FILE = 'programProfiles.json';
const BINDINGS_FILE = 'workspaceBindings.json';

type PythonStrategy = 'autoVenv' | 'fixedPath';

export interface ProgramProfile {
    id: string;
    name: string;
    basePath: string;
    pythonStrategy: PythonStrategy;
    pythonPath?: string;
    scenariosRoot: string;
    scenarioConfigsFolderName: string;
    scenarioIoFolderName: string;
    runCommandTemplate: string;
    outputFilenameParsers: OutputFilenameParser[];
    createdAtMs: number;
    updatedAtMs: number;
}

interface ProfilesFileShape {
    version: 1;
    profiles: ProgramProfile[];
}

interface BindingsFileShape {
    version: 1;
    bindings: Record<string, string>;
}

export interface ProfileValidationResult {
    valid: boolean;
    errors: string[];
}

export class ProfileManager implements vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeActiveProfile = this.changeEmitter.event;
    private readonly profiles = new Map<string, ProgramProfile>();
    private readonly workspaceBindings = new Map<string, string>();
    private activeProfile?: ProgramProfile;
    private initialized = false;

    constructor(private readonly context: vscode.ExtensionContext) {}

    async initialize(): Promise<void> {
        await this.ensureStorage();
        this.load();
        await this.resolveActiveProfile();
        this.initialized = true;
        this.changeEmitter.fire();
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }

    getActiveProfile(): ProgramProfile | undefined {
        return this.activeProfile;
    }

    async handleWorkspaceFoldersChanged(): Promise<void> {
        await this.resolveActiveProfile();
        this.changeEmitter.fire();
    }

    async createProfileForCurrentWorkspace(): Promise<void> {
        const workspacePath = this.getCurrentWorkspacePath();
        if (!workspacePath) {
            void vscode.window.showWarningMessage('Open a workspace folder first.');
            return;
        }

        const created = await this.runProfileWizard(undefined, workspacePath);
        if (!created) {
            return;
        }

        this.profiles.set(created.id, created);
        this.workspaceBindings.set(workspacePath, created.id);
        this.persist();
        this.activeProfile = created;
        this.changeEmitter.fire();
        void vscode.window.showInformationMessage(`Profile '${created.name}' created and bound to this workspace.`);
    }

    async editCurrentProfile(): Promise<void> {
        const workspacePath = this.getCurrentWorkspacePath();
        if (!workspacePath) {
            void vscode.window.showWarningMessage('Open a workspace folder first.');
            return;
        }

        const current = this.activeProfile;
        if (!current) {
            await this.createProfileForCurrentWorkspace();
            return;
        }

        const edited = await this.runProfileWizard(current, workspacePath);
        if (!edited) {
            return;
        }

        this.profiles.set(edited.id, edited);
        this.workspaceBindings.set(workspacePath, edited.id);
        this.persist();
        this.activeProfile = edited;
        this.changeEmitter.fire();
        void vscode.window.showInformationMessage(`Profile '${edited.name}' updated.`);
    }

    async rebindCurrentWorkspace(): Promise<void> {
        const workspacePath = this.getCurrentWorkspacePath();
        if (!workspacePath) {
            void vscode.window.showWarningMessage('Open a workspace folder first.');
            return;
        }
        const profiles = [...this.profiles.values()];
        if (profiles.length === 0) {
            void vscode.window.showWarningMessage('No profiles available. Create one first.');
            return;
        }

        const picked = await vscode.window.showQuickPick(
            profiles.map(profile => ({
                label: profile.name,
                description: profile.basePath,
                profile
            })),
            { placeHolder: 'Select profile to bind to this workspace' }
        );
        if (!picked) {
            return;
        }

        this.workspaceBindings.set(workspacePath, picked.profile.id);
        this.persistBindings();
        this.activeProfile = picked.profile;
        this.changeEmitter.fire();
        void vscode.window.showInformationMessage(`Workspace bound to profile '${picked.profile.name}'.`);
    }

    validateActiveProfile(): ProfileValidationResult {
        if (!this.activeProfile) {
            return {
                valid: false,
                errors: ['No active profile for this workspace.']
            };
        }
        return validateProfileStructure(this.activeProfile);
    }

    getStorageFolderUri(): vscode.Uri {
        return this.context.globalStorageUri;
    }

    getProfilesFileUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.context.globalStorageUri, PROFILES_FILE);
    }

    getBindingsFileUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.context.globalStorageUri, BINDINGS_FILE);
    }

    private async resolveActiveProfile(): Promise<void> {
        const workspacePath = this.getCurrentWorkspacePath();
        if (!workspacePath) {
            this.activeProfile = undefined;
            return;
        }

        const boundProfileId = this.workspaceBindings.get(workspacePath);
        if (boundProfileId) {
            const boundProfile = this.profiles.get(boundProfileId);
            if (boundProfile) {
                this.activeProfile = boundProfile;
                return;
            }
        }

        this.activeProfile = undefined;
        await this.promptToCreateProfileForWorkspace(workspacePath);
    }

    private async promptToCreateProfileForWorkspace(workspacePath: string): Promise<void> {
        const choice = await vscode.window.showWarningMessage(
            'No program profile is configured for this workspace. Create one now?',
            'Create Custom Profile',
            'Skip'
        );
        if (choice !== 'Create Custom Profile') {
            return;
        }

        const created = await this.runProfileWizard(undefined, workspacePath);
        if (!created) {
            return;
        }
        this.profiles.set(created.id, created);
        this.workspaceBindings.set(workspacePath, created.id);
        this.persist();
        this.activeProfile = created;
    }

    private async runProfileWizard(
        seed: ProgramProfile | undefined,
        workspacePath: string
    ): Promise<ProgramProfile | undefined> {
        const name = await vscode.window.showInputBox({
            value: seed?.name ?? path.basename(workspacePath),
            prompt: 'Profile name',
            ignoreFocusOut: true,
            validateInput: value => (value.trim() ? undefined : 'Profile name is required')
        });
        if (name === undefined) {
            return undefined;
        }

        const basePath = await vscode.window.showInputBox({
            value: seed?.basePath ?? workspacePath,
            prompt: 'Base path for this program',
            ignoreFocusOut: true,
            validateInput: value => (value.trim() ? undefined : 'Base path is required')
        });
        if (basePath === undefined) {
            return undefined;
        }

        const strategyPick = await vscode.window.showQuickPick(
            [
                { label: 'Auto detect virtual environment', strategy: 'autoVenv' as const },
                { label: 'Use fixed python path', strategy: 'fixedPath' as const }
            ],
            { placeHolder: 'Python interpreter strategy' }
        );
        if (!strategyPick) {
            return undefined;
        }

        let pythonPath = seed?.pythonPath;
        if (strategyPick.strategy === 'fixedPath') {
            const enteredPython = await vscode.window.showInputBox({
                value: pythonPath ?? DEFAULTS.pythonCommand,
                prompt: 'Fixed python executable path/command',
                ignoreFocusOut: true,
                validateInput: value => (value.trim() ? undefined : 'Python path is required for fixed strategy')
            });
            if (enteredPython === undefined) {
                return undefined;
            }
            pythonPath = enteredPython.trim();
        } else {
            pythonPath = undefined;
        }

        const scenariosRoot = await vscode.window.showInputBox({
            value: seed?.scenariosRoot ?? FOLDER_NAMES.scenariosRoot,
            prompt: 'Scenarios root folder name/path (relative to base path)',
            ignoreFocusOut: true,
            validateInput: value => (value.trim() ? undefined : 'Scenarios root is required')
        });
        if (scenariosRoot === undefined) {
            return undefined;
        }

        const configsFolder = await vscode.window.showInputBox({
            value: seed?.scenarioConfigsFolderName ?? DEFAULTS.scenarioConfigsFolderName,
            prompt: 'Scenario config folder name',
            ignoreFocusOut: true,
            validateInput: value => (sanitizeFolderName(value).length > 0 ? undefined : 'Folder name is required')
        });
        if (configsFolder === undefined) {
            return undefined;
        }

        const ioFolder = await vscode.window.showInputBox({
            value: seed?.scenarioIoFolderName ?? DEFAULTS.scenarioIoFolderName,
            prompt: 'Scenario output folder name',
            ignoreFocusOut: true,
            validateInput: value => (sanitizeFolderName(value).length > 0 ? undefined : 'Folder name is required')
        });
        if (ioFolder === undefined) {
            return undefined;
        }

        const runTemplate = await vscode.window.showInputBox({
            value: seed?.runCommandTemplate ?? DEFAULTS.runCommandTemplate,
            prompt: 'Run command template (must include <scenario_name>)',
            ignoreFocusOut: true,
            validateInput: value => (value.includes('<scenario_name>') ? undefined : "Must include '<scenario_name>'")
        });
        if (runTemplate === undefined) {
            return undefined;
        }

        const outputFilenameParsers = await this.configureFilenameParsers(seed?.outputFilenameParsers ?? []);
        if (!outputFilenameParsers) {
            return undefined;
        }

        const now = Date.now();
        const profile: ProgramProfile = {
            id: seed?.id ?? createProfileId(),
            name: name.trim(),
            basePath: basePath.trim(),
            pythonStrategy: strategyPick.strategy,
            pythonPath,
            scenariosRoot: normalizeRelativeSegment(scenariosRoot),
            scenarioConfigsFolderName: sanitizeFolderName(configsFolder),
            scenarioIoFolderName: sanitizeFolderName(ioFolder),
            runCommandTemplate: runTemplate.trim(),
            outputFilenameParsers,
            createdAtMs: seed?.createdAtMs ?? now,
            updatedAtMs: now
        };

        const validation = validateProfileStructure(profile);
        if (!validation.valid) {
            const proceed = await vscode.window.showWarningMessage(
                `Profile saved with structure warnings:\n${validation.errors.join('\n')}`,
                'Save Anyway',
                'Cancel'
            );
            if (proceed !== 'Save Anyway') {
                return undefined;
            }
        }

        return profile;
    }

    private getCurrentWorkspacePath(): string | undefined {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder || folder.uri.scheme !== 'file') {
            return undefined;
        }
        return folder.uri.fsPath;
    }

    private async ensureStorage(): Promise<void> {
        await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    }

    private load(): void {
        this.profiles.clear();
        this.workspaceBindings.clear();

        const profilesPath = this.getProfilesPath();
        if (fs.existsSync(profilesPath)) {
            const parsed = this.readJsonFile(profilesPath);
            const profiles = isJsonRecord(parsed) && Array.isArray(parsed.profiles) ? parsed.profiles : [];
            for (const entry of profiles) {
                const normalized = this.normalizeProfileFromUnknown(entry);
                if (!normalized) {
                    continue;
                }
                this.profiles.set(normalized.id, normalized);
            }
        }

        const bindingsPath = this.getBindingsPath();
        if (fs.existsSync(bindingsPath)) {
            const parsed = this.readJsonFile(bindingsPath);
            const bindings = isJsonRecord(parsed) ? asStringRecord(parsed.bindings) : {};
            for (const [workspacePath, profileId] of Object.entries(bindings)) {
                if (workspacePath) {
                    this.workspaceBindings.set(workspacePath, profileId);
                }
            }
        }
    }

    private persist(): void {
        this.persistProfiles();
        this.persistBindings();
    }

    private persistProfiles(): void {
        const payload: ProfilesFileShape = {
            version: 1,
            profiles: [...this.profiles.values()]
        };
        try {
            fs.writeFileSync(this.getProfilesPath(), JSON.stringify(payload, null, 2), 'utf8');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Could not persist profiles file: ${message}`);
        }
    }

    private persistBindings(): void {
        const payload: BindingsFileShape = {
            version: 1,
            bindings: Object.fromEntries(this.workspaceBindings.entries())
        };
        try {
            fs.writeFileSync(this.getBindingsPath(), JSON.stringify(payload, null, 2), 'utf8');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Could not persist workspace bindings file: ${message}`);
        }
    }

    private getProfilesPath(): string {
        return path.join(this.context.globalStorageUri.fsPath, PROFILES_FILE);
    }

    private getBindingsPath(): string {
        return path.join(this.context.globalStorageUri.fsPath, BINDINGS_FILE);
    }

    private normalizeProfile(profile: ProgramProfile): ProgramProfile {
        return {
            ...profile,
            outputFilenameParsers: (profile.outputFilenameParsers ?? []).map(parser => ({
                ...parser,
                appliesToKind: parser.appliesToKind ?? 'files'
            }))
        };
    }

    private normalizeProfileFromUnknown(value: unknown): ProgramProfile | undefined {
        if (!isJsonRecord(value)) {
            return undefined;
        }

        const id = typeof value.id === 'string' ? value.id.trim() : '';
        const basePath = typeof value.basePath === 'string' ? value.basePath.trim() : '';
        if (!id || !basePath) {
            return undefined;
        }

        const now = Date.now();
        const profile: ProgramProfile = {
            id,
            name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id,
            basePath,
            pythonStrategy: value.pythonStrategy === 'fixedPath' ? 'fixedPath' : 'autoVenv',
            pythonPath: typeof value.pythonPath === 'string' && value.pythonPath.trim() ? value.pythonPath.trim() : undefined,
            scenariosRoot: normalizeRelativeSegment(
                typeof value.scenariosRoot === 'string' ? value.scenariosRoot : FOLDER_NAMES.scenariosRoot
            ),
            scenarioConfigsFolderName: sanitizeFolderName(
                typeof value.scenarioConfigsFolderName === 'string'
                    ? value.scenarioConfigsFolderName
                    : DEFAULTS.scenarioConfigsFolderName
            ),
            scenarioIoFolderName: sanitizeFolderName(
                typeof value.scenarioIoFolderName === 'string'
                    ? value.scenarioIoFolderName
                    : DEFAULTS.scenarioIoFolderName
            ),
            runCommandTemplate:
                typeof value.runCommandTemplate === 'string' && value.runCommandTemplate.trim()
                    ? value.runCommandTemplate.trim()
                    : DEFAULTS.runCommandTemplate,
            outputFilenameParsers: this.normalizeOutputFilenameParsers(value.outputFilenameParsers),
            createdAtMs: typeof value.createdAtMs === 'number' ? value.createdAtMs : now,
            updatedAtMs: typeof value.updatedAtMs === 'number' ? value.updatedAtMs : now
        };

        return this.normalizeProfile(profile);
    }

    private normalizeOutputFilenameParsers(raw: unknown): OutputFilenameParser[] {
        if (!Array.isArray(raw)) {
            return [];
        }

        const parsers: OutputFilenameParser[] = [];
        for (const entry of raw) {
            if (!isJsonRecord(entry) || typeof entry.id !== 'string' || typeof entry.pattern !== 'string') {
                continue;
            }

            const fields: OutputFilenameParserField[] = [];
            if (Array.isArray(entry.fields)) {
                for (const rawField of entry.fields) {
                    if (!isJsonRecord(rawField) || typeof rawField.name !== 'string') {
                        continue;
                    }
                    if (
                        rawField.type !== 'string' &&
                        rawField.type !== 'number' &&
                        rawField.type !== 'enum' &&
                        rawField.type !== 'datetime'
                    ) {
                        continue;
                    }

                    fields.push({
                        name: rawField.name,
                        type: rawField.type,
                        enumValues: asStringArray(rawField.enumValues)
                    });
                }
            }

            parsers.push({
                id: entry.id.trim(),
                pattern: entry.pattern.trim(),
                fields,
                appliesTo: asStringArray(entry.appliesTo),
                appliesToKind: entry.appliesToKind === 'folders' || entry.appliesToKind === 'both' ? entry.appliesToKind : 'files',
                titleTemplate: typeof entry.titleTemplate === 'string' && entry.titleTemplate.trim()
                    ? entry.titleTemplate.trim()
                    : undefined
            });
        }

        return parsers;
    }

    private readJsonFile(filePath: string): unknown {
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(raw);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showWarningMessage(`Could not read '${path.basename(filePath)}': ${message}`);
            return undefined;
        }
    }

    private async configureFilenameParsers(
        seed: OutputFilenameParser[]
    ): Promise<OutputFilenameParser[] | undefined> {
        const mode = await vscode.window.showQuickPick(
            [
                { label: `Keep existing (${seed.length})`, value: 'keep' as const },
                { label: `Add parsers to existing (${seed.length})`, value: 'append' as const },
                { label: 'Replace parser templates', value: 'replace' as const },
                { label: 'Clear parser templates', value: 'clear' as const }
            ],
            { placeHolder: 'Filename metadata parser templates' }
        );
        if (!mode) {
            return undefined;
        }
        if (mode.value === 'keep') {
            return seed;
        }
        if (mode.value === 'clear') {
            return [];
        }

        const parsers: OutputFilenameParser[] = mode.value === 'append' ? [...seed] : [];
        while (true) {
            const parser = await this.collectSingleFilenameParser(parsers.length + 1);
            if (!parser) {
                break;
            }
            parsers.push(parser);

            const shouldContinue = await vscode.window.showQuickPick(
                [
                    { label: 'Add another parser', value: 'yes' },
                    { label: 'Done', value: 'no' }
                ],
                { placeHolder: 'Add another filename parser template?' }
            );
            if (!shouldContinue || shouldContinue.value === 'no') {
                break;
            }
        }
        return parsers;
    }

    private async collectSingleFilenameParser(index: number): Promise<OutputFilenameParser | undefined> {
        const id = await vscode.window.showInputBox({
            value: `parser_${index}`,
            prompt: 'Parser id',
            ignoreFocusOut: true,
            validateInput: value => (value.trim() ? undefined : 'Parser id is required')
        });
        if (id === undefined) {
            return undefined;
        }

        const pattern = await vscode.window.showInputBox({
            prompt: 'Filename pattern (example: loss_{scenario}_{metric}_{epoch}.png or regex:^loss_(?<scenario>.+)\\.png$)',
            ignoreFocusOut: true,
            validateInput: value => (value.trim() ? undefined : 'Pattern is required')
        });
        if (pattern === undefined) {
            return undefined;
        }

        let capturedFieldNames = extractCapturedFieldNamesFromPattern(pattern.trim());
        if (capturedFieldNames.length === 0) {
            const fieldListInput = await vscode.window.showInputBox({
                prompt: 'Could not infer fields from pattern. Enter captured field names (comma-separated).',
                ignoreFocusOut: true,
                validateInput: value =>
                    value
                        .split(',')
                        .map(item => item.trim())
                        .filter(Boolean).length > 0
                        ? undefined
                        : 'At least one field name is required'
            });
            if (fieldListInput === undefined) {
                return undefined;
            }
            capturedFieldNames = fieldListInput
                .split(',')
                .map(item => item.trim())
                .filter(Boolean);
        }

        const fields: OutputFilenameParserField[] = [];
        for (const fieldName of capturedFieldNames) {
            const fieldType = await vscode.window.showQuickPick(
                [
                    { label: 'string', value: 'string' as const },
                    { label: 'number', value: 'number' as const },
                    { label: 'enum', value: 'enum' as const },
                    { label: 'datetime', value: 'datetime' as const }
                ],
                { placeHolder: `Type for '${fieldName}'` }
            );
            if (!fieldType) {
                return undefined;
            }

            let enumValues: string[] | undefined;
            if (fieldType.value === 'enum') {
                const enumInput = await vscode.window.showInputBox({
                    prompt: `Enum values for '${fieldName}' (comma-separated)`,
                    ignoreFocusOut: true,
                    validateInput: value => (value.trim() ? undefined : 'At least one enum value is required')
                });
                if (enumInput === undefined) {
                    return undefined;
                }
                enumValues = enumInput
                    .split(',')
                    .map(value => value.trim())
                    .filter(Boolean);
            }

            fields.push({
                name: fieldName,
                type: fieldType.value,
                enumValues
            });
        }

        const appliesToInput = await vscode.window.showInputBox({
            prompt: 'Optional applies-to rules (comma-separated, e.g. .png, */io/*). Leave empty for all files.',
            ignoreFocusOut: true
        });
        if (appliesToInput === undefined) {
            return undefined;
        }

        const appliesToKindPick = await vscode.window.showQuickPick(
            [
                { label: 'Files', value: 'files' as const },
                { label: 'Folders', value: 'folders' as const },
                { label: 'Files and Folders', value: 'both' as const }
            ],
            { placeHolder: 'Apply this parser to files, folders, or both?' }
        );
        if (!appliesToKindPick) {
            return undefined;
        }

        const titleTemplateInput = await vscode.window.showInputBox({
            prompt: 'Optional title template for analyzer (e.g. metric={metric}, id={id}). Use {fieldName} placeholders.',
            ignoreFocusOut: true
        });
        if (titleTemplateInput === undefined) {
            return undefined;
        }

        return {
            id: id.trim(),
            pattern: pattern.trim(),
            fields,
            appliesTo: appliesToInput
                .split(',')
                .map(value => value.trim())
                .filter(Boolean),
            appliesToKind: appliesToKindPick.value,
            titleTemplate: titleTemplateInput.trim() || undefined
        };
    }
}

let managerInstance: ProfileManager | undefined;

export function initializeProfileManager(context: vscode.ExtensionContext): ProfileManager {
    managerInstance = new ProfileManager(context);
    return managerInstance;
}

export function getProfileManager(): ProfileManager | undefined {
    return managerInstance;
}

export function validateProfileStructure(profile: ProgramProfile): ProfileValidationResult {
    const errors: string[] = [];

    if (!existsDir(profile.basePath)) {
        errors.push(`Base path does not exist: ${profile.basePath}`);
    }

    const scenariosPath = path.join(profile.basePath, profile.scenariosRoot);
    if (!existsDir(scenariosPath)) {
        errors.push(`Scenarios root not found: ${scenariosPath}`);
        return { valid: errors.length === 0, errors };
    }

    const scenarioDirectories = fs
        .readdirSync(scenariosPath)
        .map(name => path.join(scenariosPath, name))
        .filter(fullPath => existsDir(fullPath));

    if (scenarioDirectories.length === 0) {
        return { valid: errors.length === 0, errors };
    }

    const hasAnyExpectedStructure = scenarioDirectories.some(scenarioPath => {
        const configsPath = path.join(scenarioPath, profile.scenarioConfigsFolderName);
        const ioPath = path.join(scenarioPath, profile.scenarioIoFolderName);
        return existsDir(configsPath) && existsDir(ioPath);
    });

    if (!hasAnyExpectedStructure) {
        errors.push(
            `No scenario under '${scenariosPath}' contains both '${profile.scenarioConfigsFolderName}' and '${profile.scenarioIoFolderName}'.`
        );
    }

    const parserIds = profile.outputFilenameParsers.map(parser => parser.id.trim()).filter(Boolean);
    const duplicateParserIds = findDuplicates(parserIds);
    if (duplicateParserIds.length > 0) {
        errors.push(`Duplicate filename parser ids: ${duplicateParserIds.join(', ')}.`);
    }

    for (const parser of profile.outputFilenameParsers) {
        errors.push(...validateFilenameParser(parser));
    }

    return { valid: errors.length === 0, errors };
}

function createProfileId(): string {
    return `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeFolderName(value: string): string {
    return value.trim().replace(/[\\/]+/g, '');
}

function normalizeRelativeSegment(value: string): string {
    return value.trim().replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
}

function findDuplicates(values: string[]): string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) {
            duplicates.add(value);
        } else {
            seen.add(value);
        }
    }
    return [...duplicates];
}

function extractCapturedFieldNamesFromPattern(pattern: string): string[] {
    const names: string[] = [];

    if (pattern.startsWith('regex:')) {
        const raw = pattern.slice('regex:'.length);
        for (const match of raw.matchAll(/\(\?<([a-zA-Z_][a-zA-Z0-9_]*)>/g)) {
            names.push(match[1]);
        }
        return [...new Set(names)];
    }

    for (const match of pattern.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)) {
        names.push(match[1]);
    }
    return [...new Set(names)];
}
