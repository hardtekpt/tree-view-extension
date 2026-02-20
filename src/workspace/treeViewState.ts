// Persisted expansion state for tree views that support nested nodes.
export interface ComponentViewWorkspaceState {
    devAreaVisible: boolean;
    srcExplorerVisible: boolean;
    scenarioExplorerVisible: boolean;
    programInfoVisible: boolean;
    configInspectorVisible: boolean;
}

export interface TreeViewWorkspaceState {
    srcExplorerExpanded: string[];
    scenarioExplorerExpanded: string[];
    componentViews: ComponentViewWorkspaceState;
}
