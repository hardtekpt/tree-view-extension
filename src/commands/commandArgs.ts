import * as vscode from 'vscode';

export type WithUri = { uri: vscode.Uri };
export type MaybeUriArg = vscode.Uri | WithUri | undefined;
export type NodeArg = WithUri & { scenarioRootPath?: string; type?: string };
export type MaybeNodeArg = NodeArg | vscode.Uri | undefined;

// Normalize command arguments that can come as Uri or node objects.
export function asUri(value: MaybeUriArg): vscode.Uri | undefined {
    if (!value) {
        return undefined;
    }

    if (value instanceof vscode.Uri) {
        return value;
    }

    return value.uri instanceof vscode.Uri ? value.uri : undefined;
}

// Preserve optional metadata required by scenario-specific actions.
export function asNodeArg(value: MaybeNodeArg): NodeArg | undefined {
    if (!value) {
        return undefined;
    }

    if (value instanceof vscode.Uri) {
        return { uri: value };
    }

    if (!(value.uri instanceof vscode.Uri)) {
        return undefined;
    }

    return { uri: value.uri, scenarioRootPath: value.scenarioRootPath, type: value.type };
}
