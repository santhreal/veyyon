import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	BASE_SEEDS,
	CORE_BULK_MAX,
	CORE_ITERATIONS,
	CORE_TIMEOUT_MS,
	REGRESSION_REPLAYS,
	SOAK_BULK_MAX,
	SOAK_ITERATIONS,
	SOAK_TIMEOUT_MS,
} from "./constants";
import type { OperationLogEntry } from "./operations";
import { maxOf, parsePositiveInt } from "./snapshot";
import { coreTemplates, soakTemplates } from "./templates";
import { scenarioTags } from "./traits";
import type { EnvKey, EnvMode, OperationKind, Scenario } from "./types";
import { isOperationKind } from "./types";

export function scenarioEnv(envMode: EnvMode): Record<EnvKey, string | undefined> {
	return {
		TMUX: envMode === "tmux" ? "1" : undefined,
		STY: undefined,
		ZELLIJ: undefined,
		TERMUX_VERSION: envMode === "termux" ? "0.118.0" : undefined,
		WEZTERM_PANE: undefined,
		KITTY_WINDOW_ID: undefined,
		GHOSTTY_RESOURCES_DIR: envMode === "ghostty" ? "/Applications/Ghostty.app/Contents/Resources" : undefined,
		ALACRITTY_WINDOW_ID: undefined,
		VTE_VERSION: envMode === "vteNoSync" ? "6800" : undefined,
		VEYYON_NO_SYNC_OUTPUT: envMode === "vteNoSync" ? "1" : undefined,
		TERM_PROGRAM: envMode === "appleTerminal" ? "Apple_Terminal" : envMode === "iterm2" ? "iTerm.app" : undefined,
		ITERM_SESSION_ID: envMode === "iterm2" ? "w0t0p0" : undefined,
		// WSL fronted by Windows Terminal: WT propagates WT_SESSION into the
		// Linux environment, and WSL sets its own distro markers. See #1610.
		WT_SESSION: envMode === "wsl" ? "5ca7376f-cd1b-4524-a45a-7e87b06b8f9e" : undefined,
		WSL_DISTRO_NAME: envMode === "wsl" ? "Ubuntu" : undefined,
		WSL_INTEROP: envMode === "wsl" ? "/run/WSL/8_interop" : undefined,
	};
}

export function buildScenarios(): Scenario[] {
	const soak = Bun.env.TUI_STRESS_SOAK === "1";
	const templates = soak ? soakTemplates() : coreTemplates();
	const replay = parseReplay(templates);
	const replayOperations = parseReplayOperations();
	if (replayOperations !== null && replay === null) {
		throw new Error("TUI_STRESS_REPLAY_LOG requires TUI_STRESS_REPLAY to select the scenario and seed");
	}
	if (replay !== null) {
		const maxHeight = maxOf(replay.template.heightChoices);
		return [
			materializeScenario(
				replay.template,
				replay.seed,
				replayOperations?.length ?? replay.iterations,
				SOAK_BULK_MAX,
				SOAK_TIMEOUT_MS,
				maxHeight,
				replayOperations ?? undefined,
			),
		];
	}
	const defaultSeedCount = Math.max(BASE_SEEDS.length, templates.length);
	const seedCount = parsePositiveInt("TUI_STRESS_SEEDS", defaultSeedCount);
	const iterations = parsePositiveInt("TUI_STRESS_ITER", soak ? SOAK_ITERATIONS : CORE_ITERATIONS);
	const bulkMax = soak ? SOAK_BULK_MAX : CORE_BULK_MAX;
	const baseIterations = soak ? SOAK_ITERATIONS : CORE_ITERATIONS;
	const baseTimeoutMs = soak ? SOAK_TIMEOUT_MS : CORE_TIMEOUT_MS;
	// Higher-iteration hunts scale worse than linearly because exhaustive
	// scrollback probes and resize/overlay rebuilds revisit larger buffers.
	const timeoutMs = Math.max(baseTimeoutMs, Math.ceil((baseTimeoutMs * iterations * 3) / baseIterations));
	const seeds = buildSeeds(seedCount);
	const scenarios: Scenario[] = [];
	for (let i = 0; i < seeds.length; i++) {
		const template = templates[i % templates.length]!;
		const maxHeight = maxOf(template.heightChoices);
		scenarios.push(materializeScenario(template, seeds[i]!, iterations, bulkMax, timeoutMs, maxHeight));
	}
	for (const pinned of REGRESSION_REPLAYS) {
		const template = templates.find(t => t.name === pinned.template);
		if (template === undefined) continue; // soak template set may not carry it
		if (scenarios.some(s => s.name === pinned.template && s.seed === pinned.seed)) continue;
		const maxHeight = maxOf(template.heightChoices);
		scenarios.push(materializeScenario(template, pinned.seed, iterations, bulkMax, timeoutMs, maxHeight));
	}
	return scenarios;
}

export function materializeScenario(
	template: ScenarioTemplate,
	seed: number,
	iterations: number,
	bulkMax: number,
	timeoutMs: number,
	maxHeight: number,
	replayOperations?: readonly OperationKind[],
): Scenario {
	const strictScrollback =
		template.envMode !== "tmux" && template.terminalMode === "normal" && template.platform !== "win32";
	const foregroundStream = template.foregroundStream ?? false;
	const reflow = template.reflow ?? false;
	return {
		...template,
		seed,
		iterations,
		bulkMax,
		scrollback: template.scrollbackRows ?? Math.max(10_000, maxHeight + 64 + iterations * (bulkMax + 8)),
		strictScrollback,
		timeoutMs,
		uniqueContent: template.uniqueContent ?? false,
		foregroundStream,
		reflow,
		tags: scenarioTags(template, strictScrollback, foregroundStream),
		replayOperations,
	};
}

export function parseReplay(
	templates: readonly ScenarioTemplate[],
): { template: ScenarioTemplate; seed: number; iterations: number } | null {
	const raw = Bun.env.TUI_STRESS_REPLAY;
	if (raw === undefined || raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid TUI_STRESS_REPLAY JSON: ${raw}`, { cause: error });
	}
	if (!isJsonRecord(parsed)) {
		throw new Error("Invalid TUI_STRESS_REPLAY: expected an object with scenario, seed, and optional iterations");
	}
	const scenario = parsed.scenario;
	if (typeof scenario !== "string" || scenario.length === 0) {
		throw new Error("Invalid TUI_STRESS_REPLAY.scenario: expected a non-empty scenario name");
	}
	const template = templates.find(candidate => candidate.name === scenario);
	if (template === undefined) throw new Error(`Unknown TUI_STRESS_REPLAY scenario: ${scenario}`);
	const iterationsValue = parsed.iterations;
	const iterations = iterationsValue === undefined ? CORE_ITERATIONS : parseReplayIterations(iterationsValue);
	const seed = parseReplaySeed(parsed.seed);
	return { template, seed, iterations };
}

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReplayIterations(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
		throw new Error("Invalid TUI_STRESS_REPLAY.iterations: expected a positive number");
	}
	return Math.floor(value);
}

export function parseReplaySeed(seed: unknown): number {
	if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
	if (typeof seed === "string") {
		const radix = seed.startsWith("0x") || seed.startsWith("0X") ? 16 : 10;
		const valid = radix === 16 ? /^0x[0-9a-f]+$/i.test(seed) : /^\d+$/.test(seed);
		if (!valid) throw new Error(`Invalid TUI_STRESS_REPLAY.seed: ${JSON.stringify(seed)}`);
		return Number.parseInt(seed, radix) >>> 0;
	}
	throw new Error("Invalid TUI_STRESS_REPLAY.seed: expected a number or integer string");
}

export function parseReplayOperations(): readonly OperationKind[] | null {
	const path = Bun.env.TUI_STRESS_REPLAY_LOG;
	if (path === undefined || path.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Invalid TUI_STRESS_REPLAY_LOG JSON: ${path}`, { cause: error });
	}
	const entries = Array.isArray(parsed)
		? parsed
		: isJsonRecord(parsed) && Array.isArray(parsed.operations)
			? parsed.operations
			: null;
	if (entries === null) {
		throw new Error("Invalid TUI_STRESS_REPLAY_LOG: expected an operation array or { operations } object");
	}
	const operations: OperationKind[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const kind = isJsonRecord(entry) ? entry.kind : entry;
		if (kind === "periodicCheckpoint") continue;
		if (!isOperationKind(kind)) {
			throw new Error(`Invalid TUI_STRESS_REPLAY_LOG operation at index ${index}`);
		}
		operations.push(kind);
	}
	return operations;
}

export function buildSeeds(count: number): number[] {
	const seeds: number[] = [];
	for (let i = 0; i < count; i++) {
		const fixed = BASE_SEEDS[i];
		seeds.push(fixed === undefined ? (0x9e3779b9 + Math.imul(i + 1, 0x85ebca6b)) >>> 0 : fixed);
	}
	return seeds;
}

export type ScenarioTemplate = Omit<
	Scenario,
	| "seed"
	| "iterations"
	| "bulkMax"
	| "scrollback"
	| "strictScrollback"
	| "timeoutMs"
	| "uniqueContent"
	| "foregroundStream"
	| "reflow"
	| "tags"
	| "replayOperations"
> & {
	scrollbackRows?: number;
	uniqueContent?: boolean;
	foregroundStream?: boolean;
	reflow?: boolean;
};

export function writeReplayLog(scenario: Scenario, operations: readonly OperationLogEntry[]): string {
	const filePath = path.join(
		os.tmpdir(),
		`veyyon-tui-stress-${scenario.name}-${(scenario.seed >>> 0).toString(16)}-${Date.now().toString(36)}.json`,
	);
	fs.writeFileSync(filePath, JSON.stringify(operations, null, 2));
	return filePath;
}
