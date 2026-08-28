import { $env } from "./env";
import { nearestNames } from "./levenshtein";
import { isRecord } from "./type-guards";

export type EvalPromptOverrides = Readonly<Record<string, string>>;

const NO_OVERRIDES: EvalPromptOverrides = Object.freeze({});

let cachedRaw: string | undefined;
let cachedOverrides: EvalPromptOverrides = NO_OVERRIDES;
const claimedIds = new Set<string>();
const announcedIds = new Set<string>();

export function parseEvalPromptOverridesJson(raw: string | undefined): EvalPromptOverrides {
	if (raw === undefined || raw.trim() === "") return NO_OVERRIDES;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`VEYYON_EVAL_PROMPTS is set but is not valid JSON: ${err}`);
	}
	if (!isRecord(parsed)) {
		throw new Error(
			`VEYYON_EVAL_PROMPTS must be a JSON object of prompt id -> replacement text, ` +
				`got ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed}`,
		);
	}
	for (const [id, value] of Object.entries(parsed)) {
		if (typeof value !== "string") {
			throw new Error(`VEYYON_EVAL_PROMPTS value for "${id}" must be a string, got ${typeof value}`);
		}
	}
	return parsed as EvalPromptOverrides;
}

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

export interface EvalPromptOverrideResult<Entry> {
	readonly prompts: Readonly<Record<string, Entry>>;
	readonly appliedIds: readonly string[];
}

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

export function announceEvalPromptOverrides(appliedIds: readonly string[]): void {
	const fresh = appliedIds.filter(id => !announcedIds.has(id));
	if (fresh.length === 0) return;
	for (const id of fresh) announcedIds.add(id);
	console.warn(
		`EVAL-ONLY prompt override is ACTIVE (VEYYON_EVAL_PROMPTS): replacing prompt(s) [${fresh.join(", ")}]. ` +
			`This is NOT the production prompt — expected only inside a benchmark arm.`,
	);
}

export function unclaimedEvalPromptOverrideIds(): readonly string[] {
	return Object.keys(evalPromptOverrides()).filter(id => !claimedIds.has(id));
}

export const PROMPT_ID_SHAPE_HINT =
	"An id is the path under a registry's directory without .md (for example tools/bash, not tools/bash.md and not bash).";

export function describeUnknownPromptIds(unknown: readonly string[], known: readonly string[]): string {
	return unknown
		.map(id => {
			const near = nearestNames(id, known, 3);
			return `  ${id}${near.length > 0 ? ` — did you mean ${near.join(", ")}?` : ""}`;
		})
		.join("\n");
}
