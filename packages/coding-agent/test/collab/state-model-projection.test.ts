/**
 * What the host's model looks like by the time a guest receives it.
 *
 * WHY THIS SUITE EXISTS. This is the fourth frame in the same family as the header, entry and event
 * leaks, and the only one somebody meant. `CollabSessionState.model` was typed as the host's catalog
 * `Model` on purpose, with a comment saying so, because a guest applies it to its replica agent so
 * model display is native rather than a display string. The intent was right and the type was wrong:
 * `@veyyon/wire` declared a four-field `WireModel`, so the contract and the value disagreed exactly
 * as they did in the three closed rows.
 *
 * WHAT WAS ACTUALLY LEAKING. The catalog `Model` carries `baseUrl`, the endpoint the host talks to.
 * On a proxied, self-hosted or gateway-routed configuration that is an internal host URL, and the
 * state frame is DEBOUNCED AND REPEATED: it re-broadcasts every couple of seconds for the whole
 * length of a stream, to every guest, including read-only viewers who joined through a view link. It
 * also carried the per-million pricing table, `requestModelId`, `headers` and the compatibility
 * record.
 *
 * THE RULE THE PROJECTION ENCODES is structural rather than a field-by-field judgement: a guest
 * never builds a provider request, because it renders a replica and forwards prompts to the host. So
 * every field whose only job is to shape a request is absent on principle. What survives is what a
 * guest draws, and the thinking fields are here because the status line shows a thinking level.
 */

import { describe, expect, it } from "bun:test";
import type { Model } from "@veyyon/ai";
import {
	fromWireModel,
	toWireModel,
	WIRE_MODEL_API_UNREPORTED,
	WIRE_MODEL_NO_ENDPOINT,
} from "@veyyon/coding-agent/collab/protocol";

/**
 * A host catalog model with the fields that must not travel filled in with values a test can spot:
 * an internal gateway endpoint, real pricing, and a private routing header.
 */
function hostModel(): Model {
	return {
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://internal-gateway.corp.example/v1",
		contextWindow: 200_000,
		maxTokens: 64_000,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		pricing: "published",
		requestModelId: "claude-opus-4-6-20260101",
		headers: { "x-corp-routing-key": "secret-routing-key" },
		priority: 1,
		thinking: {
			mode: "anthropic-adaptive",
			efforts: ["low", "medium", "high"],
			defaultLevel: "medium",
			effortMap: { low: "1024", medium: "8192", high: "32768" },
			supportsDisplay: true,
		},
		compat: { toolChoice: "native" },
	} as unknown as Model;
}

describe("projecting the host model", () => {
	/** The exact key set, so a field added to the catalog `Model` is a failure rather than a shipment. */
	it("sends six fields and no others", () => {
		expect(Object.keys(toWireModel(hostModel())).sort()).toEqual([
			"contextWindow",
			"id",
			"name",
			"provider",
			"reasoning",
			"thinking",
		]);
	});

	/**
	 * The field this row exists for. Asserted against the serialized frame rather than the object,
	 * because what reaches a guest is JSON, and a nested copy would pass a key-set check.
	 */
	it("never sends the provider endpoint", () => {
		const json = JSON.stringify(toWireModel(hostModel()));

		expect(json).not.toContain("internal-gateway.corp.example");
		expect(json).not.toContain("baseUrl");
	});

	/** The pricing table and the private routing header ride along on the same object. */
	it("never sends pricing or request headers", () => {
		const json = JSON.stringify(toWireModel(hostModel()));

		expect(json).not.toContain("secret-routing-key");
		expect(json).not.toContain("cost");
		expect(json).not.toContain("requestModelId");
		expect(json).not.toContain("claude-opus-4-6-20260101");
	});

	/** The four display fields arrive exactly as the host has them. A replica that renames is not a replica. */
	it("carries the display fields verbatim", () => {
		const wire = toWireModel(hostModel());

		expect(wire.id).toBe("claude-opus-4-6");
		expect(wire.name).toBe("Claude Opus 4.6");
		expect(wire.provider).toBe("anthropic");
		expect(wire.contextWindow).toBe(200_000);
	});

	/**
	 * The thinking config is narrowed, not passed through. `efforts` and `defaultLevel` are what the
	 * status line and the level picker read; `effortMap` and `supportsDisplay` encode an effort into
	 * a provider wire field, which only the host ever does.
	 */
	it("narrows the thinking config to what the status line reads", () => {
		const wire = toWireModel(hostModel());

		expect(wire.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: ["low", "medium", "high"],
			defaultLevel: "medium",
		});
		expect(JSON.stringify(wire)).not.toContain("effortMap");
		expect(JSON.stringify(wire)).not.toContain("supportsDisplay");
	});

	/** A model with no thinking support says so rather than shipping an empty object. */
	it("omits the thinking config when the model has none", () => {
		const model = { ...hostModel(), reasoning: false, thinking: undefined } as unknown as Model;

		expect(toWireModel(model).thinking).toBeUndefined();
		expect(toWireModel(model).reasoning).toBe(false);
	});

	/** A model with no declared window keeps the null rather than turning it into a zero. */
	it("keeps a null context window null", () => {
		const model = { ...hostModel(), contextWindow: null } as unknown as Model;

		expect(toWireModel(model).contextWindow).toBeNull();
	});
});

describe("widening a received model on the guest", () => {
	/**
	 * `Model.baseUrl` is required, so the field has to hold something, and what it holds is a scheme
	 * nothing dials. An empty string or a default endpoint would be a silent fallback: it turns "we
	 * never send this" into "we quietly send you somewhere else". This value fails immediately and
	 * says why.
	 */
	it("fills the endpoint with a scheme nothing dials", () => {
		const model = fromWireModel(toWireModel(hostModel()));

		expect(model.baseUrl).toBe("collab-guest://no-provider-endpoint");
		expect(model.baseUrl).toBe(WIRE_MODEL_NO_ENDPOINT);
		expect(() => new URL(model.baseUrl).protocol).not.toThrow();
		expect(new URL(model.baseUrl).protocol).toBe("collab-guest:");
	});

	/** Same trade for the request dialect: a real name here would be a guess a replica records as fact. */
	it("marks the api as unreported rather than inventing one", () => {
		expect(fromWireModel(toWireModel(hostModel())).api).toBe(WIRE_MODEL_API_UNREPORTED as never);
		expect(WIRE_MODEL_API_UNREPORTED).toBe("unreported-over-wire");
	});

	/**
	 * Zero pricing is only safe when something records that it is unknown. `cost` cannot represent
	 * "we were never told": a provider that publishes nothing produces the same all-zero object as a
	 * genuinely free model, and reading that zero as free is a defect the catalog already has a field
	 * for. A guest is exactly the "never told" case.
	 */
	it("marks the zero pricing unknown rather than free", () => {
		const model = fromWireModel(toWireModel(hostModel()));

		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(model.pricing).toBe("unknown");
	});

	/** A round trip preserves everything a guest draws, which is the whole point of the pair. */
	it("round-trips every field a guest draws", () => {
		const model = fromWireModel(toWireModel(hostModel()));

		expect(model.id).toBe("claude-opus-4-6");
		expect(model.name).toBe("Claude Opus 4.6");
		expect(model.provider).toBe("anthropic");
		expect(model.contextWindow).toBe(200_000);
		expect(model.reasoning).toBe(true);
		expect(model.thinking?.efforts).toEqual(["low", "medium", "high"] as never);
		expect(model.thinking?.defaultLevel).toBe("medium" as never);
	});

	/**
	 * The behaviour the over-send existed to protect. A guest's context percentage is computed from
	 * the model's window and a token count, and it must be identical before and after the projection
	 * or the fix traded a leak for a wrong number.
	 */
	it("leaves the context percentage unchanged for a fixed token count", () => {
		const before = hostModel();
		const after = fromWireModel(toWireModel(before));
		const percent = (model: Model) => ((32_000 / (model.contextWindow ?? 0)) * 100).toFixed(4);

		expect(percent(after)).toBe(percent(before));
		expect(percent(after)).toBe("16.0000");
	});

	/** A model that never had thinking support does not acquire it on the way across. */
	it("keeps a non-reasoning model non-reasoning", () => {
		const model = fromWireModel({ id: "m", name: "M", provider: "openai", contextWindow: 8192 });

		expect(model.reasoning).toBe(false);
		expect(model.thinking).toBeUndefined();
	});
});
