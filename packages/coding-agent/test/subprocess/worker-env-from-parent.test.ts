import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { workerEnvFromParent } from "@veyyon/coding-agent/subprocess/worker-client";

/**
 * workerEnvFromParent builds the environment a spawned worker subprocess inherits: every string-valued
 * variable from the parent process, with an optional overlay applied last. It had no direct test. The
 * contracts pinned here are the ones a worker-spawn regression would break:
 *   - the parent's string env vars are copied through (a worker sees the same PATH etc.);
 *   - the overlay wins on a key both define, so a caller can force a specific value into the child;
 *   - an overlay key absent from the parent is added;
 *   - the result is a plain string->string record — undefined-valued parent entries are dropped, never
 *     leaked as the literal "undefined" or an undefined value.
 */
describe("workerEnvFromParent", () => {
	// The function reads the live process env; use uniquely-named markers and restore them so the test
	// neither depends on nor pollutes the host environment.
	const BASE_KEY = "VEYYON_WEP_BASE_MARKER";
	const OVERLAY_KEY = "VEYYON_WEP_OVERLAY_ONLY";
	let savedBase: string | undefined;
	let savedOverlay: string | undefined;

	beforeEach(() => {
		savedBase = process.env[BASE_KEY];
		savedOverlay = process.env[OVERLAY_KEY];
		delete process.env[BASE_KEY];
		delete process.env[OVERLAY_KEY];
	});
	afterEach(() => {
		if (savedBase === undefined) delete process.env[BASE_KEY];
		else process.env[BASE_KEY] = savedBase;
		if (savedOverlay === undefined) delete process.env[OVERLAY_KEY];
		else process.env[OVERLAY_KEY] = savedOverlay;
	});

	it("copies the parent's string env vars through", () => {
		process.env[BASE_KEY] = "base-value";
		const env = workerEnvFromParent();
		expect(env[BASE_KEY]).toBe("base-value");
		expect(typeof env.PATH).toBe("string");
	});

	it("lets the overlay win on a key the parent also defines", () => {
		process.env[BASE_KEY] = "base-value";
		expect(workerEnvFromParent({ [BASE_KEY]: "overlaid" })[BASE_KEY]).toBe("overlaid");
	});

	it("adds an overlay key that the parent does not define", () => {
		expect(workerEnvFromParent({ [OVERLAY_KEY]: "added" })[OVERLAY_KEY]).toBe("added");
	});

	it("produces a plain string->string record with no undefined values", () => {
		const env = workerEnvFromParent();
		expect(env[BASE_KEY]).toBeUndefined();
		expect(Object.values(env).every(value => typeof value === "string")).toBe(true);
	});
});
