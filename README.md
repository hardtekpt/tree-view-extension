# Scenario Toolkit

Scenario Toolkit is a VS Code extension that provides a tree-based UI to work with a Python project organized as:

- `src/` for source code
- `scenarios/` for scenario folders
- `scenarios/<scenario>/configs/` for configuration files
- `scenarios/<scenario>/io/` for output runs

The extension adds a dedicated sidebar with focused actions for running scenarios, browsing outputs, and managing run metadata (pinning, tags, sorting, filtering).

## Features

- **Development Area**
  - Pin source files into a personal short list.
  - Remove individual files or clear the full list.
  - Save/load the entire extension workspace state from a single file.

- **Source Explorer**
  - Browse files under `<basePath>/src`.
  - Add files directly to Development Area.

- **Scenario Explorer**
  - Browse scenario folders under `<basePath>/scenarios`.
  - Run, duplicate, rename, delete scenarios.
  - Scenario duplication keeps `io/` empty in the copied scenario.
  - Pin scenarios and output runs.
  - Sort scenarios by name or most recent.
  - Sort run outputs per scenario.
  - Open run logs, rename/delete output runs.
  - Tag output runs and filter runs by tags.
  - Static quick-tag actions (`success`, `failed`) from right-click.

- **Unified Workspace Configuration**
  - State is saved in one file:
    - `<basePath>/.scenario-toolkit/workspace.json`
  - Includes:
    - Development Area items
    - Scenario filter/sort state
    - Pinning state (scenarios and runs)
    - Tag catalog and run-tag mapping
    - Per-scenario run tag filters

## Requirements

- Visual Studio Code `^1.85.0`
- Node.js + npm (for building/running from source)
- Python environment (for scenario run command)

## Extension Settings

This extension contributes:

- `scenarioToolkit.basePath`
  - Root folder containing `src/` and `scenarios/`.
- `scenarioToolkit.pythonCommand`
  - Python executable used to run scenarios (for example `python`, `py`, `python3`).
- `scenarioToolkit.runScript`
  - Script (relative to `basePath`) used for running scenarios (default `run.py`).

## Installation

### From source (development)

1. Clone this repository.
2. Install dependencies:
   - `npm install`
3. Build:
   - `npm run compile`
4. Open this folder in VS Code.
5. Start debugging with **Run Extension** (`F5`).
6. In the Extension Host window, set:
   - `scenarioToolkit.basePath` to your Python project root.

## Usage Quick Start

1. Open the **Toolkit** view container in the Activity Bar.
2. In Settings, set `scenarioToolkit.basePath`.
3. Use top toolbar actions:
   - Save workspace
   - Load workspace
   - Refresh toolkit
4. Right-click items for full context actions (same core actions as inline icons, plus extra run/tag shortcuts where applicable).

## Development Notes

- Main activation entrypoint: `src/extension.ts`
- Command wiring: `src/commands/registerCommands.ts`
- Providers:
  - `src/providers/devProvider.ts`
  - `src/providers/srcProvider.ts`
  - `src/providers/scenarioProvider.ts`
- Scenario provider supporting modules:
  - `src/providers/scenario/types.ts`
  - `src/providers/scenario/storageKeys.ts`
  - `src/providers/scenario/tagUtils.ts`

## Known Limitations

- VS Code TreeView does not support fully custom rich text backgrounds for description text. Tag chips are rendered using text and symbols for compatibility.
- Container-level toolbar uses proposed API in development configuration.

