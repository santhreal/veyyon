/**
 * `--no-title` (VEYYON_NO_TITLE) disables EVERY auto-title path (config fix).
 *
 * The bug this suite locks out (HUNT2-config-notitle-replan-and-planseed-ignored,
 * found 2026-07-22): the `--no-title` flag sets VEYYON_NO_TITLE=1, but only the
 * first-user-input title path checked it. The replan title refresh and the
 * plan-approved seed did not, so a user who asked for no titles (or an rpc/acp
 * embedder inheriting the env) still got an auto-generated title AND an
 * unexpected title-model network round-trip the moment a replan fired or a plan
 * was approved.
 *
 * The fix routes every path through one predicate, `autoTitleDisabled()`, and
 * short-circuits `generateSessionTitle` on it — so no title model is invoked for
 * any caller. These tests assert the predicate reads the env and that
 * generateSessionTitle returns null WITHOUT calling the completion API when the
 * flag is set, while still titling normally when it is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { autoTitleDisabled, generateSessionTitle } from "@veyyon/coding-agent/utils/title-generator";

function model(): Model<Api> {
	const m = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!m) throw new Error("expected bundled model");
	return m;
}

function settings(m: Model<Api>) {
	return {
		get: (path: string) => (path === "providers.tinyModel" ? "online" : undefined),
		getModelRole: (role: string) => (role === "smol" ? `${m.provider}/${m.id}` : undefined),
		getStorage: () => undefined,
	} as never;
}

function registry(m: Model<Api>) {
	return {
		getAvailable: () => [m],
		getApiKey: async () => "test-key",
		getApiKeyForProvider: async () => "test-key",
		authStorage: { rotateSessionCredential: async () => false },
		resolver: () => async () => "test-key",
	} as never;
}

const HAD_ENV = Object.hasOwn(process.env, "VEYYON_NO_TITLE");
const PREV = process.env.VEYYON_NO_TITLE;

beforeEach(() => {
	delete process.env.VEYYON_NO_TITLE;
});
afterEach(() => {
	vi.restoreAllMocks();
	if (HAD_ENV) process.env.VEYYON_NO_TITLE = PREV;
	else delete process.env.VEYYON_NO_TITLE;
});

describe("autoTitleDisabled", () => {
	it("is true only when VEYYON_NO_TITLE is set", () => {
		expect(autoTitleDisabled()).toBe(false);
		process.env.VEYYON_NO_TITLE = "1";
		expect(autoTitleDisabled()).toBe(true);
		delete process.env.VEYYON_NO_TITLE;
		expect(autoTitleDisabled()).toBe(false);
	});
});

describe("generateSessionTitle honors --no-title everywhere", () => {
	it("returns null and invokes NO title model when VEYYON_NO_TITLE is set", async () => {
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Should Not Happen</title>" }],
		} as never);
		process.env.VEYYON_NO_TITLE = "1";

		const m = model();
		// A real task message that WOULD otherwise be titled (not low-signal).
		const title = await generateSessionTitle("Investigate the resolver bug", registry(m), settings(m));

		expect(title).toBeNull();
		// The hard off switch must fire before any model round-trip.
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("titles normally when the flag is absent (the gate is scoped to the flag)", async () => {
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Resolver Investigation</title>" }],
		} as never);

		const m = model();
		const title = await generateSessionTitle("Investigate the resolver bug", registry(m), settings(m));

		expect(title).toBe("Resolver Investigation");
		expect(completeSimpleMock).toHaveBeenCalled();
	});
});
