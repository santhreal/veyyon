/**
 * The reason a provider produced no catalog has to reach whoever configured the manager.
 *
 * WHY THIS SUITE EXISTS. `fetchOpenAICompatibleModels` learned to report WHY it answers `null`, but for a
 * while nothing passed it a sink: the readers built by `provider-models/openai-compat.ts` are handed to
 * `createModelManager` as an opaque `fetchDynamicModels` closure, so the reason died at that boundary. The
 * manager then fell through to the cache and the static catalog, which is the right BEHAVIOUR and the
 * wrong silence: a provider whose endpoint refused the connection produced the same outcome as one that
 * answered with an empty list, and what the user saw was a picker missing models they pay for.
 *
 * `ModelManagerOptions.onDiscoveryFailure` is that channel, and this suite drives it through the real
 * manager rather than through the reader, because the boundary is what was broken. It also pins the two
 * cases that must stay quiet -- models came back, or the endpoint honestly listed none -- since a channel
 * that fires on success is worse than no channel.
 *
 * The manager's own catch is covered too: a fetcher that THROWS never gets to report through its hooks,
 * and that path used to be the quietest of all.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DiscoveryFailure, DiscoveryHooks } from "../src/discovery/failure";
import { createModelManager } from "../src/model-manager";
import type { Api, ModelSpec } from "../src/types";

/**
 * A model list the manager will accept.
 *
 * Every field here is REQUIRED by the manager's `modelSpecRejection` gate, which drops anything that fails it and
 * says nothing -- a spec missing `reasoning`, or a `cost` without `cacheRead` and `cacheWrite`, produced an
 * empty catalog and made the success assertions below pass for the wrong reason until every field was
 * filled in. The four cost fields are required by `ModelSpec` itself, so this is a complete spec rather
 * than a minimal one; kept to a single model so the suite stays about the failure channel.
 */
function oneModel(): ModelSpec<"openai-completions">[] {
	return [
		{
			id: "test-model",
			name: "Test Model",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://models.example.com",
			reasoning: false,
			contextWindow: 8192,
			maxTokens: 1024,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		} as ModelSpec<"openai-completions">,
	];
}

/**
 * Refresh once through the real manager, collecting whatever reasons arrive.
 *
 * Each call gets its own cache database: the manager skips the network entirely when a fresh authoritative
 * cache exists, so a shared cache would let a later test pass without ever calling the fetcher.
 */
async function refreshCollecting(
	fetchDynamicModels: Parameters<typeof createModelManager<Api>>[0]["fetchDynamicModels"],
): Promise<{ failures: DiscoveryFailure[]; modelIds: string[] }> {
	const failures: DiscoveryFailure[] = [];
	const manager = createModelManager<Api>({
		providerId: "openai",
		staticModels: [],
		cacheDbPath: path.join(mkdtempSync(path.join(tmpdir(), "veyyon-catalog-failure-")), "models.db"),
		fetchDynamicModels,
		onDiscoveryFailure: failure => failures.push(failure),
	});
	const result = await manager.refresh("online");
	return { failures, modelIds: result.models.map(model => model.id) };
}

describe("a dynamic fetcher that produces a catalog", () => {
	/** The ordinary case: the models arrive and the channel stays silent. */
	it("reports nothing", async () => {
		const { failures, modelIds } = await refreshCollecting(async () => oneModel());

		expect(modelIds).toEqual(["test-model"]);
		expect(failures).toEqual([]);
	});

	/**
	 * An endpoint that honestly lists NO models is not a failure, and this is the distinction the whole
	 * channel rests on: `[]` means "asked and told nothing", which must not reach the reporter, or the
	 * operator is told a working provider is broken.
	 */
	it("reports nothing for an empty but successful list", async () => {
		const { failures, modelIds } = await refreshCollecting(async () => []);

		expect(modelIds).toEqual([]);
		expect(failures).toEqual([]);
	});
});

describe("a dynamic fetcher that reports through its hooks", () => {
	/**
	 * The regression this exists to prevent. The reader reports a reason and returns `null`; before the
	 * hooks existed, the closure had nowhere to send it and the manager saw only the `null`.
	 */
	it("passes the reason through to the caller", async () => {
		const { failures, modelIds } = await refreshCollecting(async hooks => {
			hooks?.onFailure?.({
				stage: "status",
				url: "https://models.example.com/models",
				detail: "HTTP 401 Unauthorized",
			});
			return null;
		});

		expect(modelIds).toEqual([]);
		expect(failures).toEqual([
			{ stage: "status", url: "https://models.example.com/models", detail: "HTTP 401 Unauthorized" },
		]);
	});

	/**
	 * The stage survives intact, because it is the part that decides where an operator looks: `request` at
	 * the network, `status` at credentials, `payload` at whether the endpoint speaks the protocol. A channel
	 * that flattened these to one string would be no better than the old silence.
	 */
	it.each(["base-url", "request", "status", "body", "payload"] as const)("carries the %p stage", async stage => {
		const { failures } = await refreshCollecting(async hooks => {
			hooks?.onFailure?.({ stage, url: "https://models.example.com/models", detail: "detail" });
			return null;
		});

		expect(failures[0]?.stage).toBe(stage);
	});

	/**
	 * A reader that tries several endpoints reports several reasons, and all of them arrive: the Xiaomi
	 * token-plan reader really does walk a list of clusters, so collapsing them to the first or last would
	 * hide which cluster actually answered.
	 */
	it("passes every reason through when a reader attempts more than one endpoint", async () => {
		const { failures } = await refreshCollecting(async hooks => {
			hooks?.onFailure?.({ stage: "request", url: "https://one.example.com/models", detail: "ECONNREFUSED" });
			hooks?.onFailure?.({ stage: "status", url: "https://two.example.com/models", detail: "HTTP 403" });
			return null;
		});

		expect(failures.map(failure => failure.url)).toEqual([
			"https://one.example.com/models",
			"https://two.example.com/models",
		]);
	});

	/**
	 * A reader that reports a reason and then SUCCEEDS anyway -- the token-plan walk again, where an early
	 * cluster refuses and a later one answers -- still reports, and the models still come back. The reason
	 * is not suppressed by the eventual success, because a cluster that is refusing connections is worth
	 * knowing about even when the fallback works.
	 */
	it("keeps both the reason and the models when a later attempt succeeds", async () => {
		const { failures, modelIds } = await refreshCollecting(async hooks => {
			hooks?.onFailure?.({ stage: "request", url: "https://one.example.com/models", detail: "ECONNREFUSED" });
			return oneModel();
		});

		expect(modelIds).toEqual(["test-model"]);
		expect(failures).toHaveLength(1);
	});
});

describe("a dynamic fetcher that throws", () => {
	/**
	 * The quietest path of all before this change: a throwing fetcher never reaches its own hooks, so the
	 * manager's catch was the only thing that saw the error, and it discarded it. The catalog still falls
	 * back to the cache and the static list, so the models field is unaffected; only the reason is new.
	 *
	 * The stage is `unhandled` rather than `request`, because a reader that throws instead of reporting is a
	 * bug in the reader, not a statement about the provider's endpoint.
	 */
	it("reports the throw as an unhandled failure", async () => {
		const { failures, modelIds } = await refreshCollecting(async () => {
			throw new Error("reader blew up");
		});

		expect(modelIds).toEqual([]);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.stage).toBe("unhandled");
		expect(failures[0]?.detail).toContain("reader blew up");
	});

	/** A thrown non-Error still produces a usable reason rather than "[object Object]". */
	it("reports a thrown string", async () => {
		const { failures } = await refreshCollecting(async () => {
			throw "not an error object";
		});

		expect(failures[0]?.detail).toContain("not an error object");
	});
});

describe("a caller that supplies no channel", () => {
	/**
	 * Everything still works without `onDiscoveryFailure`, which matters because most callers of this
	 * package do not want one: the option is additive and the documented `null`-to-fallback behaviour is
	 * unchanged.
	 */
	it("still falls back without throwing", async () => {
		const manager = createModelManager<Api>({
			providerId: "openai",
			staticModels: [],
			cacheDbPath: path.join(mkdtempSync(path.join(tmpdir(), "veyyon-catalog-nochannel-")), "models.db"),
			fetchDynamicModels: async () => {
				throw new Error("reader blew up");
			},
		});

		expect((await manager.refresh("online")).models).toEqual([]);
	});
});

/**
 * Refresh once with only a models.dev fallback wired, collecting whatever reasons arrive.
 *
 * No dynamic fetcher, so the fallback is the only network source and nothing else can account for a
 * reason that shows up.
 */
async function refreshModelsDevCollecting(
	fetch: (hooks?: DiscoveryHooks) => Promise<unknown>,
	map: (payload: unknown) => readonly ModelSpec<Api>[] = () => oneModel(),
): Promise<{ failures: DiscoveryFailure[]; modelIds: string[] }> {
	const failures: DiscoveryFailure[] = [];
	const manager = createModelManager<Api>({
		providerId: "openai",
		staticModels: [],
		cacheDbPath: path.join(mkdtempSync(path.join(tmpdir(), "veyyon-catalog-modelsdev-")), "models.db"),
		modelsDev: { fetch, map },
		onDiscoveryFailure: failure => failures.push(failure),
	});
	const result = await manager.refresh("online");
	return { failures, modelIds: result.models.map(model => model.id) };
}

describe("the models.dev fallback", () => {
	/**
	 * The regression this block exists for. The fallback's `fetch` took no hooks and the manager wrapped
	 * the whole call in a bare `catch {}`, so models.dev being unreachable, refusing the request, or
	 * serving HTML were all the same silence -- the same defect the dynamic path above was fixed for, left
	 * behind on the source that enriches every Anthropic catalog.
	 */
	it("passes the reason through to the caller", async () => {
		const { failures } = await refreshModelsDevCollecting(
			async hooks => {
				hooks?.onFailure?.({ stage: "status", url: "https://models.dev/api.json", detail: "HTTP 503" });
				return null;
			},
			() => [],
		);

		expect(failures).toEqual([{ stage: "status", url: "https://models.dev/api.json", detail: "HTTP 503" }]);
	});

	/**
	 * A fetch that THROWS never reached its own hooks, so the reason is the manager's to report, and it is
	 * `unhandled` for the same reason as the dynamic path: throwing instead of reporting is this side's bug.
	 */
	it("reports a throwing fetch as unhandled", async () => {
		const { failures } = await refreshModelsDevCollecting(async () => {
			throw new Error("models.dev blew up");
		});

		expect(failures).toHaveLength(1);
		expect(failures[0]?.stage).toBe("unhandled");
		expect(failures[0]?.detail).toContain("models.dev blew up");
	});

	/** A mapper that throws is the same class of bug, and used to be swallowed by the same catch. */
	it("reports a throwing mapper as unhandled", async () => {
		const { failures } = await refreshModelsDevCollecting(
			async () => ({}),
			() => {
				throw new Error("mapper blew up");
			},
		);

		expect(failures[0]?.stage).toBe("unhandled");
		expect(failures[0]?.detail).toContain("mapper blew up");
	});

	/**
	 * Drifted payload fields are the quiet way this source disappears: every spec fails the manager's
	 * rejection gate, the catalog silently loses its enrichment, and nothing said so. Reported once per
	 * fetch, naming the count, because one drifted field disqualifies the whole payload.
	 */
	it("reports specs the manager rejected", async () => {
		const { failures, modelIds } = await refreshModelsDevCollecting(
			async () => ({}),
			() => [{ ...oneModel()[0], contextWindow: undefined } as unknown as ModelSpec<Api>],
		);

		expect(modelIds).toEqual([]);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.stage).toBe("payload");
		expect(failures[0]?.detail).toContain("test-model");
	});

	/** The success case stays silent, or the channel is worse than no channel. */
	it("reports nothing when the payload maps cleanly", async () => {
		const { failures, modelIds } = await refreshModelsDevCollecting(async () => ({}));

		expect(modelIds).toEqual(["test-model"]);
		expect(failures).toEqual([]);
	});
});
