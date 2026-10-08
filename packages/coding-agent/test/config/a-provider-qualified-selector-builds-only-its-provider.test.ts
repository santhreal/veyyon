/**
 * A CLI selector that names its provider resolves the model the whole catalog would, and builds
 * that provider alone.
 *
 * WHY: `resolveCliModel` listed the whole registry before reading the selector, so
 * `--model anthropic/claude-sonnet-4-5` built all 4,400 catalog models to return one of them: 48 ms
 * of launch and 2 MiB of heap the registry holds until its next model refresh. The named path looks the
 * reference up among the named provider's models through `ModelRegistry.getProviderModels`, and
 * falls back to the whole-catalog path on a miss.
 *
 * THE CLASS THIS CLOSES. A named answer that differs from the whole-catalog answer: a provider
 * spelled in another case, a `--provider` flag with or without the prefix repeated in the id, a
 * retired variant alias, a Bedrock inference profile, two providers whose names differ only in
 * case, and a provider from models.yml or registered at run time. Every model of the catalog is
 * swept from the registry at run time, so a provider added to the catalog is covered when it
 * lands. Every miss form (unknown provider, unknown id, empty id, `*`, a thinking suffix, an
 * OpenRouter route or date suffix, a `@role`, a bare id) is compared against the whole-catalog
 * answer, both before the registry has built its catalog and after. A catalog model the named
 * path hands to the whole catalog (a role-shaped reference, a `--provider` id equal to the default
 * role alias) is pinned by exact equality, so a new one fails the suite; a reference two models
 * share once case is folded is derived from the catalog. `getAll` is the only method that builds a
 * registry's catalog, so a named hit that builds it fails the count of `getAll` calls, and a
 * registry that builds every provider to answer one fails the retained-heap bound measured in a
 * fresh process.
 *
 * NOT COVERED: the process-level launch path in `main.ts` that calls `resolveCliModel`, which the
 * binary A/B measures, and selectors whose whole-catalog answer comes from fuzzy matching, which
 * the named path never answers.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModels } from "@veyyon/catalog/models";
import { getVariantAliasSources } from "@veyyon/catalog/variant-collapse";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { type ResolveCliModelResult, resolveCliModel } from "@veyyon/coding-agent/config/model-resolver";
import {
	DEFAULT_MODEL_ROLE_ALIAS,
	LEGACY_MODEL_ROLE_ALIAS_PREFIX,
	MODEL_ROLE_ALIAS_PREFIX,
} from "@veyyon/coding-agent/config/model-roles";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { TempDir } from "@veyyon/utils";
import type { SelectorRetention } from "../fixtures/named-selector-retention";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "named-selector-retention.ts");
const BEDROCK_PROFILE = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-v1:0";

const CONFIG_MODEL = { contextWindow: 64000, maxTokens: 4096 };

function configProvider(host: string, ids: string[]) {
	return {
		baseUrl: `https://${host}.example.com/v1`,
		api: "openai-completions",
		apiKey: "literal:TEST_KEY",
		models: ids.map(id => ({ id, name: id, ...CONFIG_MODEL })),
	};
}

/**
 * models.yml providers: one with a model whose id is the default role alias, one named like the
 * legacy role prefix, and two whose names differ only in case.
 */
const MODELS_CONFIG = {
	providers: {
		"yard-gw": configProvider("yard", ["yard-model", DEFAULT_MODEL_ROLE_ALIAS]),
		[LEGACY_MODEL_ROLE_ALIAS_PREFIX.slice(0, -1)]: configProvider("pi", ["smol"]),
		"Acme-Gw": configProvider("acme", ["alpha"]),
		"acme-gw": configProvider("acme", ["beta"]),
	},
};

/** A provider an extension registers at run time; registering it builds the registry's catalog. */
const RUNTIME_PROVIDER = "ext-gw";

interface Selector {
	cliProvider?: string;
	cliModel: string;
}

interface Registries {
	/** Answers every selector through the whole-catalog path. */
	reference: ModelRegistry;
	/** Answers through `getProviderModels` first. */
	lazy: ModelRegistry;
	/** Times the lazy registry was asked for its whole catalog since `openRegistries` returned. */
	listings: () => number;
	resolveReference: (selector: Selector) => ResolveCliModelResult;
	resolveLazy: (selector: Selector) => ResolveCliModelResult;
}

let tmp: TempDir;
const settings = Settings.isolated({});

async function openRegistry(name: string, runtime: boolean): Promise<ModelRegistry> {
	const dir = tmp.join(name);
	await fs.mkdir(dir, { recursive: true });
	const modelsPath = path.join(dir, "models.yml");
	await fs.writeFile(modelsPath, JSON.stringify(MODELS_CONFIG));
	const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	const registry = new ModelRegistry(authStorage, modelsPath, { snapshotIo: false });
	if (runtime) {
		registry.registerProvider(RUNTIME_PROVIDER, {
			baseUrl: "https://ext.example.com/v1",
			apiKey: "literal:TEST_KEY",
			api: "openai-completions",
			models: [
				{
					id: "ext-model",
					name: "Ext Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					...CONFIG_MODEL,
				},
			],
		});
	}
	return registry;
}

/**
 * A reference registry read through the whole-catalog path, and a lazy one passed to
 * `resolveCliModel` as the CLI passes it. `getAll` is the only method that builds a registry's
 * catalog, so its call count on the lazy registry is the number of times the catalog was listed.
 */
async function openRegistries(name: string, runtime = false): Promise<Registries> {
	const reference = await openRegistry(`${name}-reference`, runtime);
	const lazy = await openRegistry(`${name}-lazy`, runtime);
	const referenceView = {
		getAll: () => reference.getAll(),
		getAvailable: () => reference.getAvailable(),
		getError: () => reference.getError(),
		hasConfiguredAuth: (model: Model<Api>) => reference.hasConfiguredAuth(model),
	};
	const listing = spyOn(lazy, "getAll");
	return {
		reference,
		lazy,
		listings: () => listing.mock.calls.length,
		resolveReference: selector => resolveCliModel({ ...selector, modelRegistry: referenceView, settings }),
		resolveLazy: selector => resolveCliModel({ ...selector, modelRegistry: lazy, settings }),
	};
}

function key(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/** What a caller reads from a resolution, with the model reduced to its reference. */
function outcome(result: ResolveCliModelResult) {
	return {
		model: result.model && key(result.model),
		selector: result.selector,
		thinkingLevel: result.thinkingLevel,
		warning: result.warning,
		error: result.error,
		roleFailure: result.roleFailure,
	};
}

function label(selector: Selector): string {
	return selector.cliProvider
		? `--provider ${selector.cliProvider} --model ${selector.cliModel}`
		: `--model ${selector.cliModel}`;
}

function byProvider(models: readonly Model<Api>[]): Map<string, Model<Api>[]> {
	const out = new Map<string, Model<Api>[]>();
	for (const model of models) {
		const list = out.get(model.provider);
		if (list) list.push(model);
		else out.set(model.provider, [model]);
	}
	return out;
}

/** Whether a `--model` value is a role selector, which only the whole catalog resolves. */
function roleShaped(cliModel: string): boolean {
	return (
		cliModel === DEFAULT_MODEL_ROLE_ALIAS ||
		cliModel.startsWith(`${DEFAULT_MODEL_ROLE_ALIAS}:`) ||
		cliModel.startsWith(MODEL_ROLE_ALIAS_PREFIX) ||
		cliModel.startsWith(LEGACY_MODEL_ROLE_ALIAS_PREFIX)
	);
}

interface CatalogSelectors {
	/** Spellings the named path answers. */
	named: Selector[];
	/** References two models share once case is folded, which the named path leaves to the whole catalog. */
	ambiguous: Selector[];
	/** Unique references the named path leaves to the whole catalog: role selectors and a `--provider` id of `*`. */
	deferred: Selector[];
}

/** Selectors that name a catalog model exactly, sorted by which path answers them. */
function catalogSelectors(catalog: readonly Model<Api>[]): CatalogSelectors {
	const keyCounts = new Map<string, number>();
	for (const model of catalog) {
		const lower = key(model).toLowerCase();
		keyCounts.set(lower, (keyCounts.get(lower) ?? 0) + 1);
	}
	const out: CatalogSelectors = { named: [], ambiguous: [], deferred: [] };
	const add = (model: Model<Api>, selector: Selector, answered: boolean) => {
		if (keyCounts.get(key(model).toLowerCase()) !== 1) out.ambiguous.push(selector);
		else (answered ? out.named : out.deferred).push(selector);
	};
	const idAnswered = (model: Model<Api>) => model.id !== DEFAULT_MODEL_ROLE_ALIAS;
	for (const model of catalog) {
		add(model, { cliModel: key(model) }, !roleShaped(key(model)));
		// A `--provider` id that repeats the provider prefix is stripped to another id.
		if (!model.id.toLowerCase().startsWith(`${model.provider.toLowerCase()}/`)) {
			add(model, { cliProvider: model.provider, cliModel: model.id }, idAnswered(model));
		}
		for (const alias of getVariantAliasSources(model.provider, model.id)) {
			add(model, { cliModel: `${model.provider}/${alias}` }, true);
		}
	}
	for (const [provider, models] of byProvider(catalog)) {
		for (const model of [models[0], models.at(-1)!]) {
			add(model, { cliModel: key(model).toUpperCase() }, !roleShaped(key(model).toUpperCase()));
			add(model, { cliProvider: provider.toUpperCase(), cliModel: key(model) }, idAnswered(model));
			add(model, { cliProvider: provider.toLowerCase(), cliModel: ` ${model.id} ` }, idAnswered(model));
		}
	}
	if (catalog.some(model => model.provider === "amazon-bedrock")) {
		out.named.push({ cliModel: `amazon-bedrock/${BEDROCK_PROFILE}` });
		out.named.push({ cliProvider: "amazon-bedrock", cliModel: BEDROCK_PROFILE });
	}
	return out;
}

/** Selectors the named path does not answer, which run the whole-catalog path. */
function missSelectors(catalog: readonly Model<Api>[]): Selector[] {
	const out: Selector[] = [
		{ cliModel: "no-such-provider/no-such-model" },
		{ cliProvider: "no-such-provider", cliModel: "no-such-model" },
		{ cliModel: "@smol" },
		{ cliModel: "@nope" },
		{ cliModel: catalog[0].id },
		{ cliModel: "/leading-slash" },
	];
	for (const [provider, models] of byProvider(catalog)) {
		const first = models[0];
		out.push(
			{ cliModel: `${provider}/no-such-model` },
			{ cliProvider: provider, cliModel: "no-such-model" },
			{ cliModel: `${provider}/` },
			{ cliProvider: provider, cliModel: `${provider}/` },
			{ cliModel: `${provider}/${DEFAULT_MODEL_ROLE_ALIAS}` },
			{ cliProvider: provider, cliModel: DEFAULT_MODEL_ROLE_ALIAS },
			{ cliModel: `${key(first)}:high` },
			{ cliProvider: provider, cliModel: `${first.id}:high` },
			{ cliModel: `${key(first)}:nitro` },
			{ cliModel: `${key(first)}-20250101` },
			{ cliModel: first.id.slice(0, Math.max(1, first.id.length - 2)) },
		);
	}
	return out;
}

/** Selectors whose named answer differs from the whole-catalog answer, with both answers. */
function divergences(registries: Registries, selectors: readonly Selector[]): string[] {
	const out: string[] = [];
	for (const selector of selectors) {
		const expected = outcome(registries.resolveReference(selector));
		const actual = outcome(registries.resolveLazy(selector));
		if (!Bun.deepEquals(actual, expected)) {
			out.push(`${label(selector)}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
		}
	}
	return out;
}

/** Named selectors that listed the lazy registry's catalog to answer. */
function listingSelectors(registries: Registries, selectors: readonly Selector[]): string[] {
	const out: string[] = [];
	for (const selector of selectors) {
		const before = registries.listings();
		registries.resolveLazy(selector);
		if (registries.listings() !== before) out.push(label(selector));
	}
	return out;
}

beforeAll(async () => {
	tmp = await TempDir.create("@named-selector-");
});

afterAll(async () => {
	await tmp.remove();
});

const RESOLVED = { error: undefined, thinkingLevel: undefined, warning: undefined, roleFailure: undefined };

describe("a provider-qualified CLI selector", () => {
	it("resolves every catalog model as the whole catalog does, without listing the catalog", async () => {
		const registries = await openRegistries("sweep");
		const catalog = registries.reference.getAll();
		const providers = new Set(catalog.map(model => model.provider));
		expect(Object.keys(MODELS_CONFIG.providers).filter(provider => !providers.has(provider))).toEqual([]);
		const { named, deferred } = catalogSelectors(catalog);
		// A catalog model the named path does not answer is a decision recorded here, not a silent skip.
		expect(deferred.map(label)).toEqual([
			"--provider yard-gw --model *",
			"--model pi/smol",
			"--provider YARD-GW --model yard-gw/*",
			"--provider yard-gw --model  * ",
		]);

		expect(listingSelectors(registries, named)).toEqual([]);
		expect(divergences(registries, named)).toEqual([]);
		expect(registries.listings()).toBe(0);
	}, 60_000);

	it("answers every miss as the whole catalog does, before and after the catalog is listed", async () => {
		const registries = await openRegistries("misses");
		const catalog = registries.reference.getAll();
		const { named, ambiguous, deferred } = catalogSelectors(catalog);
		const misses = [...missSelectors(catalog), ...ambiguous, ...deferred];

		// The first miss lists the lazy registry's catalog; every named selector after it reads the listed catalog.
		expect(divergences(registries, misses)).toEqual([]);
		expect(registries.listings()).toBeGreaterThan(0);
		const listedAfterMisses = registries.listings();
		expect(divergences(registries, named)).toEqual([]);
		expect(listingSelectors(registries, named)).toEqual([]);
		expect(registries.listings()).toBe(listedAfterMisses);
	}, 60_000);

	it("resolves a name two providers share ignoring case to the provider the catalog spells last", async () => {
		const registries = await openRegistries("case");
		const selectors: Selector[] = [
			{ cliProvider: "ACME-GW", cliModel: "alpha" },
			{ cliProvider: "acme-gw", cliModel: "beta" },
			{ cliProvider: "Acme-Gw", cliModel: "acme-gw/alpha" },
			{ cliModel: "ACME-GW/beta" },
			{ cliModel: "acme-gw/alpha" },
		];

		expect(selectors.map(selector => outcome(registries.resolveLazy(selector)))).toEqual([
			{ model: "Acme-Gw/alpha", selector: "Acme-Gw/alpha", ...RESOLVED },
			{ model: "acme-gw/beta", selector: "acme-gw/beta", ...RESOLVED },
			{ model: "Acme-Gw/alpha", selector: "Acme-Gw/alpha", ...RESOLVED },
			{ model: "acme-gw/beta", selector: "acme-gw/beta", ...RESOLVED },
			{ model: "Acme-Gw/alpha", selector: "Acme-Gw/alpha", ...RESOLVED },
		]);
		expect(divergences(registries, selectors)).toEqual([]);
		expect(registries.listings()).toBe(0);
	});

	it("resolves a provider an extension registered as the whole catalog does, without listing it again", async () => {
		const registries = await openRegistries("runtime", true);
		const scoped = new Set([RUNTIME_PROVIDER, ...Object.keys(MODELS_CONFIG.providers)]);
		const catalog = registries.reference.getAll().filter(model => scoped.has(model.provider));
		expect(catalog.filter(model => model.provider === RUNTIME_PROVIDER).map(key)).toEqual(["ext-gw/ext-model"]);
		const { named, deferred } = catalogSelectors(catalog);

		expect(listingSelectors(registries, named)).toEqual([]);
		expect(divergences(registries, [...named, ...deferred, ...missSelectors(catalog)])).toEqual([]);
		expect(outcome(registries.resolveLazy({ cliModel: "EXT-GW/ext-model" }))).toEqual({
			model: "ext-gw/ext-model",
			selector: "ext-gw/ext-model",
			...RESOLVED,
		});
	});
});

describe("ModelRegistry.getProviderModels", () => {
	it("lists a provider's models as the catalog lists them, before and after the catalog is built", async () => {
		const registry = await openRegistry("provider-models", false);
		const reference = await openRegistry("provider-models-reference", false);
		const catalog = reference.getAll();
		const names = [...new Set(catalog.map(model => model.provider))];
		const queries = [...names, ...names.map(name => name.toUpperCase()), "no-such-provider"];
		const expected = (query: string) =>
			catalog.filter(model => model.provider.toLowerCase() === query.toLowerCase()).map(key);

		const unlisted = new Map(queries.map(query => [query, registry.getProviderModels(query)]));
		const listed = registry.getAll();
		for (const query of queries) {
			const before = unlisted.get(query)!;
			const after = registry.getProviderModels(query);
			expect({ query, models: before.map(key) }).toEqual({ query, models: expected(query) });
			expect(after).toEqual(listed.filter(model => model.provider.toLowerCase() === query.toLowerCase()));
			// A provider built on demand is the one the catalog later lists: the same objects, not copies.
			expect(after.every((model, index) => model === before[index])).toBe(true);
		}
		expect(registry.getProviderModels("no-such-provider")).toEqual([]);
	});

	it("leaves the rest of the catalog unbuilt when a selector names its provider", () => {
		const anthropic = getBundledModels("anthropic");
		const openai = getBundledModels("openai");
		const run = spawnSync(
			process.execPath,
			[FIXTURE, tmp.path(), `openai/${openai[0].id}`, `anthropic/${anthropic[0].id}`],
			{ encoding: "utf8" },
		);
		expect(run.stderr).toBe("");
		const retention = JSON.parse(run.stdout) as SelectorRetention;

		expect(retention.resolved).toBe(`anthropic/${anthropic[0].id}`);
		// The named resolution builds one provider, about 0.1 MiB; the listing builds every other one, about 2 MiB.
		expect(retention.listed).toBeGreaterThan(1024 * 1024);
		expect(retention.named * 8).toBeLessThan(retention.listed);
	});
});
