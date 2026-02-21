import * as vscode from 'vscode';
import type { RunTagDefinition, ScenarioRunSortMode, SortMode } from './types';

interface ScenarioTooltipInput {
    scenarioName: string;
    sudoEnabled: boolean;
    runFlags: string;
    scenarioFilter: string;
    scenarioSortMode: SortMode;
    runSortMode: ScenarioRunSortMode;
    activeRunTagFilter: string;
}

interface IoFolderTooltipInput {
    scenarioName: string;
    folderName: string;
    runSortMode: ScenarioRunSortMode;
    activeRunTagFilter: string;
    sudoEnabled: boolean;
    runFlags: string;
}

interface IoRunTooltipInput {
    runName: string;
    scenarioName: string;
    tags: ReadonlyArray<RunTagDefinition>;
    activeRunTagFilter: string;
    sudoEnabled: boolean;
    runFlags: string;
    runSortMode: ScenarioRunSortMode;
    scenarioFilter: string;
}

export function buildScenarioTooltip(input: ScenarioTooltipInput): vscode.MarkdownString {
    return buildTooltipTable('Scenario Details', [
        ['Scenario', input.scenarioName],
        ['Sudo', input.sudoEnabled ? 'Enabled' : 'Disabled'],
        ['Run flags', input.runFlags],
        ['Scenario filter', input.scenarioFilter],
        ['Scenario sort', formatSortMode(input.scenarioSortMode)],
        ['Run sort', formatSortMode(input.runSortMode)],
        ['Run tag filter', input.activeRunTagFilter]
    ]);
}

export function buildIoFolderTooltip(input: IoFolderTooltipInput): vscode.MarkdownString {
    return buildTooltipTable('Output Folder Details', [
        ['Scenario', input.scenarioName],
        ['Folder', input.folderName],
        ['Run sort', formatSortMode(input.runSortMode)],
        ['Run tag filter', input.activeRunTagFilter],
        ['Sudo', input.sudoEnabled ? 'Enabled' : 'Disabled'],
        ['Run flags', input.runFlags]
    ]);
}

export function buildIoRunTooltip(input: IoRunTooltipInput): vscode.MarkdownString {
    return buildTooltipTable('Output Run Details', [
        ['Run', input.runName],
        ['Scenario', input.scenarioName],
        ['Tags', input.tags.length > 0 ? input.tags.map(tag => tag.label).join(', ') : 'None'],
        ['Active run tag filter', input.activeRunTagFilter],
        ['Sudo', input.sudoEnabled ? 'Enabled' : 'Disabled'],
        ['Run flags', input.runFlags],
        ['Run sort', formatSortMode(input.runSortMode)],
        ['Scenario filter', input.scenarioFilter]
    ]);
}

export function formatTagFilter(
    selectedIds: ReadonlyArray<string>,
    tagsById: ReadonlyMap<string, RunTagDefinition>
): string {
    if (selectedIds.length === 0) {
        return 'None';
    }

    const labels = selectedIds
        .map(tagId => tagsById.get(tagId)?.label)
        .filter((label): label is string => Boolean(label));
    return labels.length > 0 ? labels.join(', ') : 'None';
}

function formatSortMode(mode: SortMode | ScenarioRunSortMode): string {
    return mode === 'recent' ? 'Most recent' : 'Name';
}

function buildTooltipTable(title: string, rows: ReadonlyArray<readonly [string, string]>): vscode.MarkdownString {
    const body = rows
        .map(([field, value]) => `| ${escapeMarkdownTableCell(field)} | ${escapeMarkdownTableCell(value)} |`)
        .join('\n');
    const markdown = new vscode.MarkdownString(
        `### ${escapeMarkdownHeading(title)}\n\n| Field | Value |\n| --- | --- |\n${body}`,
        true
    );
    markdown.isTrusted = false;
    return markdown;
}

function escapeMarkdownHeading(value: string): string {
    return value.replace(/\r?\n/g, ' ').trim();
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
