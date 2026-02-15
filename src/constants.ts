// Extension-level constants shared by activation, providers, and command wiring.
export const CONFIG_ROOT = 'scenarioToolkit';

export const VIEW_IDS = {
    toolkitContainer: 'toolkit',
    devArea: 'devArea',
    srcExplorer: 'srcExplorer',
    scenarioExplorer: 'scenarioExplorer',
    configInspector: 'configInspector'
} as const;

export const COMMANDS = {
    openFile: 'scenario.openFile',
    toggleDev: 'scenario.toggleDev',
    runScenario: 'scenario.run',
    duplicateScenario: 'scenario.dup',
    renameScenario: 'scenario.rename',
    deleteScenario: 'scenario.del',
    renameRun: 'run.rename',
    deleteRun: 'run.del',
    openRunLog: 'run.openLog',
    manageRunTags: 'run.tags',
    clearRunTags: 'run.clearTags',
    applySuccessTag: 'run.applySuccessTag',
    applyFailedTag: 'run.applyFailedTag',
    manageTagCatalog: 'tags.manage',
    createTag: 'tags.create',
    editTag: 'tags.edit',
    deleteTag: 'tags.delete',
    filterRunsByTag: 'run.filterByTag',
    toggleScenarioPin: 'scenario.pin',
    filterScenario: 'scenario.filter',
    toggleScenarioSort: 'scenario.toggleSort',
    toggleRunSort: 'scenario.toggleRunSort',
    openConfigInspector: 'scenario.openConfigInspector',
    refreshToolkit: 'scenario.refresh',
    saveWorkspace: 'workspace.save',
    loadWorkspace: 'workspace.load',
    resetWorkspace: 'workspace.reset',
    clearDevArea: 'dev.clear',
    removeDevFile: 'dev.remove'
} as const;
