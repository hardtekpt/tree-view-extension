// Extension-level constants shared by activation, providers, and command wiring.
export const CONFIG_ROOT = 'scenarioToolkit';
export const PYTHON_CONFIG_ROOT = 'python';

export const VIEW_IDS = {
    toolkitContainer: 'toolkit',
    manageWorkspace: 'manageWorkspace',
    devArea: 'devArea',
    srcExplorer: 'srcExplorer',
    scenarioExplorer: 'scenarioExplorer',
    configInspector: 'configInspector'
} as const;

export const SETTINGS_KEYS = {
    basePath: 'basePath',
    pythonCommand: 'pythonCommand',
    runScript: 'runScript',
    pythonDefaultInterpreterPath: 'defaultInterpreterPath'
} as const;

export const DEFAULTS = {
    pythonCommand: 'python',
    runScript: 'run.py'
} as const;

export const FOLDER_NAMES = {
    sourceRoot: 'src',
    scenariosRoot: 'scenarios',
    scenarioConfigs: 'configs',
    scenarioIo: 'io',
    toolkitStateDir: '.scenario-toolkit'
} as const;

export const FILE_NAMES = {
    workspaceConfig: 'workspace.json',
    venvMarker: 'pyvenv.cfg'
} as const;

export const FILE_EXTENSIONS = {
    xml: '.xml',
    log: '.log'
} as const;

export const GLOB_PATTERNS = {
    allFiles: '**/*',
    xmlFiles: '**/*.xml'
} as const;

export const RUNTIME_ARGS = {
    scenarioFlag: '-s'
} as const;

export const VENV_PATHS = {
    unixBinDir: 'bin',
    unixPython: 'python',
    windowsScriptsDir: 'Scripts',
    windowsPythonExe: 'python.exe'
} as const;

export const MIME_TYPES = {
    srcTree: 'application/vnd.code.tree.srcExplorer',
    devTree: 'application/vnd.code.tree.dev',
    uriList: 'text/uri-list'
} as const;

export const TREE_COMMANDS = {
    collapseSrcExplorer: 'workbench.actions.treeView.srcExplorer.collapseAll',
    collapseScenarioExplorer: 'workbench.actions.treeView.scenarioExplorer.collapseAll'
} as const;

export const WORKBENCH_COMMANDS = {
    showExtensionViewContainerPrefix: 'workbench.view.extension.',
    focusSideBar: 'workbench.action.focusSideBar'
} as const;

export const STORAGE_KEYS = {
    pinnedConfigParameters: `${CONFIG_ROOT}.pinnedConfigParameters`,
    pinnedScenarios: `${CONFIG_ROOT}.pinnedScenarios`,
    pinnedIoRuns: `${CONFIG_ROOT}.pinnedIoRuns`,
    scenarioSort: `${CONFIG_ROOT}.scenarioSortMode`,
    runSortByScenario: `${CONFIG_ROOT}.runSortByScenario`,
    tagCatalog: `${CONFIG_ROOT}.tagCatalog`,
    runTagsByPath: `${CONFIG_ROOT}.runTagsByPath`,
    runFilterTagIdsByScenario: `${CONFIG_ROOT}.runFilterTagIdsByScenario`,
    globalRunFlags: `${CONFIG_ROOT}.globalRunFlags`
} as const;

export const COMMANDS = {
    openFile: 'scenario.openFile',
    toggleDev: 'scenario.toggleDev',
    runScenario: 'scenario.run',
    runScenarioDebug: 'scenario.runDebug',
    runScenarioSudo: 'scenario.runSudo',
    runScenarioScreen: 'scenario.runScreen',
    setGlobalRunFlags: 'scenario.setGlobalRunFlags',
    duplicateScenario: 'scenario.dup',
    renameScenario: 'scenario.rename',
    deleteScenario: 'scenario.del',
    renameRun: 'run.rename',
    deleteRun: 'run.del',
    analyzeRun: 'run.analyze',
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
