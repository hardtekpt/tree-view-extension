import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getScenarioIoFolderName, getScenarioPath } from '../config';
import { DEFAULTS, MIME_TYPES } from '../constants';
import { existsDir } from '../utils/fileSystem';

type SlotId = 'left' | 'right';

interface CsvSelection {
    filePath: string;
    scenarioName: string;
    runName: string;
    relativePath: string;
}

interface CsvDiffStatePayload {
    left?: CsvSelection;
    right?: CsvSelection;
    selectedColumns: string[];
    commonColumns: string[];
}

interface DropDebugPayload {
    slot: SlotId;
    uriList: boolean;
    customTree: boolean;
    plainText: boolean;
    fileCount: number;
    customPreview?: string;
    customRaw?: string;
}

interface CsvRowRecord {
    [column: string]: string;
}

interface CsvParsed {
    headers: string[];
    rows: CsvRowRecord[];
}

export class CsvDiffToolProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private leftSelection?: CsvSelection;
    private rightSelection?: CsvSelection;
    private selectedColumns: string[] = [];

    constructor(
        private readonly resolveScenarioItemHandleToUri?: (handle: string) => vscode.Uri | undefined
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.buildHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage(message => {
            void this.handleMessage(message);
        });
        this.postState();
    }

    private async handleMessage(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') {
            return;
        }
        const typed = message as Record<string, unknown>;
        const type = typeof typed.type === 'string' ? typed.type : '';
        const slot = typed.slot === 'left' || typed.slot === 'right' ? typed.slot : undefined;

        if (type === 'chooseFile' && slot) {
            await this.chooseFileForSlot(slot);
            return;
        }
        if (type === 'clearFile' && slot) {
            this.clearFileForSlot(slot);
            return;
        }
        if (type === 'selectDroppedCsv' && slot && typeof typed.uri === 'string') {
            await this.selectDroppedCsv(slot, typed.uri, isDropDebugPayload(typed.debug) ? typed.debug : undefined);
            return;
        }
        if (type === 'openColumnSelector') {
            await this.openColumnSelector();
            return;
        }
        if (type === 'applyColumns' && Array.isArray(typed.columns)) {
            this.applySelectedColumns(typed.columns.filter((item): item is string => typeof item === 'string'));
            return;
        }
        if (type === 'compare') {
            await this.compareSelectedFiles();
        }
    }

    private clearFileForSlot(slot: SlotId): void {
        if (slot === 'left') {
            this.leftSelection = undefined;
        } else {
            this.rightSelection = undefined;
        }
        this.selectedColumns = [];
        this.postState();
        void vscode.window.showInformationMessage(`Cleared CSV selection for ${slot === 'left' ? 'left' : 'right'} slot.`);
    }

    private async chooseFileForSlot(slot: SlotId): Promise<void> {
        const picked = await this.pickCsvFileInteractively();
        if (!picked) {
            return;
        }
        this.assignSelection(slot, picked);
        void vscode.window.showInformationMessage(
            `Selected ${slot === 'left' ? 'left' : 'right'} CSV: ${path.basename(picked.filePath)}`
        );
    }

    private async selectDroppedCsv(slot: SlotId, uriText: string, debug?: DropDebugPayload): Promise<void> {
        if (debug) {
            void vscode.window.showInformationMessage(
                `CSV drop debug (${debug.slot}): uri-list=${debug.uriList}, custom=${debug.customTree}, text=${debug.plainText}, files=${debug.fileCount}${debug.customPreview ? `, customPreview=${debug.customPreview}` : ''}`
            );
        }

        let resolvedUriText = uriText.trim();
        if (!resolvedUriText && debug?.customRaw && this.resolveScenarioItemHandleToUri) {
            try {
                const parsed = JSON.parse(debug.customRaw) as { itemHandles?: unknown };
                const handles = Array.isArray(parsed.itemHandles) ? parsed.itemHandles : [];
                const firstHandle = handles.find((item): item is string => typeof item === 'string');
                if (firstHandle) {
                    const resolvedUri = this.resolveScenarioItemHandleToUri(firstHandle);
                    if (resolvedUri) {
                        resolvedUriText = resolvedUri.toString();
                    }
                }
            } catch {
                // ignore invalid custom payload
            }
        }

        if (!resolvedUriText) {
            return;
        }

        let uri: vscode.Uri;
        try {
            uri = vscode.Uri.parse(resolvedUriText);
        } catch {
            // Fallback: absolute file path dropped from host OS/webview.
            if (path.isAbsolute(resolvedUriText)) {
                uri = vscode.Uri.file(resolvedUriText);
            } else {
                void vscode.window.showWarningMessage('Dropped item is not a valid URI.');
                return;
            }
        }

        if (uri.scheme === '' && path.isAbsolute(uri.fsPath)) {
            uri = vscode.Uri.file(uri.fsPath);
        }

        if (uri.scheme !== 'file') {
            void vscode.window.showWarningMessage('Only local CSV files can be dropped.');
            return;
        }
        if (!uri.fsPath.toLowerCase().endsWith('.csv')) {
            void vscode.window.showWarningMessage('Only .csv files can be dropped into CSV Diff Tool.');
            return;
        }
        if (!fs.existsSync(uri.fsPath)) {
            void vscode.window.showWarningMessage('Dropped CSV file does not exist.');
            return;
        }

        const selection = this.buildSelectionFromPath(uri.fsPath);
        if (!selection) {
            void vscode.window.showWarningMessage('Dropped file is not inside the scenarios output folders.');
            return;
        }

        this.assignSelection(slot, selection);
        void vscode.window.showInformationMessage(
            `Selected ${slot === 'left' ? 'left' : 'right'} CSV from drag & drop: ${path.basename(selection.filePath)}`
        );
    }

    private assignSelection(slot: SlotId, selection: CsvSelection): void {
        if (slot === 'left') {
            this.leftSelection = selection;
        } else {
            this.rightSelection = selection;
        }
        const commonColumns = this.getCommonColumns();
        this.selectedColumns = [...commonColumns];
        this.postState();
    }

    private async openColumnSelector(): Promise<void> {
        const commonColumns = this.getCommonColumns();
        if (commonColumns.length === 0) {
            void vscode.window.showWarningMessage('Select two CSV files first to compute common columns.');
            return;
        }
        this.view?.webview.postMessage({
            type: 'showColumnSelector',
            commonColumns,
            selectedColumns: this.selectedColumns
        });
    }

    private applySelectedColumns(columns: string[]): void {
        const commonColumns = this.getCommonColumns();
        this.selectedColumns = columns.filter(column => commonColumns.includes(column));
        this.postState();
        void vscode.window.showInformationMessage(`Selected ${this.selectedColumns.length} columns for comparison.`);
    }

    private async compareSelectedFiles(): Promise<void> {
        if (!this.leftSelection || !this.rightSelection) {
            void vscode.window.showWarningMessage('Select both CSV files before comparing.');
            return;
        }

        const commonColumns = this.getCommonColumns();
        if (commonColumns.length === 0) {
            void vscode.window.showWarningMessage('No common columns were found between selected CSV files.');
            return;
        }

        const columnsToCompare = this.selectedColumns.length > 0 ? this.selectedColumns : commonColumns;
        void vscode.window.showInformationMessage(`Starting CSV diff for ${columnsToCompare.length} columns...`);

        try {
            const leftParsed = parseCsvFile(this.leftSelection.filePath);
            const rightParsed = parseCsvFile(this.rightSelection.filePath);
            const maxRows = Math.max(leftParsed.rows.length, rightParsed.rows.length);

            const outputHeaders = [...columnsToCompare.map(column => `${column}_diff`)];
            const outputRows: string[][] = [];

            for (let index = 0; index < maxRows; index += 1) {
                const leftRow = leftParsed.rows[index] ?? {};
                const rightRow = rightParsed.rows[index] ?? {};
                const nextRow: string[] = [];

                for (const column of columnsToCompare) {
                    const leftValue = Number(leftRow[column] ?? '');
                    const rightValue = Number(rightRow[column] ?? '');
                    if (Number.isNaN(leftValue) || Number.isNaN(rightValue)) {
                        nextRow.push('');
                        continue;
                    }
                    nextRow.push(String(leftValue - rightValue));
                }
                outputRows.push(nextRow);
            }

            const outputDir = path.dirname(this.leftSelection.filePath);
            const outputFile = buildDiffOutputPath(outputDir, this.leftSelection.filePath, this.rightSelection.filePath);
            const csvContent = serializeCsv(outputHeaders, outputRows);
            fs.writeFileSync(outputFile, csvContent, 'utf8');

            this.postState();
            void vscode.window.showInformationMessage(`CSV diff completed: ${outputFile}`);
            await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(outputFile));
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(outputFile));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`CSV diff failed: ${message}`);
        }
    }

    private async pickCsvFileInteractively(): Promise<CsvSelection | undefined> {
        const scenariosRoot = getScenarioPath();
        if (!scenariosRoot || !existsDir(scenariosRoot)) {
            void vscode.window.showWarningMessage('Scenarios root is not available. Check the active profile.');
            return undefined;
        }

        const scenarioNames = fs.readdirSync(scenariosRoot).filter(name => existsDir(path.join(scenariosRoot, name)));
        if (scenarioNames.length === 0) {
            void vscode.window.showWarningMessage('No scenarios were found.');
            return undefined;
        }

        const pickedScenario = await vscode.window.showQuickPick(
            scenarioNames
                .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
                .map(name => ({ label: name, scenarioPath: path.join(scenariosRoot, name) })),
            { placeHolder: 'Select scenario' }
        );
        if (!pickedScenario) {
            return undefined;
        }

        const ioPath = path.join(pickedScenario.scenarioPath, getScenarioIoFolderName());
        if (!existsDir(ioPath)) {
            void vscode.window.showWarningMessage(`No '${getScenarioIoFolderName()}' folder in selected scenario.`);
            return undefined;
        }

        const runNames = fs.readdirSync(ioPath).filter(name => existsDir(path.join(ioPath, name)));
        const pickedRun = await vscode.window.showQuickPick(
            runNames
                .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
                .map(name => ({ label: name, runPath: path.join(ioPath, name) })),
            { placeHolder: 'Select run' }
        );
        if (!pickedRun) {
            return undefined;
        }

        const csvFiles = listCsvFilesRecursively(pickedRun.runPath);
        if (csvFiles.length === 0) {
            void vscode.window.showWarningMessage('No CSV files found in selected run.');
            return undefined;
        }

        const pickedFile = await vscode.window.showQuickPick(
            csvFiles
                .map(filePath => ({
                    label: path.relative(pickedRun.runPath, filePath),
                    description: path.basename(filePath),
                    filePath
                }))
                .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
            { placeHolder: 'Select CSV file' }
        );
        if (!pickedFile) {
            return undefined;
        }

        return {
            filePath: pickedFile.filePath,
            scenarioName: pickedScenario.label,
            runName: pickedRun.label,
            relativePath: path.relative(pickedRun.runPath, pickedFile.filePath)
        };
    }

    private buildSelectionFromPath(filePath: string): CsvSelection | undefined {
        const scenariosRoot = getScenarioPath();
        if (!scenariosRoot) {
            return undefined;
        }
        const ioSegment = `${path.sep}${getScenarioIoFolderName()}${path.sep}`;
        const normalized = path.normalize(filePath);
        const ioIndex = normalized.indexOf(ioSegment);
        if (ioIndex < 0) {
            return undefined;
        }

        const scenarioPath = normalized.slice(0, ioIndex);
        const scenarioName = path.basename(scenarioPath);
        const rest = normalized.slice(ioIndex + ioSegment.length);
        const parts = rest.split(path.sep).filter(Boolean);
        if (parts.length < 2) {
            return undefined;
        }
        const [runName, ...subPath] = parts;
        return {
            filePath,
            scenarioName,
            runName,
            relativePath: subPath.join(path.sep)
        };
    }

    private getCommonColumns(): string[] {
        if (!this.leftSelection || !this.rightSelection) {
            return [];
        }
        try {
            const leftParsed = parseCsvFile(this.leftSelection.filePath);
            const rightParsed = parseCsvFile(this.rightSelection.filePath);
            const rightSet = new Set(rightParsed.headers);
            return leftParsed.headers.filter(header => rightSet.has(header));
        } catch {
            return [];
        }
    }

    private postState(): void {
        if (!this.view) {
            return;
        }
        const payload: CsvDiffStatePayload = {
            left: this.leftSelection,
            right: this.rightSelection,
            selectedColumns: this.selectedColumns,
            commonColumns: this.getCommonColumns()
        };
        this.view.webview.postMessage({ type: 'state', payload });
    }

    private buildHtml(webview: vscode.Webview): string {
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px; margin: 0; }
    .section { border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; padding: 8px; background: var(--vscode-editor-background); }
    .slots { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 6px; margin-bottom: 6px; }
    .slot { border: 1px dashed var(--vscode-editorWidget-border); border-radius: 6px; padding: 6px; background: var(--vscode-sideBar-background); min-height: 0; }
    .slot h3 { margin: 0 0 4px 0; font-size: 11px; opacity: .85; line-height: 1.1; }
    .muted { opacity: 0.8; font-size: 12px; }
    .file-info { font-size: 11px; line-height: 1.25; word-break: break-all; }
    .slot-content { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; }
    .meta-line { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
    .meta-chip { border: 1px solid var(--vscode-editorWidget-border); border-radius: 999px; padding: 0 6px; font-size: 10px; line-height: 16px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 2px; }
    .left-actions { display: flex; align-items: center; gap: 6px; }
    .right-actions { display: flex; align-items: center; gap: 6px; }
    button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid transparent; border-radius: 4px; min-height: 24px; padding: 0 8px; cursor: pointer; font-size: 11px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.ghost { color: var(--vscode-foreground); background: transparent; border-color: var(--vscode-editorWidget-border); }
    button.ghost:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    button.icon-btn { min-width: 24px; width: 24px; min-height: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
    .toolbar { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
    .summary { margin-top: 4px; font-size: 11px; opacity: .9; }
    .hidden { display: none; }
    .modal { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: none; align-items: center; justify-content: center; padding: 10px; }
    .modal.open { display: flex; }
    .modal-panel { width: min(520px, 96vw); max-height: 82vh; overflow: auto; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; background: var(--vscode-editor-background); padding: 8px; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
    .column-list { display: grid; gap: 4px; margin-top: 4px; }
    .column-list label { font-size: 11px; display: inline-flex; align-items: center; gap: 4px; }
  </style>
</head>
<body>
  <div class="section">
    <div class="slots">
      <div class="slot" id="leftSlot" data-slot="left">
        <h3>File A</h3>
        <div id="leftContent"></div>
      </div>
      <div class="slot" id="rightSlot" data-slot="right">
        <h3>File B</h3>
        <div id="rightContent"></div>
      </div>
    </div>

    <div class="toolbar">
      <button id="columnsBtn" class="ghost" type="button">Select Columns</button>
      <button id="compareBtn" type="button">Compare CSV files</button>
    </div>
    <div id="columnsSummary" class="summary">No columns selected.</div>
  </div>

  <div id="columnModal" class="modal" aria-hidden="true">
    <div class="modal-panel">
      <div class="modal-header">
        <strong>Select Columns to Compare</strong>
        <button id="closeModalBtn" class="ghost" type="button">Close</button>
      </div>
      <div class="toolbar">
        <button id="selectAllColumnsBtn" class="ghost" type="button">Select all</button>
        <button id="clearAllColumnsBtn" class="ghost" type="button">Clear all</button>
      </div>
      <div id="columnList" class="column-list"></div>
      <div class="toolbar" style="margin-top: 10px;">
        <button id="applyColumnsBtn" type="button">Apply</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const leftContent = document.getElementById('leftContent');
    const rightContent = document.getElementById('rightContent');
    const columnsBtn = document.getElementById('columnsBtn');
    const compareBtn = document.getElementById('compareBtn');
    const columnsSummary = document.getElementById('columnsSummary');
    const columnModal = document.getElementById('columnModal');
    const columnList = document.getElementById('columnList');
    const closeModalBtn = document.getElementById('closeModalBtn');
    const selectAllColumnsBtn = document.getElementById('selectAllColumnsBtn');
    const clearAllColumnsBtn = document.getElementById('clearAllColumnsBtn');
    const applyColumnsBtn = document.getElementById('applyColumnsBtn');
    const leftSlot = document.getElementById('leftSlot');
    const rightSlot = document.getElementById('rightSlot');

    let state = { left: undefined, right: undefined, selectedColumns: [], commonColumns: [] };
    let modalSelected = [];

    const preventDragDefaults = event => {
      event.preventDefault();
      event.stopPropagation();
    };

    const normalizeDroppedUri = raw => {
      if (!raw) {
        return undefined;
      }
      const trimmed = String(raw).trim();
      if (!trimmed) {
        return undefined;
      }
      if (trimmed.startsWith('file://')) {
        return trimmed;
      }
      if (trimmed.startsWith('/') || /^[a-zA-Z]:[\\\\/]/.test(trimmed)) {
        return trimmed;
      }
      return undefined;
    };

    const extractUriFromUnknown = value => {
      if (value === null || value === undefined) {
        return undefined;
      }
      if (typeof value === 'string') {
        return normalizeDroppedUri(value);
      }
      if (typeof value !== 'object') {
        return undefined;
      }

      if (typeof value.fsPath === 'string') {
        return normalizeDroppedUri(value.fsPath);
      }
      if (typeof value.path === 'string' && typeof value.scheme === 'string') {
        if (value.scheme === 'file') {
          return normalizeDroppedUri(value.path);
        }
        const authority = typeof value.authority === 'string' ? value.authority : '';
        return normalizeDroppedUri(value.scheme + '://' + authority + value.path);
      }

      return (
        extractUriFromUnknown(value.uri) ||
        extractUriFromUnknown(value.resourceUri) ||
        extractUriFromUnknown(value.path) ||
        extractUriFromUnknown(value.fsPath) ||
        extractUriFromUnknown(value.value)
      );
    };

    const parseUriList = raw => {
      if (!raw) {
        return undefined;
      }
      const line = String(raw)
        .split(/\\r?\\n/)
        .map(item => item.trim())
        .find(item => item.length > 0 && !item.startsWith('#'));
      return normalizeDroppedUri(line);
    };

    const parseCustomTreePayload = raw => {
      if (!raw) {
        return undefined;
      }
      try {
        const parsed = JSON.parse(String(raw));
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            const extracted = extractUriFromUnknown(entry);
            if (extracted) {
              return extracted;
            }
          }
        }
        const extracted = extractUriFromUnknown(parsed);
        if (extracted) {
          return extracted;
        }
      } catch {
        // Some environments may deliver non-JSON custom payloads.
      }
      return normalizeDroppedUri(String(raw));
    };

    const extractDroppedUri = dataTransfer => {
      if (!dataTransfer) {
        return undefined;
      }
      return (
        parseUriList(dataTransfer.getData('${MIME_TYPES.uriList}')) ||
        parseCustomTreePayload(dataTransfer.getData('${MIME_TYPES.scenarioTree}')) ||
        normalizeDroppedUri(dataTransfer.getData('text/plain')) ||
        (dataTransfer.files && dataTransfer.files.length > 0
          ? normalizeDroppedUri(dataTransfer.files[0].path || '')
          : undefined)
      );
    };

    const resolveSlotFromEvent = event => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      for (const entry of path) {
        if (!entry || !entry.getAttribute) {
          continue;
        }
        const slot = entry.getAttribute('data-slot');
        if (slot === 'left' || slot === 'right') {
          return slot;
        }
      }

      const rawTarget = event.target;
      const element =
        rawTarget && rawTarget.nodeType === 3
          ? rawTarget.parentElement
          : rawTarget;
      const closest = element && element.closest ? element.closest('[data-slot]') : null;
      if (!closest) {
        return undefined;
      }
      const slot = closest.getAttribute('data-slot');
      return slot === 'left' || slot === 'right' ? slot : undefined;
    };

    document.addEventListener('dragover', event => {
      if (!resolveSlotFromEvent(event)) {
        return;
      }
      preventDragDefaults(event);
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    });

    document.addEventListener('dragenter', event => {
      if (!resolveSlotFromEvent(event)) {
        return;
      }
      preventDragDefaults(event);
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    });

    document.addEventListener('drop', event => {
      const slot = resolveSlotFromEvent(event);
      if (!slot) {
        return;
      }
      preventDragDefaults(event);
      const dataTransfer = event.dataTransfer;
      const uriListRaw = dataTransfer ? dataTransfer.getData('${MIME_TYPES.uriList}') : '';
      const customRaw = dataTransfer ? dataTransfer.getData('${MIME_TYPES.scenarioTree}') : '';
      const plainRaw = dataTransfer ? dataTransfer.getData('text/plain') : '';
      const uri = extractDroppedUri(dataTransfer) || '';
      vscode.postMessage({
        type: 'selectDroppedCsv',
        slot,
        uri,
        debug: {
          slot,
          uriList: Boolean(uriListRaw),
          customTree: Boolean(customRaw),
          plainText: Boolean(plainRaw),
          fileCount: dataTransfer && dataTransfer.files ? dataTransfer.files.length : 0,
          customPreview: customRaw ? String(customRaw).slice(0, 120) : '',
          customRaw: customRaw || ''
        }
      });
    });

    const renderSlot = (slot, selection, container) => {
      if (!selection) {
        container.innerHTML =
          '<div class="row"><div class="left-actions"><button data-action="choose" data-slot="' + slot + '" type="button">Select CSV file</button></div></div>';
        return;
      }

      container.innerHTML =
        '<div class="slot-content">' +
        '<div class="file-info">' +
        '<div><strong>File:</strong> ' + escapeHtml(selection.relativePath) + '</div>' +
        '<div class="meta-line">' +
        '<span class="meta-chip">' + escapeHtml(selection.scenarioName) + '</span>' +
        '<span class="meta-chip">' + escapeHtml(selection.runName) + '</span>' +
        '</div>' +
        '</div>' +
        '<div class="right-actions">' +
        '<button class="ghost icon-btn" title="Edit selection" aria-label="Edit selection" data-action="edit" data-slot="' + slot + '" type="button">✎</button>' +
        '<button class="ghost icon-btn" title="Clear selection" aria-label="Clear selection" data-action="clear" data-slot="' + slot + '" type="button">✕</button>' +
        '</div>' +
        '</div>';
    };

    const renderState = () => {
      renderSlot('left', state.left, leftContent);
      renderSlot('right', state.right, rightContent);

      const selectedCount = state.selectedColumns.length;
      const commonCount = state.commonColumns.length;
      columnsSummary.textContent =
        commonCount === 0
          ? 'No common columns available.'
          : selectedCount > 0
            ? selectedCount + ' selected of ' + commonCount + ' common columns.'
            : 'No explicit selection. Compare will use all ' + commonCount + ' common columns.';
    };

    const openModal = (commonColumns, selectedColumns) => {
      modalSelected = [...selectedColumns];
      columnList.innerHTML = '';
      for (const column of commonColumns) {
        const row = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = column;
        checkbox.checked = selectedColumns.includes(column);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            if (!modalSelected.includes(column)) {
              modalSelected.push(column);
            }
          } else {
            modalSelected = modalSelected.filter(item => item !== column);
          }
        });
        row.appendChild(checkbox);
        row.appendChild(document.createTextNode(column));
        columnList.appendChild(row);
      }
      columnModal.classList.add('open');
      columnModal.setAttribute('aria-hidden', 'false');
    };

    const closeModal = () => {
      columnModal.classList.remove('open');
      columnModal.setAttribute('aria-hidden', 'true');
    };

    document.addEventListener('click', event => {
      const target = event.target && event.target.closest ? event.target.closest('button[data-action]') : null;
      if (!target) {
        return;
      }
      const action = target.getAttribute('data-action');
      const slot = target.getAttribute('data-slot');
      if (!slot) {
        return;
      }
      if (action === 'choose' || action === 'edit') {
        vscode.postMessage({ type: 'chooseFile', slot });
        return;
      }
      if (action === 'clear') {
        vscode.postMessage({ type: 'clearFile', slot });
      }
    });

    columnsBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'openColumnSelector' });
    });

    compareBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'compare' });
    });

    closeModalBtn.addEventListener('click', closeModal);
    selectAllColumnsBtn.addEventListener('click', () => {
      modalSelected = [...state.commonColumns];
      for (const checkbox of columnList.querySelectorAll('input[type="checkbox"]')) {
        checkbox.checked = true;
      }
    });
    clearAllColumnsBtn.addEventListener('click', () => {
      modalSelected = [];
      for (const checkbox of columnList.querySelectorAll('input[type="checkbox"]')) {
        checkbox.checked = false;
      }
    });
    applyColumnsBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'applyColumns', columns: modalSelected });
      closeModal();
    });

    window.addEventListener('message', event => {
      const message = event.data || {};
      if (message.type === 'state') {
        state = message.payload || state;
        renderState();
        return;
      }
      if (message.type === 'showColumnSelector') {
        openModal(message.commonColumns || [], message.selectedColumns || []);
      }
    });

    function escapeHtml(value) {
      return String(value).replace(/[&<>\"']/g, char => {
        if (char === '&') return '&amp;';
        if (char === '<') return '&lt;';
        if (char === '>') return '&gt;';
        if (char === '\"') return '&quot;';
        return '&#39;';
      });
    }
  </script>
</body>
</html>`;
    }
}

function isDropDebugPayload(value: unknown): value is DropDebugPayload {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const typed = value as Record<string, unknown>;
    return (
        (typed.slot === 'left' || typed.slot === 'right') &&
        typeof typed.uriList === 'boolean' &&
        typeof typed.customTree === 'boolean' &&
        typeof typed.plainText === 'boolean' &&
        typeof typed.fileCount === 'number' &&
        (typed.customPreview === undefined || typeof typed.customPreview === 'string') &&
        (typed.customRaw === undefined || typeof typed.customRaw === 'string')
    );
}

function listCsvFilesRecursively(rootPath: string): string[] {
    const files: string[] = [];
    const visit = (currentPath: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentPath, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const full = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                visit(full);
                continue;
            }
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) {
                files.push(full);
            }
        }
    };
    visit(rootPath);
    return files;
}

function parseCsvFile(filePath: string): CsvParsed {
    const text = fs.readFileSync(filePath, 'utf8');
    const rows = parseCsvText(text);
    if (rows.length === 0) {
        return { headers: [], rows: [] };
    }

    const headers = rows[0].map(value => value.trim());
    const resultRows: CsvRowRecord[] = [];
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        const record: CsvRowRecord = {};
        headers.forEach((header, index) => {
            record[header] = row[index] ?? '';
        });
        resultRows.push(record);
    }
    return { headers, rows: resultRows };
}

function parseCsvText(text: string): string[][] {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentCell = '';
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                currentCell += '"';
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === ',' && !inQuotes) {
            currentRow.push(currentCell);
            currentCell = '';
            continue;
        }

        if ((char === '\n' || char === '\r') && !inQuotes) {
            if (char === '\r' && next === '\n') {
                index += 1;
            }
            currentRow.push(currentCell);
            currentCell = '';
            if (currentRow.some(cell => cell.length > 0)) {
                rows.push(currentRow);
            }
            currentRow = [];
            continue;
        }

        currentCell += char;
    }

    currentRow.push(currentCell);
    if (currentRow.some(cell => cell.length > 0)) {
        rows.push(currentRow);
    }
    return rows;
}

function serializeCsv(headers: string[], rows: string[][]): string {
    const allRows = [headers, ...rows];
    return `${allRows.map(row => row.map(escapeCsvValue).join(',')).join('\n')}\n`;
}

function escapeCsvValue(value: string): string {
    const stringValue = String(value ?? '');
    if (!/[,"\n\r]/.test(stringValue)) {
        return stringValue;
    }
    return `"${stringValue.replace(/"/g, '""')}"`;
}

function buildDiffOutputPath(outputDir: string, leftFile: string, rightFile: string): string {
    const leftName = path.basename(leftFile, '.csv').replace(/[^a-zA-Z0-9_-]+/g, '_');
    const rightName = path.basename(rightFile, '.csv').replace(/[^a-zA-Z0-9_-]+/g, '_');
    const now = new Date();
    const stamp =
        `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
        `-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    return path.join(outputDir, `${leftName}-minus-${rightName}_${stamp}.csv`);
}

function pad2(value: number): string {
    return value < 10 ? `0${value}` : String(value);
}
