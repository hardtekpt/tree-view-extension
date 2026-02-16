# Scenario Toolkit

Scenario Toolkit is a VS Code extension for Python scenario-driven projects.  
It adds a dedicated Toolkit sidebar to manage source files, scenarios, scenario outputs, tags, and workspace snapshots.

## Project Layout Expectations

Set `scenarioToolkit.basePath` to a root folder with this structure:

- `<basePath>/src` (source code)
- `<basePath>/scenarios/<scenario>/configs` (XML config files)
- `<basePath>/scenarios/<scenario>/io` (output run folders/files)

## Core Features

- Development Area:
  - Personal shortlist of files.
  - Drag-and-drop support from Source Explorer.
  - Remove individual files or clear all.

- Source Explorer:
  - Browses from `<basePath>` root.
  - Drag-and-drop to move files/folders.
  - Toggle files into Development Area.

- Scenario Explorer:
  - Run scenarios (normal, sudo, detached `screen`).
  - Global run flags action in Scenarios view title.
  - Scenario CRUD: duplicate, rename, delete.
  - Output run CRUD: rename, delete, open `.log`.
  - Pin scenarios and output runs.
  - Sort scenarios and per-scenario output runs.
  - Tag output runs (catalog + assignment + filtering).

- Config Inspector:
  - Webview editor for XML config parameters.
  - Auto-refresh and auto-save on edits.
  - File/parameter filtering and parameter pinning.

- Workspace Snapshot:
  - Save/load/reset full extension state to/from JSON.
  - Includes tree expansion state, run/tag/filter/sort/pin state, and global run flags.

## Settings

- `scenarioToolkit.basePath`: project root path.
- `scenarioToolkit.pythonCommand`: Python executable fallback (used if no venv auto-detected).
- `scenarioToolkit.runScript`: script path relative to base path (default `run.py`).

## Installation (From Source)

1. `npm install`
2. `npm run compile`
3. Open the repository in VS Code.
4. Press `F5` to launch the Extension Host.
5. In the Extension Host, set `scenarioToolkit.basePath`.

## Packaging (.vsix)

### 1. Prerequisites

1. Set a real publisher in `package.json` (do not keep `undefined_publisher`).
2. Build:
   - `npm install`
   - `npm run compile`

### 2. Create the package

1. Install VS Code packaging tool (once):
   - `npm i -D @vscode/vsce`
2. Create `.vsix`:
   - `npx @vscode/vsce package`

### 3. Install the package locally

1. In VS Code:
   - `Extensions: Install from VSIX...`
2. Select the generated `.vsix` file.

## Toolbar Behavior (No Proposed API)

The extension now uses only stable VS Code menu contributions (`menus.view/title`).

- Workspace actions (Save, Load, Refresh, Reset) are available in each Toolkit view title:
  - Development Area
  - Source Explorer
  - Scenarios
  - Config Inspector
- This works in both development (`F5`) and packaged `.vsix` installs.
- No `--enable-proposed-api` launch flag is required.

## Refactored Architecture

- `src/extension.ts`: activation and composition.
- `src/extension/watchers.ts`: file-watcher lifecycle.
- `src/extension/treeReveal.ts`: expanded-node replay.
- `src/commands/registerCommands.ts`: command registrations.
- `src/commands/commandArgs.ts`: shared command-argument normalization.
- `src/providers/devProvider.ts`: Development Area provider.
- `src/providers/srcProvider.ts`: Source Explorer provider + DnD.
- `src/providers/scenarioProvider.ts`: Scenario feature orchestration.
- `src/providers/scenario/runtimeUtils.ts`: run/process/config/runtime helpers.
- `src/providers/scenario/treeUtils.ts`: scenario tree sorting/filter/root helpers.
- `src/providers/scenario/tagUtils.ts`: tag normalization/formatting.
- `src/workspace/workspaceManager.ts`: save/load/reset workflow.
- `src/workspace/workspaceFilePicker.ts`: save/open dialog + default path logic.
- `src/configInspector/configInspectorProvider.ts`: webview controller.
- `src/configInspector/webviewHtml.ts`: webview HTML template.
- `src/configInspector/xmlParameters.ts`: XML parse/update utilities.

## Notes

- Tree item descriptions cannot render arbitrary rich components, so run tags are text-based chips.
- Item inline icons are preserved and continue to work as before.
