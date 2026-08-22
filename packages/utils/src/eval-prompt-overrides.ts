/**
 * Replacing a registered prompt's text for ONE benchmark arm, and nothing else.
 *
 * WHY THIS EXISTS AT ALL. A prompt experiment cannot be run by editing the prompt
 * file: both arms of a comparison are served by one built binary, so the edit reaches
 * both and the delta it produces has no cause. The variant has to ride to the agent
 * per arm, which is what `VEYYON_EVAL_PROMPTS` is — a JSON object of prompt id to
 * replacement text, set by the bench runner around a single arm and by nothing else.
 * There is no config key and no CLI flag, deliberately: a config-reachable prompt
 * override could contaminate a production session, and a contaminated eval reports a
 * number that looks valid. This mirrors `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS` and
 * `VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS`, which are the same instrument aimed at the
 * system prompt's regions and rules rather than at a whole registered prompt.
 *
 * WHY IT IS ITS OWN MODULE. `prompt-registry.ts` describes what a registry IS; this
 * describes one eval-only substitution applied to one. Keeping them apart is what
 * makes the production path visibly free: {@link applyEvalPromptOverrides} returns the
 * caller's own table by identity when no override is set, so a session pays one env
 * read for a benchmark that is not running.
 *
 * WHY AN UNKNOWN ID IS NOT REFUSED HERE. A registry holds its own package's prompts
 * and cannot know whether an unclaimed id belongs to a sibling registry, so a refusal
 * from inside one is a guess. It guessed wrong: the first version refused on every
 * read of any registry once some override id was still unclaimed, and `@veyyon/ai`'s
 * registry is constructed before the coding agent's, so a valid `tools/bash` override
 * killed the agent at startup with `unknown prompt "tools/bash" in packages/ai/src/prompts`
 * and every trial in the arm hard-errored at zero output tokens. The id space is only
 * complete where every registry is known, so refusal lives in the two places that know
 * it: the bench runner, before a container starts and before quota is spent
 * (`packages/deepswe-bench/arm-prompts.ts`), and the application's own complete
 * registry list at prompt-assembly time (`packages/coding-agent/src/prompts/all-registries.ts`).
 * {@link unclaimedEvalPromptOverrideIds} is what those layers read.
 */
import { $env } from "./env";

/** One prompt id to the text that replaces it for this arm. */
export type EvalPromptOverrides = Readonly<Record<string, string>>;

const NO_OVERRIDES: EvalPromptOverrides = Object.freeze({});

let cachedRaw: string | undefined;
let cachedOverrides: EvalPromptOverrides = NO_OVERRIDES;
/** Ids some registry in this process holds, so the ones left over are the wrong ones. */
const claimedIds = new Set<string>();
/** Ids already named in the loud banner, so N registries do not print N banners. */
const announcedIds = new Set<string>();

/**
 * Parse and validate the payload carried by `VEYYON_EVAL_PROMPTS`.
 *
 * Malformed JSON, a non-object payload, and a non-string replacement all fail loudly:
 * a payload the agent silently ignores would bench the control under the treatment's
 * name, which is worse than a crash because the resulting table looks like a result.
 * Empty input is the quiet case and means the registered prompts.
 */
export function parseEvalPromptOverridesJson(raw: string | undefined): EvalPromptOverrides {
	if (raw === undefined || raw.trim() === "") return NO_OVERRIDES;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`VEYYON_EVAL_PROMPTS is set but is not valid JSON: ${err}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			`VEYYON_EVAL_PROMPTS must be a JSON object of prompt id -> replacement text, ` +
				`got ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed}`,
		);
	}
	for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value !== "string") {
			throw new Error(`VEYYON_EVAL_PROMPTS value for "${id}" must be a string, got ${typeof value}`);
		}
	}
	return parsed as EvalPromptOverrides;
}

/**
 * The override set in force, parsed once per distinct env value.
 *
 * Re-reading the env var rather than snapshotting it at import time is what lets a test
 * set the variable and observe the result; the parse itself is cached, and a changed
 * value resets the claim and announcement bookkeeping so a second scenario in one
 * process starts clean.
 */
export function evalPromptOverrides(): EvalPromptOverrides {
	const raw = $env.VEYYON_EVAL_PROMPTS;
	if (raw !== cachedRaw) {
		cachedRaw = raw;
		cachedOverrides = parseEvalPromptOverridesJson(raw);
		claimedIds.clear();
		announcedIds.clear();
	}
	return cachedOverrides;
}

/** What {@link applyEvalPromptOverrides} did, for a caller that reports or asserts on it. */
export interface EvalPromptOverrideResult<Entry> {
	/** The rows to serve: the caller's own table by identity when nothing was replaced. */
	readonly prompts: Readonly<Record<string, Entry>>;
	/** Ids this registry replaced, in override order. */
	readonly appliedIds: readonly string[];
}

/**
 * Replace the text of every row this registry owns and an override names.
 *
 * A row is replaced by copying it and swapping `text`, so everything else a registry
 * declares about a prompt — its purpose, its sections — still describes the prompt the
 * model is actually sent. Ids the table does not hold are left for another registry to
 * claim; see the module header for why that is not an error here.
 */
export function applyEvalPromptOverrides<Entry extends { text: string }>(
	prompts: Readonly<Record<string, Entry>>,
): EvalPromptOverrideResult<Entry> {
	const overrides = evalPromptOverrides();
	const ids = Object.keys(overrides);
	if (ids.length === 0) return { prompts, appliedIds: [] };

	const appliedIds: string[] = [];
	let replaced: Record<string, Entry> | undefined;
	for (const id of ids) {
		if (!Object.hasOwn(prompts, id)) continue;
		claimedIds.add(id);
		appliedIds.push(id);
		replaced ??= { ...prompts };
		replaced[id] = { ...prompts[id], text: overrides[id] };
	}
	return { prompts: replaced ?? prompts, appliedIds };
}

/**
 * Say once, loudly, that the prompts in force are not the shipped ones.
 *
 * Named by id and not by directory: a prompt id already names its file (it IS the path
 * under its registry's directory), and a caller cannot restate that directory without
 * copying a fact its registry owns. `veyyon prompt --prompts` maps an id to its package.
 *
 * WHY `console.warn` AND NOT `logger.warn`: this module is reached by browser-bundled
 * packages (collab-web, tool-render) through the registry contract, and
 * `@veyyon/utils/logger` pulls in `node:fs` and winston. `console.warn` is a portable
 * global on browser, Node and Bun.
 */
export function announceEvalPromptOverrides(appliedIds: readonly string[]): void {
	const fresh = appliedIds.filter(id => !announcedIds.has(id));
	if (fresh.length === 0) return;
	for (const id of fresh) announcedIds.add(id);
	console.warn(
		`EVAL-ONLY prompt override is ACTIVE (VEYYON_EVAL_PROMPTS): replacing prompt(s) [${fresh.join(", ")}]. ` +
			`This is NOT the production prompt — expected only inside a benchmark arm.`,
	);
}

/**
 * Override ids no registry built so far has claimed.
 *
 * A caller that knows the COMPLETE registry set turns this into a refusal. A caller
 * that does not must not: at any earlier moment the answer is only "not yet", and
 * acting on it is the defect described in the module header.
 */
export function unclaimedEvalPromptOverrideIds(): readonly string[] {
	return Object.keys(evalPromptOverrides()).filter(id => !claimedIds.has(id));
}
