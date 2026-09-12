/**
 * WHY: `modelOverrides.<id>.thinking` states the effort ladder an operator's
 * endpoint accepts, and it reached the built model as nothing. `buildModel`
 * resolves thinking from the discovery-declared surface first, so a row whose
 * upstream metadata says `noEffortControl` — openrouter's
 * `anthropic/claude-sonnet-4` after a catalog regen — discarded the authored
 * ladder and left the picker closed on a model the operator had just described.
 * A declared ladder that merely disagrees with the authored one did the same.
 *
 * The class this closes: a bundled row's declared reasoning surface outranking
 * an authored one, for every provider that ships such a row, not only the row
 * from the report. Candidates are read from the registry's own bundled catalog
 * at run time, so a provider that grows one is swept without an edit here. A
 * custom model definition carrying `thinking` for a bundled id patches through
 * the same `applyModelPatch` choke point as an override, so it is fixed by the
 * same line rather than covered by a second sweep.
 *
 * Not covered: a transport that cannot carry the effort field at all
 * (`openai-responses` with `supportsReasoningEffort: false`), where dropping
 * the ladder is the wire fact rather than a lost override — those rows are
 * excluded below and the exclusion is asserted to be exactly that shape.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { Effort } from "@veyyon/catalog/effort";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

/** The ladder an operator authors, in canonical order, on a mode no row declares. */
const AUTHORED = { mode: "budget", efforts: [Effort.Low, Effort.High] } as const;

/** APIs where `supportsReasoningEffort: false` means the field is omitted from the wire entirely. */
const EFFORTLESS_RESPONSES_APIS = new Set<string>([
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
]);

function omitsWireEffort(model: Model<Api>): boolean {
	if (!EFFORTLESS_RESPONSES_APIS.has(model.api)) return false;
	const compat = model.compat as { supportsReasoningEffort?: boolean } | undefined;
	return compat?.supportsReasoningEffort === false;
}

let tempDirs: string[] = [];

function registryFor(config: Record<string, unknown>, auth: AuthStorage): ModelRegistry {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-authored-thinking-${Snowflake.next()}-`));
	tempDirs.push(dir);
	const modelsJson = path.join(dir, "models.json");
	fs.writeFileSync(modelsJson, JSON.stringify(config));
	return new ModelRegistry(auth, modelsJson);
}

describe("an authored thinking ladder outranks the declared surface", () => {
	let auth: AuthStorage;
	let bundled: Model<Api>[];

	beforeAll(async () => {
		auth = await AuthStorage.create(":memory:");
		bundled = registryFor({ providers: {} }, auth).getAll();
	});

	afterEach(() => {
		for (const dir of tempDirs) {
			if (fs.existsSync(dir)) removeSyncWithRetries(dir);
		}
		tempDirs = [];
	});

	/**
	 * One candidate per provider per declared shape: a registry is built once
	 * for the whole sweep, so the cost is the row count and not the provider
	 * count, while every provider that ships the shape is still represented.
	 */
	function candidates(shape: (model: Model<Api>) => boolean): Map<string, Model<Api>> {
		const byProvider = new Map<string, Model<Api>>();
		for (const model of bundled) {
			if (!model.reasoning || omitsWireEffort(model) || !shape(model)) continue;
			if (!byProvider.has(model.provider)) byProvider.set(model.provider, model);
		}
		return byProvider;
	}

	function overrideEvery(picked: Map<string, Model<Api>>): Map<string, Model<Api>> {
		const providers: Record<string, unknown> = {};
		for (const [provider, model] of picked) {
			providers[provider] = { modelOverrides: { [model.id]: { thinking: AUTHORED } } };
		}
		const registry = registryFor({ providers }, auth);
		const resolved = new Map<string, Model<Api>>();
		for (const [provider, model] of picked) {
			const built = registry.getAll().find(m => m.provider === provider && m.id === model.id);
			if (built) resolved.set(provider, built);
		}
		return resolved;
	}

	function ladderOf(models: Map<string, Model<Api>>): Record<string, unknown> {
		return Object.fromEntries(
			[...models].map(([provider, model]) => [
				provider,
				{ mode: model.thinking?.mode, efforts: model.thinking?.efforts },
			]),
		);
	}

	function expectedLadder(providers: Iterable<string>): Record<string, unknown> {
		return Object.fromEntries(
			[...providers].map(provider => [provider, { mode: "budget", efforts: AUTHORED.efforts }]),
		);
	}

	test("a row whose discovery declares no effort control still offers the authored ladder", () => {
		const picked = candidates(model => model.reasoningOptions?.noEffortControl === true);
		// The defect was reported on a row of this shape; a catalog with none
		// left is a premise change somebody has to record, not a silent pass.
		expect([...picked.keys()].length).toBeGreaterThan(0);
		const built = overrideEvery(picked);
		expect([...built.keys()].sort()).toEqual([...picked.keys()].sort());
		expect(ladderOf(built)).toEqual(expectedLadder(picked.keys()));
	});

	test("a row that declares its own ladder still offers the authored one", () => {
		const picked = candidates(model => {
			const declared = model.reasoningOptions?.efforts;
			return Array.isArray(declared) && declared.length > 0;
		});
		expect([...picked.keys()].length).toBeGreaterThan(0);
		const built = overrideEvery(picked);
		expect([...built.keys()].sort()).toEqual([...picked.keys()].sort());
		expect(ladderOf(built)).toEqual(expectedLadder(picked.keys()));
	});

	test("the excluded rows are exactly the responses transports that omit the effort field", () => {
		const excluded = bundled.filter(model => model.reasoning && omitsWireEffort(model));
		const apis = [...new Set(excluded.map(model => model.api))].sort();
		expect(apis.every(api => EFFORTLESS_RESPONSES_APIS.has(api))).toBe(true);
		const picked = new Map(excluded.slice(0, 1).map(model => [model.provider, model]));
		if (picked.size === 0) return;
		const built = overrideEvery(picked);
		// The authored ladder is dropped here on purpose: the endpoint rejects
		// the field, so offering tiers would be offering an error.
		expect([...built.values()].map(model => model.thinking)).toEqual([undefined]);
	});
});
