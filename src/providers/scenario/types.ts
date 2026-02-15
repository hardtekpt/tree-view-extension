// Shared types used by scenario provider and workspace persistence.
export type SortMode = 'name' | 'recent';
export type ScenarioRunSortMode = 'name' | 'recent';

export interface RunTagDefinition {
    id: string;
    label: string;
    color: string;
    icon?: string;
    description?: string;
}

export interface ScenarioWorkspaceState {
    filter: string;
    scenarioSortMode: SortMode;
    pinnedScenarios: string[];
    pinnedIoRuns: string[];
    runSortByScenario: Record<string, ScenarioRunSortMode>;
    tagCatalog: RunTagDefinition[];
    runTagsByPath: Record<string, string[]>;
    runFilterTagIdsByScenario: Record<string, string[]>;
}
