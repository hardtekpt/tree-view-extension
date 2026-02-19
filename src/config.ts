import * as path from 'path';
import { DEFAULTS } from './constants';
import { findPythonInBasePath } from './providers/scenario/runtimeUtils';
import { getProfileManager } from './profile/profileManager';

export function getBasePath(): string | undefined {
    return getProfileManager()?.getActiveProfile()?.basePath;
}

export function getScenarioPath(): string | undefined {
    const base = getBasePath();
    const scenariosRoot = getScenarioRootFolder();
    return base ? path.join(base, scenariosRoot) : undefined;
}

export function getPythonCommand(): string {
    const profile = getProfileManager()?.getActiveProfile();
    if (!profile) {
        return DEFAULTS.pythonCommand;
    }

    if (profile.pythonStrategy === 'fixedPath') {
        return profile.pythonPath?.trim() || DEFAULTS.pythonCommand;
    }

    return findPythonInBasePath(profile.basePath) ?? DEFAULTS.pythonCommand;
}

export function getRunCommandTemplate(): string {
    const template = getProfileManager()?.getActiveProfile()?.runCommandTemplate?.trim();
    return template && template.length > 0 ? template : DEFAULTS.runCommandTemplate;
}

export function getScenarioConfigsFolderName(): string {
    const value = getProfileManager()?.getActiveProfile()?.scenarioConfigsFolderName;
    return sanitizeFolderName(value, DEFAULTS.scenarioConfigsFolderName);
}

export function getScenarioIoFolderName(): string {
    const value = getProfileManager()?.getActiveProfile()?.scenarioIoFolderName;
    return sanitizeFolderName(value, DEFAULTS.scenarioIoFolderName);
}

export function getScenarioRootFolder(): string {
    const value = getProfileManager()?.getActiveProfile()?.scenariosRoot;
    return sanitizeSegment(value, 'scenarios');
}

function sanitizeFolderName(value: string | undefined, fallback: string): string {
    return sanitizeSegment(value, fallback).replace(/[\\/]+/g, '');
}

function sanitizeSegment(value: string | undefined, fallback: string): string {
    const cleaned = (value ?? '').trim().replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
    return cleaned.length > 0 ? cleaned : fallback;
}
