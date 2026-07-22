import { afterEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";

// WHY THIS SUITE EXISTS (BACKLOG TEST-ISO-SETTINGS)
// -------------------------------------------------
// `Settings.init` is guarded to initialize the process-wide singleton exactly
// once: the first caller wins, and every later `Settings.init(...)` in the same
// process returns that first instance and SILENTLY DROPS its own options. The CI
// runner (scripts/ci-test-ts.ts) groups several test files into one `bun test`
// child process per chunk, so two files that each call `Settings.init` with
// different options collide: whichever runs first dictates the settings the
// other one silently reads. This actually happened: a stray
// `Settings.init({ inMemory: true })` in one file handed the wrong instance to
// session-workdir-settings-ui's persist test when they landed in the same chunk.
//
// The seam that breaks the guard is `resetSettingsForTest()`. Every suite that
// touches the global singleton must reset before init (claim a clean slate) and
// after (release the guard for the next file). This suite locks BOTH halves of
// that contract so the contamination class cannot silently return: it proves the
// guard drops a second init's options, and proves reset makes the next init win.

describe("Settings global-singleton init isolation", () => {
	// Each case mutates the process-wide singleton, so release it between cases
	// (and, via the last afterEach, for the next test FILE in this CI chunk).
	afterEach(() => {
		resetSettingsForTest();
	});

	it("guards init to once per process: a second init without reset returns the first instance and silently drops its options", async () => {
		resetSettingsForTest();

		const first = await Settings.init({ inMemory: true, overrides: { "debug.enabled": true } });
		const second = await Settings.init({ inMemory: true, overrides: { "debug.enabled": false } });

		// The guard returns the SAME object for the second call...
		expect(second).toBe(first);
		// ...and the second call's options never took effect. Both instances read
		// the first init's value (true), not the second's (false). This is the
		// contamination symptom: a co-chunked file that expected its own options
		// silently gets the earlier file's instead.
		expect(first.get("debug.enabled")).toBe(true);
		expect(second.get("debug.enabled")).toBe(true);
	});

	it("resetSettingsForTest releases the guard so the next init applies its own options", async () => {
		resetSettingsForTest();
		const first = await Settings.init({ inMemory: true, overrides: { "debug.enabled": true } });
		expect(first.get("debug.enabled")).toBe(true);

		// Simulate the next file in the chunk: reset, then init with its own options.
		resetSettingsForTest();
		const second = await Settings.init({ inMemory: true, overrides: { "debug.enabled": false } });

		// A distinct instance whose OWN options took effect: the fix in action.
		expect(second).not.toBe(first);
		expect(second.get("debug.enabled")).toBe(false);
	});

	it("Settings.instance reflects the most recently initialized instance after a reset", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "debug.enabled": true } });
		expect(Settings.instance.get("debug.enabled")).toBe(true);

		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "debug.enabled": false } });
		expect(Settings.instance.get("debug.enabled")).toBe(false);
	});
});
