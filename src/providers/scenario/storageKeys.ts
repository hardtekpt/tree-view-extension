// Keys used for VS Code workspaceState persistence.
export const SCENARIO_STORAGE_KEYS = {
    pinnedScenarios: 'scenarioToolkit.pinnedScenarios',
    pinnedIoRuns: 'scenarioToolkit.pinnedIoRuns',
    scenarioSort: 'scenarioToolkit.scenarioSortMode',
    runSortByScenario: 'scenarioToolkit.runSortByScenario',
    tagCatalog: 'scenarioToolkit.tagCatalog',
    runTagsByPath: 'scenarioToolkit.runTagsByPath',
    runFilterTagIdsByScenario: 'scenarioToolkit.runFilterTagIdsByScenario'
} as const;
