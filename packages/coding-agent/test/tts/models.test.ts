import { describe, expect, it } from "bun:test";
import {
	DEFAULT_TTS_LOCAL_MODEL_KEY,
	DEFAULT_TTS_VOICE,
	getTtsLocalModelSpec,
	isCorruptModelCacheError,
	isTtsLocalModelKey,
	KOKORO_VOICES,
	resolveTtsRepo,
	resolveTtsVoice,
	TTS_LOCAL_MODELS,
} from "@veyyon/coding-agent/tts/models";

/**
 * The local TTS model registry maps a settings key (`tts.localModel`/`tts.localVoice`) to the concrete
 * Hugging Face repo and voice id the worker loads. These resolvers are the only layer between an
 * operator's setting and a download, and they were untested. The contracts that matter: a registered
 * key round-trips to its exact repo/voice; an unset key resolves to the documented default rather than
 * throwing; and an unknown voice degrades to the model's own default voice (first entry) so generation
 * never fails on a stale voice id. A regression that dropped the default fallback would make speech
 * silently fail whenever a setting is unset or points at a retired voice.
 */
describe("resolveTtsRepo", () => {
	it("returns the registered repo for a known model key", () => {
		expect(resolveTtsRepo("kokoro")).toBe("onnx-community/Kokoro-82M-v1.0-ONNX");
	});

	it("resolves an unset (undefined) key to the default model's repo", () => {
		// The default model's own spec must carry the repo the undefined-key path resolves to.
		expect(getTtsLocalModelSpec(DEFAULT_TTS_LOCAL_MODEL_KEY)?.repo).toBe("onnx-community/Kokoro-82M-v1.0-ONNX");
		expect(resolveTtsRepo(undefined)).toBe(resolveTtsRepo(DEFAULT_TTS_LOCAL_MODEL_KEY));
	});

	it("falls back to the default model's repo for an unregistered key (resolve-or-default)", () => {
		// This is a documented resolve-or-default helper: an unknown key is not an error, it yields the
		// default model. With a single registered model that means the kokoro repo.
		expect(resolveTtsRepo("no-such-model")).toBe(resolveTtsRepo(DEFAULT_TTS_LOCAL_MODEL_KEY));
	});
});

describe("resolveTtsVoice", () => {
	it("returns a requested voice that the model supports, unchanged", () => {
		expect(resolveTtsVoice("kokoro", "af_bella")).toBe("af_bella");
	});

	it("falls back to the model's default voice (first catalog entry) for an unknown voice id", () => {
		expect(resolveTtsVoice("kokoro", "not-a-voice")).toBe(KOKORO_VOICES[0].id);
		expect(KOKORO_VOICES[0].id).toBe(DEFAULT_TTS_VOICE);
	});

	it('treats the legacy "default" sentinel as unknown and returns the default voice', () => {
		expect(resolveTtsVoice("kokoro", "default")).toBe(DEFAULT_TTS_VOICE);
	});

	it("returns the default voice when no voice is requested", () => {
		expect(resolveTtsVoice("kokoro", undefined)).toBe(DEFAULT_TTS_VOICE);
		expect(resolveTtsVoice(undefined, undefined)).toBe(DEFAULT_TTS_VOICE);
	});

	it("resolves an unknown model key through the default model's catalog", () => {
		// Unknown model key -> default model spec, then the requested voice is matched in that catalog.
		expect(resolveTtsVoice("no-such-model", "af_bella")).toBe("af_bella");
	});
});

describe("getTtsLocalModelSpec / isTtsLocalModelKey", () => {
	it("returns the registered spec for a known key and undefined otherwise", () => {
		expect(getTtsLocalModelSpec("kokoro")?.key).toBe("kokoro");
		expect(getTtsLocalModelSpec("no-such-model")).toBeUndefined();
	});

	it("is a type guard true only for registered keys", () => {
		expect(isTtsLocalModelKey("kokoro")).toBe(true);
		expect(isTtsLocalModelKey("no-such-model")).toBe(false);
	});

	it("keeps the default model key registered so the resolvers always have a fallback", () => {
		// resolveTtsRepo/resolveTtsVoice both depend on the default key being present; if this drifts,
		// an unset setting would throw instead of resolving.
		expect(getTtsLocalModelSpec(DEFAULT_TTS_LOCAL_MODEL_KEY)).toBeDefined();
		expect(TTS_LOCAL_MODELS.some(m => m.key === DEFAULT_TTS_LOCAL_MODEL_KEY)).toBe(true);
	});
});

/**
 * isCorruptModelCacheError recognizes the two error shapes a truncated weight file produces so the
 * worker knows to purge-and-restart rather than surfacing an opaque parse failure. It must match on the
 * error's message whether an Error object or a bare string is thrown, and must NOT match unrelated
 * failures (a network timeout is retried in place, not by nuking the cache).
 */
describe("isCorruptModelCacheError", () => {
	it("matches an onnx protobuf parse failure", () => {
		expect(isCorruptModelCacheError(new Error("onnx protobuf parsing failed at byte 3"))).toBe(true);
	});

	it("matches a 'load model from <path> failed' error, case-insensitively", () => {
		expect(isCorruptModelCacheError(new Error("Load model from /cache/x.onnx failed"))).toBe(true);
	});

	it("matches when the message is thrown as a bare string, not an Error", () => {
		expect(isCorruptModelCacheError("protobuf parsing failed")).toBe(true);
	});

	it("does not match an unrelated failure", () => {
		expect(isCorruptModelCacheError(new Error("network timeout while fetching weights"))).toBe(false);
	});
});
