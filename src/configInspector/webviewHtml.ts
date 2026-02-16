// Build the Config Inspector webview HTML with inline script/styles.
export function getConfigInspectorHtml(nonce: string, codiconCssUri: string): string {
    return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${codiconCssUri}" rel="stylesheet" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 10px; }
    button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 4px 10px; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--vscode-editorWidget-border); text-align: left; padding: 6px 4px; }
    input { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px; }
    .muted { opacity: .8; margin-bottom: 8px; }
    .pin-btn { background: transparent; border: none; cursor: pointer; color: inherit; padding: 0 4px; }
  </style>
</head>
<body>
  <div id="meta" class="muted"></div>
  <div id="message" class="muted"></div>
  <div class="toolbar">
    <input id="fileFilter" placeholder="Filter by file..." />
    <input id="paramFilter" placeholder="Filter by parameter..." />
    <button id="clearFilters" title="Clear filters">Clear</button>
  </div>
  <table id="table">
    <thead>
      <tr>
        <th></th>
        <th>File</th>
        <th>Parameter</th>
        <th>Value</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const tbody = document.querySelector('tbody');
    const meta = document.getElementById('meta');
    const message = document.getElementById('message');
    const fileFilter = document.getElementById('fileFilter');
    const paramFilter = document.getElementById('paramFilter');
    const clearFilters = document.getElementById('clearFilters');
    const state = { rows: [], pinnedIds: new Set() };

    function render(payload) {
      state.rows = payload.rows || [];
      state.pinnedIds = new Set(payload.pinnedIds || []);
      meta.textContent = payload.folderName ? 'Editing: ' + payload.folderName : '';
      message.textContent = payload.message || '';
      renderRows();
    }

    function renderRows() {
      const fileTerm = (fileFilter.value || '').trim().toLowerCase();
      const paramTerm = (paramFilter.value || '').trim().toLowerCase();
      tbody.innerHTML = '';
      const sortedRows = [...state.rows].sort((a, b) => {
        const aPinned = state.pinnedIds.has(a.id);
        const bPinned = state.pinnedIds.has(b.id);
        if (aPinned !== bPinned) {
          return aPinned ? -1 : 1;
        }
        const fileCmp = a.fileName.localeCompare(b.fileName);
        if (fileCmp !== 0) {
          return fileCmp;
        }
        return a.parameterPath.localeCompare(b.parameterPath);
      });

      for (const row of sortedRows) {
        if (fileTerm && !row.fileName.toLowerCase().includes(fileTerm)) {
          continue;
        }
        if (paramTerm && !row.parameterPath.toLowerCase().includes(paramTerm)) {
          continue;
        }
        const tr = document.createElement('tr');
        const pinClass = state.pinnedIds.has(row.id) ? 'codicon-pinned' : 'codicon-pin';
        tr.innerHTML = '<td><button class="pin-btn" data-id="' + escapeHtml(row.id) + '" title="Toggle pin"><span class="codicon ' + pinClass + '"></span></button></td><td>' + escapeHtml(row.fileName) + '</td><td>' + escapeHtml(row.parameterPath) + '</td>';
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.value = row.value;
        input.dataset.id = row.id;
        td.appendChild(input);
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
    }

    function escapeHtml(value) {
      return value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',\"'\":'&#39;'}[c]));
    }

    let pending = new Map();
    let timer = null;
    function flush() {
      for (const [id, value] of pending.entries()) {
        vscode.postMessage({ type: 'update', id, value });
      }
      pending.clear();
      timer = null;
    }

    document.addEventListener('input', event => {
      const input = event.target;
      if (!input || input.tagName !== 'INPUT') {
        return;
      }

      if (input.id === 'fileFilter' || input.id === 'paramFilter') {
        renderRows();
        return;
      }

      pending.set(input.dataset.id, input.value);
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(flush, 200);
    });

    document.addEventListener('click', event => {
      const target = event.target;
      const pinButton = target && target.closest ? target.closest('.pin-btn') : null;
      if (!pinButton) {
        return;
      }
      const id = pinButton.dataset.id;
      if (!id) {
        return;
      }
      vscode.postMessage({ type: 'togglePin', id });
    });

    clearFilters.addEventListener('click', () => {
      fileFilter.value = '';
      paramFilter.value = '';
      renderRows();
    });

    window.addEventListener('message', event => render(event.data));
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
