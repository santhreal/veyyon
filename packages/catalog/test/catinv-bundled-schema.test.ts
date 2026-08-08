/**
 * WHY: every bundled models.json row must round-trip the one Model constructor,
 * because the registry builds rows LAZILY and a malformed row only detonates
 * when a user opens that provider. This is the incident class of
 * openrouter-pricing-nan (a NaN price shipped in the bundle and was read as a
 * real number downstream) and of every generator regression that writes a row
 * shape `buildModel` never validates: a typo'd `api` silently resolves
 * `compat: undefined` and breaks wire dispatch, a new generator field that is
 * not in the ModelSpec vocabulary rides the `{...spec}` spread into runtime
 * models unnoticed, and a zeroed/negative limit poisons context budgeting.
 *
 * These are sweep guards, not samples: each assertion collects EVERY offender
 * across all bundled rows and fails with the full list, so a regen that breaks
 * N rows names all N.
 *
 * Deliberately NOT asserted: `maxTokens <= contextWindow`. 26 bundled rows
 * carry upstream models.dev data where the declared output cap exceeds the
 * declared context (e.g. `huggingface/Sao10K/L3-8B-Stheno-v3.2` 32000 > 8192,
 * `aimlapi/gpt-3.5-turbo-0613` 4096 > 4095). The generator copies upstream
 * limits faithfully, so whether to clamp is a product decision, not a bug this
 * suite can pin.
 */
import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import { isEffort } from "@veyyon/catalog/effort";
import MODELS from "@veyyon/catalog/models.json" with { type: "json" };
import type { Api, ModelSpec } from "@veyyon/catalog/types";

/**
 * The `KnownApi` union in `types.ts` is type-only; this is its runtime spelling
 * for the sweep. A new api lands in the union -> this set fails until updated,
 * which is the intended tripwire: a bundled row may never carry an api the
 * union does not know, because an unrecognized api falls through `buildCompat`
 * to `compat: undefined` and the wire layer then dispatches blind.
 */
const KNOWN_APIS: Record<string, true> = {
	"openai-completions": true,
	"openai-responses": true,
	openrouter: true,
	"openai-codex-responses": true,
	"azure-openai-responses": true,
	"anthropic-messages": true,
	"bedrock-converse-stream": true,
	"google-generative-ai": true,
	"google-gemini-cli": true,
	"google-vertex": true,
	"ollama-chat": true,
	"cursor-agent": true,
	"gitlab-duo-agent": true,
	"devin-agent": true,
};

/**
 * The ModelSpec vocabulary (`types.ts`, the `Model` interface minus the
 * builder-emitted `compat`/`compatConfig`). The generator may only write
 * these keys: `buildModel` spreads the raw spec, so an unknown key would
 * silently become a runtime model field nothing reads.
 */
const SPEC_KEYS: Record<string, true> = {
	id: true,
	requestModelId: true,
	reasoningMode: true,
	name: true,
	api: true,
	provider: true,
	baseUrl: true,
	reasoning: true,
	input: true,
	imageInputDecoder: true,
	supportsTools: true,
	gitlabDuoWorkflowRootNamespaceId: true,
	cursorMaxMode: true,
	cost: true,
	pricing: true,
	premiumMultiplier: true,
	contextWindow: true,
	maxTokens: true,
	omitMaxOutputTokens: true,
	headers: true,
	transport: true,
	preferWebsockets: true,
	useResponsesLite: true,
	contextPromotionTarget: true,
	compactionModel: true,
	priority: true,
	thinking: true,
	reasoningOptions: true,
	compat: true,
	applyPatchToolType: true,
	isOAuth: true,
};

const COST_BUCKETS = ["cacheRead", "cacheWrite", "input", "output"];

interface Row {
	provider: string;
	key: string;
	row: Record<string, unknown>;
}

function allRows(): Row[] {
	const out: Row[] = [];
	for (const [provider, section] of Object.entries(
		MODELS as Record<string, Record<string, Record<string, unknown>>>,
	)) {
		for (const [key, row] of Object.entries(section)) {
			out.push({ provider, key, row });
		}
	}
	return out;
}

const label = (r: Row) => `${r.provider}/${r.key}`;

describe("every bundled row is filed under its own identity", () => {
	it("row.id matches the object key and row.provider matches the section key", () => {
		const offenders = allRows().flatMap(r => {
			const problems: string[] = [];
			if (r.row.id !== r.key) problems.push(`${label(r)}: id=${String(r.row.id)}`);
			if (r.row.provider !== r.provider) problems.push(`${label(r)}: provider=${String(r.row.provider)}`);
			return problems;
		});
		expect(offenders).toEqual([]);
	});
});

describe("every bundled row uses only the ModelSpec vocabulary", () => {
	it("carries no key the Model interface does not declare", () => {
		const offenders = allRows().flatMap(r =>
			Object.keys(r.row)
				.filter(key => SPEC_KEYS[key] !== true)
				.map(key => `${label(r)}: unknown key "${key}"`),
		);
		expect(offenders).toEqual([]);
	});
});

describe("every bundled row carries valid enum and scalar fields", () => {
	it("api is a KnownApi, reasoning is boolean, name is non-empty", () => {
		const offenders = allRows().flatMap(r => {
			const problems: string[] = [];
			if (typeof r.row.api !== "string" || KNOWN_APIS[r.row.api] !== true) {
				problems.push(`${label(r)}: api=${String(r.row.api)}`);
			}
			if (typeof r.row.reasoning !== "boolean") problems.push(`${label(r)}: reasoning=${String(r.row.reasoning)}`);
			if (typeof r.row.name !== "string" || r.row.name.length === 0) problems.push(`${label(r)}: bad name`);
			return problems;
		});
		expect(offenders).toEqual([]);
	});

	it("baseUrl is a string, empty only for azure whose deployment host resolves at runtime", () => {
		const offenders = allRows().flatMap(r => {
			if (typeof r.row.baseUrl !== "string") return [`${label(r)}: baseUrl=${String(r.row.baseUrl)}`];
			if (r.row.baseUrl.length === 0 && r.provider !== "azure") {
				return [`${label(r)}: empty baseUrl on a provider whose host is not runtime-resolved`];
			}
			return [];
		});
		expect(offenders).toEqual([]);
	});

	it("input is a non-empty array of text/image", () => {
		const offenders = allRows().flatMap(r => {
			const input = r.row.input;
			if (!Array.isArray(input) || input.length === 0) return [`${label(r)}: input=${JSON.stringify(input)}`];
			if (input.some(v => v !== "text" && v !== "image")) {
				return [`${label(r)}: input=${JSON.stringify(input)}`];
			}
			return [];
		});
		expect(offenders).toEqual([]);
	});
});

describe("every bundled row carries structurally valid cost and limits", () => {
	it("cost is exactly the four buckets, each a finite non-negative number", () => {
		const offenders = allRows().flatMap(r => {
			const cost = r.row.cost as Record<string, unknown> | undefined;
			if (cost === undefined || cost === null || typeof cost !== "object" || Array.isArray(cost)) {
				return [`${label(r)}: cost=${JSON.stringify(cost)}`];
			}
			const keys = Object.keys(cost).sort();
			if (keys.length !== 4 || keys.some((k, i) => k !== COST_BUCKETS[i])) {
				return [`${label(r)}: cost keys=${keys.join(",")}`];
			}
			return Object.entries(cost).flatMap(([bucket, value]) =>
				typeof value !== "number" || !Number.isFinite(value) || value < 0
					? [`${label(r)}: cost.${bucket}=${String(value)}`]
					: [],
			);
		});
		expect(offenders).toEqual([]);
	});

	it("contextWindow and maxTokens are null or finite positive numbers", () => {
		const offenders = allRows().flatMap(r =>
			(["contextWindow", "maxTokens"] as const).flatMap(field => {
				const value = r.row[field];
				if (value === null) return [];
				if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
					return [`${label(r)}: ${field}=${String(value)}`];
				}
				return [];
			}),
		);
		expect(offenders).toEqual([]);
	});

	it("headers, when present, is a record of strings", () => {
		const offenders = allRows().flatMap(r => {
			const headers = r.row.headers as Record<string, unknown> | undefined;
			if (headers === undefined) return [];
			if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
				return [`${label(r)}: headers=${JSON.stringify(headers)}`];
			}
			return Object.values(headers).some(v => typeof v !== "string") ? [`${label(r)}: non-string header value`] : [];
		});
		expect(offenders).toEqual([]);
	});

	it("reasoningOptions, when present, declares only real effort levels", () => {
		const offenders = allRows().flatMap(r => {
			const ro = r.row.reasoningOptions as { efforts?: unknown; noEffortControl?: unknown } | undefined;
			if (ro === undefined) return [];
			if (ro === null || typeof ro !== "object" || Array.isArray(ro)) {
				return [`${label(r)}: reasoningOptions=${JSON.stringify(ro)}`];
			}
			const problems: string[] = [];
			if (ro.efforts !== undefined) {
				if (!Array.isArray(ro.efforts) || ro.efforts.some(e => !isEffort(e))) {
					problems.push(`${label(r)}: reasoningOptions.efforts=${JSON.stringify(ro.efforts)}`);
				}
			}
			if (ro.noEffortControl !== undefined && typeof ro.noEffortControl !== "boolean") {
				problems.push(`${label(r)}: reasoningOptions.noEffortControl=${String(ro.noEffortControl)}`);
			}
			return problems;
		});
		expect(offenders).toEqual([]);
	});
});

describe("every bundled row round-trips the one Model constructor", () => {
	it("buildModel accepts every row and preserves its declared facts", () => {
		const offenders = allRows().flatMap(r => {
			try {
				const built = buildModel(r.row as unknown as ModelSpec<Api>);
				const problems: string[] = [];
				if (built.id !== r.row.id || built.provider !== r.row.provider) {
					problems.push(`${label(r)}: builder drifted identity`);
				}
				if (built.contextWindow !== r.row.contextWindow || built.maxTokens !== r.row.maxTokens) {
					problems.push(`${label(r)}: builder rewrote declared limits`);
				}
				return problems;
			} catch (error) {
				return [`${label(r)}: buildModel threw: ${(error as Error).message}`];
			}
		});
		expect(offenders).toEqual([]);
	});
});
