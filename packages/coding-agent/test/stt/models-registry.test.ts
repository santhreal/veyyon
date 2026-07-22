import { describe, expect, it } from "bun:test";
import {
	DEFAULT_STT_MODEL_KEY,
	getSttModelSpec,
	isSttModelKey,
	resolveSttModelSpec,
} from "@veyyon/coding-agent/stt/models";

/**
 * The speech-to-text model registry and its resolvers had no direct test. resolveSttModelSpec is
 * what turns a persisted (possibly stale/legacy) stt.modelName into the concrete model the ASR
 * worker loads, so a broken key match or a wrong fallback would silently transcribe with the wrong
 * engine. These pin the key guard, the spec lookup (including the transformers-vs-sherpa engine per
 * tier), and the documented fallback to the SoTA default for both an undefined and an unknown key.
 */

describe("isSttModelKey", () => {
	it("recognizes every shipped tier and rejects unknown or sentinel values", () => {
		expect(isSttModelKey("fast")).toBe(true);
		expect(isSttModelKey("balanced")).toBe(true);
		expect(isSttModelKey("turbo")).toBe(true);
		expect(isSttModelKey("parakeet")).toBe(true);
		expect(isSttModelKey("online")).toBe(false);
		expect(isSttModelKey("xyz")).toBe(false);
	});
});

describe("getSttModelSpec", () => {
	it("returns the spec with its engine and repo, and undefined for an unknown key", () => {
		const fast = getSttModelSpec("fast");
		expect(fast?.engine).toBe("transformers");
		expect(fast?.repo).toBe("onnx-community/whisper-base");
		// The default tier is the native sherpa engine, not transformers.
		expect(getSttModelSpec("parakeet")?.engine).toBe("sherpa");
		expect(getSttModelSpec("xyz")).toBeUndefined();
	});
});

describe("resolveSttModelSpec", () => {
	it("returns the named tier when the key is valid", () => {
		expect(resolveSttModelSpec("fast").key).toBe("fast");
	});

	it("falls back to the SoTA default for both an undefined and an unknown key", () => {
		expect(resolveSttModelSpec(undefined).key).toBe(DEFAULT_STT_MODEL_KEY);
		expect(resolveSttModelSpec("xyz").key).toBe(DEFAULT_STT_MODEL_KEY);
		expect(DEFAULT_STT_MODEL_KEY).toBe("parakeet");
	});

	it("keeps the default key a valid registry member so the fallback can never dangle", () => {
		expect(isSttModelKey(DEFAULT_STT_MODEL_KEY)).toBe(true);
	});
});
