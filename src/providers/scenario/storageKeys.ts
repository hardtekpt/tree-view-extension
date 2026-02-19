import { STORAGE_KEYS } from '../../constants';

// Keys used for VS Code workspaceState persistence.
export const SCENARIO_STORAGE_KEYS = {
    pinnedScenarios: STORAGE_KEYS.pinnedScenarios,
    pinnedIoRuns: STORAGE_KEYS.pinnedIoRuns,
    scenarioSort: STORAGE_KEYS.scenarioSort,
    runSortByScenario: STORAGE_KEYS.runSortByScenario,
    tagCatalog: STORAGE_KEYS.tagCatalog,
    runTagsByPath: STORAGE_KEYS.runTagsByPath,
    runFilterTagIdsByScenario: STORAGE_KEYS.runFilterTagIdsByScenario,
    globalRunFlags: STORAGE_KEYS.globalRunFlags,
    sudoExecutionByScenario: STORAGE_KEYS.sudoExecutionByScenario
} as const;
