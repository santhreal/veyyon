import { describe, expect, it } from "bun:test";
import {
	AUTH_RETRY_MAX_ATTEMPTS,
	createAuthRetryKeyState,
	isApiKeyResolver,
	seedApiKeyResolver,
} from "../src/auth-retry";

describe("AUTH_RETRY_MAX_ATTEMPTS", () => {
	it("is 64", () => {
		expect(AUTH_RETRY_MAX_ATTEMPTS).toBe(64);
	});
});

describe("isApiKeyResolver", () => {
	it("returns true for function", () => {
		expect(isApiKeyResolver(() => "key")).toBe(true);
	});
	it("returns false for string", () => {
		expect(isApiKeyResolver("api-key")).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(isApiKeyResolver(undefined)).toBe(false);
	});
});

describe("seedApiKeyResolver", () => {
	it("returns seed on first call without error", async () => {
		const resolver = seedApiKeyResolver("seed-key", () => "resolved-key");
		const result = await resolver({ lastChance: false, error: undefined });
		expect(result).toBe("seed-key");
	});
	it("returns resolver result after seed is consumed", async () => {
		const resolver = seedApiKeyResolver("seed-key", () => "resolved-key");
		await resolver({ lastChance: false, error: undefined });
		const result = await resolver({ lastChance: false, error: undefined });
		expect(result).toBe("resolved-key");
	});
	it("returns resolver result when error is present (seed not consumed)", async () => {
		const resolver = seedApiKeyResolver("seed-key", () => "resolved-key");
		const result = await resolver({ lastChance: false, error: new Error("auth failed") });
		expect(result).toBe("resolved-key");
	});
	it("returns seed on first call, then resolver on subsequent even with error", async () => {
		const resolver = seedApiKeyResolver("seed-key", () => "resolved-key");
		const first = await resolver({ lastChance: false, error: undefined });
		expect(first).toBe("seed-key");
		const second = await resolver({ lastChance: false, error: new Error("auth") });
		expect(second).toBe("resolved-key");
	});
	it("handles undefined seed", async () => {
		const resolver = seedApiKeyResolver(undefined, () => "resolved-key");
		const result = await resolver({ lastChance: false, error: undefined });
		expect(result).toBe("resolved-key");
	});
});

describe("createAuthRetryKeyState", () => {
	it("creates state with initial key in attemptedKeys", () => {
		const state = createAuthRetryKeyState("initial-key");
		expect(state.attemptedKeys.has("initial-key")).toBe(true);
		expect(state.lastKey).toBe("initial-key");
	});
	it("starts with refreshedCurrent false", () => {
		const state = createAuthRetryKeyState("initial-key");
		expect(state.refreshedCurrent).toBe(false);
	});
	it("starts with legacyAuthSwitchUsed false", () => {
		const state = createAuthRetryKeyState("initial-key");
		expect(state.legacyAuthSwitchUsed).toBe(false);
	});
	it("starts with attempts 1", () => {
		const state = createAuthRetryKeyState("initial-key");
		expect(state.attempts).toBe(1);
	});
	it("attemptedKeys has exactly one entry", () => {
		const state = createAuthRetryKeyState("initial-key");
		expect(state.attemptedKeys.size).toBe(1);
	});
});
