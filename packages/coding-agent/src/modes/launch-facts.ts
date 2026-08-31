/**
 * What the last launch of this project knew, so the card can state it instead of a placeholder.
 *
 * THE PROBLEM THIS SOLVES. The launch card paints at about 48ms and the session finishes booting at
 * about 650ms. Four of the things on that card cannot be computed inside the first budget at any
 * price: a model's display name needs the catalog, the working tree's dirty flag needs a `git
 * status` that costs 130ms on a repository this size, the context gauge needs a prompt that has not
 * been assembled yet, and the effort the row prints is resolved against the model and clamped to
 * what that model supports. Rendered as placeholders they were not merely blank — the hero announced
 * `no model yet · /login` to an operator who is logged in, and the status row printed a raw
 * `provider/vendor/model-id` so long that the justifier dropped the profile segment to fit it. Both
 * corrected themselves 600ms later, which is the repaint a person actually notices.
 *
 * WHY A CACHE IS THE ANSWER AND NOT A FASTER LOOKUP. All three are properties of the PROJECT AT
 * REST, not of this run. They were true when the last session ended and they are almost always
 * still true, so the previous launch's answer is an answer rather than a guess. Reading it costs
 * one small JSON file, which is why this respects the launch path's rule — no registry, no catalog,
 * no auth storage — while a lookup that resolved any of them honestly would not.
 *
 * EVERY FACT DECLARES WHAT IT IS VALID FOR. A dirty marker survives a model change and a context
 * percentage does not; a display name survives a change of directory and a dirty marker does not.
 * So each fact is filed under the key it answers to, and a fact whose key no longer matches is
 * dropped and the surface renders its own absent state, which is the behaviour that existed before
 * this cache.
 *
 * WHEN IT IS WRONG. Committing from another terminal, editing an `AGENTS.md`, installing a skill,
 * connecting an MCP server or changing `defaultEffort` moves one of these without moving its key.
 * The first frame then states the previous answer and the session corrects it in place, which is
 * one changed row instead of the whole screen. The alternative on that frame is a placeholder, and
 * a placeholder is not more accurate than a slightly stale truth — `no model yet · /login` was the
 * proof.
 */

import { readFileSync } from "node:fs";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import { TERMINAL_ID } from "@veyyon/tui/terminal-capabilities";
import { atomicWriteJson } from "@veyyon/utils/atomic-write";
import { getLaunchFactsCachePath, getProjectDir, VERSION } from "@veyyon/utils/dirs";
import { isEnoent } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { settings } from "../config/settings-instance";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../thinking";
import type { GitStatusSummary } from "../utils/git";

/**
 * The levels a recorded effort may hold, from the two modules that own them.
 *
 * The row prints this value through a theme table, so a damaged file must not be able to put text
 * of its own choosing on the status row: an unknown string is discarded like any other invalid
 * fact. Derived from the ladder rather than listed, so a new rung needs no edit here.
 */
const RECORDABLE_THINKING: ReadonlySet<string> = new Set<string>([...Object.values(ThinkingLevel), AUTO_THINKING]);

/**
 * The file on disk: what a project knows, what a model knows, and what a terminal looks like, in
 * three maps.
 *
 * A single set of facts was enough for one project and made every launch cold for anyone who works
 * in two: the second project's launch overwrote the first's, so alternating between them meant the
 * card never had a fact to state and the gauge read `?` on every start.
 *
 * The maps exist because the facts have different scopes, and filing them together made each one
 * as narrow as the narrowest. A display name, its provider and the effort belong to the MODEL:
 * they are the same in every directory, so a first launch in a new project can state them rather
 * than printing a raw id and growing an effort tail 600ms later. The dirty marker and the gauge
 * belong to the PROJECT: one describes its working tree and the other is measured against the
 * prompt this project assembles, so neither says anything about the directory next door. The
 * background color belongs to the TERMINAL: it is a property of the emulator the card is drawn
 * into, identical in every project and under every model, and it is the only fact here that the
 * card cannot obtain for itself at paint time.
 *
 * Every map is bounded and evicts the oldest write, because this is a cache of what is worth
 * stating on a first frame, not a record of every directory ever opened.
 *
 * `version` is checked on read. A file written by an older shape is dropped rather than
 * reinterpreted, since its facts were filed under keys this reader would resolve differently.
 */
const FACTS_VERSION = 4;

/** How many entries each map keeps. Each is a few hundred bytes and the file is read on paint. */
const MAX_ENTRIES = 24;

/** The one shape a recorded background may hold, checked on read and on write. */
const GROUND_HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * What one project knows.
 *
 * Every fact is optional: they are recorded from different places at different moments, and a
 * launch that never resolved one leaves the previous value alone rather than writing a null over
 * it. `modelRole` is what the gauge was measured under: a percentage is a fraction of one model's
 * window, so a role change invalidates it while leaving the dirty marker alone.
 */
interface ProjectFacts {
	modelRole: string;
	gitStatus?: GitStatusSummary;
	contextPercent?: number;
	/** Milliseconds since the epoch, used only to decide which entry leaves when the map is full. */
	recordedAt: number;
}

/** What one model knows, in every project it is used in. */
interface ModelFacts {
	name?: string;
	provider?: string;
	/** The effort the row printed, concrete or `auto`; absent when it printed none. */
	thinking?: string;
	/**
	 * The at-rest reading this model last took, in whatever project took it.
	 *
	 * What a project that has never been measured states instead of nothing. Most of a resting
	 * prompt is the model's own: the system prompt, the tool schemas and the skills index are the
	 * same wherever it runs, and what a project adds to them is its `AGENTS.md`. So this lands
	 * within a few points of what that project will measure, and the session replaces it with the
	 * measured reading in place, moving a number rather than filling an empty bar.
	 */
	contextPercent?: number;
	/** Milliseconds since the epoch, used only to decide which entry leaves when the map is full. */
	recordedAt: number;
}

/**
 * What one terminal looks like.
 *
 * The emulator's own background, as it last reported it (OSC 11). Every structural chrome color
 * is derived from it -- the hairline above the composer, the composer outline, the transcript
 * rules -- and the query that obtains it is answered milliseconds AFTER the card is already on
 * screen, so a card with no recorded ground draws that chrome from the static token and then
 * restyles it once the answer lands.
 *
 * Keyed by terminal id and not by release: the background of an emulator is not a property of the
 * version painting into it, and putting the release in the key would throw the fact away on every
 * upgrade. Two profiles of the SAME emulator with different backgrounds share one entry, so
 * alternating between them mis-seeds one card and corrects it on the report, which is the state
 * every launch was in before this was recorded at all.
 */
interface TerminalFacts {
	/** `#rrggbb`, as the terminal reported it. */
	ground?: string;
	/** Milliseconds since the epoch, used only to decide which entry leaves when the map is full. */
	recordedAt: number;
}

interface LaunchFactsFile {
	version: number;
	projects: Record<string, ProjectFacts>;
	models: Record<string, ModelFacts>;
	terminals: Record<string, TerminalFacts>;
}

/** The facts that survived validation, each null when it did not. */
export interface LaunchFacts {
	/**
	 * The last scan's summary, not a flag.
	 *
	 * The row asks `isTreeDirty` and renders one `*`, but the summary is what a scan produces and
	 * what the live row carries, so storing it keeps the launch value and the measured value the
	 * same shape. A synthesised summary standing in for a boolean would be four invented numbers.
	 */
	gitStatus: GitStatusSummary | null;
	modelName: string | null;
	providerName: string | null;
	/**
	 * How much of the window a resting prompt costs, as a percentage SPENT.
	 *
	 * This project's own reading when it has one, and this model's last reading anywhere when it
	 * does not. A project opened for the first time would otherwise draw an empty bar and `?`,
	 * which is not more accurate than the answer every other project using this model gave, only
	 * emptier, and it is the one segment whose arrival redraws the row instead of moving a number
	 * on it. Null only before this model has rested anywhere, which no cache can answer.
	 */
	contextPercent: number | null;
	/**
	 * The effort the last launch of this model ran at, or null when it ran without one.
	 *
	 * Model-scoped, like the name and the provider beside it: an effort is resolved against the
	 * model and clamped to what that model supports, so the level one model ran at states nothing
	 * about the next, and every project using this model ran at the same one.
	 */
	thinking: ConfiguredThinkingLevel | null;
	/**
	 * The background this terminal last reported, or null before it has reported one here.
	 *
	 * Seeds the ground-relative chrome so the card draws the hairline, the composer outline and
	 * the transcript rules in the shade the session settles on, instead of drawing them from the
	 * static token and restyling once the OSC 11 answer arrives.
	 */
	terminalGround: string | null;
}

/** What a caller can contribute; anything omitted keeps its recorded value. */
export interface LaunchFactsUpdate {
	gitStatus?: GitStatusSummary;
	modelName?: string;
	providerName?: string;
	/** The resting cost measured in THIS project, as a percentage of the limit it runs out at. */
	contextPercent?: number;
	/**
	 * The same reading with this project's context files taken out, filed under the model.
	 *
	 * What a project that has never been measured states. Recorded separately because a reading
	 * taken in one directory is not one taken in another: the difference is whatever `AGENTS.md`
	 * and the rest of that project's context contribute, which on a large repository is enough to
	 * move the bar a cell and the number by ten points.
	 */
	modelContextPercent?: number;
	/**
	 * The effort, or null to record that there was none.
	 *
	 * The only fact with an explicit clear. The others describe something that exists and is merely
	 * unresolved yet, so omitting them keeps the recorded value; an effort turned off is a fact in
	 * itself, and carrying the previous one forward would print `@high` on a row that has none.
	 */
	thinking?: ConfiguredThinkingLevel | null;
	/** The background the terminal reported (`#rrggbb`), recorded for the next launch's card. */
	terminalGround?: string;
}

/**
 * The release and the project.
 *
 * The release is in the key because what the card draws ships with it; the project because the
 * working tree is the thing being described.
 */
function projectKey(): string {
	return `${VERSION}|${getProjectDir()}`;
}

/**
 * The release and the configured default model, which is what the model-scoped facts describe.
 *
 * A display name, a provider and an effort belong to the model rather than to the directory it was
 * used in, so they are keyed on the role alone and a first launch in a new project states them.
 * The id is read from the settings store the launch path has already loaded, and it is the same id
 * the next session will start from.
 *
 * The release is in this key for the reason it is in the project's: the value was recorded by the
 * code that shipped with it. An upgrade starts cold rather than replaying a fact whose meaning may
 * have moved.
 */
function modelKey(): string {
	return `${VERSION}|${settings.getModelRole("default") ?? ""}`;
}

/**
 * The terminal, and nothing else.
 *
 * Not the release, because an emulator's background does not change when this ships a new version,
 * and not the project, because it is the same window whichever directory is open in it.
 */
function terminalKey(): string {
	return TERMINAL_ID;
}

/** The configured default model, which is what a project's gauge was measured against. */
function modelRole(): string {
	return settings.getModelRole("default") ?? "";
}

/** Hold a percentage inside the band the gauge can draw, since the bar derives its cells from it. */
function clampPercent(percent: number): number {
	return Math.max(0, Math.min(100, percent));
}

/**
 * A recorded percentage the gauge can draw, or null.
 *
 * Out of band is clamped rather than rejected, because the bar derives its filled cells from this
 * and 140 would draw past them; anything that is not a number is not a reading at all. One
 * predicate rather than a `typeof` beside it: the only caller is the JSON parser, whose grammar
 * has no NaN and no infinity, so the two spellings can only differ for a caller that does not
 * exist yet, and a test cannot tell them apart.
 */
function asPercent(value: unknown): number | null {
	return Number.isFinite(value) ? clampPercent(value as number) : null;
}

/**
 * The file as last read or written by this process, or undefined before the first read.
 *
 * Memoized because the hero and the status row both ask, the row asks on every redraw, and this
 * process is the only writer — so a second read of the disk could only return what is already
 * here. {@link resetLaunchFactsForTest} clears it.
 */
let memo: LaunchFactsFile | null | undefined;

/** The file, or null when it is missing, damaged or unreadable. Every failure is the same answer. */
function load(): LaunchFactsFile | null {
	if (memo !== undefined) return memo;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(getLaunchFactsCachePath(), "utf8"));
	} catch (err) {
		if (!isEnoent(err)) {
			logger.warn("Launch facts could not be read; the card will use placeholders until the session lands", {
				error: errorMessage(err),
			});
		}
		memo = null;
		return memo;
	}
	if (!parsed || typeof parsed !== "object") {
		memo = null;
		return memo;
	}
	const file = parsed as Partial<LaunchFactsFile>;
	// A file this reader would misread is no better than no file. The single-slot shape that came
	// before this one filed its facts under one project with no map to look them up in.
	if (
		file.version !== FACTS_VERSION ||
		!file.projects ||
		typeof file.projects !== "object" ||
		!file.models ||
		typeof file.models !== "object" ||
		!file.terminals ||
		typeof file.terminals !== "object"
	) {
		memo = null;
		return memo;
	}
	memo = { version: FACTS_VERSION, projects: file.projects, models: file.models, terminals: file.terminals };
	return memo;
}

/**
 * A parsed value shaped like a scan summary, or null.
 *
 * The file is JSON that anything on the machine can edit, so each count is checked rather than
 * assumed: a summary with a string where a number belongs would reach `isTreeDirty`, compare
 * `> 0` against a string, and decide dirtiness on the result.
 */
function asGitStatus(value: unknown): GitStatusSummary | null {
	if (!value || typeof value !== "object") return null;
	const { staged, unstaged, untracked, truncated } = value as Partial<GitStatusSummary>;
	if (![staged, unstaged, untracked].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
	if (typeof truncated !== "boolean") return null;
	return { staged, unstaged, untracked, truncated } as GitStatusSummary;
}

/**
 * A parsed value shaped like a `#rrggbb` background, or null.
 *
 * The same reason the scan summary is checked: this string is spliced straight into an SGR
 * sequence, so a damaged file must not be able to write escape bytes of its own into the frame.
 */
function asGroundHex(value: unknown): string | null {
	return typeof value === "string" && GROUND_HEX_RE.test(value) ? value : null;
}

/**
 * What the card may state, validated against the keys the facts were recorded under.
 *
 * Synchronous because the caller is a render, and a read the frame cannot await is a read the frame
 * does not get.
 */
export function readLaunchFacts(): LaunchFacts {
	const file = load();
	const project = file?.projects[projectKey()];
	const model = file?.models[modelKey()];

	// The gauge answers to both keys, project first. A reading is a fraction of THIS model's
	// window, so a role change invalidates the project's copy while the dirty marker beside it,
	// which describes the working tree, survives. What stands in for an invalidated or missing
	// reading is the same model's resting cost from wherever it last idled: system prompt, tool
	// schemas and skills index dominate it, and only the project-scoped context that directory
	// contributed differs, which on a project carrying a large `AGENTS.md` is several points. That
	// is a bar drawn a cell or two off against `? left` and no bar at all, and `?` is the one
	// reading whose arrival redraws the row rather than moving a number already on it.
	const projectGauge = project && project.modelRole === modelRole() ? asPercent(project.contextPercent) : null;
	return {
		gitStatus: project ? asGitStatus(project.gitStatus) : null,
		modelName: model && typeof model.name === "string" && model.name.length > 0 ? model.name : null,
		providerName: model && typeof model.provider === "string" && model.provider.length > 0 ? model.provider : null,
		contextPercent: projectGauge ?? (model ? asPercent(model.contextPercent) : null),
		thinking:
			model && typeof model.thinking === "string" && RECORDABLE_THINKING.has(model.thinking)
				? (model.thinking as ConfiguredThinkingLevel)
				: null,
		terminalGround: asGroundHex(file?.terminals[terminalKey()]?.ground),
	};
}

/**
 * What the card prints for the model before a catalog exists to name it.
 *
 * The display name recorded for this model, in whatever project it was last used in, and failing
 * that the configured role reduced to its final path segment. A role is stored qualified —
 * `nous-research/z-ai/glm-5.1` — and printing it whole costs the row the segments that trail it,
 * the context gauge first: at eighty columns that one id is twenty-six of them, so a row with no
 * recorded name drew no gauge and then grew one when the session resolved a display name. The tail
 * is the part a display name is derived from anyway, so the row states a narrower form of the same
 * fact rather than a different fact.
 *
 * A `:` or `@` suffix is left attached. It carries a thinking level, an upstream route or an Ollama
 * tag, telling them apart needs the resolver this path may not load, and the tail is short with
 * them on. Empty when no default role is configured, which is the one case where the card has
 * nothing to state and says so.
 */
export function launchModelLabel(): string {
	const { modelName } = readLaunchFacts();
	if (modelName) return modelName;
	const role = settings.getModelRole("default");
	if (!role) return "";
	return role.slice(role.lastIndexOf("/") + 1);
}

/**
 * Merge `update` into what this project and this model have recorded, and write it when anything
 * changed.
 *
 * Each fact lands in the map whose key it answers to, so a launch here contributes the model's
 * display name to every project that uses it while its gauge stays this project's alone. A gauge
 * recorded under a model that has since moved is DROPPED rather than carried onto the new one: a
 * percentage taken against another window is worse than none, because the card would state it with
 * the same confidence as a correct one. The dirty marker is kept, since it describes the working
 * tree rather than the model.
 *
 * Other entries in both maps are carried through untouched. When a map is full the oldest write
 * leaves, so a machine that opens hundreds of directories keeps the ones it returns to.
 *
 * A caller reaches this on every redraw of an idle session, so an update that changes nothing
 * returns before it touches the disk. The write is atomic, so a crash cannot leave a half-written
 * file, and unflushed, because losing it to power loss costs exactly one frame.
 *
 * The returned promise settles when the file is on disk and never rejects; callers discard it. A
 * failed write is not retried on the next frame — that would turn an unwritable cache directory
 * into a warning per redraw — and the next changed fact tries again.
 */
export function recordLaunchFacts(update: LaunchFactsUpdate): Promise<void> {
	// Each key is read once, so the entry this call merges into and the entry it writes back are
	// the same one even though the settings store is free to move between statements.
	const key = projectKey();
	const model = modelKey();
	const role = modelRole();
	const previous = load();
	const recordedProject = previous?.projects[key];
	const recordedModel = previous?.models[model];
	const sameModel = recordedProject?.modelRole === role;
	const terminal = terminalKey();
	const recordedTerminal = previous?.terminals[terminal];

	const nextProject: ProjectFacts = {
		modelRole: role,
		recordedAt: Date.now(),
		...(recordedProject && asGitStatus(recordedProject.gitStatus) ? { gitStatus: recordedProject.gitStatus } : {}),
		...(sameModel && typeof recordedProject?.contextPercent === "number"
			? { contextPercent: recordedProject.contextPercent }
			: {}),
	};
	if (update.gitStatus !== undefined) nextProject.gitStatus = update.gitStatus;

	const nextModel: ModelFacts = {
		recordedAt: Date.now(),
		...(typeof recordedModel?.name === "string" ? { name: recordedModel.name } : {}),
		...(typeof recordedModel?.provider === "string" ? { provider: recordedModel.provider } : {}),
		...(typeof recordedModel?.thinking === "string" ? { thinking: recordedModel.thinking } : {}),
		...(typeof recordedModel?.contextPercent === "number" ? { contextPercent: recordedModel.contextPercent } : {}),
	};
	if (update.modelName !== undefined && update.modelName.length > 0) nextModel.name = update.modelName;
	if (update.providerName !== undefined && update.providerName.length > 0) nextModel.provider = update.providerName;

	// A reading lands under BOTH keys, and they are NOT the same number. The project's is the exact
	// resting cost measured in this directory. The model's stands in for a project that has never
	// been measured, so it carries the model FLOOR: the same reading with this project's context
	// files taken out. Recording the whole reading under the model key served one project's
	// `AGENTS.md` to the next -- a card seeded in a heavy repository stated 77% left where the
	// session settled at 88%, an eleven-point correction on a settled screen. The floor is a lower
	// bound every project shares, so the settle only ever moves the bar toward MORE spent, by
	// exactly what this project's context adds. Only an at-rest reading reaches here (the
	// recorder's own guard), so neither number is the size of somebody's conversation.
	if (update.contextPercent !== undefined && Number.isFinite(update.contextPercent)) {
		nextProject.contextPercent = clampPercent(Math.round(update.contextPercent));
	}
	if (update.modelContextPercent !== undefined && Number.isFinite(update.modelContextPercent)) {
		nextModel.contextPercent = clampPercent(Math.round(update.modelContextPercent));
	}

	// The one fact a caller can erase: `null` states that the row printed no effort, which is a
	// different answer from not having resolved one yet.
	if (update.thinking === null) {
		delete nextModel.thinking;
	} else if (update.thinking !== undefined) {
		nextModel.thinking = update.thinking;
	}

	// A background arrives once per launch, from the terminal's own report, and it is the same
	// value every time until the emulator's theme changes. Recorded rather than re-derived because
	// the card that needs it paints before the query it answers can be asked.
	const nextTerminal: TerminalFacts = {
		recordedAt: Date.now(),
		...(asGroundHex(recordedTerminal?.ground) ? { ground: recordedTerminal?.ground } : {}),
	};
	if (asGroundHex(update.terminalGround)) nextTerminal.ground = update.terminalGround;

	// `recordedAt` moves on every call, so it is left out of the comparison: a redraw that changed
	// no fact must not rewrite the file, which is what keeps an idle session off the disk.
	if (
		recordedProject &&
		recordedModel &&
		recordedTerminal &&
		sameFacts(recordedProject, nextProject) &&
		sameFacts(recordedModel, nextModel) &&
		sameFacts(recordedTerminal, nextTerminal)
	) {
		return Promise.resolve();
	}

	const file: LaunchFactsFile = {
		version: FACTS_VERSION,
		projects: evictOldest({ ...previous?.projects, [key]: nextProject }),
		models: evictOldest({ ...previous?.models, [model]: nextModel }),
		terminals: evictOldest({ ...previous?.terminals, [terminal]: nextTerminal }),
	};
	memo = file;
	return atomicWriteJson(getLaunchFactsCachePath(), file, { fsync: false }).catch((err: unknown) => {
		logger.warn("Launch facts could not be written; the next launch will use placeholders", {
			error: errorMessage(err),
		});
	});
}

/** Every fact but the timestamp, which moves on each call and is not itself a fact about the entry. */
function sameFacts<T extends { recordedAt: number }>(left: T, right: T): boolean {
	const strip = ({ recordedAt: _, ...rest }: T): Omit<T, "recordedAt"> => rest;
	return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
}

/** The newest {@link MAX_ENTRIES} entries, so neither map can grow without bound. */
function evictOldest<T extends { recordedAt: number }>(entries: Record<string, T>): Record<string, T> {
	const rows = Object.entries(entries);
	if (rows.length <= MAX_ENTRIES) return entries;
	rows.sort(([, left], [, right]) => (right.recordedAt ?? 0) - (left.recordedAt ?? 0));
	return Object.fromEntries(rows.slice(0, MAX_ENTRIES));
}

/** Forget what this process read or wrote, so a test can drive the file directly. */
export function resetLaunchFactsForTest(): void {
	memo = undefined;
}
