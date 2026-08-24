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
import type { CursorOptions } from "@veyyon/ai/providers/cursor";
import type { DevinOptions } from "@veyyon/ai/providers/devin";
import { mapOptionsForApi } from "@veyyon/ai/stream";
import type { Api, Model } from "@veyyon/ai/types";
import { getBundledModel, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";

/** One bundled model per distinct api, so the sweep covers every mapped case. */
function oneModelPerApi(): Map<Api, Model<Api>> {
	const byApi = new Map<Api, Model<Api>>();
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider)) {
			if (!byApi.has(model.api)) byApi.set(model.api, model);
		}
	}
	return byApi;
}

describe("mapOptionsForApi keeps the caller's conversation identity", () => {
	it("covers more than one api, so the sweep below is not vacuous", () => {
		const apis = [...oneModelPerApi().keys()];
		expect(apis.length).toBeGreaterThan(5);
	});

	it("forwards conversationId for every api the catalog bundles", () => {
		const dropped: string[] = [];
		for (const [api, model] of oneModelPerApi()) {
			const mapped = mapOptionsForApi(model, { conversationId: "session-1#compaction_summary" });
			if (mapped.conversationId !== "session-1#compaction_summary") dropped.push(api);
		}

		expect(dropped.sort()).toEqual([]);
	});

	it("leaves conversationId unset when the caller names none, so the provider still falls back", () => {
		for (const [, model] of oneModelPerApi()) {
			const mapped = mapOptionsForApi(model, { sessionId: "session-1" });
			expect(mapped.conversationId).toBeUndefined();
			expect(mapped.sessionId).toBe("session-1");
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
