import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
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

// Open one standalone analysis panel for a specific scenario output run folder.
export async function openRunAnalysisPanel(runUri: vscode.Uri): Promise<void> {
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
    panel.webview.html = buildHtml(panel.webview, scenarioName, runName, runUri, tree);
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
    root: PlotFolderNode
): string {
    const sections = renderFolder(webview, runUri, root, true);
    return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { --plot-card-width: 240px; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
    h2 { margin: 0 0 8px 0; font-size: 16px; }
    .muted { opacity: .8; margin-bottom: 12px; }
    .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .toolbar input[type="range"] { width: 220px; }
    .toolbar .value { min-width: 44px; opacity: .85; }
    details { margin: 8px 0; border-left: 2px solid var(--vscode-editorWidget-border); padding-left: 10px; }
    summary { cursor: pointer; font-weight: 600; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--plot-card-width), 1fr)); gap: 12px; margin-top: 8px; }
    figure { margin: 0; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; overflow: hidden; background: var(--vscode-editor-background); }
    img { width: 100%; display: block; background: #fff; }
    figcaption { padding: 6px 8px; font-size: 12px; border-top: 1px solid var(--vscode-editorWidget-border); word-break: break-word; }
    .empty { opacity: .8; font-style: italic; margin-top: 10px; }
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
  <h2>${escapeHtml(scenarioName)} / ${escapeHtml(runName)}</h2>
  <div class="muted">${escapeHtml(runUri.fsPath)}</div>
  <div class="toolbar">
    <label for="imageSize">Image size</label>
    <input id="imageSize" type="range" min="140" max="520" step="10" value="240" />
    <span id="imageSizeValue" class="value">240px</span>
  </div>
  ${sections}
  <div id="viewer" class="viewer" aria-hidden="true">
    <img id="viewerImage" alt="" />
    <div id="viewerCaption" class="caption"></div>
  </div>
  <script>
    const slider = document.getElementById('imageSize');
    const valueLabel = document.getElementById('imageSizeValue');
    const applySize = () => {
      const next = Number(slider.value);
      document.documentElement.style.setProperty('--plot-card-width', next + 'px');
      valueLabel.textContent = next + 'px';
    };
    slider.addEventListener('input', applySize);
    applySize();

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
      const captionNode = image.closest('figure')?.querySelector('figcaption');
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

function renderFolder(webview: vscode.Webview, runUri: vscode.Uri, folder: PlotFolderNode, isRoot = false): string {
    const fileCards = folder.files
        .map(file => {
            const relFile = folder.relativePath ? path.join(folder.relativePath, file) : file;
            const fileUri = vscode.Uri.file(path.join(runUri.fsPath, relFile));
            const src = webview.asWebviewUri(fileUri);
            const label = path.parse(file).name;
            return `<figure><img src="${src}" alt="${escapeHtml(file)}" loading="lazy" /><figcaption>${escapeHtml(label)}</figcaption></figure>`;
        })
        .join('');

    const folderSections = folder.folders
        .map(child => renderFolder(webview, runUri, child, false))
        .join('');

    const content = `${fileCards ? `<div class="grid">${fileCards}</div>` : ''}${folderSections}`;
    if (isRoot) {
        return content || '<div class="empty">No plot images found in this output run folder.</div>';
    }

    return `<details open><summary>${escapeHtml(folder.relativePath || folder.name)}</summary>${content || '<div class="empty">No images in this folder.</div>'}</details>`;
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
