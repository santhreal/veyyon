/**
 * WHY: `conversationId` decides which server-side conversation a request joins.
 * `cursor-agent` and `devin-agent` thread turns by it and fall back to
 * `sessionId`, so a side request that carried the live session id arrived as a
 * one-message conversation under the live conversation's identity. The fix gives
 * a side request its own id, which is worth nothing if the mapping seam drops
 * the field: the provider would fall back to `sessionId` again and the defect
 * would return with no test failing.
 *
 * The class this closes: every api case in `mapOptionsForApi` builds its own
 * object, so any case that spells its fields out can silently omit one. The
 * sweep below enumerates the apis from the bundled catalog at run time, so a new
 * api case, or a case rewritten to stop spreading the shared base, turns this
 * red rather than shipping a request that joins the wrong conversation.
 *
 * What it does not catch: whether a given provider READS the field. That is
 * per-provider behavior, and only cursor and devin act on it today; this suite
 * asserts the seam delivers it to all of them.
 */
import { describe, expect, it } from "bun:test";
import { BUILTIN_API_IDS } from "@veyyon/ai/api-registry";
import type { CursorOptions } from "@veyyon/ai/providers/cursor";
import type { DevinOptions } from "@veyyon/ai/providers/devin";
import { mapOptionsForApi } from "@veyyon/ai/stream";
import type { KnownApi, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";

/** Build a model for each API in BUILTIN_API_IDS, preferring bundled catalog entries. */
function modelForApi(api: KnownApi): Model<KnownApi> {
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider)) {
			if (model.api === api) return model as Model<KnownApi>;
		}
	}
	return buildModel({
		id: `test-model-${api}`,
		name: `Test ${api}`,
		provider: "test-provider",
		api,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 4096,
		contextWindow: 128_000,
	});
}

describe("mapOptionsForApi keeps the caller's conversation identity", () => {
	it("covers all built-in apis, so the sweep below is not vacuous", () => {
		expect(BUILTIN_API_IDS.length).toBeGreaterThanOrEqual(14);
	});

	it("forwards conversationId for every api in BUILTIN_API_IDS", () => {
		expect(BUILTIN_API_IDS.length).toBeGreaterThanOrEqual(14);
		const dropped: string[] = [];
		for (const api of BUILTIN_API_IDS) {
			const model = modelForApi(api);
			const mapped = mapOptionsForApi(model, {
				sessionId: "session-1",
				conversationId: "session-1#compaction_summary",
			});
			if (mapped.conversationId !== "session-1#compaction_summary") dropped.push(api);
			if (mapped.sessionId !== "session-1") dropped.push(`${api}-missing-sessionId`);
		}

		expect(dropped.sort()).toEqual([]);
	});

	it("leaves conversationId unset when the caller names none, so the provider still falls back", () => {
		for (const api of BUILTIN_API_IDS) {
			const model = modelForApi(api);
			const mapped = mapOptionsForApi(model, { sessionId: "session-1" });
			expect(mapped.conversationId).toBeUndefined();
			expect(mapped.sessionId).toBe("session-1");
		}
	});

	it("preserves explicit conversationId when sessionId is absent", () => {
		for (const api of BUILTIN_API_IDS) {
			const model = modelForApi(api);
			const mapped = mapOptionsForApi(model, { conversationId: "standalone-conv-id" });
			expect(mapped.conversationId).toBe("standalone-conv-id");
			expect(mapped.sessionId).toBeUndefined();
		}
	});

	it("delivers a side-request id to the two stateful agent apis without disturbing effort routing", () => {
		const cursor = mapOptionsForApi(getBundledModel("cursor", "gpt-5.4") as Model<"cursor-agent">, {
			sessionId: "live-session",
			conversationId: "live-session#compaction_turn_prefix",
		}) as CursorOptions;
		expect(cursor.conversationId).toBe("live-session#compaction_turn_prefix");
		expect(cursor.sessionId).toBe("live-session");
		expect(cursor.wireModelId).toBe("gpt-5.4-low");

		const devin = mapOptionsForApi(getBundledModel("devin", "claude-sonnet-5") as Model<"devin-agent">, {
			sessionId: "live-session",
			conversationId: "live-session#branch_summary",
		}) as DevinOptions;
		expect(devin.conversationId).toBe("live-session#branch_summary");
		expect(devin.sessionId).toBe("live-session");
	});
});
