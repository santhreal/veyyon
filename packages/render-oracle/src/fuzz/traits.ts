import type { EnvMode, Scenario, ScenarioTag, TerminalMode, TerminalStressTraits } from "./types";

export function isEd3RiskScenario(terminalMode: TerminalMode, envMode: EnvMode): boolean {
	return (
		terminalMode === "unknown" &&
		(envMode === "appleTerminal" || envMode === "iterm2" || envMode === "wsl" || envMode === "ghostty")
	);
}

export function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${String(value)}`);
}

export function terminalStressTraits(scenario: Scenario): TerminalStressTraits {
	return {
		preservesPaneHistory: scenario.envMode === "tmux",
		strictNativeScrollback: scenario.strictScrollback,
		syncOutputDisabled: scenario.envMode === "vteNoSync",
		viewportProbe: scenario.terminalMode === "normal" ? "known" : scenario.terminalMode,
		ed3ScrollbackEraseRisk: isEd3RiskScenario(scenario.terminalMode, scenario.envMode),
		conptyHostScrollbackUnobservable: scenario.platform === "win32" && scenario.terminalMode === "unknown",
		foregroundStreaming: scenario.foregroundStream,
	};
}

export function scenarioTags(
	template: Pick<Scenario, "envMode" | "terminalMode" | "geometryMode">,
	strictNativeScrollback: boolean,
	foregroundStreaming: boolean,
): readonly ScenarioTag[] {
	const tags: ScenarioTag[] = [template.geometryMode];
	if (template.envMode === "tmux") tags.push("tmux");
	if (strictNativeScrollback) tags.push("strictScrollback");
	if (template.terminalMode !== "normal") tags.push("unknownViewport");
	if (foregroundStreaming) tags.push("foregroundStream");
	if (isEd3RiskScenario(template.terminalMode, template.envMode)) tags.push("ed3Risk");
	return tags;
}
