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
    .table-wrap { overflow-x: auto; max-width: 100%; padding-bottom: 4px; }
    table { width: max-content; min-width: 100%; border-collapse: collapse; table-layout: auto; }
    th, td { border-bottom: 1px solid var(--vscode-editorWidget-border); text-align: left; padding: 6px 4px; white-space: nowrap; }
    input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px; box-sizing: border-box; }
    .value-input { width: var(--value-input-width, 16ch); min-width: 0; }
    .parameter-cell { width: max-content; }
    .value-cell { width: max-content; }
    .muted { opacity: .8; margin-bottom: 8px; }
    .pin-btn { background: transparent; border: none; cursor: pointer; color: inherit; padding: 0 4px; }
    .property-btn { background: transparent; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; font: inherit; text-align: left; white-space: nowrap; }
    .property-btn:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div id="meta" class="muted"></div>
  <div id="message" class="muted"></div>
  <div class="toolbar">
    <input id="paramFilter" placeholder="Filter by parameter..." />
    <button id="clearFilters" title="Clear filters">Clear</button>
  </div>
  <div class="table-wrap">
    <table id="table">
      <thead>
        <tr>
          <th></th>
          <th>Parameter</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const tbody = document.querySelector('tbody');
    const meta = document.getElementById('meta');
    const message = document.getElementById('message');
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
      const visibleRows = sortedRows.filter(row => !paramTerm || row.parameterPath.toLowerCase().includes(paramTerm));
      const maxValueChars = visibleRows.reduce((max, row) => Math.max(max, (row.value || '').length), 0);
      const inputWidthChars = Math.max(8, maxValueChars + 2);
      document.documentElement.style.setProperty('--value-input-width', inputWidthChars + 'ch');

      for (const row of visibleRows) {
        const tr = document.createElement('tr');
        const pinClass = state.pinnedIds.has(row.id) ? 'codicon-pinned' : 'codicon-pin';
        tr.innerHTML = '<td><button class="pin-btn" data-id="' + escapeHtml(row.id) + '" title="Toggle pin"><span class="codicon ' + pinClass + '"></span></button></td><td class="parameter-cell"><button class="property-btn" data-id="' + escapeHtml(row.id) + '" title="Open in editor">' + escapeHtml(row.parameterPath) + '</button></td>';
        const td = document.createElement('td');
        td.className = 'value-cell';
        const input = document.createElement('input');
        input.className = 'value-input';
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

      if (input.id === 'paramFilter') {
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
      if (pinButton) {
        const id = pinButton.dataset.id;
        if (!id) {
          return;
        }
        vscode.postMessage({ type: 'togglePin', id });
        return;
      }

      const propertyButton = target && target.closest ? target.closest('.property-btn') : null;
      if (!propertyButton) {
        return;
      }
      const id = propertyButton.dataset.id;
      if (!id) {
        return;
      }
      vscode.postMessage({ type: 'openParameter', id });
    });

    clearFilters.addEventListener('click', () => {
      paramFilter.value = '';
      renderRows();
    });

    window.addEventListener('message', event => render(event.data));
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
