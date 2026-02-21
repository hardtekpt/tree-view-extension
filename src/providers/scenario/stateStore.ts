import * as vscode from 'vscode';
import { toPathKey } from '../../utils/pathKey';
import { SCENARIO_STORAGE_KEYS } from './storageKeys';
import { normalizeRunFlags } from './runtimeUtils';
import { createTagId, normalizeTag } from './tagUtils';
import type { RunTagDefinition, ScenarioRunSortMode, ScenarioWorkspaceState, SortMode } from './types';

export interface ScenarioStateCollections {
    pinnedScenarios: Set<string>;
    pinnedIoRuns: Set<string>;
    runSortByScenario: Map<string, ScenarioRunSortMode>;
    tagCatalog: Map<string, RunTagDefinition>;
    runTagsByPath: Map<string, string[]>;
    runFilterTagIdsByScenario: Map<string, string[]>;
    sudoExecutionByScenario: Map<string, boolean>;
}

export interface ScenarioStateScalars {
    filter: string;
    scenarioSortMode: SortMode;
    globalRunFlags: string;
}

export function snapshotScenarioWorkspaceState(
    collections: ScenarioStateCollections,
    scalars: ScenarioStateScalars
): ScenarioWorkspaceState {
    return {
        filter: scalars.filter,
        scenarioSortMode: scalars.scenarioSortMode,
        pinnedScenarios: [...collections.pinnedScenarios],
        pinnedIoRuns: [...collections.pinnedIoRuns],
        runSortByScenario: Object.fromEntries(collections.runSortByScenario.entries()),
        tagCatalog: [...collections.tagCatalog.values()],
        runTagsByPath: Object.fromEntries(collections.runTagsByPath.entries()),
        runFilterTagIdsByScenario: Object.fromEntries(collections.runFilterTagIdsByScenario.entries()),
        globalRunFlags: scalars.globalRunFlags,
        sudoExecutionByScenario: Object.fromEntries(collections.sudoExecutionByScenario.entries())
    };
}

export function applyScenarioWorkspaceState(
    next: ScenarioWorkspaceState,
    collections: ScenarioStateCollections
): ScenarioStateScalars {
    collections.pinnedScenarios.clear();
    for (const item of next.pinnedScenarios ?? []) {
        collections.pinnedScenarios.add(toPathKey(item));
    }

    collections.pinnedIoRuns.clear();
    for (const item of next.pinnedIoRuns ?? []) {
        collections.pinnedIoRuns.add(toPathKey(item));
    }

    collections.runSortByScenario.clear();
    for (const [key, mode] of Object.entries(next.runSortByScenario ?? {})) {
        collections.runSortByScenario.set(toPathKey(key), mode);
    }

    collections.tagCatalog.clear();
    for (const tag of next.tagCatalog ?? []) {
        if (!tag?.id || !tag.label) {
            continue;
        }
        collections.tagCatalog.set(tag.id, normalizeTag(tag));
    }

    collections.runTagsByPath.clear();
    for (const [runPath, tagIds] of Object.entries(next.runTagsByPath ?? {})) {
        const filteredIds = (tagIds ?? []).filter(tagId => collections.tagCatalog.has(tagId));
        if (filteredIds.length > 0) {
            collections.runTagsByPath.set(toPathKey(runPath), filteredIds);
        }
    }

    collections.runFilterTagIdsByScenario.clear();
    for (const [scenarioPath, tagIds] of Object.entries(next.runFilterTagIdsByScenario ?? {})) {
        const filteredIds = (tagIds ?? []).filter(tagId => collections.tagCatalog.has(tagId));
        if (filteredIds.length > 0) {
            collections.runFilterTagIdsByScenario.set(toPathKey(scenarioPath), filteredIds);
        }
    }

    collections.sudoExecutionByScenario.clear();
    for (const [scenarioPath, enabled] of Object.entries(next.sudoExecutionByScenario ?? {})) {
        if (enabled) {
            collections.sudoExecutionByScenario.set(toPathKey(scenarioPath), true);
        }
    }

    return {
        filter: next.filter ?? '',
        scenarioSortMode: next.scenarioSortMode ?? 'name',
        globalRunFlags: normalizeRunFlags(next.globalRunFlags ?? '')
    };
}

export function loadScenarioStateFromMemento(
    state: vscode.Memento,
    collections: ScenarioStateCollections
): ScenarioStateScalars {
    const pinned = state.get<string[]>(SCENARIO_STORAGE_KEYS.pinnedScenarios, []);
    collections.pinnedScenarios.clear();
    for (const item of pinned) {
        collections.pinnedScenarios.add(toPathKey(item));
    }

    const pinnedRuns = state.get<string[]>(SCENARIO_STORAGE_KEYS.pinnedIoRuns, []);
    collections.pinnedIoRuns.clear();
    for (const item of pinnedRuns) {
        collections.pinnedIoRuns.add(toPathKey(item));
    }

    const catalog = state.get<RunTagDefinition[]>(SCENARIO_STORAGE_KEYS.tagCatalog, []);
    collections.tagCatalog.clear();
    for (const tag of catalog) {
        if (!tag?.id || !tag.label) {
            continue;
        }
        collections.tagCatalog.set(tag.id, normalizeTag(tag));
    }

    const runTags = state.get<Record<string, string[]>>(SCENARIO_STORAGE_KEYS.runTagsByPath, {});
    collections.runTagsByPath.clear();
    for (const [runPath, tagIds] of Object.entries(runTags)) {
        const ids = (tagIds ?? []).filter(tagId => collections.tagCatalog.has(tagId));
        if (ids.length > 0) {
            collections.runTagsByPath.set(toPathKey(runPath), ids);
        }
    }

    const filterByScenario = state.get<Record<string, string[]>>(
        SCENARIO_STORAGE_KEYS.runFilterTagIdsByScenario,
        {}
    );
    collections.runFilterTagIdsByScenario.clear();
    for (const [scenarioPath, tagIds] of Object.entries(filterByScenario)) {
        const filteredIds = (tagIds ?? []).filter(tagId => collections.tagCatalog.has(tagId));
        if (filteredIds.length > 0) {
            collections.runFilterTagIdsByScenario.set(toPathKey(scenarioPath), filteredIds);
        }
    }

    const sudoByScenario = state.get<Record<string, boolean>>(SCENARIO_STORAGE_KEYS.sudoExecutionByScenario, {});
    collections.sudoExecutionByScenario.clear();
    for (const [scenarioPath, enabled] of Object.entries(sudoByScenario)) {
        if (enabled) {
            collections.sudoExecutionByScenario.set(toPathKey(scenarioPath), true);
        }
    }

    collections.runSortByScenario.clear();
    const byScenario = state.get<Record<string, ScenarioRunSortMode>>(
        SCENARIO_STORAGE_KEYS.runSortByScenario,
        {}
    );
    for (const [key, mode] of Object.entries(byScenario)) {
        collections.runSortByScenario.set(toPathKey(key), mode);
    }

    return {
        filter: '',
        scenarioSortMode: state.get<SortMode>(SCENARIO_STORAGE_KEYS.scenarioSort, 'name'),
        globalRunFlags: normalizeRunFlags(state.get<string>(SCENARIO_STORAGE_KEYS.globalRunFlags, ''))
    };
}

export function persistScenarioTagState(
    state: vscode.Memento,
    collections: Pick<ScenarioStateCollections, 'tagCatalog' | 'runTagsByPath' | 'runFilterTagIdsByScenario'>
): void {
    void state.update(SCENARIO_STORAGE_KEYS.tagCatalog, [...collections.tagCatalog.values()]);
    void state.update(SCENARIO_STORAGE_KEYS.runTagsByPath, Object.fromEntries(collections.runTagsByPath.entries()));
    void state.update(
        SCENARIO_STORAGE_KEYS.runFilterTagIdsByScenario,
        Object.fromEntries(collections.runFilterTagIdsByScenario.entries())
    );
}

export function ensureDefaultRunTags(
    collections: Pick<ScenarioStateCollections, 'tagCatalog'>
): boolean {
    const defaults: Array<Omit<RunTagDefinition, 'id'>> = [
        { label: 'success', color: '#4CAF50', icon: 'check' },
        { label: 'failed', color: '#F44336', icon: 'error' },
        { label: 'reviewed', color: '#2196F3', icon: 'eye' }
    ];

    let changed = false;
    for (const definition of defaults) {
        const exists = [...collections.tagCatalog.values()].some(
            tag => tag.label.toLowerCase() === definition.label.toLowerCase()
        );
        if (exists) {
            continue;
        }

        const id = createTagId(definition.label, collections.tagCatalog);
        collections.tagCatalog.set(id, normalizeTag({ id, ...definition }));
        changed = true;
    }

    return changed;
}

export function getOrCreateDefaultRunTag(
    tagLabel: 'success' | 'failed',
    collections: Pick<ScenarioStateCollections, 'tagCatalog'>
): RunTagDefinition {
    const existing = [...collections.tagCatalog.values()].find(tag => tag.label.toLowerCase() === tagLabel);
    if (existing) {
        return existing;
    }

    const definition =
        tagLabel === 'success'
            ? { label: 'success', color: '#4CAF50', icon: 'check' }
            : { label: 'failed', color: '#F44336', icon: 'error' };

    const id = createTagId(definition.label, collections.tagCatalog);
    const tag = normalizeTag({ id, ...definition });
    collections.tagCatalog.set(id, tag);
    return tag;
}
