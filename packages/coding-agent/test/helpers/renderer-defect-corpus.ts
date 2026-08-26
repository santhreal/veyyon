/**
 * Committed reproduction cases for the composer defect oracles, and the round trip that writes them.
 *
 * A sweep that finds a failing state promotes one case per failing oracle into `CORPUS_DIR`, which is
 * tracked. The case names the state, the oracle, what was wrong with it, and the grid that was on the
 * screen, which is everything `replayCorpusCase` needs to mount that exact frame again. Committing the
 * file is what turns a failure someone saw once into a case every run replays; a promoted case that
 * stays untracked reproduces nothing for anybody else.
 *
 * A case records either verdict an oracle can get wrong: a wrong answer, and no answer at all. The
 * second is the one two defects in this module lived in, so a corpus that could only hold a failure
 * could not hold the defect class it was written for.
 *
 * A case is validated on load rather than trusted. It carries a schema version, and its file name is a
 * hash of the state, the oracle and the kind, so a case recorded under an older shape or edited by
 * hand is rejected with the corrective action instead of being replayed as something it no longer is.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core";
import {
	COMPOSER_ORACLE_GUARANTEES,
	type ComposerOracleGuarantee,
	type OracleFailure,
} from "../../src/modes/components/composer-defect-oracle";
import { type RunnerOptions, type RunnerResult, runComposerOracleScenario } from "./composer-oracle-runner";

/**
 * Option keys that cannot round-trip through CorpusCaseState JSON serialisation.
 *
 * - `customParts`: holds live component instances and factory functions passed to `mountComposerZone`,
 *   which are runtime closures/objects that cannot be serialised to deterministic JSON artifacts.
 */
export const CORPUS_EXCLUDED_OPTION_KEYS = ["customParts"] as const;
export type CorpusExcludedOptionKey = (typeof CORPUS_EXCLUDED_OPTION_KEYS)[number];

/**
 * Bumped whenever `CorpusCase` or `CorpusCaseState` changes shape. A file recorded under an older
 * version is rejected on load, because a state whose fields have moved replays as a different scenario
 * than the one that failed.
 */
export const CORPUS_SCHEMA_VERSION = 2;

/**
 * - `recorded`: the oracle still gets this state wrong. The case is an open defect.
 * - `resolved`: the oracle reads this state and passes after a fix, and the case guards the fix.
 * - `exempted`: the state is out of scope and the case documents why. Requires `reason`.
 */
export const CORPUS_CASE_STATUSES = ["recorded", "resolved", "exempted"] as const;
export type CorpusCaseStatus = (typeof CORPUS_CASE_STATUSES)[number];

/**
 * What the oracle did with the state.
 *
 * - `failed`: it applied, read a subject and reported a failure.
 * - `blind`: it applied and had nothing to read, which the evaluator reports as `blind` and which a
 *   caller reading only `passed` cannot tell from a state that was judged and found clean.
 */
export const CORPUS_CASE_KINDS = ["failed", "blind"] as const;
export type CorpusCaseKind = (typeof CORPUS_CASE_KINDS)[number];

/** What one oracle did with one state, as the corpus records it. */
export interface CorpusObservation {
	oracle: ComposerOracleGuarantee;
	kind: CorpusCaseKind;
	message: string;
}

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
	schemaVersion: typeof CORPUS_SCHEMA_VERSION;
	id: string;
	status: CorpusCaseStatus;
	reason?: string;
	recordedAt: string;
	template: string;
	seed: number;
	state: CorpusCaseState;
	oracle: ComposerOracleGuarantee;
	kind: CorpusCaseKind;
	message: string;
	/**
	 * The viewport as it was when the case was recorded. For a `recorded` case that is the broken
	 * frame; for a `resolved` one it is the frame the fix produces. Either way a replay that paints a
	 * different grid is a change the case has to be re-recorded for.
	 */
	observedGrid: string[];
}

export const CORPUS_DIR = path.resolve(import.meta.dirname, "../corpus/renderer-defect-oracle");

/** Compute the deterministic case id: the file name a state and observation are recorded under. */
export function computeCaseHash(state: CorpusCaseState, oracle: string, kind: CorpusCaseKind): string {
	const normalized = JSON.stringify({
		state,
		oracle,
		kind,
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

/** Absolute paths of every committed case, in file-name order so a run is reproducible. */
export function listCorpusFiles(): readonly string[] {
	if (!fs.existsSync(CORPUS_DIR)) {
		return [];
	}
	return fs
		.readdirSync(CORPUS_DIR)
		.filter(name => name.endsWith(".json"))
		.sort()
		.map(name => path.join(CORPUS_DIR, name));
}

function corpusStateFrom(value: Record<string, unknown>, label: string): CorpusCaseState {
	const state = value.state;
	if (typeof state !== "object" || state === null) {
		throw new Error(`${label}: no state object.`);
	}
	const fields = state as Record<string, unknown>;
	const mode = fields.modeState;
	const transcriptLines = fields.transcriptLines;
	const markers = fields.transcriptLineMarkers;
	if (
		typeof fields.width !== "number" ||
		typeof fields.height !== "number" ||
		typeof fields.editorText !== "string" ||
		typeof fields.scrollIsolation !== "boolean" ||
		typeof fields.scrollOffset !== "number" ||
		typeof fields.focused !== "boolean" ||
		typeof mode !== "object" ||
		mode === null ||
		!(typeof transcriptLines === "number" || Array.isArray(transcriptLines)) ||
		(markers !== undefined && !Array.isArray(markers)) ||
		(fields.statusMessage !== undefined && typeof fields.statusMessage !== "string")
	) {
		throw new Error(`${label}: state fields are missing or the wrong type. Re-record the case with the sweep.`);
	}
	return state as CorpusCaseState;
}

/**
 * Read a committed case and reject anything that would replay as a different scenario than the one
 * recorded: a stale schema, an unknown status or kind, an exemption with no reason, an oracle that no
 * longer exists in the registry, or a state edited without recomputing the id.
 */
export function loadCorpusCase(filePath: string): CorpusCase {
	const label = path.basename(filePath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch (error) {
		throw new Error(`${label}: not readable as JSON. ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`${label}: not a JSON object.`);
	}
	const fields = parsed as Record<string, unknown>;
	if (fields.schemaVersion !== CORPUS_SCHEMA_VERSION) {
		throw new Error(
			`${label}: recorded under schema ${String(fields.schemaVersion)}, this build reads ${CORPUS_SCHEMA_VERSION}. Re-record the case with the sweep and delete the stale file.`,
		);
	}
	const status = fields.status;
	if (typeof status !== "string" || !(CORPUS_CASE_STATUSES as readonly string[]).includes(status)) {
		throw new Error(`${label}: status ${String(status)} is not one of ${CORPUS_CASE_STATUSES.join(", ")}.`);
	}
	if (status === "exempted" && (typeof fields.reason !== "string" || fields.reason.trim() === "")) {
		throw new Error(`${label}: an exempted case has to say why in "reason".`);
	}
	const oracle = fields.oracle;
	if (typeof oracle !== "string" || !(COMPOSER_ORACLE_GUARANTEES as readonly string[]).includes(oracle)) {
		throw new Error(
			`${label}: oracle ${String(oracle)} is not a member of COMPOSER_ORACLE_GUARANTEES. An oracle was renamed or removed; re-record the case or exempt it.`,
		);
	}
	const kind = fields.kind;
	if (typeof kind !== "string" || !(CORPUS_CASE_KINDS as readonly string[]).includes(kind)) {
		throw new Error(`${label}: kind ${String(kind)} is not one of ${CORPUS_CASE_KINDS.join(", ")}.`);
	}
	if (typeof fields.message !== "string" || fields.message.trim() === "" || !Array.isArray(fields.observedGrid)) {
		throw new Error(`${label}: message or observedGrid is missing.`);
	}
	const state = corpusStateFrom(fields, label);
	const id = computeCaseHash(state, oracle, kind as CorpusCaseKind);
	if (fields.id !== id) {
		throw new Error(
			`${label}: id ${String(fields.id)} does not hash its own state, oracle and kind (${id}). The case was edited by hand; re-record it.`,
		);
	}
	if (label !== `${id}.json`) {
		throw new Error(`${label}: file name does not match the case id ${id}.`);
	}
	return parsed as CorpusCase;
}

/**
 * Load and replay a committed corpus case from disk.
 */
export async function replayCorpusFile(filePath: string): Promise<{ corpusCase: CorpusCase; result: RunnerResult }> {
	const corpusCase = loadCorpusCase(filePath);
	const result = await replayCorpusCase(corpusCase.state);
	return { corpusCase, result };
}

/**
 * Record one oracle's verdict on one state as a corpus case, or refresh the one already on disk.
 * Returns the written file path.
 */
export function promoteCaseToCorpus(
	state: CorpusCaseState,
	observation: CorpusObservation,
	observedGrid: readonly string[],
	options?: { template?: string; seed?: number; status?: CorpusCaseStatus; reason?: string },
): string {
	fs.mkdirSync(CORPUS_DIR, { recursive: true });
	const id = computeCaseHash(state, observation.oracle, observation.kind);
	const filePath = path.join(CORPUS_DIR, `${id}.json`);

	// A re-promotion of a case already on disk keeps its status, its reason and the timestamp it was
	// first seen, so replaying the sweep does not rewrite a committed file with today's date.
	let status: CorpusCaseStatus = options?.status ?? "recorded";
	let reason = options?.reason;
	let recordedAt = new Date().toISOString();
	if (fs.existsSync(filePath)) {
		try {
			const existing = loadCorpusCase(filePath);
			status = options?.status ?? existing.status;
			reason = options?.reason ?? existing.reason;
			recordedAt = existing.recordedAt;
		} catch {
			// A case that no longer validates is rewritten from what this run observed.
		}
	}

	const corpusCase: CorpusCase = {
		schemaVersion: CORPUS_SCHEMA_VERSION,
		id,
		status,
		reason,
		recordedAt,
		template: options?.template ?? "composer-sweep",
		seed: options?.seed ?? 0,
		state,
		oracle: observation.oracle,
		kind: observation.kind,
		message: observation.message,
		observedGrid: [...observedGrid],
	};

	fs.writeFileSync(filePath, `${JSON.stringify(corpusCase, null, "\t")}\n`, "utf-8");
	return filePath;
}

/** Record a failure the evaluator reported. */
export function promoteFailureToCorpus(
	state: CorpusCaseState,
	failure: OracleFailure,
	observedGrid: readonly string[],
	options?: { template?: string; seed?: number; status?: CorpusCaseStatus; reason?: string },
): string {
	return promoteCaseToCorpus(
		state,
		{ oracle: failure.oracle, kind: "failed", message: failure.message },
		observedGrid,
		options,
	);
}
