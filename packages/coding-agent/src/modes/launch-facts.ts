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
 * EVERY FACT DECLARES WHAT IT IS VALID FOR. A dirty flag survives a model change and a display name
 * does not, so the two live under separate keys and are invalidated separately. A fact whose key no
 * longer matches is dropped and the surface renders its own absent state, which is the behaviour
 * that existed before this cache.
 *
 * WHEN IT IS WRONG. Committing from another terminal, editing an `AGENTS.md`, installing a skill or
 * connecting an MCP server moves one of these without moving its key. The first frame then states
 * the previous answer and the session corrects it in place, which is one changed row instead of the
 * whole screen. The alternative on that frame is a placeholder, and a placeholder is not more
 * accurate than a slightly stale truth — `no model yet · /login` was the proof.
 */

import { readFileSync } from "node:fs";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
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
 * The file on disk: one entry per project, so a launch in one project does not erase what another
 * knows.
 *
 * A single set of facts was enough for one project and made every launch cold for anyone who works
 * in two: the second project's launch overwrote the first's, so alternating between them meant the
 * card never had a fact to state and the gauge read `?` on every start. Entries are bounded and the
 * oldest write is evicted, because this is a cache of what is worth stating on a first frame, not a
 * record of every directory ever opened.
 *
 * `version` is checked on read. A file written by an older shape is dropped rather than
 * reinterpreted, since its facts were filed under keys this reader would resolve differently.
 */
const FACTS_VERSION = 2;

/** How many projects keep facts. Each entry is a few hundred bytes and the file is read on paint. */
const MAX_PROJECTS = 24;

/**
 * What one project knows.
 *
 * Every fact is optional: they are recorded from different places at different moments, and a
 * launch that never resolved one leaves the previous value alone rather than writing a null over
 * it. `modelRole` is what the model-scoped facts were measured under, so a role change invalidates
 * the display name and the gauge while leaving the dirty flag alone.
 */
interface ProjectFacts {
	modelRole: string;
	gitStatus?: GitStatusSummary;
	modelName?: string;
	providerName?: string;
	contextPercent?: number;
	/** The effort the row printed, concrete or `auto`; absent when it printed none. */
	thinking?: string;
	/** Milliseconds since the epoch, used only to decide which entry leaves when the map is full. */
	recordedAt: number;
}

interface LaunchFactsFile {
	version: number;
	projects: Record<string, ProjectFacts>;
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
	contextPercent: number | null;
	/**
	 * The effort the last launch of this model ran at, or null when it ran without one.
	 *
	 * Model-scoped like the name and the gauge: an effort is resolved against the model and clamped
	 * to what that model supports, so the level one model ran at states nothing about the next.
	 */
	thinking: ConfiguredThinkingLevel | null;
}

/** What a caller can contribute; anything omitted keeps its recorded value. */
export interface LaunchFactsUpdate {
	gitStatus?: GitStatusSummary;
	modelName?: string;
	providerName?: string;
	contextPercent?: number;
	/**
	 * The effort, or null to record that there was none.
	 *
	 * The only fact with an explicit clear. The others describe something that exists and is merely
	 * unresolved yet, so omitting them keeps the recorded value; an effort turned off is a fact in
	 * itself, and carrying the previous one forward would print `@high` on a row that has none.
	 */
	thinking?: ConfiguredThinkingLevel | null;
}

const NO_FACTS: LaunchFacts = {
	gitStatus: null,
	modelName: null,
	providerName: null,
	contextPercent: null,
	thinking: null,
};

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
 * The configured default model, which is what the model-scoped facts were measured under.
 *
 * A display name belongs to one model and a context percentage is taken against one window. The id
 * is read from the settings store the launch path has already loaded, and it is the same id the
 * next session will start from.
 */
function modelRole(): string {
	return settings.getModelRole("default") ?? "";
}

/** Hold a percentage inside the band the gauge can draw, since the bar derives its cells from it. */
function clampPercent(percent: number): number {
	return Math.max(0, Math.min(100, percent));
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
	if (file.version !== FACTS_VERSION || !file.projects || typeof file.projects !== "object") {
		memo = null;
		return memo;
	}
	memo = { version: FACTS_VERSION, projects: file.projects };
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
 * What the card may state, validated against the keys the facts were recorded under.
 *
 * Synchronous because the caller is a render, and a read the frame cannot await is a read the frame
 * does not get.
 */
export function readLaunchFacts(): LaunchFacts {
	const entry = load()?.projects[projectKey()];
	if (!entry || typeof entry !== "object") return NO_FACTS;

	// The dirty flag belongs to the working tree and survives a model change; the name, the provider
	// and the gauge were measured against one model and do not.
	const modelValid = entry.modelRole === modelRole();
	return {
		gitStatus: asGitStatus(entry.gitStatus),
		modelName:
			modelValid && typeof entry.modelName === "string" && entry.modelName.length > 0 ? entry.modelName : null,
		providerName:
			modelValid && typeof entry.providerName === "string" && entry.providerName.length > 0
				? entry.providerName
				: null,
		contextPercent:
			modelValid && typeof entry.contextPercent === "number" && Number.isFinite(entry.contextPercent)
				? clampPercent(entry.contextPercent)
				: null,
		thinking:
			modelValid && typeof entry.thinking === "string" && RECORDABLE_THINKING.has(entry.thinking)
				? (entry.thinking as ConfiguredThinkingLevel)
				: null,
	};
}

/**
 * What the card prints for the model before a catalog exists to name it.
 *
 * The display name the last launch of this same model recorded, and failing that the configured
 * role reduced to its final path segment. A role is stored qualified — `nous-research/z-ai/glm-5.1`
 * — and printing it whole costs the row the segments that trail it, the context gauge first: at
 * eighty columns that one id is twenty-six of them, so the first launch of a project drew a row
 * with no gauge on it and then grew one when the session resolved a display name. The tail is the
 * part a display name is derived from anyway, so the row states a narrower form of the same fact
 * rather than a different fact.
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
 * Merge `update` into what this project has recorded and write it, when anything changed.
 *
 * Facts recorded under a model that has since moved are DROPPED rather than carried onto the new
 * one: a display name from the model the operator just left is worse than no name at all, because
 * the card would state it with the same confidence as a correct one. The dirty flag is kept, since
 * it describes the working tree rather than the model.
 *
 * Other projects' entries are carried through untouched. When the map is full the oldest write
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
	const key = projectKey();
	const role = modelRole();
	const previous = load();
	const recorded = previous?.projects[key];
	const sameModel = recorded?.modelRole === role;

	const next: ProjectFacts = {
		modelRole: role,
		recordedAt: Date.now(),
		...(recorded && asGitStatus(recorded.gitStatus) ? { gitStatus: recorded.gitStatus } : {}),
		...(sameModel && recorded
			? {
					...(typeof recorded.modelName === "string" ? { modelName: recorded.modelName } : {}),
					...(typeof recorded.providerName === "string" ? { providerName: recorded.providerName } : {}),
					...(typeof recorded.contextPercent === "number" ? { contextPercent: recorded.contextPercent } : {}),
					...(typeof recorded.thinking === "string" ? { thinking: recorded.thinking } : {}),
				}
			: {}),
	};
	if (update.gitStatus !== undefined) next.gitStatus = update.gitStatus;
	if (update.modelName !== undefined && update.modelName.length > 0) next.modelName = update.modelName;
	if (update.providerName !== undefined && update.providerName.length > 0) next.providerName = update.providerName;
	if (update.contextPercent !== undefined && Number.isFinite(update.contextPercent)) {
		next.contextPercent = clampPercent(Math.round(update.contextPercent));
	}
	// The one fact a caller can erase: `null` states that the row printed no effort, which is a
	// different answer from not having resolved one yet.
	if (update.thinking === null) {
		delete next.thinking;
	} else if (update.thinking !== undefined) {
		next.thinking = update.thinking;
	}

	// `recordedAt` moves on every call, so it is left out of the comparison: a redraw that changed
	// no fact must not rewrite the file, which is what keeps an idle session off the disk.
	if (recorded && sameFacts(recorded, next)) return Promise.resolve();

	const projects = { ...previous?.projects, [key]: next };
	const file: LaunchFactsFile = { version: FACTS_VERSION, projects: evictOldest(projects) };
	memo = file;
	return atomicWriteJson(getLaunchFactsCachePath(), file, { fsync: false }).catch((err: unknown) => {
		logger.warn("Launch facts could not be written; the next launch will use placeholders", {
			error: errorMessage(err),
		});
	});
}

/** Every fact but the timestamp, which moves on each call and is not itself a fact about the project. */
function sameFacts(left: ProjectFacts, right: ProjectFacts): boolean {
	const strip = ({ recordedAt: _, ...rest }: ProjectFacts): Omit<ProjectFacts, "recordedAt"> => rest;
	return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
}

/** The newest {@link MAX_PROJECTS} entries, so the file cannot grow without bound. */
function evictOldest(projects: Record<string, ProjectFacts>): Record<string, ProjectFacts> {
	const entries = Object.entries(projects);
	if (entries.length <= MAX_PROJECTS) return projects;
	entries.sort(([, left], [, right]) => (right.recordedAt ?? 0) - (left.recordedAt ?? 0));
	return Object.fromEntries(entries.slice(0, MAX_PROJECTS));
}

/** Forget what this process read or wrote, so a test can drive the file directly. */
export function resetLaunchFactsForTest(): void {
	memo = undefined;
}
