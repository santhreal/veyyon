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
import type { OverlayOptions } from "@veyyon/tui";
import {
	COMPOSER_ORACLE_GUARANTEES,
	type ComposerOracleGuarantee,
	type OracleFailure,
	OVERLAY_ORACLE_GUARANTEES,
	type OverlayOracleFailure,
	type OverlayOracleGuarantee,
	TOOL_RENDER_ORACLE_GUARANTEES,
	type ToolRenderEvaluationResult,
	type ToolRenderOracleFailure,
	type ToolRenderOracleGuarantee,
	type ToolRenderSurface,
} from "../../src/modes/components/defect-oracles";
import type { Theme } from "../../src/modes/theme/theme";
import { type RunnerOptions, type RunnerResult, runComposerOracleScenario } from "./composer-oracle-runner";
import { type OverlayRunnerResult, type OverlaySpec, runOverlayOracleScenario } from "./overlay-oracle-runner";
import { evaluateToolRenderAttempts, RENDER_FIXTURES, sweepToolRenders } from "./tool-render-oracle-runner";

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
export const CORPUS_SCHEMA_VERSION = 3;

/**
 * The oracle families the corpus holds a case for.
 *
 * One corpus, three registries. The round trip, the validation on load and the promotion path are the
 * same work for all of them, and a second copy of them per registry would drift the way the two mode
 * axes did. Keyed tables below make a new family a compile error until it declares its guarantees, its
 * state validator and its replay.
 */
export const CORPUS_FAMILIES = ["composer", "overlay", "toolRender"] as const;
export type CorpusFamily = (typeof CORPUS_FAMILIES)[number];

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
	oracle: ComposerOracleGuarantee | OverlayOracleGuarantee | ToolRenderOracleGuarantee;
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

/**
 * One overlay of an overlay case, as JSON holds it.
 *
 * `OverlayOptions.visible` is a predicate and cannot survive serialisation, so it is not recorded and
 * a state that needs it cannot be a corpus case. `CORPUS_EXCLUDED_OVERLAY_OPTION_KEYS` names it.
 */
export interface OverlayCaseSpec {
	name: string;
	lines: string[];
	options?: Omit<OverlayOptions, "visible">;
	caret?: { line: number; col: number };
	hideBeforeCapture?: boolean;
}

export const CORPUS_EXCLUDED_OVERLAY_OPTION_KEYS = ["visible"] as const;
export type CorpusExcludedOverlayOptionKey = (typeof CORPUS_EXCLUDED_OVERLAY_OPTION_KEYS)[number];

/** An overlay case is a composer state plus the modals shown over it. */
export interface OverlayCorpusCaseState extends CorpusCaseState {
	overlays: OverlayCaseSpec[];
}

/**
 * A tool-render case: which renderer, which surface, which fixture, at which width.
 *
 * The rows are not recorded as the state, because they are the output. The four fields are the whole
 * input to `sweepToolRenders`, so a replay renders the same component over the same hostile string and
 * the recorded `observedGrid` is the comparison.
 */
export interface ToolRenderCorpusCaseState {
	tool: string;
	surface: ToolRenderSurface;
	fixture: string;
	width: number;
}

/** Any family's state, for the id hash and the promotion path that are shared across families. */
export type AnyCorpusCaseState = CorpusCaseState | OverlayCorpusCaseState | ToolRenderCorpusCaseState;

interface CorpusCaseFields {
	schemaVersion: typeof CORPUS_SCHEMA_VERSION;
	id: string;
	status: CorpusCaseStatus;
	reason?: string;
	recordedAt: string;
	template: string;
	seed: number;
	kind: CorpusCaseKind;
	message: string;
	/**
	 * The viewport as it was when the case was recorded. For a `recorded` case that is the broken
	 * frame; for a `resolved` one it is the frame the fix produces. Either way a replay that paints a
	 * different grid is a change the case has to be re-recorded for.
	 */
	observedGrid: string[];
}

export interface ComposerCorpusCase extends CorpusCaseFields {
	family: "composer";
	state: CorpusCaseState;
	oracle: ComposerOracleGuarantee;
}

export interface OverlayCorpusCase extends CorpusCaseFields {
	family: "overlay";
	state: OverlayCorpusCaseState;
	oracle: OverlayOracleGuarantee;
}

export interface ToolRenderCorpusCase extends CorpusCaseFields {
	family: "toolRender";
	state: ToolRenderCorpusCaseState;
	oracle: ToolRenderOracleGuarantee;
}

/** Discriminated on `family`, so a reader that handles one cannot silently be handed the other. */
export type CorpusCase = ComposerCorpusCase | OverlayCorpusCase | ToolRenderCorpusCase;

/**
 * Which state shape each family records.
 *
 * Extends a `Record` over the family union, so a family added to `CORPUS_FAMILIES` does not compile
 * until it names the state it records.
 */
interface CorpusStateByFamily extends Record<CorpusFamily, AnyCorpusCaseState> {
	composer: CorpusCaseState;
	overlay: OverlayCorpusCaseState;
	toolRender: ToolRenderCorpusCaseState;
}

/** What a replay produces, in the terms every family reports: a verdict, the rows, and a teardown. */
export interface CorpusReplay {
	evaluation: {
		passed: boolean;
		failures: readonly { oracle: string; message: string }[];
		skipped: readonly string[];
		inspected: readonly string[];
		blind: readonly string[];
	};
	frameState: { viewportLines: readonly string[] };
	cleanUp: () => void;
}

/** What a family cannot build for itself. A renderer takes a theme as an argument; a mount does not. */
export interface ReplayDeps {
	theme?: Theme;
}

/**
 * Everything the corpus needs to know about one oracle family.
 *
 * One row per family, rather than a guarantee table, a validator table, a replay dispatch and a case
 * builder that each had to be edited in step. Three of those four were separate `Record`s and the
 * fourth was a chain of `if`s, so a family could declare its guarantees, be rejected by a validator it
 * never registered, and replay through the composer runner.
 */
interface OracleFamily<State extends AnyCorpusCaseState> {
	/** The registry whose guarantee ids a case of this family may name. */
	guarantees: readonly string[];
	/** Validate the state as written on disk, or throw with the corrective action. */
	readState: (fields: Record<string, unknown>, label: string) => State;
	/** Rebuild the recorded scenario and re-judge it. */
	replay: (state: State, deps: ReplayDeps, label: string) => Promise<CorpusReplay>;
}

const ORACLE_FAMILIES: { readonly [F in CorpusFamily]: OracleFamily<CorpusStateByFamily[F]> } = {
	composer: {
		guarantees: COMPOSER_ORACLE_GUARANTEES,
		readState: composerCorpusStateFrom,
		replay: state => replayCorpusCase(state),
	},
	overlay: {
		guarantees: OVERLAY_ORACLE_GUARANTEES,
		readState: overlayCorpusStateFrom,
		replay: state => replayOverlayCorpusCase(state),
	},
	toolRender: {
		guarantees: TOOL_RENDER_ORACLE_GUARANTEES,
		readState: toolRenderCorpusStateFrom,
		replay: (state, deps, label) => {
			if (!deps.theme) {
				throw new Error(
					`${label}: a tool-render case replays through a renderer, which takes a theme as an argument. Pass one in deps.theme.`,
				);
			}
			return Promise.resolve(replayToolRenderCorpusCase(state, deps.theme));
		},
	},
};

/**
 * The family's row, for a family known only at run time.
 *
 * The one cast in the family axis. A caller holding a `CorpusFamily` variable cannot call through the
 * mapped table, because the parameter types intersect; widening the row to the state union is sound
 * here because the state a caller passes came back from this row's own `readState`.
 */
function familyRow(family: CorpusFamily): OracleFamily<AnyCorpusCaseState> {
	return ORACLE_FAMILIES[family] as OracleFamily<AnyCorpusCaseState>;
}

/** The guarantees a case of each family may name. */
export const CORPUS_FAMILY_GUARANTEES: Readonly<Record<CorpusFamily, readonly string[]>> = Object.freeze(
	Object.fromEntries(CORPUS_FAMILIES.map(family => [family, ORACLE_FAMILIES[family].guarantees])) as Record<
		CorpusFamily,
		readonly string[]
	>,
);

export const CORPUS_DIR = path.resolve(import.meta.dirname, "../corpus/renderer-defect-oracle");

/** Compute the deterministic case id: the file name a state and observation are recorded under. */
export function computeCaseHash(
	family: CorpusFamily,
	state: AnyCorpusCaseState,
	oracle: string,
	kind: CorpusCaseKind,
): string {
	const normalized = JSON.stringify({
		family,
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

/** Record the overlays of an overlay scenario, dropping the one option a file cannot hold. */
export function overlaySpecsToCorpus(overlays: readonly OverlaySpec[]): OverlayCaseSpec[] {
	return overlays.map(spec => {
		const recorded: OverlayCaseSpec = { name: spec.name, lines: [...spec.lines] };
		if (spec.options) {
			const { visible: _dropped, ...rest } = spec.options;
			recorded.options = rest;
		}
		if (spec.caret) recorded.caret = { ...spec.caret };
		if (spec.hideBeforeCapture !== undefined) recorded.hideBeforeCapture = spec.hideBeforeCapture;
		return recorded;
	});
}

/** Rebuild the overlays of an overlay scenario from a recorded case. */
export function corpusStateToOverlaySpecs(state: OverlayCorpusCaseState): OverlaySpec[] {
	return state.overlays.map(spec => {
		const rebuilt: OverlaySpec = { name: spec.name, lines: [...spec.lines] };
		if (spec.options) rebuilt.options = { ...spec.options };
		if (spec.caret) rebuilt.caret = { ...spec.caret };
		if (spec.hideBeforeCapture !== undefined) rebuilt.hideBeforeCapture = spec.hideBeforeCapture;
		return rebuilt;
	});
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

/** Replay an overlay case: the same composer mount, with the recorded modals shown over it. */
export async function replayOverlayCorpusCase(state: OverlayCorpusCaseState): Promise<OverlayRunnerResult> {
	return await runOverlayOracleScenario({
		...corpusStateToRunnerOptions(state),
		overlays: corpusStateToOverlaySpecs(state),
	});
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

function toolRenderCorpusStateFrom(value: Record<string, unknown>, label: string): ToolRenderCorpusCaseState {
	const state = value.state;
	if (typeof state !== "object" || state === null) {
		throw new Error(`${label}: no state object.`);
	}
	const fields = state as Record<string, unknown>;
	if (
		typeof fields.tool !== "string" ||
		typeof fields.width !== "number" ||
		typeof fields.fixture !== "string" ||
		(fields.surface !== "call" && fields.surface !== "result")
	) {
		throw new Error(
			`${label}: a tool-render case records tool, surface, fixture and width. Re-record the case with the sweep.`,
		);
	}
	if (!RENDER_FIXTURES.some(fixture => fixture.name === fields.fixture)) {
		throw new Error(
			`${label}: fixture ${String(fields.fixture)} is not one the runner drives. A fixture was renamed or removed; re-record the case.`,
		);
	}
	return state as ToolRenderCorpusCaseState;
}

/**
 * Replay a tool-render case by rendering the same component over the same fixture.
 *
 * The theme comes from the caller. A renderer takes it as an argument, loading one needs the settings
 * store initialised, and a corpus module that bootstrapped settings on load would do it for every
 * suite that reads a case.
 */
export interface ToolRenderReplayResult {
	evaluation: ToolRenderEvaluationResult;
	/** The rows the renderer returned, under the name every family's replay reports its frame by. */
	frameState: { viewportLines: readonly string[] };
	cleanUp: () => void;
}

export function replayToolRenderCorpusCase(state: ToolRenderCorpusCaseState, theme: Theme): ToolRenderReplayResult {
	const fixture = RENDER_FIXTURES.find(entry => entry.name === state.fixture);
	if (!fixture) throw new Error(`fixture ${state.fixture} is not one the runner drives`);
	const attempts = sweepToolRenders({
		theme,
		widths: [state.width],
		fixtures: [fixture],
		tools: [state.tool],
	}).filter(attempt => attempt.surface === state.surface);
	const attempt = attempts[0];
	if (!attempt) throw new Error(`${state.tool}/${state.surface} rendered nothing to replay`);
	if (attempt.error) throw attempt.error;
	return {
		evaluation: evaluateToolRenderAttempts([attempt]),
		frameState: { viewportLines: attempt.snapshot?.rawRows ?? [] },
		cleanUp: () => {},
	};
}

function overlayCorpusStateFrom(value: Record<string, unknown>, label: string): OverlayCorpusCaseState {
	const state = composerCorpusStateFrom(value, label);
	const overlays = (state as unknown as Record<string, unknown>).overlays;
	if (!Array.isArray(overlays) || overlays.length === 0) {
		throw new Error(`${label}: an overlay case records at least one overlay in state.overlays.`);
	}
	for (const entry of overlays) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			typeof (entry as Record<string, unknown>).name !== "string" ||
			!Array.isArray((entry as Record<string, unknown>).lines)
		) {
			throw new Error(`${label}: every recorded overlay needs a name and a lines array.`);
		}
		if ((entry as Record<string, unknown>).options !== undefined) {
			const options = (entry as Record<string, unknown>).options;
			if (typeof options !== "object" || options === null) {
				throw new Error(`${label}: a recorded overlay's options must be an object.`);
			}
			for (const key of CORPUS_EXCLUDED_OVERLAY_OPTION_KEYS) {
				if (key in (options as Record<string, unknown>)) {
					throw new Error(
						`${label}: overlay option '${key}' cannot round-trip through a file, so a case cannot record it.`,
					);
				}
			}
		}
	}
	// The parsed object itself, not a rebuild: the id hashes the state as written, so a copy whose
	// keys land in another order would hash differently than the file it came from.
	return state as OverlayCorpusCaseState;
}

function composerCorpusStateFrom(value: Record<string, unknown>, label: string): CorpusCaseState {
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
	const family = fields.family;
	if (typeof family !== "string" || !(CORPUS_FAMILIES as readonly string[]).includes(family)) {
		throw new Error(`${label}: family ${String(family)} is not one of ${CORPUS_FAMILIES.join(", ")}.`);
	}
	const oracle = fields.oracle;
	const row = familyRow(family as CorpusFamily);
	if (typeof oracle !== "string" || !row.guarantees.includes(oracle)) {
		throw new Error(
			`${label}: oracle ${String(oracle)} is not a guarantee of the ${family} registry. An oracle was renamed or removed; re-record the case or exempt it.`,
		);
	}
	const kind = fields.kind;
	if (typeof kind !== "string" || !(CORPUS_CASE_KINDS as readonly string[]).includes(kind)) {
		throw new Error(`${label}: kind ${String(kind)} is not one of ${CORPUS_CASE_KINDS.join(", ")}.`);
	}
	if (typeof fields.message !== "string" || fields.message.trim() === "" || !Array.isArray(fields.observedGrid)) {
		throw new Error(`${label}: message or observedGrid is missing.`);
	}
	const state = row.readState(fields, label);
	const id = computeCaseHash(family as CorpusFamily, state, oracle, kind as CorpusCaseKind);
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
export async function replayCorpusFile(
	filePath: string,
	deps: ReplayDeps = {},
): Promise<{ corpusCase: CorpusCase; result: CorpusReplay }> {
	const corpusCase = loadCorpusCase(filePath);
	const label = path.basename(filePath);
	const result = await familyRow(corpusCase.family).replay(corpusCase.state, deps, label);
	return { corpusCase, result };
}

/**
 * Record one oracle's verdict on one state as a corpus case, or refresh the one already on disk.
 * Returns the written file path.
 */
export function promoteCaseToCorpus(
	family: CorpusFamily,
	state: AnyCorpusCaseState,
	observation: CorpusObservation,
	observedGrid: readonly string[],
	options?: { template?: string; seed?: number; status?: CorpusCaseStatus; reason?: string },
): string {
	fs.mkdirSync(CORPUS_DIR, { recursive: true });
	const id = computeCaseHash(family, state, observation.oracle, observation.kind);
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

	const fields: CorpusCaseFields = {
		schemaVersion: CORPUS_SCHEMA_VERSION,
		id,
		status,
		reason,
		recordedAt,
		template: options?.template ?? `${family}-sweep`,
		seed: options?.seed ?? 0,
		kind: observation.kind,
		message: observation.message,
		observedGrid: [...observedGrid],
	};
	const corpusCase = caseOf(family, fields, state, observation.oracle);

	fs.writeFileSync(filePath, `${JSON.stringify(corpusCase, null, "\t")}\n`, "utf-8");
	return filePath;
}

/**
 * Assemble the family's case from the shared fields.
 *
 * The casts land here and nowhere else: the family decided which validator read the state, and this is
 * the one place that knows both which family it is and that the state came back from that validator.
 */
function caseOf(
	family: CorpusFamily,
	fields: CorpusCaseFields,
	state: AnyCorpusCaseState,
	oracle: CorpusObservation["oracle"],
): CorpusCase {
	// The union's arms pair a family with its own state and oracle types, and TypeScript cannot see
	// that pairing through three variables. The promotion helpers are typed per family, so the caller
	// supplied a matching triple; a case read from disk is validated by the family's own row instead.
	return { ...fields, family, state, oracle } as CorpusCase;
}

/** Record a failure the evaluator reported. */
export function promoteFailureToCorpus(
	state: CorpusCaseState,
	failure: OracleFailure,
	observedGrid: readonly string[],
	options?: { template?: string; seed?: number; status?: CorpusCaseStatus; reason?: string },
): string {
	return promoteCaseToCorpus(
		"composer",
		state,
		{ oracle: failure.oracle, kind: "failed", message: failure.message },
		observedGrid,
		options,
	);
}

/** Record a tool-render failure the evaluator reported. */
export function promoteToolRenderFailureToCorpus(
	state: ToolRenderCorpusCaseState,
	failure: ToolRenderOracleFailure,
	observedGrid: readonly string[],
	options?: { template?: string; seed?: number; status?: CorpusCaseStatus; reason?: string },
): string {
	return promoteCaseToCorpus(
		"toolRender",
		state,
		{ oracle: failure.oracle, kind: "failed", message: failure.message },
		observedGrid,
		options,
	);
}

/** Record an overlay failure the evaluator reported. */
export function promoteOverlayFailureToCorpus(
	state: OverlayCorpusCaseState,
	failure: OverlayOracleFailure,
	observedGrid: readonly string[],
	options?: { template?: string; seed?: number; status?: CorpusCaseStatus; reason?: string },
): string {
	return promoteCaseToCorpus(
		"overlay",
		state,
		{ oracle: failure.oracle, kind: "failed", message: failure.message },
		observedGrid,
		options,
	);
}
