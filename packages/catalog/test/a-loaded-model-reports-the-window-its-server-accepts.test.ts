/**
 * A locally loaded model reports the context window its server accepts.
 *
 * WHY THIS SUITE EXISTS. LM Studio's native metadata carries two windows for one
 * model: `max_context_length`, the ceiling compiled into the weights, and
 * `loaded_context_length`, the window the running server was started with. A
 * 27B model whose ceiling is 262144 loads at 200192 on a 32 GB card, and a
 * request past 200192 is refused by the server. The reader took the ceiling, so
 * a session planned compaction against 262144, never compacted, and died on a
 * provider error at the point the window was actually exhausted. `/v1/models`
 * reports neither field for LM Studio, so this metadata is the only source the
 * discovered model has.
 *
 * THE CLASS IT CLOSES. "A discovery read takes a capability ceiling where the
 * running server's configured limit is what requests are measured against." The
 * fix is an ordering: the loaded value wins over every ceiling-shaped field, and
 * each ceiling-shaped field still answers when nothing better is reported.
 *
 * WHAT IT DOES NOT CATCH. It drives the reader with fabricated payloads, so it
 * proves the window the reader reports, not that LM Studio spells the field this
 * way in a future version, and not what the server does with a request that
 * exceeds the window. A new window field added to the payload is not detected
 * until someone adds it here.
 */

import { describe, expect, it } from "bun:test";
import { fetchLmStudioNativeModelMetadata } from "../src/provider-models/openai-compat";
import type { FetchImpl } from "../src/types";

/** A fetch that answers one native-metadata payload for every request. */
function nativeMetadataFetch(entries: Record<string, unknown>[]): FetchImpl {
	return (async () =>
		new Response(JSON.stringify({ data: entries }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as FetchImpl;
}

async function windowOf(entry: Record<string, unknown>): Promise<number | undefined> {
	const metadata = await fetchLmStudioNativeModelMetadata("http://127.0.0.1:1234/v1", nativeMetadataFetch([entry]));
	expect(metadata).not.toBeNull();
	return metadata?.get(String(entry.id))?.contextWindow;
}

/** Every ceiling-shaped field the reader accepts, lowest precedence last. */
const CEILING_FIELDS = ["max_context_length", "context_length", "max_model_len"] as const;

describe("a loaded model reports the window its server accepts", () => {
	it("prefers the loaded window over the model's ceiling", async () => {
		expect(
			await windowOf({
				id: "qwen3-27b",
				state: "loaded",
				max_context_length: 262_144,
				loaded_context_length: 200_192,
			}),
		).toBe(200_192);
	});

	for (const field of CEILING_FIELDS) {
		it(`prefers the loaded window over ${field}`, async () => {
			expect(
				await windowOf({ id: "qwen3-27b", state: "loaded", [field]: 262_144, loaded_context_length: 200_192 }),
			).toBe(200_192);
		});

		it(`falls back to ${field} when no loaded window is reported`, async () => {
			expect(await windowOf({ id: "qwen3-27b", state: "not-loaded", [field]: 262_144 })).toBe(262_144);
		});
	}

	it("keeps the ceiling ordering among the fields that report one", async () => {
		expect(
			await windowOf({
				id: "qwen3-27b",
				max_context_length: 262_144,
				context_length: 131_072,
				max_model_len: 65_536,
			}),
		).toBe(262_144);
		expect(await windowOf({ id: "qwen3-27b", context_length: 131_072, max_model_len: 65_536 })).toBe(131_072);
	});

	it("ignores a loaded window that is not a positive number", async () => {
		expect(await windowOf({ id: "qwen3-27b", loaded_context_length: 0, max_context_length: 262_144 })).toBe(262_144);
		expect(await windowOf({ id: "qwen3-27b", loaded_context_length: -1, max_context_length: 262_144 })).toBe(262_144);
		expect(await windowOf({ id: "qwen3-27b", loaded_context_length: null, max_context_length: 262_144 })).toBe(
			262_144,
		);
		expect(await windowOf({ id: "qwen3-27b", loaded_context_length: "unlimited", max_context_length: 262_144 })).toBe(
			262_144,
		);
	});

	it("accepts a loaded window serialized as a number in a string", async () => {
		expect(await windowOf({ id: "qwen3-27b", loaded_context_length: "200192", max_context_length: 262_144 })).toBe(
			200_192,
		);
	});

	it("reports no window when the payload states none", async () => {
		const metadata = await fetchLmStudioNativeModelMetadata(
			"http://127.0.0.1:1234/v1",
			nativeMetadataFetch([{ id: "qwen3-27b", type: "vlm" }]),
		);
		const model = metadata?.get("qwen3-27b");
		expect(model).toEqual({ input: ["text", "image"] });
		expect(model && "contextWindow" in model).toBe(false);
	});

	it("reads each model's own window when several are reported", async () => {
		const metadata = await fetchLmStudioNativeModelMetadata(
			"http://127.0.0.1:1234/v1",
			nativeMetadataFetch([
				{ id: "loaded-small", state: "loaded", max_context_length: 262_144, loaded_context_length: 200_192 },
				{ id: "unloaded-large", state: "not-loaded", max_context_length: 262_144 },
			]),
		);
		expect(metadata?.get("loaded-small")?.contextWindow).toBe(200_192);
		expect(metadata?.get("unloaded-large")?.contextWindow).toBe(262_144);
	});
});
