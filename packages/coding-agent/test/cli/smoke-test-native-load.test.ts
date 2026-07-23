import { describe, expect, it } from "bun:test";
import { countTokens, visibleWidth } from "@veyyon/natives";

/**
 * The native-load contract that `veyyon --smoke-test` relies on to catch the
 * "breaks immediately on launch" crash.
 *
 * `--smoke-test` is what release verification runs against the PUBLISHED binary
 * (ci.yml `release_github_verify`), and what `scripts/install-tests/run-ci.sh`
 * runs against every install. But the core `@veyyon/natives` addon loads LAZILY:
 * the loader defers `dlopen` and the version-sentinel check until the first real
 * native call. The workers `--smoke-test` spawns (title/stt/tts/mnemopi/eval) do
 * NOT call `@veyyon/natives`, so before the probe was added the smoke test could
 * pass on a binary whose core addon was stale or unloadable — exactly the addon a
 * normal launch needs (grep, pty, tokens, text width). The user hit that crash;
 * the test did not.
 *
 * `runSmokeTest` now forces the load by calling `visibleWidth("veyyon", 4)` and
 * asserting it returns 6. A native call cannot return a correct value unless the
 * loader ran `dlopen` and passed the version-sentinel validation, so these
 * public-API assertions are a genuine end-to-end proof the addon loaded — not a
 * shape check. They pin the exact value the probe checks so the magic number
 * cannot drift and false-fail a good release.
 */
describe("smoke-test native-load probe contract", () => {
	it("visibleWidth('veyyon', 4) === 6 — the exact value the smoke probe asserts", () => {
		// Six ASCII columns, no tabs (so tabWidth is irrelevant). This is the value
		// runSmokeTest checks; a native addon that failed to load could not return it.
		expect(visibleWidth("veyyon", 4)).toBe(6);
	});

	it("width probe is stable across repeated calls (memoized load stays correct)", () => {
		// The loader memoizes bindings; a second call must return the same width, so
		// the probe is deterministic on the retry path install-tests exercises.
		expect(visibleWidth("veyyon", 4)).toBe(6);
		expect(visibleWidth("veyyon", 4)).toBe(6);
	});

	it("a second distinct native function also loads and returns a real value", () => {
		// A different entrypoint through the same addon: token counting. Proves the
		// load is not specific to one export and returns a concrete positive count,
		// not an empty/zero placeholder.
		const tokens = countTokens("the quick brown fox jumps over the lazy dog");
		expect(typeof tokens).toBe("number");
		expect(tokens).toBeGreaterThan(0);
		expect(tokens).toBeLessThan(50);
	});
});
