import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULTS, FOLDER_NAMES } from '../constants';
import { validateFilenameParser } from '../providers/scenario/filenameMetadata';
import { findPythonInBasePath } from '../providers/scenario/runtimeUtils';
import { existsDir } from '../utils/fileSystem';
import { asStringArray, asStringRecord, isJsonRecord } from '../utils/json';
import { OutputFilenameParser, OutputFilenameParserField } from './profileTypes';

const PROFILES_FILE = 'programProfiles.json';
const BINDINGS_FILE = 'workspaceBindings.json';
const LEGACY_PROFILES_FILES = ['profiles.json'];
const LEGACY_BINDINGS_FILES = ['bindings.json'];

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

interface ProfileStudioParserDraft {
    id: string;
    pattern: string;
    appliesTo: string;
    appliesToKind: 'files' | 'folders' | 'both';
    titleTemplate: string;
    fieldsJson: string;
}

interface ProfileStudioDraft {
    name: string;
    basePath: string;
    pythonStrategy: PythonStrategy;
    pythonPath: string;
    scenariosRoot: string;
    scenarioConfigsFolderName: string;
    scenarioIoFolderName: string;
    runCommandTemplate: string;
    outputFilenameParsers: ProfileStudioParserDraft[];
}

export class ProfileManager implements vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeActiveProfile = this.changeEmitter.event;
    private readonly profiles = new Map<string, ProgramProfile>();
    private readonly workspaceBindings = new Map<string, string>();
    private activeProfile?: ProgramProfile;
    private initialized = false;
    private isPromptingForMissingProfile = false;

    constructor(private readonly context: vscode.ExtensionContext) {}

    async initialize(): Promise<void> {
        await this.ensureStorage();
        this.load();
        this.synchronizeStorageFilesAfterLoad();
        await this.resolveActiveProfile(false);
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
        await this.resolveActiveProfile(false);
        this.changeEmitter.fire();
    }

    async promptToCreateProfileIfMissing(): Promise<void> {
        if (this.isPromptingForMissingProfile) {
            return;
        }
        this.isPromptingForMissingProfile = true;
        try {
            const previousProfileId = this.activeProfile?.id;
            await this.resolveActiveProfile(true);
            if (this.activeProfile?.id !== previousProfileId) {
                this.changeEmitter.fire();
            }
        } finally {
            this.isPromptingForMissingProfile = false;
        }
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

    private async resolveActiveProfile(promptIfMissing: boolean): Promise<void> {
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
        if (promptIfMissing) {
            await this.promptToCreateProfileForWorkspace(workspacePath);
        }
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
        return this.openProfileStudio(seed, workspacePath);
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
        this.migrateLegacyStorageIfNeeded();
        this.ensureStorageFilesExist();
    }

    private migrateLegacyStorageIfNeeded(): void {
        const profilesPath = this.getProfilesPath();
        const bindingsPath = this.getBindingsPath();

        if (fs.existsSync(profilesPath)) {
            return;
        }

        // 1) Migrate from legacy filenames inside current storage folder.
        const localLegacyProfiles = this.findFirstExistingFile(
            this.context.globalStorageUri.fsPath,
            LEGACY_PROFILES_FILES
        );
        if (localLegacyProfiles) {
            this.safeCopyFile(localLegacyProfiles, profilesPath);
            const localLegacyBindings = this.findFirstExistingFile(
                this.context.globalStorageUri.fsPath,
                LEGACY_BINDINGS_FILES
            );
            if (localLegacyBindings && !fs.existsSync(bindingsPath)) {
                this.safeCopyFile(localLegacyBindings, bindingsPath);
            }
            return;
        }

        // 2) Conservative sibling scan (older extension id storage folder).
        const parentDir = path.dirname(this.context.globalStorageUri.fsPath);
        if (!existsDir(parentDir)) {
            return;
        }

        const siblingDirs = fs
            .readdirSync(parentDir)
            .map(name => path.join(parentDir, name))
            .filter(full => full !== this.context.globalStorageUri.fsPath && existsDir(full));

        const candidates = siblingDirs
            .map(dir => ({
                dir,
                profiles:
                    this.findFirstExistingFile(dir, [PROFILES_FILE]) ??
                    this.findFirstExistingFile(dir, LEGACY_PROFILES_FILES),
                bindings:
                    this.findFirstExistingFile(dir, [BINDINGS_FILE]) ??
                    this.findFirstExistingFile(dir, LEGACY_BINDINGS_FILES)
            }))
            .filter(entry => Boolean(entry.profiles));

        if (candidates.length !== 1) {
            return;
        }

        const [candidate] = candidates;
        if (candidate.profiles) {
            this.safeCopyFile(candidate.profiles, profilesPath);
            if (candidate.bindings && !fs.existsSync(bindingsPath)) {
                this.safeCopyFile(candidate.bindings, bindingsPath);
            }
            void vscode.window.showInformationMessage(
                `Imported program profiles from legacy storage folder: ${path.basename(candidate.dir)}`
            );
        }
    }

    private ensureStorageFilesExist(): void {
        const profilesPayload: ProfilesFileShape = { version: 1, profiles: [] };
        const bindingsPayload: BindingsFileShape = { version: 1, bindings: {} };

        const profileFiles = [
            this.getProfilesPath(),
            ...LEGACY_PROFILES_FILES.map(name => path.join(this.context.globalStorageUri.fsPath, name))
        ];
        for (const filePath of profileFiles) {
            if (!fs.existsSync(filePath)) {
                this.writeJsonFileWithError(filePath, profilesPayload, path.basename(filePath));
            }
        }

        const bindingFiles = [
            this.getBindingsPath(),
            ...LEGACY_BINDINGS_FILES.map(name => path.join(this.context.globalStorageUri.fsPath, name))
        ];
        for (const filePath of bindingFiles) {
            if (!fs.existsSync(filePath)) {
                this.writeJsonFileWithError(filePath, bindingsPayload, path.basename(filePath));
            }
        }
    }

    private findFirstExistingFile(dir: string, names: string[]): string | undefined {
        for (const name of names) {
            const full = path.join(dir, name);
            if (fs.existsSync(full)) {
                return full;
            }
        }
        return undefined;
    }

    private safeCopyFile(source: string, destination: string): void {
        try {
            fs.copyFileSync(source, destination);
        } catch {}
    }

    private writeJsonFileWithError(filePath: string, payload: unknown, label: string): void {
        try {
            fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Could not persist ${label}: ${message}`);
        }
    }

    private load(): void {
        this.profiles.clear();
        this.workspaceBindings.clear();

        const profilePaths = [
            this.getProfilesPath(),
            ...LEGACY_PROFILES_FILES.map(name => path.join(this.context.globalStorageUri.fsPath, name))
        ];
        for (const profilesPath of profilePaths) {
            if (!fs.existsSync(profilesPath)) {
                continue;
            }
            const parsed = this.readJsonFile(profilesPath);
            const profiles = isJsonRecord(parsed) && Array.isArray(parsed.profiles) ? parsed.profiles : [];
            for (const entry of profiles) {
                const normalized = this.normalizeProfileFromUnknown(entry);
                if (!normalized || this.profiles.has(normalized.id)) {
                    continue;
                }
                this.profiles.set(normalized.id, normalized);
            }
        }

        const bindingsPaths = [
            this.getBindingsPath(),
            ...LEGACY_BINDINGS_FILES.map(name => path.join(this.context.globalStorageUri.fsPath, name))
        ];
        for (const bindingsPath of bindingsPaths) {
            if (!fs.existsSync(bindingsPath)) {
                continue;
            }
            const parsed = this.readJsonFile(bindingsPath);
            const bindings = isJsonRecord(parsed) ? asStringRecord(parsed.bindings) : {};
            for (const [workspacePath, profileId] of Object.entries(bindings)) {
                if (!workspacePath || this.workspaceBindings.has(workspacePath)) {
                    continue;
                }
                this.workspaceBindings.set(workspacePath, profileId);
            }
        }
    }

    private persist(): void {
        this.persistProfiles();
        this.persistBindings();
    }

    private synchronizeStorageFilesAfterLoad(): void {
        if (this.profiles.size === 0 && this.workspaceBindings.size === 0) {
            return;
        }
        this.persist();
    }

    private persistProfiles(): void {
        const payload: ProfilesFileShape = {
            version: 1,
            profiles: [...this.profiles.values()]
        };
        this.writeJsonFileWithError(this.getProfilesPath(), payload, 'profiles file');
        for (const legacyName of LEGACY_PROFILES_FILES) {
            this.writeJsonFileWithError(
                path.join(this.context.globalStorageUri.fsPath, legacyName),
                payload,
                `legacy profiles file (${legacyName})`
            );
        }
    }

    private persistBindings(): void {
        const payload: BindingsFileShape = {
            version: 1,
            bindings: Object.fromEntries(this.workspaceBindings.entries())
        };
        this.writeJsonFileWithError(this.getBindingsPath(), payload, 'workspace bindings file');
        for (const legacyName of LEGACY_BINDINGS_FILES) {
            this.writeJsonFileWithError(
                path.join(this.context.globalStorageUri.fsPath, legacyName),
                payload,
                `legacy bindings file (${legacyName})`
            );
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

    private async openProfileStudio(
        seed: ProgramProfile | undefined,
        workspacePath: string
    ): Promise<ProgramProfile | undefined> {
        const panel = vscode.window.createWebviewPanel(
            'scenarioToolkitProfileStudio',
            seed ? `Edit Profile: ${seed.name}` : 'Create Profile',
            vscode.ViewColumn.Active,
            { enableScripts: true }
        );

        const initialDraft: ProfileStudioDraft = {
            name: seed?.name ?? path.basename(workspacePath),
            basePath: seed?.basePath ?? workspacePath,
            pythonStrategy: seed?.pythonStrategy ?? 'autoVenv',
            pythonPath: seed?.pythonPath ?? DEFAULTS.pythonCommand,
            scenariosRoot: seed?.scenariosRoot ?? FOLDER_NAMES.scenariosRoot,
            scenarioConfigsFolderName: seed?.scenarioConfigsFolderName ?? DEFAULTS.scenarioConfigsFolderName,
            scenarioIoFolderName: seed?.scenarioIoFolderName ?? DEFAULTS.scenarioIoFolderName,
            runCommandTemplate: seed?.runCommandTemplate ?? DEFAULTS.runCommandTemplate,
            outputFilenameParsers: (seed?.outputFilenameParsers ?? []).map(parser => ({
                id: parser.id,
                pattern: parser.pattern,
                appliesTo: (parser.appliesTo ?? []).join(', '),
                appliesToKind: parser.appliesToKind ?? 'files',
                titleTemplate: parser.titleTemplate ?? '',
                fieldsJson: JSON.stringify(parser.fields ?? [], null, 2)
            }))
        };

        panel.webview.html = buildProfileStudioHtml(initialDraft, seed ? 'edit' : 'create');

        return new Promise<ProgramProfile | undefined>(resolve => {
            let settled = false;
            const finish = (value: ProgramProfile | undefined) => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve(value);
            };

            const disposeOnFinish = panel.onDidDispose(() => finish(undefined));
            const messageHandler = panel.webview.onDidReceiveMessage(async (message: unknown) => {
                if (!isJsonRecord(message) || typeof message.type !== 'string') {
                    return;
                }

                if (message.type === 'detectPythonFromBasePath') {
                    const basePathRaw = message.basePath;
                    const basePath = typeof basePathRaw === 'string' ? basePathRaw.trim() : '';
                    const detectedPython = basePath ? (findPythonInBasePath(basePath) ?? DEFAULTS.pythonCommand) : DEFAULTS.pythonCommand;
                    void panel.webview.postMessage({
                        type: 'detectedPythonPath',
                        pythonPath: detectedPython
                    });
                    return;
                }

                if (message.type === 'cancel') {
                    finish(undefined);
                    panel.dispose();
                    return;
                }

                if (message.type !== 'save' || !isJsonRecord(message.payload)) {
                    return;
                }

                const built = this.buildProfileFromStudioDraft(message.payload, seed);
                if (!built.valid) {
                    void panel.webview.postMessage({ type: 'validation', errors: built.errors });
                    return;
                }

                const validation = validateProfileStructure(built.profile);
                if (!validation.valid) {
                    const proceed = await vscode.window.showWarningMessage(
                        `Profile saved with structure warnings:\n${validation.errors.join('\n')}`,
                        'Save Anyway',
                        'Cancel'
                    );
                    if (proceed !== 'Save Anyway') {
                        void panel.webview.postMessage({ type: 'validation', errors: validation.errors });
                        return;
                    }
                }

                finish(built.profile);
                panel.dispose();
            });

            panel.onDidDispose(() => {
                disposeOnFinish.dispose();
                messageHandler.dispose();
            });
        });
    }

    private buildProfileFromStudioDraft(
        payload: Record<string, unknown>,
        seed: ProgramProfile | undefined
    ): { valid: true; profile: ProgramProfile } | { valid: false; errors: string[] } {
        const errors: string[] = [];
        const text = (key: string): string => {
            const value = payload[key];
            return typeof value === 'string' ? value.trim() : '';
        };

        const name = text('name');
        const basePath = text('basePath');
        const scenariosRoot = text('scenariosRoot');
        const configsFolder = sanitizeFolderName(text('scenarioConfigsFolderName'));
        const ioFolder = sanitizeFolderName(text('scenarioIoFolderName'));
        const runTemplate = text('runCommandTemplate');
        const strategy = payload.pythonStrategy === 'fixedPath' ? 'fixedPath' : 'autoVenv';
        const pythonPath = strategy === 'fixedPath' ? text('pythonPath') : undefined;

        if (!name) {
            errors.push('Profile name is required.');
        }
        if (!basePath) {
            errors.push('Base path is required.');
        }
        if (!scenariosRoot) {
            errors.push('Scenarios root is required.');
        }
        if (!configsFolder) {
            errors.push('Scenario config folder name is required.');
        }
        if (!ioFolder) {
            errors.push('Scenario output folder name is required.');
        }
        if (!runTemplate.includes('<scenario_name>')) {
            errors.push("Run command template must include '<scenario_name>'.");
        }
        if (strategy === 'fixedPath' && !pythonPath) {
            errors.push('Python path is required for fixed strategy.');
        }

        const outputFilenameParsers: OutputFilenameParser[] = [];
        const parserRows = Array.isArray(payload.outputFilenameParsers) ? payload.outputFilenameParsers : [];
        for (let index = 0; index < parserRows.length; index += 1) {
            const row = parserRows[index];
            if (!isJsonRecord(row)) {
                errors.push(`Parser #${index + 1}: invalid parser row.`);
                continue;
            }
            const id = typeof row.id === 'string' ? row.id.trim() : '';
            const pattern = typeof row.pattern === 'string' ? row.pattern.trim() : '';
            const appliesTo = typeof row.appliesTo === 'string' ? row.appliesTo : '';
            const appliesToKind = row.appliesToKind === 'folders' || row.appliesToKind === 'both' ? row.appliesToKind : 'files';
            const titleTemplate = typeof row.titleTemplate === 'string' ? row.titleTemplate.trim() : '';
            const fieldsJson = typeof row.fieldsJson === 'string' ? row.fieldsJson.trim() : '[]';

            if (!id) {
                errors.push(`Parser #${index + 1}: id is required.`);
                continue;
            }
            if (!pattern) {
                errors.push(`Parser #${index + 1}: pattern is required.`);
                continue;
            }

            let parsedFields: unknown;
            try {
                parsedFields = JSON.parse(fieldsJson || '[]');
            } catch {
                errors.push(`Parser '${id}': fields JSON is invalid.`);
                continue;
            }
            const fields = this.normalizeOutputFilenameParsers([
                { id, pattern, fields: parsedFields, appliesTo: [], appliesToKind, titleTemplate }
            ])[0]?.fields ?? [];

            if (Array.isArray(parsedFields) && fields.length !== parsedFields.length) {
                errors.push(`Parser '${id}': one or more fields are invalid.`);
                continue;
            }

            outputFilenameParsers.push({
                id,
                pattern,
                fields,
                appliesTo: appliesTo
                    .split(',')
                    .map(value => value.trim())
                    .filter(Boolean),
                appliesToKind,
                titleTemplate: titleTemplate || undefined
            });
        }

        if (errors.length > 0) {
            return { valid: false, errors };
        }

        const now = Date.now();
        return {
            valid: true,
            profile: {
                id: seed?.id ?? createProfileId(),
                name,
                basePath,
                pythonStrategy: strategy,
                pythonPath,
                scenariosRoot: normalizeRelativeSegment(scenariosRoot),
                scenarioConfigsFolderName: configsFolder,
                scenarioIoFolderName: ioFolder,
                runCommandTemplate: runTemplate,
                outputFilenameParsers,
                createdAtMs: seed?.createdAtMs ?? now,
                updatedAtMs: now
            }
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

function buildProfileStudioHtml(initialDraft: ProfileStudioDraft, mode: 'create' | 'edit'): string {
    const initial = JSON.stringify(initialDraft).replace(/</g, '\\u003c');
    const title = mode === 'edit' ? 'Edit Profile' : 'Create Profile';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
    .toolbar { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; gap: 8px; padding: 10px 0; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-editorWidget-border); }
    .toolbar .actions { display: flex; gap: 8px; }
    button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 6px; min-height: 30px; padding: 0 10px; cursor: pointer; }
    button.secondary { background: transparent; color: var(--vscode-foreground); border-color: var(--vscode-editorWidget-border); }
    .section { border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; margin-top: 12px; padding: 12px; }
    .section h2 { margin: 0 0 10px 0; font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
    input, select, textarea { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border)); border-radius: 6px; padding: 6px 8px; font: inherit; }
    textarea { min-height: 90px; }
    .radio { display: flex; gap: 12px; align-items: center; padding-top: 4px; }
    .parser-card { border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
    .parser-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .errors { display: none; border: 1px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); border-radius: 8px; padding: 10px; margin-top: 12px; white-space: pre-wrap; }
    .summary { background: var(--vscode-sideBar-background); border-radius: 8px; padding: 10px; font-size: 12px; white-space: pre-wrap; }
    pre { margin: 0; font-size: 11px; overflow: auto; }
  </style>
</head>
<body>
  <div class="toolbar">
    <strong>Profile Studio: ${escapeHtml(title)}</strong>
    <div class="actions">
      <button class="secondary" id="cancelBtn">Cancel</button>
      <button id="saveBtn">Save</button>
    </div>
  </div>

  <div id="errors" class="errors"></div>

  <section class="section">
    <h2>1. Basics</h2>
    <div class="grid">
      <label>Profile name<input id="name" /></label>
      <label>Base path<input id="basePath" /></label>
    </div>
  </section>

  <section class="section">
    <h2>2. Python</h2>
    <div class="radio">
      <label><input type="radio" name="pythonStrategy" value="autoVenv" /> Auto venv</label>
      <label><input type="radio" name="pythonStrategy" value="fixedPath" /> Fixed path</label>
    </div>
    <div class="grid" style="margin-top:8px;">
      <label>Python path<input id="pythonPath" /></label>
    </div>
  </section>

  <section class="section">
    <h2>3. Structure</h2>
    <div class="grid">
      <label>Scenarios root<input id="scenariosRoot" /></label>
      <label>Config folder<input id="scenarioConfigsFolderName" /></label>
      <label>Output folder<input id="scenarioIoFolderName" /></label>
    </div>
  </section>

  <section class="section">
    <h2>4. Run Template</h2>
    <label>Run command template<input id="runCommandTemplate" /></label>
  </section>

  <section class="section">
    <h2>5. Filename Parsers</h2>
    <div style="margin-bottom:8px;">
      <button id="addParserBtn" class="secondary">Add parser</button>
    </div>
    <div id="parsersContainer"></div>
  </section>

  <section class="section">
    <h2>6. Review</h2>
    <div class="summary" id="summaryText"></div>
    <div style="margin-top:8px;">
      <pre id="jsonPreview"></pre>
    </div>
  </section>

  <script>
    const vscode = acquireVsCodeApi();
    const initial = ${initial};
    const parsersContainer = document.getElementById('parsersContainer');
    const errorsEl = document.getElementById('errors');
    const ids = ['name','basePath','pythonPath','scenariosRoot','scenarioConfigsFolderName','scenarioIoFolderName','runCommandTemplate'];

    const byId = (id) => document.getElementById(id);
    const readStrategy = () => document.querySelector('input[name="pythonStrategy"]:checked')?.value || 'autoVenv';
    let detectTimer;

    const parserTemplate = (parser = {}) => {
      const row = document.createElement('div');
      row.className = 'parser-card';
      row.innerHTML = \`
        <div class="parser-header">
          <strong>Parser</strong>
          <button type="button" class="secondary remove-parser">Remove</button>
        </div>
        <div class="grid">
          <label>ID<input data-key="id" value="\${parser.id || ''}" /></label>
          <label>Pattern<input data-key="pattern" value="\${parser.pattern || ''}" /></label>
          <label>Applies to kind
            <select data-key="appliesToKind">
              <option value="files">files</option>
              <option value="folders">folders</option>
              <option value="both">both</option>
            </select>
          </label>
          <label>Applies to (comma separated)<input data-key="appliesTo" value="\${parser.appliesTo || ''}" /></label>
          <label>Title template<input data-key="titleTemplate" value="\${parser.titleTemplate || ''}" /></label>
        </div>
        <label style="margin-top:8px;">Fields JSON<textarea data-key="fieldsJson">\${parser.fieldsJson || '[]'}</textarea></label>
      \`;
      row.querySelector('[data-key="appliesToKind"]').value = parser.appliesToKind || 'files';
      row.querySelector('.remove-parser').addEventListener('click', () => {
        row.remove();
        refreshReview();
      });
      row.querySelectorAll('input,select,textarea').forEach(el => el.addEventListener('input', refreshReview));
      return row;
    };

    const getDraft = () => {
      const draft = {};
      ids.forEach(id => draft[id] = byId(id).value || '');
      draft.pythonStrategy = readStrategy();
      draft.outputFilenameParsers = [...parsersContainer.querySelectorAll('.parser-card')].map(card => {
        const read = (key) => card.querySelector('[data-key="' + key + '"]')?.value || '';
        return {
          id: read('id'),
          pattern: read('pattern'),
          appliesToKind: read('appliesToKind'),
          appliesTo: read('appliesTo'),
          titleTemplate: read('titleTemplate'),
          fieldsJson: read('fieldsJson')
        };
      });
      return draft;
    };

    const updatePythonPathInputState = () => {
      const pythonInput = byId('pythonPath');
      const auto = readStrategy() === 'autoVenv';
      pythonInput.readOnly = auto;
      pythonInput.title = auto ? 'Auto-detected from base path when Auto venv is selected' : '';
    };

    const requestDetectedPythonPath = () => {
      if (readStrategy() !== 'autoVenv') {
        return;
      }
      const basePath = byId('basePath').value || '';
      vscode.postMessage({ type: 'detectPythonFromBasePath', basePath });
    };

    const scheduleDetectedPythonPath = () => {
      if (detectTimer) {
        clearTimeout(detectTimer);
      }
      detectTimer = setTimeout(requestDetectedPythonPath, 200);
    };

    const refreshReview = () => {
      const draft = getDraft();
      byId('summaryText').textContent =
        'Name: ' + (draft.name || '(empty)') + '\\n' +
        'Base: ' + (draft.basePath || '(empty)') + '\\n' +
        'Python strategy: ' + draft.pythonStrategy + '\\n' +
        'Scenarios root: ' + (draft.scenariosRoot || '(empty)') + '\\n' +
        'Folders: ' + (draft.scenarioConfigsFolderName || '(empty)') + ' / ' + (draft.scenarioIoFolderName || '(empty)') + '\\n' +
        'Parsers: ' + draft.outputFilenameParsers.length;
      byId('jsonPreview').textContent = JSON.stringify(draft, null, 2);
    };

    const applyInitial = () => {
      ids.forEach(id => { byId(id).value = initial[id] || ''; });
      const strategy = initial.pythonStrategy === 'fixedPath' ? 'fixedPath' : 'autoVenv';
      const radio = document.querySelector('input[name="pythonStrategy"][value="' + strategy + '"]');
      if (radio) {
        radio.checked = true;
      }
      (initial.outputFilenameParsers || []).forEach(parser => parsersContainer.appendChild(parserTemplate(parser)));
      updatePythonPathInputState();
      scheduleDetectedPythonPath();
      refreshReview();
    };

    ids.forEach(id => byId(id).addEventListener('input', refreshReview));
    byId('basePath').addEventListener('input', () => {
      scheduleDetectedPythonPath();
    });
    document.querySelectorAll('input[name="pythonStrategy"]').forEach(el => el.addEventListener('change', () => {
      updatePythonPathInputState();
      scheduleDetectedPythonPath();
      refreshReview();
    }));
    byId('addParserBtn').addEventListener('click', () => {
      parsersContainer.appendChild(parserTemplate());
      refreshReview();
    });
    byId('saveBtn').addEventListener('click', () => {
      errorsEl.style.display = 'none';
      vscode.postMessage({ type: 'save', payload: getDraft() });
    });
    byId('cancelBtn').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg?.type === 'validation' && Array.isArray(msg.errors) && msg.errors.length > 0) {
        errorsEl.style.display = 'block';
        errorsEl.textContent = msg.errors.join('\\n');
        return;
      }

      if (msg?.type === 'detectedPythonPath' && typeof msg.pythonPath === 'string') {
        if (readStrategy() === 'autoVenv') {
          byId('pythonPath').value = msg.pythonPath;
          refreshReview();
        }
      }
    });

    applyInitial();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => {
        switch (char) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            default:
                return '&#39;';
        }
    });
}
