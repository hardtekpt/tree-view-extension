# Scenario Toolkit

Scenario Toolkit is a VS Code extension for Python scenario-driven projects.  
It adds a dedicated Toolkit sidebar to manage source files, scenarios, scenario outputs, tags, and workspace snapshots.

## Project Layout Expectations

Scenario Toolkit now uses **Program Profiles** instead of fixed extension settings.

Each profile defines the structure for one Python program, including:

- base path
- Python strategy/path
- scenarios root
- per-scenario config folder name
- per-scenario output folder name
- run command template
- optional filename metadata parsers (template/regex based) to extract encoded plot/output parameters

Profile files are stored in the extension global storage (persistent, outside your program folders).

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
  - Analyze output run plots in a dedicated editor webview (one panel per click).
  - Pin scenarios and output runs.
  - Sort scenarios and per-scenario output runs.
  - Tag output runs (catalog + assignment + filtering).

- Config Inspector:
  - Webview editor for XML config parameters.
  - Auto-refresh and auto-save on edits.
  - File/parameter filtering and parameter pinning.

- Workspace Snapshot:
  - Save/load/reset full extension state to/from JSON.
  - Supports a default workspace config and custom workspace config files.
  - Includes Source Explorer and Scenarios tree expansion state, view visibility state, run/tag/filter/sort/pin state, and global run flags.

## Settings

Project-specific configuration is no longer read from extension settings.

Use Program Profile commands from the Command Palette to create, edit, bind, and validate program structure.

## Installation (From Source)

1. `npm install`
2. `npm run compile`
3. Open the repository in VS Code.
4. Press `F5` to launch the Extension Host.
5. In the Extension Host, run `Program Profiles: Create` for your opened workspace folder.

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

## Command Palette Commands

Workspace actions:

- `Save Workspace`
- `Load Workspace`
- `Refresh Toolkit`
- `Reset Workspace`

## Workspace Config Behavior

The workspace snapshot feature persists extension state to a JSON file.

### Default vs custom workspace config

- Default config path:
  - `<basePath>/.scenario-toolkit/workspace.json`
- You can also save/load custom workspace config files anywhere.
- The extension always tracks one active workspace config file.

### Active config rules

- Autosave always writes to the active workspace config file.
- `Save Workspace`:
  - Writes to the selected file and makes it active.
- `Load Workspace`:
  - Loads the selected file and makes it active.
- `Reset Workspace`:
  - Resets extension state and writes the reset state into the current active file.

### Startup behavior

- On startup, the extension attempts to load the last active workspace config path first.
- If that file is missing, it falls back to the default config path.
- If the default file is missing, it creates it and sets it active.
- Workspace initialization is ordered to avoid startup autosave overwriting a saved config.

### What is saved

- `devArea`: Development Area file list.
- `scenario`: Scenario state:
  - scenario filter
  - scenario/run sorting
  - scenario/run pinning
  - tag catalog, tag assignments, tag filters
  - global run flags
  - sudo execution per scenario
- `treeViews`:
  - `srcExplorerExpanded`
  - `scenarioExplorerExpanded`
  - `componentViews` visibility flags:
    - `devAreaVisible`
    - `srcExplorerVisible`
    - `scenarioExplorerVisible`
    - `programInfoVisible`
    - `configInspectorVisible`

### Notes

- Program Info tree expansion state is intentionally not persisted; it always uses default collapse behavior.
- If `srcExplorerVisible` is false, Source Explorer expanded paths are treated as empty in saved state for consistency.

Program Profile actions:

- `Program Profiles: Create`
- `Program Profiles: Edit Current`
- `Program Profiles: Rebind Current Workspace`
- `Program Profiles: Validate Current`

Filename metadata parser templates:

- During profile create/edit, you can configure output filename parser templates.
- Supported pattern styles:
  - token template: `loss_{scenario}_{metric}_{epoch}.png`
  - regex template: `regex:^loss_(?<scenario>.+)_(?<epoch>\\d+)\\.png$`
- Supported field types: `string`, `number`, `enum`, `datetime`.
- Parsed metadata is indexed and cached by the extension and exposed through scenario provider APIs for analyzer integration.

How to add a filename template to the current profile:

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run `Program Profiles: Edit Current`.
3. Continue through base profile prompts until `Filename metadata parser templates`.
4. Choose:
`Replace parser templates` to define a new set, or `Keep existing` to keep current templates.
5. Add parser data:
`Parser id`: example `plot_metric_parser`.
`Pattern`: token style like `asmhdkafjh_{param}_{id}_{metric}_{name}.png`.
6. Add fields for each placeholder:
`param` -> `number` or `string`.
`id` -> `number`.
`metric` -> `string`.
`name` -> `string`.
7. Optionally set `appliesTo` rules (example: `.png`), or leave empty for all files.
8. Choose `Done` to finish fields and parsers.
9. Save profile and run `Program Profiles: Validate Current`.

Regex example for compact filename tokens (e.g. `param02`, `id35`):

- `regex:^asmhdkafjh_param(?<param>\\d+)_id(?<id>\\d+)_(?<metric>[^_]+)_(?<name>.+)\\.png$`

Startup behavior:

- On activation (and workspace-folder changes), the extension checks if the current workspace has a bound profile.
- If no profile is bound, it prompts you to create a custom profile or skip.

Quick keywords:

- `workspace save`
- `workspace load`
- `refresh toolkit`
- `workspace reset`
- `program profiles create`
- `program profiles edit`
- `program profiles rebind`
- `program profiles validate`

## Refactored Architecture

- `src/extension.ts`: activation and composition.
- `src/extension/watchers.ts`: file-watcher lifecycle.
- `src/extension/treeReveal.ts`: expanded-node replay.
- `src/commands/registerCommands.ts`: command registrations.
- `src/commands/commandArgs.ts`: shared command-argument normalization.
- `src/profile/profileManager.ts`: profile persistence, workspace binding, wizard, validation.
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
