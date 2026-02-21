import * as fs from 'fs';
import * as path from 'path';
import { existsDir, listEntriesSorted } from '../../utils/fileSystem';

export interface ScenarioLastExecutionInfo {
    scenarioName: string;
    scenarioPath: string;
    runPath?: string;
    runName?: string;
    timestampMs: number;
}

export function findLastScenarioExecution(
    scenariosRoot: string,
    ioFolderName: string
): ScenarioLastExecutionInfo | undefined {
    if (!existsDir(scenariosRoot)) {
        return undefined;
    }

    const scenarioNames = listEntriesSorted(scenariosRoot).filter(name => existsDir(path.join(scenariosRoot, name)));
    let newestScenarioName: string | undefined;
    let newestRunPath: string | undefined;
    let newestTimestamp = -1;

    for (const scenarioName of scenarioNames) {
        const scenarioPath = path.join(scenariosRoot, scenarioName);
        const candidate = findLatestRunCandidateForScenario(scenarioPath, ioFolderName);
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

function findLatestRunCandidateForScenario(
    scenarioPath: string,
    ioFolderName: string
): { runPath?: string; timestampMs: number } | undefined {
    const ioPath = path.join(scenarioPath, ioFolderName);
    if (!existsDir(ioPath)) {
        return undefined;
    }

    const latestPath = findLatestPathRecursive(ioPath);
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

function findLatestPathRecursive(rootPath: string): string | undefined {
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
            const fullPath = path.join(currentPath, entry.name);
            let stat: fs.Stats;
            try {
                stat = fs.statSync(fullPath);
            } catch {
                continue;
            }

            if (stat.mtimeMs > latestMtime) {
                latestMtime = stat.mtimeMs;
                latestPath = fullPath;
            }

            if (entry.isDirectory()) {
                visit(fullPath);
            }
        }
    };

    visit(rootPath);
    return latestPath;
}
