import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULTS, FOLDER_NAMES } from '../constants';
import { existsDir } from '../utils/fileSystem';

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
            try {
                const parsed = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as Partial<ProfilesFileShape>;
                for (const profile of parsed.profiles ?? []) {
                    if (!profile?.id || !profile.basePath) {
                        continue;
                    }
                    this.profiles.set(profile.id, profile as ProgramProfile);
                }
            } catch {}
        }

        const bindingsPath = this.getBindingsPath();
        if (fs.existsSync(bindingsPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(bindingsPath, 'utf8')) as Partial<BindingsFileShape>;
                for (const [workspacePath, profileId] of Object.entries(parsed.bindings ?? {})) {
                    if (workspacePath && profileId) {
                        this.workspaceBindings.set(workspacePath, profileId);
                    }
                }
            } catch {}
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
        fs.writeFileSync(this.getProfilesPath(), JSON.stringify(payload, null, 2), 'utf8');
    }

    private persistBindings(): void {
        const payload: BindingsFileShape = {
            version: 1,
            bindings: Object.fromEntries(this.workspaceBindings.entries())
        };
        fs.writeFileSync(this.getBindingsPath(), JSON.stringify(payload, null, 2), 'utf8');
    }

    private getProfilesPath(): string {
        return path.join(this.context.globalStorageUri.fsPath, PROFILES_FILE);
    }

    private getBindingsPath(): string {
        return path.join(this.context.globalStorageUri.fsPath, BINDINGS_FILE);
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
