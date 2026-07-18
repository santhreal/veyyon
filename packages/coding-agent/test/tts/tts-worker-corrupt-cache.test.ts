/**
 * Corrupt cached TTS weights must be recognized so `loadModel` can purge the
 * cache and re-download instead of failing forever.
 *
 * Live repro that motivated this: an interrupted first download left a
 * truncated `model_quantized.onnx` in the tiny-models cache; every later
 * `veyyon say` failed with the onnxruntime error below until the cache was
 * deleted by hand.
 */
import { describe, expect, it } from "bun:test";
import { isCorruptModelCacheError } from "@veyyon/coding-agent/tts/models";

describe("isCorruptModelCacheError", () => {
	it("matches the live onnxruntime truncated-weights error", () => {
		// Exact shape observed from onnxruntime-node loading a truncated onnx.
		const live = new Error(
			"Load model from /home/user/.veyyon/agent/cache/tiny-models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.onnx failed:Protobuf parsing failed.",
		);
		expect(isCorruptModelCacheError(live)).toBe(true);
	});

	it("matches a bare protobuf parse failure", () => {
		expect(isCorruptModelCacheError(new Error("Protobuf parsing failed."))).toBe(true);
	});

	it("does not match network failures (purging the cache would not help)", () => {
		expect(isCorruptModelCacheError(new Error("fetch failed: getaddrinfo ENOTFOUND huggingface.co"))).toBe(false);
	});

	it("does not match device errors", () => {
		expect(isCorruptModelCacheError(new Error("No TTS devices configured"))).toBe(false);
	});

	it("handles non-Error values without throwing", () => {
		expect(isCorruptModelCacheError("Protobuf parsing failed.")).toBe(true);
		expect(isCorruptModelCacheError(undefined)).toBe(false);
	});
});
