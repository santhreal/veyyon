import { describe, expect, it } from "bun:test";
import { resolveLocalWavPath, resolveTtsBackend } from "../../src/tools/tts";

/**
 * resolveTtsBackend and resolveLocalWavPath are the two pure decision functions
 * behind the tts tool (both documented "Pure for testability") and had no test.
 *
 * resolveTtsBackend routes synthesis to the local on-device backend or the xAI
 * cloud. The subtle rule is the `auto` case: local is preferred EXCEPT when the
 * caller asked for an .mp3 AND xAI credentials exist, because only the cloud path
 * can emit MP3, so it routes to xAI to honor the requested container instead of
 * silently substituting WAV. An explicit `xai`/`local` preference always wins,
 * even against those signals (xai even without creds, local even for mp3).
 *
 * resolveLocalWavPath rewrites a non-.wav output path to a sibling .wav because
 * local synthesis has no MP3 encoder. The load-bearing edges: the .wav check is
 * case-insensitive and returns the path UNCHANGED (substituted:false); a dot that
 * belongs to a DIRECTORY component (no dot in the filename) must not be treated
 * as an extension boundary; and the original separator style is preserved.
 */

describe("resolveTtsBackend", () => {
	it("honors an explicit xai preference even when no credentials exist", () => {
		expect(resolveTtsBackend({ preference: "xai", wantsMp3: false, hasXaiCreds: false })).toBe("xai");
	});

	it("honors an explicit local preference even when mp3 is requested with credentials", () => {
		expect(resolveTtsBackend({ preference: "local", wantsMp3: true, hasXaiCreds: true })).toBe("local");
	});

	it("routes auto to xai only when mp3 is wanted AND credentials exist", () => {
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: true, hasXaiCreds: true })).toBe("xai");
	});

	it("routes auto to local when mp3 is wanted but no credentials exist", () => {
		// Cloud is the only mp3 path; without creds it falls back to local WAV.
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: true, hasXaiCreds: false })).toBe("local");
	});

	it("routes auto to local when mp3 is not wanted, regardless of credentials", () => {
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: false, hasXaiCreds: true })).toBe("local");
	});

	it("treats an unrecognized preference like auto", () => {
		expect(resolveTtsBackend({ preference: "", wantsMp3: true, hasXaiCreds: true })).toBe("xai");
		expect(resolveTtsBackend({ preference: "unknown", wantsMp3: false, hasXaiCreds: true })).toBe("local");
	});
});

describe("resolveLocalWavPath", () => {
	it("leaves an existing .wav path unchanged", () => {
		expect(resolveLocalWavPath("out/voice.wav")).toEqual({ wavPath: "out/voice.wav", substituted: false });
	});

	it("recognizes .wav case-insensitively and preserves the original casing", () => {
		expect(resolveLocalWavPath("out/voice.WAV")).toEqual({ wavPath: "out/voice.WAV", substituted: false });
	});

	it("rewrites an .mp3 request to a sibling .wav and flags the substitution", () => {
		expect(resolveLocalWavPath("out/voice.mp3")).toEqual({ wavPath: "out/voice.wav", substituted: true });
	});

	it("appends .wav to a path that has no extension", () => {
		expect(resolveLocalWavPath("voice")).toEqual({ wavPath: "voice.wav", substituted: true });
	});

	it("does not treat a dot in a directory component as an extension", () => {
		// The dot is in "dir.v1"; the filename "clip" has none, so nothing is
		// stripped and .wav is appended to the whole path.
		expect(resolveLocalWavPath("dir.v1/clip")).toEqual({ wavPath: "dir.v1/clip.wav", substituted: true });
	});

	it("preserves backslash separators when rewriting a Windows path", () => {
		expect(resolveLocalWavPath("a\\b\\audio.mp3")).toEqual({ wavPath: "a\\b\\audio.wav", substituted: true });
	});

	it("rewrites a trailing-dot path by dropping the empty extension", () => {
		expect(resolveLocalWavPath("clip.")).toEqual({ wavPath: "clip.wav", substituted: true });
	});
});
