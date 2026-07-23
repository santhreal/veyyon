/**
 * Effort-to-wire-id routing for providers that select reasoning effort by
 * MODEL ID instead of a wire param.
 *
 * Found 2026-07-22 (user report: "almost no LLMs have no reasoning choice"):
 * Cursor's transport carries no effort field, and `buildGrpcRequest` sent
 * `model.requestModelId ?? model.id` unconditionally — so the effort ladders
 * on cursor models were INERT: whatever the user set with /thinking, the same
 * wire id was requested. Devin already routed effort into `chatModelUid`;
 * cursor now mirrors it via `CursorOptions.wireModelId`. These tests lock the
 * mapping at the `mapOptionsForApi` seam for both providers, so a regression
 * to the unconditional id path fails loudly.
 */
import { describe, expect, it } from "bun:test";
import type { CursorOptions } from "@veyyon/ai/providers/cursor";
import type { DevinOptions } from "@veyyon/ai/providers/devin";
import { mapOptionsForApi } from "@veyyon/ai/stream";
import { Effort, type Model } from "@veyyon/ai/types";
import { getBundledModel } from "@veyyon/catalog/models";

describe("cursor effort routes to tier-suffixed wire model ids", () => {
	const model = getBundledModel("cursor", "gpt-5.4") as Model<"cursor-agent">;

	it("bundles cursor gpt-5.4 as an effort-routed family (precondition)", () => {
		expect(model).toBeDefined();
		expect(model.thinking?.effortRouting?.[Effort.XHigh]).toBe("gpt-5.4-xhigh");
	});

	it("maps each requested effort to its tier sibling", () => {
		for (const [effort, wire] of [
			[Effort.Low, "gpt-5.4-low"],
			[Effort.Medium, "gpt-5.4-medium"],
			[Effort.High, "gpt-5.4-high"],
			[Effort.XHigh, "gpt-5.4-xhigh"],
		] as const) {
			const mapped = mapOptionsForApi(model, { reasoning: effort }) as CursorOptions;
			expect(mapped.wireModelId).toBe(wire);
		}
	});

	it("falls back to the default wire id when no effort is requested", () => {
		const mapped = mapOptionsForApi(model, {}) as CursorOptions;
		expect(mapped.wireModelId).toBe("gpt-5.4-low");
	});
});

describe("devin effort routes to sibling wire model uids (existing contract)", () => {
	it("routes the collapsed claude-sonnet-5 family per effort", () => {
		const model = getBundledModel("devin", "claude-sonnet-5") as Model<"devin-agent">;
		const mapped = mapOptionsForApi(model, { reasoning: Effort.Max }) as DevinOptions;
		expect(mapped.chatModelUid).toBe("claude-sonnet-5-max");
	});
});
