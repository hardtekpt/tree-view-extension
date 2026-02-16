import * as path from 'path';
import { existsDir } from '../../utils/fileSystem';
import { toPathKey } from '../../utils/pathKey';
import { SortMode } from './types';
import { getMtimeMs } from './runtimeUtils';

// Shared deterministic sort used by scenario roots and io entries.
export function sortEntries(root: string, names: string[], mode: SortMode, directoriesFirst = true): string[] {
    const sorted = [...names].sort((a, b) => {
        const aPath = path.join(root, a);
        const bPath = path.join(root, b);
        const aDir = existsDir(aPath);
        const bDir = existsDir(bPath);

        if (directoriesFirst && aDir !== bDir) {
            return aDir ? -1 : 1;
        }

        if (mode === 'recent') {
            const bTime = getMtimeMs(bPath);
            const aTime = getMtimeMs(aPath);
            if (aTime !== bTime) {
                return bTime - aTime;
            }
        }

        return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });

    return sorted;
}

// Run passes filter when any selected tag is attached to the run.
export function matchRunTagFilter(
    runTagsByPath: Map<string, string[]>,
    runFilterTagIdsByScenario: Map<string, string[]>,
    runKey: string,
    scenarioKey: string
): boolean {
    const filterTagIds = runFilterTagIdsByScenario.get(scenarioKey) ?? [];
    if (filterTagIds.length === 0) {
        return true;
    }

    const runTags = runTagsByPath.get(runKey) ?? [];
    return filterTagIds.some(tagId => runTags.includes(tagId));
}

// Walk upward until reaching scenarios root parent; return owning scenario directory.
export function findScenarioRoot(fsPath: string, scenariosRoot: string): string | undefined {
    let current = path.resolve(fsPath);
    const rootKey = toPathKey(scenariosRoot);

    while (true) {
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }

        if (toPathKey(parent) === rootKey) {
            return current;
        }

        current = parent;
    }
}
