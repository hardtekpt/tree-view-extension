import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ParsedOutputFileMetadata, ParsedOutputFolderMetadata, ScenarioProvider } from '../providers/scenarioProvider';
import { existsDir } from '../utils/fileSystem';

const IMAGE_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.svg',
    '.gif',
    '.webp',
    '.bmp',
    '.tif',
    '.tiff'
]);

interface PlotFolderNode {
    name: string;
    relativePath: string;
    folders: PlotFolderNode[];
    files: string[];
}

export async function openRunAnalysisPanel(
    runUri: vscode.Uri,
    scenarioProvider?: ScenarioProvider
): Promise<void> {
    if (!existsDir(runUri.fsPath)) {
        void vscode.window.showWarningMessage('Analyze is only available for output run folders.');
        return;
    }

    const runName = path.basename(runUri.fsPath);
    const scenarioName = resolveScenarioNameFromRunPath(runUri.fsPath);
    const panel = vscode.window.createWebviewPanel(
        'scenarioRunAnalysis',
        `Analyze: ${scenarioName} / ${runName}`,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            localResourceRoots: [runUri]
        }
    );

    const tree = buildPlotTree(runUri.fsPath, '');
    const fileMetadataByRelativePath = buildFileMetadataLookup(
        runUri.fsPath,
        scenarioProvider?.getParsedOutputMetadataForRun(runUri.fsPath) ?? []
    );
    const folderMetadataByRelativePath = buildFolderMetadataLookup(
        runUri.fsPath,
        scenarioProvider?.getParsedOutputFolderMetadataForRun(runUri.fsPath) ?? []
    );
    panel.webview.html = buildHtml(
        panel.webview,
        scenarioName,
        runName,
        runUri,
        tree,
        fileMetadataByRelativePath,
        folderMetadataByRelativePath
    );
}

function buildPlotTree(rootPath: string, relativePath: string): PlotFolderNode {
    const absolute = relativePath ? path.join(rootPath, relativePath) : rootPath;
    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
        return { name: path.basename(absolute), relativePath, folders: [], files: [] };
    }

    const directories = entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const files = entries
        .filter(entry => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    return {
        name: relativePath ? path.basename(absolute) : path.basename(rootPath),
        relativePath,
        folders: directories.map(directory =>
            buildPlotTree(rootPath, relativePath ? path.join(relativePath, directory) : directory)
        ),
        files
    };
}

function buildHtml(
    webview: vscode.Webview,
    scenarioName: string,
    runName: string,
    runUri: vscode.Uri,
    root: PlotFolderNode,
    fileMetadataByRelativePath: Map<string, ParsedOutputFileMetadata>,
    folderMetadataByRelativePath: Map<string, ParsedOutputFolderMetadata>
): string {
    const sections = renderFolder(
        webview,
        runUri,
        root,
        fileMetadataByRelativePath,
        folderMetadataByRelativePath,
        true
    );
    return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { --plot-card-width: 240px; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
    .header {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 12px;
      background: var(--vscode-sideBar-background);
    }
    .header h2 { margin: 0 0 6px 0; font-size: 17px; font-weight: 700; }
    .header .subline { opacity: .88; margin-bottom: 4px; }
    .header .path { opacity: .75; font-family: var(--vscode-editor-font-family); word-break: break-all; font-size: 12px; }
    details.panel {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 8px;
      padding: 8px 10px;
      margin-bottom: 12px;
      background: var(--vscode-editor-background);
    }
    details.panel > summary { font-weight: 700; margin-bottom: 8px; cursor: pointer; }
    .controls { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; margin-bottom: 12px; }
    .controls label { font-size: 12px; }
    .controls input[type="range"] { width: 220px; }
    .controls .value { min-width: 44px; opacity: .85; }
    button,
    select,
    input[type="text"] {
      font: inherit;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border));
      border-radius: 6px;
      min-height: 30px;
      padding: 0 10px;
      outline: none;
    }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: transparent;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.ghost {
      color: var(--vscode-foreground);
      background: transparent;
      border-color: var(--vscode-editorWidget-border);
      font-weight: 500;
    }
    button.ghost:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    select:focus,
    input[type="text"]:focus {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }
    .filter-section-title { font-size: 12px; font-weight: 700; margin: 0 0 8px 0; opacity: .9; }
    .filter-builder { display: grid; gap: 10px; }
    .filter-row {
      display: grid;
      grid-template-columns: max-content auto max-content auto auto;
      gap: 8px;
      align-items: center;
      justify-content: start;
      justify-items: start;
      width: max-content;
      max-width: 100%;
    }
    .filter-row select { min-height: 28px; min-width: 160px; max-width: 260px; }
    .filter-row .eq { opacity: .8; font-size: 12px; text-align: center; }
    .active-filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .active-filter {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      width: fit-content;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 12px;
    }
    .active-filter button {
      border: none;
      background: transparent;
      color: var(--vscode-errorForeground);
      cursor: pointer;
      padding: 0;
      line-height: 1;
      font-size: 13px;
    }
    .active-filter button.edit {
      color: var(--vscode-textLink-foreground);
      font-size: 11px;
    }
    .active-filter button:hover { text-decoration: underline; }
    details.tree-folder { margin: 8px 0; border-left: 2px solid var(--vscode-editorWidget-border); padding-left: 10px; }
    details.tree-folder > summary { cursor: pointer; font-weight: 600; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--plot-card-width), 1fr)); gap: 12px; margin-top: 8px; }
    figure.plot-card { margin: 0; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; overflow: hidden; background: var(--vscode-editor-background); }
    img { width: 100%; display: block; background: #fff; }
    figcaption { padding: 6px 8px; font-size: 12px; border-top: 1px solid var(--vscode-editorWidget-border); word-break: break-word; }
    .caption-title { margin-bottom: 6px; }
    .badges { display: flex; flex-wrap: wrap; gap: 4px; }
    .badge { font-size: 11px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 999px; padding: 1px 6px; opacity: .95; }
    .badge strong { opacity: .85; font-weight: 600; }
    .hide-badges .badges { display: none; }
    .empty { opacity: .8; font-style: italic; margin-top: 10px; }
    #noMatchMessage { display: none; }
    #noMatchMessage.visible { display: block; }
    .viewer {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.78);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
      z-index: 1000;
      cursor: zoom-out;
    }
    .viewer.open { display: flex; }
    .viewer img {
      max-width: min(96vw, 1800px);
      max-height: 90vh;
      width: auto;
      height: auto;
      object-fit: contain;
      border-radius: 6px;
      box-shadow: 0 0 0 1px rgba(255,255,255,.2);
      background: #fff;
    }
    .viewer .caption {
      position: absolute;
      bottom: 10px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,.6);
      color: #fff;
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 12px;
      max-width: 90vw;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <div class="header">
    <h2>Scenario: ${escapeHtml(scenarioName)}</h2>
    <div class="subline"><strong>Run:</strong> ${escapeHtml(runName)}</div>
    <div class="path">${escapeHtml(runUri.fsPath)}</div>
  </div>

  <details class="panel" open>
    <summary>View & Filter Options</summary>
    <div class="controls">
      <label for="imageSize">Image size</label>
      <input id="imageSize" type="range" min="140" max="520" step="10" value="240" />
      <span id="imageSizeValue" class="value">240px</span>
      <button id="toggleBadges" type="button" class="ghost">Show badges</button>
      <button id="clearFilters" type="button" class="ghost">Clear filters</button>
    </div>
    <div class="filter-section-title">Filter by parameter combinations</div>
    <div id="filterBuilder" class="filter-builder">
      <div class="filter-row">
        <select id="filterFieldSelect"></select>
        <span class="eq">=</span>
        <select id="filterValueSelect"></select>
        <button id="addFilter" type="button">Add filter</button>
      </div>
      <div id="activeFilters" class="active-filters"></div>
    </div>
  </details>

  ${sections}
  <div id="noMatchMessage" class="empty">No plots match the selected parameter filters.</div>

  <div id="viewer" class="viewer" aria-hidden="true">
    <img id="viewerImage" alt="" />
    <div id="viewerCaption" class="caption"></div>
  </div>

  <script>
    const slider = document.getElementById('imageSize');
    const valueLabel = document.getElementById('imageSizeValue');
    const toggleBadges = document.getElementById('toggleBadges');
    const clearFilters = document.getElementById('clearFilters');
    const filterBuilder = document.getElementById('filterBuilder');
    const filterFieldSelect = document.getElementById('filterFieldSelect');
    const filterValueSelect = document.getElementById('filterValueSelect');
    const addFilter = document.getElementById('addFilter');
    const activeFilters = document.getElementById('activeFilters');
    const noMatchMessage = document.getElementById('noMatchMessage');

    const figures = Array.from(document.querySelectorAll('figure.plot-card'));
    const folderDetails = Array.from(document.querySelectorAll('details.tree-folder'));
    const activeRules = [];
    let badgesVisible = false;

    const readFigureMetadata = figure => {
      const raw = figure.dataset.meta;
      if (!raw) {
        return {};
      }
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    };

    const applySize = () => {
      const next = Number(slider.value);
      document.documentElement.style.setProperty('--plot-card-width', next + 'px');
      valueLabel.textContent = next + 'px';
    };
    slider.addEventListener('input', applySize);
    applySize();

    const setBadgeVisibility = () => {
      document.body.classList.toggle('hide-badges', !badgesVisible);
      toggleBadges.textContent = badgesVisible ? 'Hide badges' : 'Show badges';
    };
    toggleBadges.addEventListener('click', () => {
      badgesVisible = !badgesVisible;
      setBadgeVisibility();
    });
    setBadgeVisibility();

    const collectFilterOptions = () => {
      const optionsByField = new Map();
      for (const figure of figures) {
        const metadata = readFigureMetadata(figure);
        for (const [key, value] of Object.entries(metadata)) {
          if (!optionsByField.has(key)) {
            optionsByField.set(key, new Set());
          }
          optionsByField.get(key).add(String(value));
        }
      }
      return optionsByField;
    };

    const optionsByField = collectFilterOptions();

    const sortedFields = () => Array.from(optionsByField.keys()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const sortedValuesForField = field =>
      Array.from(optionsByField.get(field) || []).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    const renderValueOptions = field => {
      filterValueSelect.innerHTML = '';
      for (const value of sortedValuesForField(field)) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        filterValueSelect.appendChild(option);
      }
    };

    const renderFieldOptions = () => {
      filterFieldSelect.innerHTML = '';
      for (const field of sortedFields()) {
        const option = document.createElement('option');
        option.value = field;
        option.textContent = field;
        filterFieldSelect.appendChild(option);
      }
      if (filterFieldSelect.options.length > 0) {
        renderValueOptions(filterFieldSelect.value);
      }
    };

    const renderActiveRules = () => {
      activeFilters.innerHTML = '';
      if (activeRules.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No filters applied.';
        activeFilters.appendChild(empty);
        return;
      }
      activeRules.forEach((rule, index) => {
        const chip = document.createElement('div');
        chip.className = 'active-filter';
        chip.textContent = rule.field + ' = ' + rule.value;

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.title = 'Remove filter';
        remove.setAttribute('aria-label', 'Remove filter');
        remove.textContent = 'x';
        remove.addEventListener('click', () => {
          activeRules.splice(index, 1);
          renderActiveRules();
          applyFilters();
        });
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'edit';
        edit.title = 'Edit filter';
        edit.setAttribute('aria-label', 'Edit filter');
        edit.textContent = 'edit';
        edit.addEventListener('click', () => {
          filterFieldSelect.value = rule.field;
          renderValueOptions(rule.field);
          filterValueSelect.value = rule.value;
          activeRules.splice(index, 1);
          renderActiveRules();
          applyFilters();
        });
        chip.appendChild(edit);
        chip.appendChild(remove);
        activeFilters.appendChild(chip);
      });
    };

    const buildFilterUi = () => {
      if (optionsByField.size === 0) {
        filterBuilder.innerHTML = '<div class="empty">No parsed parameters available for filtering. Configure filename parsers in the current profile.</div>';
        return;
      }

      renderFieldOptions();
      renderActiveRules();

      filterFieldSelect.addEventListener('change', () => {
        renderValueOptions(filterFieldSelect.value);
      });

      addFilter.addEventListener('click', () => {
        const field = filterFieldSelect.value;
        const value = filterValueSelect.value;
        if (!field || !value) {
          return;
        }
        const exists = activeRules.some(rule => rule.field === field && rule.value === value);
        if (!exists) {
          activeRules.push({ field, value });
          renderActiveRules();
          applyFilters();
        }
      });
    };

    const matchesSelections = metadata => {
      if (activeRules.length === 0) {
        return true;
      }
      for (const rule of activeRules) {
        const value = metadata[rule.field];
        if (value === undefined || String(value) !== rule.value) {
          return false;
        }
      }
      return true;
    };

    const updateFolderVisibility = () => {
      const sorted = [...folderDetails].sort((a, b) => b.querySelectorAll('details').length - a.querySelectorAll('details').length);
      for (const detail of sorted) {
        const directFigures = Array.from(detail.querySelectorAll(':scope > .grid > figure.plot-card'));
        const directChildren = Array.from(detail.querySelectorAll(':scope > details.tree-folder'));
        const hasVisibleFigures = directFigures.some(node => node.style.display !== 'none');
        const hasVisibleChildDetails = directChildren.some(node => node.style.display !== 'none');
        detail.style.display = hasVisibleFigures || hasVisibleChildDetails ? '' : 'none';
      }
    };

    const applyFilters = () => {
      let visibleCount = 0;
      for (const figure of figures) {
        const metadata = readFigureMetadata(figure);
        const visible = matchesSelections(metadata);
        figure.style.display = visible ? '' : 'none';
        if (visible) {
          visibleCount += 1;
        }
      }
      updateFolderVisibility();
      noMatchMessage.classList.toggle('visible', visibleCount === 0);
    };

    clearFilters.addEventListener('click', () => {
      activeRules.length = 0;
      renderActiveRules();
      applyFilters();
    });

    buildFilterUi();
    applyFilters();

    const viewer = document.getElementById('viewer');
    const viewerImage = document.getElementById('viewerImage');
    const viewerCaption = document.getElementById('viewerCaption');

    const closeViewer = () => {
      viewer.classList.remove('open');
      viewer.setAttribute('aria-hidden', 'true');
      viewerImage.removeAttribute('src');
      viewerCaption.textContent = '';
    };

    document.addEventListener('click', event => {
      const image = event.target && event.target.closest ? event.target.closest('figure img') : null;
      if (!image) {
        return;
      }
      viewerImage.src = image.src;
      viewerImage.alt = image.alt || 'plot';
      const captionNode = image.closest('figure')?.querySelector('.caption-title');
      viewerCaption.textContent = captionNode ? captionNode.textContent : '';
      viewer.classList.add('open');
      viewer.setAttribute('aria-hidden', 'false');
    });

    viewer.addEventListener('click', closeViewer);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && viewer.classList.contains('open')) {
        closeViewer();
      }
    });
  </script>
</body>
</html>`;
}

function resolveScenarioNameFromRunPath(runPath: string): string {
    const ioFolder = path.dirname(runPath);
    const scenarioFolder = path.dirname(ioFolder);
    const scenarioName = path.basename(scenarioFolder);
    return scenarioName || 'unknown-scenario';
}

function renderFolder(
    webview: vscode.Webview,
    runUri: vscode.Uri,
    folder: PlotFolderNode,
    fileMetadataByRelativePath: Map<string, ParsedOutputFileMetadata>,
    folderMetadataByRelativePath: Map<string, ParsedOutputFolderMetadata>,
    isRoot = false
): string {
    const fileCards = folder.files
        .map(file => {
            const relFile = folder.relativePath ? path.join(folder.relativePath, file) : file;
            const fileUri = vscode.Uri.file(path.join(runUri.fsPath, relFile));
            const src = webview.asWebviewUri(fileUri);
            const metadata = fileMetadataByRelativePath.get(normalizePathKey(relFile));
            const label = metadata?.title?.trim() || path.parse(file).name;
            const badges = metadata ? renderMetadataBadges(metadata) : '';
            const metadataForCard = metadata ? { parser: metadata.parserId, ...metadata.extracted } : {};
            const metadataJson = JSON.stringify(metadataForCard);
            return `<figure class="plot-card" data-meta="${escapeAttribute(metadataJson)}"><img src="${src}" alt="${escapeHtml(file)}" loading="lazy" /><figcaption><div class="caption-title">${escapeHtml(label)}</div>${badges}</figcaption></figure>`;
        })
        .join('');

    const folderSections = folder.folders
        .map(child => renderFolder(webview, runUri, child, fileMetadataByRelativePath, folderMetadataByRelativePath, false))
        .join('');

    const content = `${fileCards ? `<div class="grid">${fileCards}</div>` : ''}${folderSections}`;
    if (isRoot) {
        return content || '<div class="empty">No plot images found in this output run folder.</div>';
    }

    const folderMetadata = folderMetadataByRelativePath.get(normalizePathKey(folder.relativePath));
    const folderLabel = folderMetadata?.title?.trim() || folder.name;
    const folderBadges = folderMetadata ? renderMetadataBadgesInline(folderMetadata) : '';
    return `<details class="tree-folder"><summary><span>${escapeHtml(folderLabel)}</span>${folderBadges}</summary>${content || '<div class="empty">No images in this folder.</div>'}</details>`;
}

function buildFileMetadataLookup(
    runPath: string,
    metadata: ParsedOutputFileMetadata[]
): Map<string, ParsedOutputFileMetadata> {
    const map = new Map<string, ParsedOutputFileMetadata>();
    for (const item of metadata) {
        const relative = normalizePathKey(path.relative(runPath, item.filePath));
        map.set(relative, item);
    }
    return map;
}

function buildFolderMetadataLookup(
    runPath: string,
    metadata: ParsedOutputFolderMetadata[]
): Map<string, ParsedOutputFolderMetadata> {
    const map = new Map<string, ParsedOutputFolderMetadata>();
    for (const item of metadata) {
        const relative = normalizePathKey(path.relative(runPath, item.folderPath));
        map.set(relative, item);
    }
    return map;
}

function renderMetadataBadges(metadata: ParsedOutputFileMetadata): string {
    const entries = Object.entries(metadata.extracted);
    if (entries.length === 0) {
        return '';
    }

    const parserBadge = `<span class="badge"><strong>parser</strong>: ${escapeHtml(metadata.parserId)}</span>`;
    const valueBadges = entries
        .map(([key, value]) => `<span class="badge"><strong>${escapeHtml(key)}</strong>: ${escapeHtml(String(value))}</span>`)
        .join('');
    return `<div class="badges">${parserBadge}${valueBadges}</div>`;
}

function renderMetadataBadgesInline(metadata: ParsedOutputFileMetadata | ParsedOutputFolderMetadata): string {
    const entries = Object.entries(metadata.extracted);
    if (entries.length === 0) {
        return '';
    }

    const parserBadge = `<span class="badge"><strong>parser</strong>: ${escapeHtml(metadata.parserId)}</span>`;
    const valueBadges = entries
        .map(([key, value]) => `<span class="badge"><strong>${escapeHtml(key)}</strong>: ${escapeHtml(String(value))}</span>`)
        .join('');
    return `<span class="badges">${parserBadge}${valueBadges}</span>`;
}

function normalizePathKey(value: string): string {
    return value.replace(/\\/g, '/');
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => {
        switch (char) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            default:
                return '&#39;';
        }
    });
}
