import { describe, expect, it } from "bun:test";
import {
	type ApiKey,
	type ApiKeyResolveContext,
	type ApiKeyResolver,
	AUTH_RETRY_MAX_ATTEMPTS,
	createAuthRetryKeyState,
	isApiKeyResolver,
	seedApiKeyResolver,
} from "../src/auth-retry";
import {
	ANTHROPIC_USE_INTERLEAVED_THINKING,
	MIN_OUTPUT_TOKENS,
	mapAnthropicToolChoice,
	mapGoogleToolChoice,
	OUTPUT_CAP_WHEN_UNKNOWN,
	OUTPUT_FALLBACK_BUFFER,
	THINKING_LOOP_MAX_ABORTS,
	THINKING_LOOP_RETRY_BASE_DELAY_MS,
	THINKING_LOOP_RETRY_MAX_DELAY_MS,
} from "../src/stream-helpers";
import type { ToolChoice } from "../src/types";

describe("MIN_OUTPUT_TOKENS", () => {
	it("is 1024", () => {
		expect(MIN_OUTPUT_TOKENS).toBe(1024);
	});
});

describe("OUTPUT_CAP_WHEN_UNKNOWN", () => {
	it("is 64000", () => {
		expect(OUTPUT_CAP_WHEN_UNKNOWN).toBe(64_000);
	});
});

describe("OUTPUT_FALLBACK_BUFFER", () => {
	it("is 4000", () => {
		expect(OUTPUT_FALLBACK_BUFFER).toBe(4000);
	});
});

describe("THINKING_LOOP_MAX_ABORTS", () => {
	it("is 3", () => {
		expect(THINKING_LOOP_MAX_ABORTS).toBe(3);
	});
});

describe("THINKING_LOOP_RETRY_BASE_DELAY_MS", () => {
	it("is 500", () => {
		expect(THINKING_LOOP_RETRY_BASE_DELAY_MS).toBe(500);
	});
});

describe("THINKING_LOOP_RETRY_MAX_DELAY_MS", () => {
	it("is 8000", () => {
		expect(THINKING_LOOP_RETRY_MAX_DELAY_MS).toBe(8_000);
	});
});

describe("ANTHROPIC_USE_INTERLEAVED_THINKING", () => {
	it("is a boolean", () => {
		expect(typeof ANTHROPIC_USE_INTERLEAVED_THINKING).toBe("boolean");
	});
});

describe("mapAnthropicToolChoice", () => {
	it("returns undefined for undefined", () => {
		expect(mapAnthropicToolChoice(undefined)).toBeUndefined();
	});
	it("maps required to any", () => {
		expect(mapAnthropicToolChoice("required")).toBe("any");
	});
	it("maps auto", () => {
		expect(mapAnthropicToolChoice("auto")).toBe("auto");
	});
	it("maps none", () => {
		expect(mapAnthropicToolChoice("none")).toBe("none");
	});
	it("maps any", () => {
		expect(mapAnthropicToolChoice("any")).toBe("any");
	});
	it("maps tool choice with name", () => {
		const choice: ToolChoice = { type: "tool", name: "my-tool" };
		expect(mapAnthropicToolChoice(choice)).toEqual({ type: "tool", name: "my-tool" });
	});
	it("returns undefined for tool choice without name", () => {
		const choice = { type: "tool", name: "" } as unknown as ToolChoice;
		expect(mapAnthropicToolChoice(choice)).toBeUndefined();
	});
	it("maps function choice with function.name", () => {
		const choice: ToolChoice = { type: "function", function: { name: "my-fn" } };
		expect(mapAnthropicToolChoice(choice)).toEqual({ type: "tool", name: "my-fn" });
	});
	it("maps function choice with name", () => {
		const choice = { type: "function", name: "my-fn" } as unknown as ToolChoice;
		expect(mapAnthropicToolChoice(choice)).toEqual({ type: "tool", name: "my-fn" });
	});
	it("returns undefined for function without name", () => {
		const choice = { type: "function", function: { name: "" } } as unknown as ToolChoice;
		expect(mapAnthropicToolChoice(choice)).toBeUndefined();
	});
});

describe("mapGoogleToolChoice", () => {
	it("returns undefined for undefined", () => {
		expect(mapGoogleToolChoice(undefined)).toBeUndefined();
	});
	it("maps required to any", () => {
		expect(mapGoogleToolChoice("required")).toBe("any");
	});
	it("maps auto", () => {
		expect(mapGoogleToolChoice("auto")).toBe("auto");
	});
	it("maps none", () => {
		expect(mapGoogleToolChoice("none")).toBe("none");
	});
	it("maps any", () => {
		expect(mapGoogleToolChoice("any")).toBe("any");
	});
	it("maps tool choice to ANY mode with allowedFunctionNames", () => {
		const choice: ToolChoice = { type: "tool", name: "my-tool" };
		expect(mapGoogleToolChoice(choice)).toEqual({ mode: "ANY", allowedFunctionNames: ["my-tool"] });
	});
	it("returns undefined for tool choice without name", () => {
		const choice = { type: "tool", name: "" } as unknown as ToolChoice;
		expect(mapGoogleToolChoice(choice)).toBeUndefined();
	});
	it("maps function choice with function.name", () => {
		const choice: ToolChoice = { type: "function", function: { name: "my-fn" } };
		expect(mapGoogleToolChoice(choice)).toEqual({ mode: "ANY", allowedFunctionNames: ["my-fn"] });
	});
	it("returns undefined for function without name", () => {
		const choice = { type: "function", function: { name: "" } } as unknown as ToolChoice;
		expect(mapGoogleToolChoice(choice)).toBeUndefined();
	});
});

describe("AUTH_RETRY_MAX_ATTEMPTS", () => {
	it("is 64", () => {
		expect(AUTH_RETRY_MAX_ATTEMPTS).toBe(64);
	});
});

describe("isApiKeyResolver", () => {
	it("returns true for function", () => {
		const fn: ApiKeyResolver = () => "key";
		expect(isApiKeyResolver(fn)).toBe(true);
	});
	it("returns false for string", () => {
		expect(isApiKeyResolver("api-key" as ApiKey)).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(isApiKeyResolver(undefined)).toBe(false);
	});
});

describe("seedApiKeyResolver", () => {
	it("returns seed on first call without error", () => {
		const resolver: ApiKeyResolver = () => "fallback";
		const seeded = seedApiKeyResolver("seed-key", resolver);
		const ctx: ApiKeyResolveContext = { lastChance: false, error: undefined };
		expect(seeded(ctx)).toBe("seed-key");
	});
	it("returns resolver result after seed used", () => {
		const resolver: ApiKeyResolver = () => "fallback";
		const seeded = seedApiKeyResolver("seed-key", resolver);
		const ctx1: ApiKeyResolveContext = { lastChance: false, error: undefined };
		seeded(ctx1);
		const ctx2: ApiKeyResolveContext = { lastChance: false, error: new Error("auth") };
		expect(seeded(ctx2)).toBe("fallback");
	});
	it("returns resolver result when error is present on first call", () => {
		const resolver: ApiKeyResolver = () => "fallback";
		const seeded = seedApiKeyResolver("seed-key", resolver);
		const ctx: ApiKeyResolveContext = { lastChance: false, error: new Error("auth") };
		expect(seeded(ctx)).toBe("fallback");
	});
	it("returns undefined when seed is undefined", () => {
		const resolver: ApiKeyResolver = () => "fallback";
		const seeded = seedApiKeyResolver(undefined, resolver);
		const ctx: ApiKeyResolveContext = { lastChance: false, error: undefined };
		expect(seeded(ctx)).toBe("fallback");
	});
});

describe("createAuthRetryKeyState", () => {
	it("creates state with initial key", () => {
		const state = createAuthRetryKeyState("initial-key");
		expect(state.lastKey).toBe("initial-key");
		expect(state.attemptedKeys.has("initial-key")).toBe(true);
		expect(state.refreshedCurrent).toBe(false);
		expect(state.legacyAuthSwitchUsed).toBe(false);
		expect(state.attempts).toBe(1);
	});
	it("creates independent state instances", () => {
		const state1 = createAuthRetryKeyState("key1");
		const state2 = createAuthRetryKeyState("key2");
		expect(state1.lastKey).toBe("key1");
		expect(state2.lastKey).toBe("key2");
		expect(state1.attemptedKeys.has("key2")).toBe(false);
	});
});
