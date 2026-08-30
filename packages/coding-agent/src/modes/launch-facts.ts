/**
 * What the last launch of this project knew, so the card can state it instead of a placeholder.
 *
 * THE PROBLEM THIS SOLVES. The launch card paints at about 48ms and the session finishes booting at
 * about 650ms. Three of the things on that card cannot be computed inside the first budget at any
 * price: a model's display name needs the catalog, the working tree's dirty flag needs a `git
 * status` that costs 130ms on a repository this size, and the context gauge needs a prompt that has
 * not been assembled yet. Rendered as placeholders they were not merely blank — the hero announced
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
import { atomicWriteJson } from "@veyyon/utils/atomic-write";
import { getLaunchFactsCachePath, getProjectDir, VERSION } from "@veyyon/utils/dirs";
import { isEnoent } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { settings } from "../config/settings-instance";
import type { GitStatusSummary } from "../utils/git";

/**
 * The file on disk. Both keys are stored so a reader can tell which facts survived.
 *
 * Every fact is optional: they are recorded from different places at different moments, and a
 * launch that never resolved one leaves the previous value alone rather than writing a null over
 * it.
 */
interface LaunchFactsFile {
	projectKey: string;
	gitStatus?: GitStatusSummary;
	modelKey: string;
	modelName?: string;
	providerName?: string;
	contextPercent?: number;
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
}

/** What a caller can contribute; anything omitted keeps its recorded value. */
export interface LaunchFactsUpdate {
	gitStatus?: GitStatusSummary;
	modelName?: string;
	providerName?: string;
	contextPercent?: number;
}

const NO_FACTS: LaunchFacts = { gitStatus: null, modelName: null, providerName: null, contextPercent: null };

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
 * The release, the project and the configured default model.
 *
 * The model is in this key because a display name belongs to one model and a context percentage is
 * taken against one window. The id is read from the settings store the launch path has already
 * loaded, and it is the same id the next session will start from.
 */
function modelKey(): string {
	return `${projectKey()}|${settings.getModelRole("default") ?? ""}`;
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
	if (typeof file.projectKey !== "string" || typeof file.modelKey !== "string") {
		memo = null;
		return memo;
	}
	memo = file as LaunchFactsFile;
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
	const file = load();
	if (!file) return NO_FACTS;

	const projectValid = file.projectKey === projectKey();
	const modelValid = file.modelKey === modelKey();
	return {
		gitStatus: projectValid ? asGitStatus(file.gitStatus) : null,
		modelName: modelValid && typeof file.modelName === "string" && file.modelName.length > 0 ? file.modelName : null,
		providerName:
			modelValid && typeof file.providerName === "string" && file.providerName.length > 0 ? file.providerName : null,
		contextPercent:
			modelValid && typeof file.contextPercent === "number" && Number.isFinite(file.contextPercent)
				? clampPercent(file.contextPercent)
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
 * Merge `update` into what is recorded and write it, when anything changed.
 *
 * Facts recorded under a key that has since moved are DROPPED rather than carried onto the new key:
 * a display name from the model the operator just left is worse than no name at all, because the
 * card would state it with the same confidence as a correct one.
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
	const currentProjectKey = projectKey();
	const currentModelKey = modelKey();
	const previous = load();
	// Only facts still valid under today's keys survive into the merge.
	const kept: LaunchFactsFile = {
		projectKey: currentProjectKey,
		modelKey: currentModelKey,
		...(previous?.projectKey === currentProjectKey && asGitStatus(previous.gitStatus)
			? { gitStatus: previous.gitStatus }
			: {}),
		...(previous?.modelKey === currentModelKey
			? {
					...(typeof previous.modelName === "string" ? { modelName: previous.modelName } : {}),
					...(typeof previous.providerName === "string" ? { providerName: previous.providerName } : {}),
					...(typeof previous.contextPercent === "number" ? { contextPercent: previous.contextPercent } : {}),
				}
			: {}),
	};

	const next: LaunchFactsFile = { ...kept };
	if (update.gitStatus !== undefined) next.gitStatus = update.gitStatus;
	if (update.modelName !== undefined && update.modelName.length > 0) next.modelName = update.modelName;
	if (update.providerName !== undefined && update.providerName.length > 0) next.providerName = update.providerName;
	if (update.contextPercent !== undefined && Number.isFinite(update.contextPercent)) {
		next.contextPercent = clampPercent(Math.round(update.contextPercent));
	}

	if (previous && JSON.stringify(previous) === JSON.stringify(next)) return Promise.resolve();
	memo = next;
	return atomicWriteJson(getLaunchFactsCachePath(), next, { fsync: false }).catch((err: unknown) => {
		logger.warn("Launch facts could not be written; the next launch will use placeholders", {
			error: errorMessage(err),
		});
	});
}

/** Forget what this process read or wrote, so a test can drive the file directly. */
export function resetLaunchFactsForTest(): void {
	memo = undefined;
}
