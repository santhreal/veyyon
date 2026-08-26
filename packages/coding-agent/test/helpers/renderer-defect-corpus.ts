/**
 * Auto-promoting corpus manager and replay harness for renderer defect oracle.
 *
 * When the sweep or test encounters a failing input, it promotes that case into a
 * deterministic, committed JSON artifact in the corpus directory. A separate always-on
 * test replays the corpus on every pull request.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { ComposerOracleGuarantee, OracleFailure } from "../../src/modes/components/composer-defect-oracle";
import { type RunnerOptions, type RunnerResult, runComposerOracleScenario } from "./composer-oracle-runner";

/**
 * Option keys that cannot round-trip through CorpusCaseState JSON serialisation.
 *
 * - `customParts`: holds live component instances and factory functions passed to `mountComposerZone`,
 *   which are runtime closures/objects that cannot be serialised to deterministic JSON artifacts.
 */
export const CORPUS_EXCLUDED_OPTION_KEYS = ["customParts"] as const;
export type CorpusExcludedOptionKey = (typeof CORPUS_EXCLUDED_OPTION_KEYS)[number];

export interface CorpusCaseState {
	width: number;
	height: number;
	modeState: {
		bypass?: boolean;
		bashMode?: boolean;
		pythonMode?: boolean;
		planMode?: boolean;
		focusedSubagent?: boolean;
		sessionAccentAnsi?: string;
		thinkingLevel?: string;
	};
	editorText: string;
	transcriptLines: number | string[];
	scrollIsolation: boolean;
	scrollOffset: number; // 0 for live tail, >0 for scroll back
	focused: boolean;
	statusMessage?: string;
	transcriptLineMarkers?: readonly string[];
}

export interface CorpusCase {
	schemaVersion: 1;
	id: string;
	status: "recorded" | "resolved" | "exempted";
	reason?: string;
	recordedAt: string;
	template: string;
	seed: number;
	state: CorpusCaseState;
	failingOracle: ComposerOracleGuarantee;
	errorMessage: string;
	observedGrid: string[];
}

export const CORPUS_DIR = path.resolve(import.meta.dirname, "../corpus/renderer-defect-oracle");

/** Ensure corpus directory exists */
function ensureCorpusDir(): void {
	if (!fs.existsSync(CORPUS_DIR)) {
		fs.mkdirSync(CORPUS_DIR, { recursive: true });
	}
}

/** Compute deterministic SHA-256 hash for a corpus case */
function computeCaseHash(state: CorpusCaseState, failingOracle: string): string {
	const normalized = JSON.stringify({
		state,
		failingOracle,
	});
	return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Convert runner options to CorpusCaseState */
export function runnerOptionsToCorpusState(options: RunnerOptions): CorpusCaseState {
	const state: CorpusCaseState = {
		width: options.width,
		height: options.height,
		modeState: {
			bypass: options.modeState?.bypass,
			bashMode: options.modeState?.bashMode,
			pythonMode: options.modeState?.pythonMode,
			planMode: options.modeState?.planMode,
			focusedSubagent: options.modeState?.focusedSubagent,
			sessionAccentAnsi: options.modeState?.sessionAccentAnsi,
			thinkingLevel: options.modeState?.thinkingLevel,
		},
		editorText: options.editorText ?? "",
		transcriptLines: Array.isArray(options.transcriptLines)
			? [...options.transcriptLines]
			: (options.transcriptLines ?? 0),
		scrollIsolation: options.scrollIsolation ?? true,
		scrollOffset: options.scrollOffset ?? 0,
		focused: options.focused ?? true,
	};
	if (options.statusMessage !== undefined) {
		state.statusMessage = options.statusMessage;
	}
	if (options.transcriptLineMarkers !== undefined) {
		state.transcriptLineMarkers = [...options.transcriptLineMarkers];
	}
	return state;
}

/** Convert CorpusCaseState back to RunnerOptions */
export function corpusStateToRunnerOptions(state: CorpusCaseState): RunnerOptions {
	let thinkingLevel: ThinkingLevel = ThinkingLevel.Off;
	if (state.modeState?.thinkingLevel) {
		thinkingLevel = state.modeState.thinkingLevel as ThinkingLevel;
	}
	const options: RunnerOptions = {
		width: state.width,
		height: state.height,
		modeState: {
			bypass: state.modeState?.bypass,
			bashMode: state.modeState?.bashMode,
			pythonMode: state.modeState?.pythonMode,
			planMode: state.modeState?.planMode,
			focusedSubagent: state.modeState?.focusedSubagent,
			sessionAccentAnsi: state.modeState?.sessionAccentAnsi,
			thinkingLevel,
		},
		editorText: state.editorText,
		transcriptLines: Array.isArray(state.transcriptLines) ? [...state.transcriptLines] : state.transcriptLines,
		scrollIsolation: state.scrollIsolation,
		scrollOffset: state.scrollOffset,
		focused: state.focused,
	};
	if (state.statusMessage !== undefined) {
		options.statusMessage = state.statusMessage;
	}
	if (state.transcriptLineMarkers !== undefined) {
		options.transcriptLineMarkers = [...state.transcriptLineMarkers];
	}
	return options;
}

/**
 * Replay a corpus state by mounting it in the runner and re-evaluating all defect oracles.
 *
 * Produces the same oracle evaluation and frame geometry as the original mount.
 */
export async function replayCorpusCase(state: CorpusCaseState): Promise<RunnerResult> {
	const options = corpusStateToRunnerOptions(state);
	return await runComposerOracleScenario(options);
}

/**
 * Load and replay a committed corpus case from disk.
 */
export async function replayCorpusFile(filePath: string): Promise<{ corpusCase: CorpusCase; result: RunnerResult }> {
	const raw = fs.readFileSync(filePath, "utf-8");
	const corpusCase: CorpusCase = JSON.parse(raw);
	const result = await replayCorpusCase(corpusCase.state);
	return { corpusCase, result };
}

/**
 * Promote a failing scenario to the committed corpus.
 * Returns the written file path.
 */
export function promoteFailingCaseToCorpus(
	state: CorpusCaseState,
	failure: OracleFailure,
	observedGrid: string[],
	options?: { template?: string; seed?: number; status?: "recorded" | "resolved" | "exempted"; reason?: string },
): string {
	ensureCorpusDir();
	const id = computeCaseHash(state, failure.oracle);
	const filePath = path.join(CORPUS_DIR, `${id}.json`);

	// If file already exists and is marked resolved/exempted, keep its status unless overwritten
	let existingStatus: "recorded" | "resolved" | "exempted" = options?.status ?? "recorded";
	let existingReason = options?.reason;

	if (fs.existsSync(filePath)) {
		try {
			const existing: CorpusCase = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			if (!options?.status) {
				existingStatus = existing.status;
			}
			if (options?.reason === undefined) {
				existingReason = existing.reason;
			}
		} catch {
			// rewrite corrupted file
		}
	}

	const corpusCase: CorpusCase = {
		schemaVersion: 1,
		id,
		status: existingStatus,
		reason: existingReason,
		recordedAt: new Date().toISOString(),
		template: options?.template ?? "composer-sweep",
		seed: options?.seed ?? 0,
		state,
		failingOracle: failure.oracle,
		errorMessage: failure.message,
		observedGrid,
	};

	fs.writeFileSync(filePath, `${JSON.stringify(corpusCase, null, "\t")}\n`, "utf-8");
	return filePath;
}
