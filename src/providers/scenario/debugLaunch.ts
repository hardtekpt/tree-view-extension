import type * as vscode from 'vscode';

export const SCENARIO_TOOLKIT_DEBUG_ID = 'scenario-toolkit';

export type DebugRunTarget =
    | { kind: 'program'; program: string; args: string[] }
    | { kind: 'module'; module: string; args: string[] };

interface BuildDebugConfigurationInput {
    basePath: string;
    python: string;
    scenarioName: string;
    useSudo: boolean;
    debugTarget: DebugRunTarget;
    extraArgs: string[];
    configurationName: string;
}

export function buildScenarioConfigurationName(scenarioName: string): string {
    return `Scenario Toolkit: ${scenarioName}`;
}

export function createScenarioDebugLaunchConfiguration(
    input: BuildDebugConfigurationInput
): vscode.DebugConfiguration {
    const args = [...input.debugTarget.args, ...input.extraArgs];
    const configuration: vscode.DebugConfiguration = {
        type: 'debugpy',
        request: 'launch',
        name: input.configurationName,
        cwd: input.basePath,
        python: input.python,
        console: 'integratedTerminal',
        justMyCode: false,
        sudo: input.useSudo,
        scenarioToolkitId: SCENARIO_TOOLKIT_DEBUG_ID,
        scenarioToolkitScenario: input.scenarioName,
        scenarioToolkitSudo: input.useSudo
    };

    if (input.debugTarget.kind === 'program') {
        configuration.program = input.debugTarget.program;
    } else {
        configuration.module = input.debugTarget.module;
    }
    configuration.args = args;
    return configuration;
}
