/**
 * WHY THIS SUITE EXISTS (A-GATEWAY-DESCRIBES-THE-MODEL-IT-PROXIES-NOT-ITSELF).
 *
 * A gateway proxies other vendors' models and reports their limits badly or not at all. Cursor, Devin and
 * Antigravity each used to answer the blind Claude-class assumption for every model they served, so a
 * gateway-hosted `grok-4.5`, a 500k model, was described as a 200k one and a Gemini row as a fifth of its real
 * window. The number is not cosmetic: auto-compaction, the context panel, context promotion and the overflow
 * check all read it, so the agent compacted at two fifths of the window it had and an operator with a 256k
 * threshold was told the threshold exceeded the model's context.
 *
 * THE CLASS, which is what this suite is written against rather than the reported id: a limit a gateway
 * publishes for a model it proxies must come from what is known about THAT MODEL, and never from the gateway's
 * own assumption while something known describes it. Three ways to be outside the class, all of which have
 * shipped here:
 *
 *  1. A gateway that never calls the resolver (the original defect, all three of them).
 *  2. A gateway that calls it but has its answer shadowed by something else. `cursor.ts` took limits from the
 *     bundled `cursor/*` row whenever one existed, which is every id a generator had already written down, so
 *     the resolver was inert for exactly the ids Cursor actually serves.
 *  3. The resolver answering out of the gateways' own rows. The bundled catalog carries `cursor/gpt-5.1-high` at
 *     200k because a pre-fix discovery run put it there, and resolving against the whole catalog handed that
 *     number back as if it were knowledge about GPT-5.1, whose window is 400k.
 *  4. A persisted copy of a pre-fix answer being served instead of a resolved one. Discovery output is cached
 *     per provider on disk, so the rows written under the old rule outlive the fix. That half of the class lives
 *     in `stale-cached-gateway-limits.test.ts`, next to the cache version it turns on.
 *
 * So the suite drives each gateway's REAL discovery entry point over a corpus read out of the bundled catalog at
 * run time, and derives the members it must cover from the tree and the data rather than from a list: the
 * discovery directory (every module is classified or the suite is red), the gateways' own provider ids as
 * observed from the rows their discovery produces, and every bundled row of every gateway provider.
 *
 * WHAT THIS DOES NOT CATCH. Bundled rows already shipped in `models.json` keep whatever a pre-resolver run wrote
 * until the next `bun run gen:models`; discovery outranks them at runtime for these providers, which is why the
 * operator sees the fix before the regen. Gateway id spellings beyond an effort tier, a speed marker and a
 * dash-for-dot version still land on the floor (`kimi-k2-7` does), which under-reports and is the safe
 * direction. A gateway whose limits are wrong because the VENDOR row is wrong is outside this class entirely.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import * as path from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
// Import from source, not the package specifier: the workspace `node_modules` copy resolves to the primary
// checkout, not this worktree.
import { fetchAntigravityDiscoveryModels } from "../src/discovery/antigravity";
import { fetchCursorUsableModels } from "../src/discovery/cursor";
import { GetUsableModelsResponseSchema, ModelDetailsSchema } from "../src/discovery/cursor-gen/agent_pb";
import {
	AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW,
	AGENT_GATEWAY_DEFAULT_MAX_TOKENS,
} from "../src/discovery/default-limits";
import { fetchDevinModels } from "../src/discovery/devin";
import { GetCliModelConfigsResponseSchema } from "../src/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import { ClientModelConfigSchema } from "../src/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";
import {
	GATEWAY_ROW_PROVIDERS,
	gatewayContextWindow,
	gatewayIdCandidates,
	gatewayMaxTokens,
	gatewayModelReference,
} from "../src/discovery/gateway-limits";
import { buildGitLabDuoWorkflowModelSpec } from "../src/discovery/gitlab-duo-workflow";
import { type GeneratedProvider, getBundledModel, getBundledModels, getBundledProviders } from "../src/models";
import { CATALOG_PROVIDERS } from "../src/provider-models/descriptors";
import type { Api, Model, ModelSpec } from "../src/types";

const DISCOVERY = path.resolve(import.meta.dir, "../src/discovery");

/** A bundled row whose two limits are both published, which every corpus member below has to be. */
type LimitedModel = Model<Api> & { contextWindow: number; maxTokens: number };

function publishesBothLimits(model: Model<Api> | undefined): model is LimitedModel {
	return typeof model?.contextWindow === "number" && typeof model.maxTokens === "number";
}

/**
 * The corpus is read out of the bundled catalog rather than written down: these are the numbers the catalog
 * itself publishes, so an assertion cannot drift from the data it is about. A missing row throws here rather
 * than turning every case below into a comparison against `undefined`.
 */
function catalogModel(provider: GeneratedProvider, id: string): LimitedModel {
	const model = getBundledModel(provider, id);
	if (!publishesBothLimits(model)) {
		throw new Error(`the bundled catalog publishes no limits for ${provider}/${id}`);
	}
	return model;
}

/**
 * A row that says nothing beyond the assumption: exactly the assumed pair, and no pricing at all. Written out
 * here rather than imported so the suite states the shape it expects the resolver to discard instead of asking
 * the resolver whether it agrees with itself.
 */
function isAssumptionShaped(model: Model<Api>): boolean {
	return (
		model.contextWindow === AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW &&
		model.maxTokens === AGENT_GATEWAY_DEFAULT_MAX_TOKENS &&
		model.cost.input === 0 &&
		model.cost.output === 0 &&
		model.cost.cacheRead === 0 &&
		model.cost.cacheWrite === 0
	);
}

/** The incident model: a 500k window against the 200k assumption, proxied by all three gateways. */
const WIDER = catalogModel("xai", "grok-4.5");

/**
 * A model whose real window is BELOW the assumption, so the resolver is shown not to raise a window to the
 * floor either. Derived from the data: the largest window under the floor that the resolver still answers with
 * that same number. Gemini ids are skipped because a gateway collapse table rewrites them, and a bare id is
 * required so the vendor-prefix case stays a separate axis.
 *
 * A broken resolver answers nothing that way, and the fallback pick is what turns that into a failing case
 * naming the model rather than a module that throws before any test runs.
 */
const NARROWER = ((): LimitedModel => {
	const belowTheFloor = getBundledProviders()
		.filter(provider => GATEWAY_ROW_PROVIDERS[provider] === undefined)
		.flatMap(provider => getBundledModels(provider))
		.filter(publishesBothLimits)
		.filter(
			model =>
				model.contextWindow > 0 &&
				model.contextWindow < AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW &&
				!model.id.includes("/") &&
				!model.id.toLowerCase().includes("gemini"),
		)
		.sort((left, right) => right.contextWindow - left.contextWindow || left.id.localeCompare(right.id));
	const pick = belowTheFloor.find(model => gatewayContextWindow(model.id) === model.contextWindow) ?? belowTheFloor[0];
	if (!pick) throw new Error("the bundled catalog publishes no model with a window below the gateway floor");
	return pick;
})();

/** An id nothing known describes, so the assumption is the honest answer. */
const UNKNOWN_ID = "totally-unknown-model-xyz";

/** A row as a gateway serves it: an id, plus whatever limits that endpoint has a field for. */
interface ServedRow {
	readonly id: string;
	/** A context window the endpoint itself reports. */
	readonly reportedWindow?: number;
	/** An output cap the endpoint itself reports. */
	readonly reportedCap?: number;
}

/**
 * One gateway, driven through the entry point its provider actually calls. Nothing here stands in for the
 * normalizer under test: the transport is faked because a test cannot reach Cursor's HTTP/2 endpoint, and every
 * line that decides a limit is the shipped one.
 */
interface GatewayUnderTest {
	/** The module under `src/discovery/` that owns this gateway's normalization. */
	readonly module: string;
	/** What this endpoint is able to report about a model's limits. */
	readonly reports: "nothing" | "one-number" | "window-and-cap";
	serve(rows: readonly ServedRow[]): Promise<ReadonlyMap<string, ModelSpec<Api>>>;
}

function byId(models: readonly ModelSpec<Api>[] | null): ReadonlyMap<string, ModelSpec<Api>> {
	return new Map((models ?? []).map(model => [model.id, model]));
}

/** A `typeof fetch` that answers every request with one body, without casting through `unknown`. */
function respondWith(body: string | Uint8Array, contentType: string): typeof fetch {
	return Object.assign(async () => new Response(body, { status: 200, headers: { "Content-Type": contentType } }), {
		preconnect() {},
	});
}

// Cursor talks HTTP/2 directly rather than through an injectable fetch, so it needs a real server. The rows it
// should serve are set immediately before each call.
let cursorServer: http2.Http2Server | undefined;
let cursorBaseUrl = "";
let cursorRows: readonly ServedRow[] = [];

beforeAll(async () => {
	const server = http2.createServer();
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});
		stream.on("end", () => {
			if (headers[":path"] !== "/agent.v1.AgentService/GetUsableModels") {
				stream.respond({ ":status": 404 });
				stream.end();
				return;
			}
			const response = create(GetUsableModelsResponseSchema, {
				models: cursorRows.map(row => create(ModelDetailsSchema, { modelId: row.id })),
			});
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			stream.end(Buffer.from(toBinary(GetUsableModelsResponseSchema, response)));
		});
	});
	const { promise, resolve } = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => resolve());
	await promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("http2 fixture server bound no tcp port");
	cursorServer = server;
	cursorBaseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
	cursorServer?.close();
});

/**
 * The gateways this suite drives. The set is checked against the discovery directory and against the provider
 * table below, so it cannot quietly fall behind either.
 */
const GATEWAYS: GatewayUnderTest[] = [
	{
		module: "cursor.ts",
		// `ModelDetails` carries an id, display names, aliases, thinking details and a max-mode flag. There is
		// no limit field on the wire at all.
		reports: "nothing",
		async serve(rows) {
			cursorRows = rows;
			return byId(await fetchCursorUsableModels({ apiKey: "test-key", baseUrl: cursorBaseUrl }));
		},
	},
	{
		module: "devin.ts",
		// One `maxTokens` has to serve as the context window; there is no separate output-cap field.
		reports: "one-number",
		async serve(rows) {
			const response = create(GetCliModelConfigsResponseSchema, {
				clientModelConfigs: rows.map(row =>
					create(ClientModelConfigSchema, {
						modelUid: row.id,
						label: row.id,
						maxTokens: row.reportedWindow ?? 0,
					}),
				),
			});
			return byId(
				await fetchDevinModels({
					apiKey: "test-token",
					baseUrl: "https://devin.example",
					fetch: respondWith(toBinary(GetCliModelConfigsResponseSchema, response), "application/proto"),
				}),
			);
		},
	},
	{
		module: "antigravity.ts",
		reports: "window-and-cap",
		async serve(rows) {
			const models: Record<string, Record<string, unknown>> = {};
			for (const row of rows) {
				models[row.id] = {
					displayName: row.id,
					...(row.reportedWindow === undefined ? undefined : { maxTokens: row.reportedWindow }),
					...(row.reportedCap === undefined ? undefined : { maxOutputTokens: row.reportedCap }),
				};
			}
			return byId(
				await fetchAntigravityDiscoveryModels({
					token: "test-token",
					endpoint: "https://antigravity.example",
					fetcher: respondWith(JSON.stringify({ models }), "application/json"),
				}),
			);
		},
	},
];

describe.each(GATEWAYS)("$module publishes the proxied model's limits", gateway => {
	/**
	 * The headline. A gateway that reports nothing about a 500k model must still describe it as a 500k model,
	 * and the same resolution has to hold for the id spellings a gateway actually serves: an effort tier, a
	 * speed marker, both stacked, a dash where the vendor writes a dot, and a vendor-prefixed id.
	 */
	it("answers the catalog's window for every spelling of a wider model", async () => {
		const ids = [
			WIDER.id,
			`${WIDER.id}-medium`,
			`${WIDER.id}-fast`,
			`${WIDER.id}-high-fast`,
			WIDER.id.replace(/\./g, "-"),
			`${WIDER.provider}/${WIDER.id}`,
		];
		const models = await gateway.serve(ids.map(id => ({ id })));
		for (const id of ids) {
			const model = models.get(id);
			expect(model, `${gateway.module} dropped ${id}`).toBeDefined();
			expect(model?.contextWindow, `${gateway.module} published ${id}`).toBe(WIDER.contextWindow);
		}
	});

	/**
	 * The other direction, which a resolver that simply answered "the largest number it can find" would fail:
	 * a model whose real window is BELOW the assumption keeps its own smaller number. Its output cap is kept as
	 * published too, since the clamp is an upper bound and not a value.
	 */
	it("does not raise a narrower model to the assumption", async () => {
		const models = await gateway.serve([{ id: NARROWER.id }]);
		const model = models.get(NARROWER.id);
		expect(model?.contextWindow).toBe(NARROWER.contextWindow);
		expect(NARROWER.contextWindow).toBeLessThan(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
		expect(model?.maxTokens).toBe(Math.min(NARROWER.maxTokens ?? 0, AGENT_GATEWAY_DEFAULT_MAX_TOKENS));
	});

	/**
	 * The floor, pinned to the literal pair rather than to the constants: an id nothing known describes has no
	 * evidence either way, and 200k/64k is what such a model is assumed to offer. Against the constants this
	 * case could only agree with itself.
	 */
	it("falls to the assumed pair only for an id nothing known describes", async () => {
		expect(gatewayModelReference(UNKNOWN_ID)).toBeUndefined();
		const models = await gateway.serve([{ id: UNKNOWN_ID }]);
		expect(models.get(UNKNOWN_ID)?.contextWindow).toBe(200_000);
		expect(models.get(UNKNOWN_ID)?.maxTokens).toBe(64_000);
	});

	/**
	 * A catalog-derived output cap is clamped to the assumption: a vendor's own cap is not a promise about the
	 * proxy, and some gateways refuse an oversized output budget outright rather than clamping it. The wider
	 * model's vendor cap is above the assumption, so this pins the clamp rather than a coincidence.
	 */
	it("clamps a catalog output cap to the assumption", async () => {
		expect(WIDER.maxTokens ?? 0).toBeGreaterThan(AGENT_GATEWAY_DEFAULT_MAX_TOKENS);
		const models = await gateway.serve([{ id: WIDER.id }]);
		expect(models.get(WIDER.id)?.maxTokens).toBe(64_000);
	});

	/**
	 * What the gateway reported still outranks the catalog, because it is the only party that knows what the
	 * proxy will actually accept. A gateway with no field for a window ignores the report instead of skipping the
	 * case: an endpoint that starts carrying limits, or a `reports` label that stops being true, has to be red
	 * somewhere rather than silently turning this case off.
	 */
	it("keeps a reported window over the catalog's, when it has a field for one", async () => {
		const models = await gateway.serve([{ id: WIDER.id, reportedWindow: 131_072 }]);
		expect(models.get(WIDER.id)?.contextWindow).toBe(gateway.reports === "nothing" ? WIDER.contextWindow : 131_072);
	});

	/**
	 * A reported zero or negative is "not told" rather than a limit. A zero window would make auto-compaction
	 * fire before any turn began. Only these two reach a normalizer through a real transport: protobuf refuses
	 * to encode a non-finite int32 at all, and `JSON.stringify` turns one into `null`. The non-finite guard is
	 * asserted at the resolver and against a hand-written JSON body further down.
	 */
	it("treats a non-positive reported window as not told", async () => {
		for (const reportedWindow of [0, -1]) {
			const models = await gateway.serve([{ id: WIDER.id, reportedWindow }]);
			expect(models.get(WIDER.id)?.contextWindow, `reported ${reportedWindow}`).toBe(WIDER.contextWindow);
		}
	});

	/**
	 * A cap the gateway itself reported IS a statement about the proxy, so it is taken as given even above the
	 * assumption. Only Antigravity has a field for one, and the others have to ignore a cap they cannot see.
	 */
	it("takes a reported output cap as given, when it has a field for one", async () => {
		const models = await gateway.serve([{ id: WIDER.id, reportedCap: 96_000 }]);
		expect(models.get(WIDER.id)?.maxTokens).toBe(gateway.reports === "window-and-cap" ? 96_000 : 64_000);
	});

	/**
	 * A reported CONTEXT window is never taken as an output cap. Devin reports one number that has to serve as
	 * the window, and reading it as a budget asks the gateway for half a megabyte of output, which some of them
	 * refuse outright rather than clamping. So a reported window of 500k leaves the cap at the assumption.
	 */
	it("never turns a reported context window into an output cap", async () => {
		const models = await gateway.serve([{ id: WIDER.id, reportedWindow: 500_000 }]);
		const row = models.get(WIDER.id);
		expect(row?.contextWindow).toBe(gateway.reports === "nothing" ? WIDER.contextWindow : 500_000);
		expect(row?.maxTokens).toBe(64_000);
	});
});

describe("a non-finite reported limit is not a limit", () => {
	/**
	 * `NaN` and `Infinity` cannot cross protobuf and do not survive `JSON.stringify`, so the guard is asserted
	 * at the choke point every gateway calls. An infinite window would mean the agent never compacts at all, and
	 * a NaN one makes every comparison against it false, so both have to read as "not told".
	 */
	it("ignores a NaN or infinite reported limit at the resolver", () => {
		for (const reported of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(gatewayContextWindow(WIDER.id, reported), `window ${reported}`).toBe(WIDER.contextWindow);
			expect(gatewayMaxTokens(WIDER.id, reported), `cap ${reported}`).toBe(AGENT_GATEWAY_DEFAULT_MAX_TOKENS);
		}
	});

	/**
	 * One transport can still deliver an infinity: `JSON.parse` turns an overflowing literal into `Infinity`,
	 * and Antigravity's payload is JSON a server writes. So the hand-written body is the real adversarial input
	 * rather than a value a test could only inject in-process.
	 */
	it("ignores an overflowing JSON number from a real payload", async () => {
		const body = `{"models":{"${WIDER.id}":{"displayName":"overflow","maxTokens":1e999}}}`;
		// `1e999` parses to Infinity, and re-serializing a non-finite number yields `null`, so this is the proof
		// that the payload really delivers one rather than a number the reader could have kept.
		expect(JSON.stringify(JSON.parse(body))).toContain('"maxTokens":null');
		const models = byId(
			await fetchAntigravityDiscoveryModels({
				token: "test-token",
				endpoint: "https://antigravity.example",
				fetcher: respondWith(body, "application/json"),
			}),
		);
		expect(models.get(WIDER.id)?.contextWindow).toBe(WIDER.contextWindow);
	});
});

describe("the gateways' own rows are never the evidence", () => {
	const gatewayProviders = getBundledProviders().filter(provider => GATEWAY_ROW_PROVIDERS[provider] !== undefined);

	/** Non-vacuity: the bundled catalog does carry gateway rows, so the sweep below has something to sweep. */
	it("finds gateway rows in the bundled catalog", () => {
		expect(gatewayProviders.length).toBeGreaterThan(0);
		expect(gatewayProviders.flatMap(provider => getBundledModels(provider)).length).toBeGreaterThan(20);
	});

	/**
	 * The laundering case. Every id below is one a gateway published, so the catalog holds that gateway's own
	 * row for it; resolving against the whole catalog answered with that row and handed a pre-fix assumption
	 * back as knowledge. No id a gateway serves may resolve onto a gateway's row, whichever gateway wrote it.
	 */
	it("resolves no gateway-served id onto a gateway row", () => {
		const laundered: string[] = [];
		for (const provider of gatewayProviders) {
			for (const model of getBundledModels(provider)) {
				const reference = gatewayModelReference(model.id);
				if (reference && GATEWAY_ROW_PROVIDERS[reference.provider] !== undefined) {
					laundered.push(`${provider}/${model.id} -> ${reference.provider}/${reference.id}`);
				}
			}
		}
		expect(laundered).toEqual([]);
	});

	/**
	 * A row carrying exactly the assumed pair with no pricing at all is the shape every gateway row had before
	 * the resolver existed, so the resolver never answers with one whoever published it: that is how a gateway
	 * nobody has classified yet still cannot launder its guess back in. Discarding an honest row of that shape
	 * costs nothing, since the answer without it is the same pair. Swept over the whole catalog, so a new
	 * provider that starts publishing that shape is covered without being named here.
	 */
	it("never answers with an assumption-shaped row, whoever published it", () => {
		const shaped = getBundledProviders()
			.flatMap(provider => getBundledModels(provider))
			.filter(isAssumptionShaped);
		expect(shaped.length).toBeGreaterThan(0);
		const answered: string[] = [];
		for (const model of shaped) {
			const reference = gatewayModelReference(model.id);
			if (reference && isAssumptionShaped(reference)) {
				answered.push(`${model.provider}/${model.id} -> ${reference.provider}/${reference.id}`);
			}
		}
		expect(answered).toEqual([]);
	});

	/**
	 * Cursor reports no limit at all, so every limit it publishes has to be the resolver's answer. The sweep is
	 * over every id the bundled catalog says Cursor serves, which is where the shadowing defect lived: the
	 * normalizer took limits off the bundled `cursor/*` row for exactly those ids, and the resolver never ran.
	 *
	 * Each id is swept twice, because the normalizer has TWO reference paths and only one of them is reached by a
	 * bundled id: an exact bundled row, and a tier id the collapse table does not know yet (`gpt-5.4-max`), which
	 * inherits its base's row. Sweeping only the exact ids left the second path free to keep publishing the
	 * bundled window, and a tier of a stale row is the same defect one indirection along.
	 */
	it("gives every id Cursor serves the resolver's numbers, through both reference paths", async () => {
		const served = getBundledModels("cursor");
		expect(served.length).toBeGreaterThan(20);
		const ids = [...served.map(model => model.id), ...served.map(model => `${model.id}-max`)];
		cursorRows = ids.map(id => ({ id }));
		const published = byId(await fetchCursorUsableModels({ apiKey: "test-key", baseUrl: cursorBaseUrl }));
		const wrong: string[] = [];
		for (const id of ids) {
			const row = published.get(id);
			const expectedWindow = gatewayContextWindow(id);
			const expectedCap = gatewayMaxTokens(id);
			if (row?.contextWindow !== expectedWindow || row?.maxTokens !== expectedCap) {
				wrong.push(`${id}: ${row?.contextWindow}/${row?.maxTokens} want ${expectedWindow}/${expectedCap}`);
			}
		}
		expect(wrong).toEqual([]);
		// Non-vacuity with teeth, one per path: some of those ids have a bundled window the resolver contradicts,
		// which is the stale pre-fix data. If none did, this test could pass while the normalizer read the row.
		const contradicted = served.filter(model => gatewayContextWindow(model.id) !== model.contextWindow);
		expect(contradicted.length).toBeGreaterThan(0);
		for (const model of contradicted) {
			expect(gatewayContextWindow(`${model.id}-max`), `${model.id}-max`).not.toBe(model.contextWindow);
		}
	});
});

describe("a gateway's own id spelling reaches the vendor's row", () => {
	/**
	 * Devin cannot put a dot in an id, so it serves `gpt-5-4`, `gemini-3-1-pro` and `glm-5-2` for models the
	 * vendors publish as `gpt-5.4`, `gemini-3.1-pro` and `GLM-5.2`. Nothing in the reference lookup undoes that,
	 * so before this the resolver was inert for most of Devin's catalog and a silent row went out at a fifth of
	 * its window. The corpus is every dash-spelled id the bundled catalog says Devin serves whose dotted spelling
	 * names something known, excluding the ids some vendor owns in dash form already (`kimi-k2-6` is a real
	 * Venice id, and the nearest match is the right answer for it).
	 *
	 * Driven through Devin's real discovery reporting nothing at all, which is the case the resolver exists for.
	 */
	it("resolves every dash-spelled version Devin serves like its dotted form", async () => {
		const devin = GATEWAYS.find(gateway => gateway.module === "devin.ts");
		expect(devin, "the devin case is missing from the harness").toBeDefined();
		const corpus: { id: string; window: number }[] = [];
		for (const row of getBundledModels("devin")) {
			if (!/\d-\d/.test(row.id)) continue;
			// An id a vendor owns in dash form resolves to itself; the dotted spelling is not its evidence.
			if (gatewayModelReference(row.id)?.id === row.id) continue;
			const dotted = gatewayModelReference(row.id.replace(/(\d)-(\d)/g, "$1.$2"));
			if (dotted?.contextWindow == null) continue;
			corpus.push({ id: row.id, window: dotted.contextWindow });
		}
		expect(corpus.length).toBeGreaterThan(10);
		const published = await devin?.serve(corpus.map(entry => ({ id: entry.id })));
		const wrong: string[] = [];
		for (const entry of corpus) {
			const window = published?.get(entry.id)?.contextWindow;
			if (window !== entry.window) wrong.push(`${entry.id}: ${window} want ${entry.window}`);
		}
		expect(wrong).toEqual([]);
		// Non-vacuity: at least one of them is wider than the assumption, so the sweep cannot pass by answering
		// the floor for everything.
		expect(corpus.some(entry => entry.window > AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW)).toBe(true);
	});

	/**
	 * A gateway also writes its OWN name into the id: Cursor serves the operator's default model as
	 * `cursor-grok-4.5-medium`, so every rewrite below fired and none of them reached `grok-4.5`, and a 500k
	 * model went out as a 200k one. That is not cosmetic: the compaction trigger is derived from the window, so
	 * the session compacted at two fifths of the context it had.
	 *
	 * The corpus is a cross product read out of the catalog rather than a list: every gateway id the distrust
	 * table names, against every bare vendor model the resolver answers ABOVE the assumption for. So a new
	 * gateway is covered the moment it is distrusted, and a new wide model the moment it is bundled, with no
	 * list to go stale. Only models above the assumption qualify, so a resolver that stopped resolving and
	 * answered the floor for everything cannot pass.
	 */
	const WIDE_VENDOR_MODELS = ((): { id: string; window: number }[] => {
		const seen = new Set<string>();
		return getBundledProviders()
			.filter(provider => GATEWAY_ROW_PROVIDERS[provider] === undefined)
			.flatMap(provider => getBundledModels(provider))
			.filter(publishesBothLimits)
			.filter(model => !model.id.includes("/"))
			.filter(model => gatewayContextWindow(model.id) > AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW)
			.filter(model => (seen.has(model.id) ? false : seen.add(model.id) !== undefined))
			.slice(0, 30)
			.map(model => ({ id: model.id, window: gatewayContextWindow(model.id) }));
	})();

	const GATEWAY_PREFIXES = Object.keys(GATEWAY_ROW_PROVIDERS);

	/** Non-vacuity for both axes of the cross product below. */
	it("finds gateway names and wide vendor models to cross", () => {
		expect(GATEWAY_PREFIXES.length).toBeGreaterThanOrEqual(3);
		expect(WIDE_VENDOR_MODELS.length).toBeGreaterThan(10);
	});

	it("resolves a gateway-prefixed id like the vendor id it wraps", () => {
		const wrong: string[] = [];
		for (const prefix of GATEWAY_PREFIXES) {
			for (const model of WIDE_VENDOR_MODELS) {
				const window = gatewayContextWindow(`${prefix}-${model.id}`);
				if (window !== model.window) wrong.push(`${prefix}-${model.id}: ${window} want ${model.window}`);
			}
		}
		expect(wrong).toEqual([]);
	});

	/**
	 * The prefix is a candidate, not a substitution, and the vocabulary is closed: only a bundled provider id
	 * counts as a gateway name, and stripping one may never produce an empty id. Without the first half any
	 * model whose real name happens to start with a word before a dash would be resolved as something else;
	 * without the second, the bare provider id would resolve as a model.
	 *
	 * A nested provider id does parse as a shorter provider plus a word (`google-antigravity` offers
	 * `antigravity` as a candidate), which is why the assertion is that no gateway name names a model rather
	 * than that it offers nothing: the remainder is a word no vendor publishes, and the assumption is what comes
	 * back.
	 */
	it("strips only a provider id, and never the whole id", () => {
		expect(gatewayContextWindow(`notaprovider-${WIDER.id}`)).toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
		expect(gatewayIdCandidates(`notaprovider-${WIDER.id}`)).toEqual([`notaprovider-${WIDER.id}`]);
		for (const prefix of GATEWAY_PREFIXES) {
			// The trailing-dash id is the malformed shape the strip could turn into an empty candidate. Two owners
			// refuse it (the strip returns nothing, and the walk skips a falsy candidate), so what is asserted is
			// the property they exist for rather than either one of them.
			for (const id of [prefix, `${prefix}-`]) {
				const candidates = gatewayIdCandidates(id);
				expect(candidates[0], id).toBe(id);
				expect(
					candidates.filter(candidate => candidate.length === 0),
					id,
				).toEqual([]);
				expect(gatewayContextWindow(id), id).toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
			}
		}
	});

	/**
	 * The longest name wins, which matters because provider ids nest: `google` is a prefix of
	 * `google-antigravity`, and `minimax-code` of `minimax-code-cn`. Taking the shorter one would leave the rest
	 * of the gateway's own name glued to the model (`antigravity-grok-4.5`), which resolves to nothing. The
	 * nesting pairs are derived from the bundled provider ids, so a newly nested id is covered on arrival.
	 */
	it("takes the longest provider id when they nest", () => {
		const providers = getBundledProviders();
		const nested = providers.flatMap(short =>
			providers.filter(long => long !== short && long.startsWith(`${short}-`)).map(long => ({ short, long })),
		);
		expect(nested.length).toBeGreaterThan(0);
		for (const { short, long } of nested) {
			const candidates = gatewayIdCandidates(`${long}-${WIDER.id}`);
			expect(candidates, `${long} under ${short}`).toContain(WIDER.id);
			expect(candidates, `${long} under ${short}`).not.toContain(`${long.slice(short.length + 1)}-${WIDER.id}`);
		}
	});

	/**
	 * The incident itself, through Cursor's real discovery: the gateway reports no limits at all, and the id
	 * composes its own name with an effort tier, so two rewrites have to compose for the vendor row to be
	 * reached.
	 */
	it("publishes the vendor's window for the id shape Cursor really serves", async () => {
		const cursor = GATEWAYS.find(gateway => gateway.module === "cursor.ts");
		expect(cursor, "the cursor case is missing from the harness").toBeDefined();
		const ids = [`cursor-${WIDER.id}`, `cursor-${WIDER.id}-medium`, `cursor-${WIDER.id}-high-fast`];
		const published = await cursor?.serve(ids.map(id => ({ id })));
		for (const id of ids) {
			expect(published?.get(id)?.contextWindow, id).toBe(WIDER.contextWindow);
		}
		expect(WIDER.contextWindow).toBeGreaterThan(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
	});

	/**
	 * The ladder is a queue that feeds itself: each candidate pushes a tier-stripped, a speed-stripped and a
	 * dotted rewrite of itself, and those rewrites compose. What makes it end is a measure that every rewrite
	 * strictly reduces, plus the visited check. A rewrite that lengthens a candidate, or a lost visited check,
	 * makes the walk unbounded, and a resolver that never returns hangs discovery instead of publishing a
	 * wrong number, which no value assertion can see. So the three properties are asserted directly against an
	 * id built to stack every rewrite ten times over, rather than through a wall-clock deadline that only says
	 * "fast on this machine today".
	 */
	it("walks a bounded ladder for an id that stacks every rewrite", () => {
		const stacked = `gpt-5-4-3-2-1-9-8-7-6-5${"-high-fast".repeat(10)}`;
		const candidates = gatewayIdCandidates(stacked);

		expect(candidates[0]).toBe(stacked);
		expect(new Set(candidates).size, "the same id is walked twice").toBe(candidates.length);
		expect(candidates.filter(candidate => candidate.length > stacked.length)).toEqual([]);
		// Two affixes to strip ten times over and one dash rewrite: a few dozen ids, not a few thousand.
		expect(candidates.length).toBeLessThanOrEqual(128);
		// Non-vacuity: the stacked id really does drive the ladder, and the resolver still answers for it.
		expect(candidates.length).toBeGreaterThan(10);
		expect(gatewayContextWindow(stacked)).toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
	});
});

/**
 * Every discovery module is classified. A new module is red until someone records which of these it is, which is
 * the only reason a gateway added next year is covered by the sweeps above.
 */
const NOT_A_GATEWAY: Record<string, string> = {
	"codex.ts": "first-party OpenAI Codex: a model host, with its own documented 272k/128k pair",
	"default-limits.ts": "the assumed pair itself, with no discovery in it",
	"failure.ts": "the shared discovery-failure reason type",
	"gateway-limits.ts": "the resolver these gateways route through",
	"gemini.ts": "first-party Google: a model host that publishes its own limits",
	"index.ts": "barrel",
	"openai-compatible.ts": "generic OpenAI-compatible discovery against an endpoint that publishes its own limits",
};

/**
 * A gateway that does NOT route through the resolver, with the reason it is still outside the fix. Pinned by
 * exact equality so it is a recorded decision rather than an oversight, and so routing it turns this red.
 */
const GATEWAY_NOT_ROUTED: Record<string, string> = {
	"gitlab-duo-workflow.ts":
		"resolves its windows from its own five-pattern table, matched against GitLab's model ref rather than " +
		"against the catalog; a proxied model outside those patterns still gets the gateway floor",
};

/** Directories of generated protobuf descriptors, which carry no limit decision. */
const GENERATED_DIRECTORIES: readonly string[] = ["cursor-gen", "devin-gen"];

describe("every discovery module is classified", () => {
	function classify(files: readonly string[]): { unclassified: string[]; generatedDirs: string[] } {
		const driven = new Set(GATEWAYS.map(gateway => gateway.module));
		const unclassified: string[] = [];
		const generatedDirs = new Set<string>();
		for (const file of files) {
			const [head, ...rest] = file.split("/");
			if (head !== undefined && rest.length > 0) {
				generatedDirs.add(head);
				continue;
			}
			if (driven.has(file) || NOT_A_GATEWAY[file] !== undefined || GATEWAY_NOT_ROUTED[file] !== undefined) {
				continue;
			}
			unclassified.push(file);
		}
		return { unclassified: unclassified.sort(), generatedDirs: [...generatedDirs].sort() };
	}

	function discoveryFiles(): string[] {
		return [...new Bun.Glob("**/*.ts").scanSync(DISCOVERY)].map(file => file.split(path.sep).join("/")).sort();
	}

	/** The fail-by-default half: a module nobody classified is red, and the generated dirs are pinned exactly. */
	it("leaves no discovery module unclassified", () => {
		const files = discoveryFiles();
		expect(files.length).toBeGreaterThan(GATEWAYS.length);
		const { unclassified, generatedDirs } = classify(files);
		expect(unclassified).toEqual([]);
		expect(generatedDirs).toEqual([...GENERATED_DIRECTORIES]);
	});

	/**
	 * And the classifier is shown to actually reject a new member, since a fail-by-default rule that cannot be
	 * observed failing is a claim. A module that nobody has decided about is unclassified whatever it is named.
	 */
	it("rejects a module nobody has decided about", () => {
		const { unclassified } = classify([...discoveryFiles(), "brand-new-gateway.ts"]);
		expect(unclassified).toEqual(["brand-new-gateway.ts"]);
	});
});

describe("the gateway provider ids line up with the tables that name them", () => {
	/**
	 * The link that makes the distrust table honest: the provider id is read off the rows each gateway's real
	 * discovery produces, so a new gateway whose rows are not distrusted is red here, and a renamed provider is
	 * red too. Without this the table is a list of strings nobody checks.
	 */
	it("distrusts the provider id every driven gateway publishes", async () => {
		const observed: string[] = [];
		for (const gateway of GATEWAYS) {
			const models = await gateway.serve([{ id: WIDER.id }]);
			const provider = models.get(WIDER.id)?.provider;
			expect(provider, `${gateway.module} published no row`).toBeDefined();
			if (provider !== undefined) observed.push(provider);
		}
		expect(observed.length).toBe(GATEWAYS.length);
		for (const provider of observed) {
			expect(GATEWAY_ROW_PROVIDERS[provider], `${provider} is not in GATEWAY_ROW_PROVIDERS`).toBeDefined();
		}
	});

	/**
	 * The rest of the distrust table is pinned by exact equality with a reason, so nobody can add an id to it
	 * without recording why, and dropping one is red. `gitlab-duo` publishes gateway rows through the runtime
	 * rather than through this directory; `gitlab-duo-agent` is the module pinned above.
	 */
	it("pins the ids no driven gateway accounts for", async () => {
		const driven = new Set<string>();
		for (const gateway of GATEWAYS) {
			const models = await gateway.serve([{ id: WIDER.id }]);
			const provider = models.get(WIDER.id)?.provider;
			if (provider !== undefined) driven.add(provider);
		}
		const extra = Object.keys(GATEWAY_ROW_PROVIDERS)
			.filter(provider => !driven.has(provider))
			.sort();
		expect(extra).toEqual(["gitlab-duo", "gitlab-duo-agent"]);
	});

	/**
	 * Every distrusted id is a real provider in the catalog table. A typo, or a provider renamed there, would
	 * otherwise leave the distrust silently inert: the rows would keep their old id and keep being believed.
	 */
	it("names only providers the catalog table declares", () => {
		const declared = new Set<string>(CATALOG_PROVIDERS.map(entry => entry.id));
		const missing = Object.keys(GATEWAY_ROW_PROVIDERS)
			.filter(provider => !declared.has(provider))
			.sort();
		expect(missing).toEqual([]);
	});

	/** Every distrusted id carries a reason, since the table's whole purpose is to record why. */
	it("carries a reason for each distrusted id", () => {
		for (const [provider, reason] of Object.entries(GATEWAY_ROW_PROVIDERS)) {
			expect(reason.length, provider).toBeGreaterThan(20);
		}
	});
});

describe("a gateway outside the resolver", () => {
	/**
	 * The recorded gap. GitLab Duo Workflow matches its own five patterns against GitLab's model ref and falls
	 * to the gateway floor for anything else, so it describes a proxied 500k model as a 200k one exactly the way
	 * the three gateways above used to. Its rows are distrusted so the number cannot spread, but the number is
	 * still wrong at the source. Routing it through the resolver turns this red, which is the point: the next
	 * person to fix it deletes this case instead of discovering the gap.
	 */
	it("still answers its own pattern table, and is distrusted for it", () => {
		const spec = buildGitLabDuoWorkflowModelSpec({ name: WIDER.name, ref: WIDER.id });
		expect(GATEWAY_NOT_ROUTED["gitlab-duo-workflow.ts"]).toBeDefined();
		expect(spec.contextWindow).toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
		expect(spec.contextWindow).not.toBe(WIDER.contextWindow);
		expect(GATEWAY_ROW_PROVIDERS[spec.provider]).toBeDefined();
	});
});
