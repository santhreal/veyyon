import { describe, expect, it } from "bun:test";
import { isFoundryEnabled } from "../src/utils/foundry";
import {
	DEFAULT_MAX_LOCAL_WORK_HOLD_MS,
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	getStreamFirstEventTimeoutMs,
	getStreamIdleTimeoutMs,
} from "../src/utils/idle-iterator";
import { getOpenRouterHeaders } from "../src/utils/openrouter-headers";
import { createSdkStreamRequestOptions } from "../src/utils/sdk-stream-timeout";

describe("getOpenRouterHeaders", () => {
	it("returns headers with User-Agent containing Veyyon", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["User-Agent"]).toContain("Veyyon/");
	});
	it("returns HTTP-Referer pointing to veyyon.dev", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["HTTP-Referer"]).toBe("https://veyyon.dev/");
	});
	it("returns X-OpenRouter-Title as Veyyon", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["X-OpenRouter-Title"]).toBe("Veyyon");
	});
	it("returns X-OpenRouter-Categories as cli-agent", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["X-OpenRouter-Categories"]).toBe("cli-agent");
	});
	it("returns cache headers", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["X-OpenRouter-Cache"]).toBe("true");
		expect(headers["X-OpenRouter-Cache-TTL"]).toBe("3600");
	});
});

describe("isFoundryEnabled", () => {
	it("returns false when env var is not set", () => {
		const original = process.env.CLAUDE_CODE_USE_FOUNDRY;
		delete process.env.CLAUDE_CODE_USE_FOUNDRY;
		expect(isFoundryEnabled()).toBe(false);
		process.env.CLAUDE_CODE_USE_FOUNDRY = original;
	});
	it("returns true for '1'", () => {
		const original = process.env.CLAUDE_CODE_USE_FOUNDRY;
		process.env.CLAUDE_CODE_USE_FOUNDRY = "1";
		expect(isFoundryEnabled()).toBe(true);
		process.env.CLAUDE_CODE_USE_FOUNDRY = original;
	});
	it("returns true for 'true'", () => {
		const original = process.env.CLAUDE_CODE_USE_FOUNDRY;
		process.env.CLAUDE_CODE_USE_FOUNDRY = "true";
		expect(isFoundryEnabled()).toBe(true);
		process.env.CLAUDE_CODE_USE_FOUNDRY = original;
	});
	it("returns true for 'TRUE' (case-insensitive)", () => {
		const original = process.env.CLAUDE_CODE_USE_FOUNDRY;
		process.env.CLAUDE_CODE_USE_FOUNDRY = "TRUE";
		expect(isFoundryEnabled()).toBe(true);
		process.env.CLAUDE_CODE_USE_FOUNDRY = original;
	});
	it("returns true for 'yes'", () => {
		const original = process.env.CLAUDE_CODE_USE_FOUNDRY;
		process.env.CLAUDE_CODE_USE_FOUNDRY = "yes";
		expect(isFoundryEnabled()).toBe(true);
		process.env.CLAUDE_CODE_USE_FOUNDRY = original;
	});
	it("returns true for 'on'", () => {
		const original = process.env.CLAUDE_CODE_USE_FOUNDRY;
		process.env.CLAUDE_CODE_USE_FOUNDRY = "on";
		expect(isFoundryEnabled()).toBe(true);
		process.env.CLAUDE_CODE_USE_FOUNDRY = original;
	});
	it("returns false for '0'", () => {
		const original = process.env.CLAUDE_CODE_USE_FOUNDRY;
		process.env.CLAUDE_CODE_USE_FOUNDRY = "0";
		expect(isFoundryEnabled()).toBe(false);
		process.env.CLAUDE_CODE_USE_FOUNDRY = original;
	});
	it("returns false for 'false'", () => {
		const original = process.env.CLAUDE_CODE_USE_FOUNDRY;
		process.env.CLAUDE_CODE_USE_FOUNDRY = "false";
		expect(isFoundryEnabled()).toBe(false);
		process.env.CLAUDE_CODE_USE_FOUNDRY = original;
	});
	it("returns false for empty string", () => {
		const original = process.env.CLAUDE_CODE_USE_FOUNDRY;
		process.env.CLAUDE_CODE_USE_FOUNDRY = "";
		expect(isFoundryEnabled()).toBe(false);
		process.env.CLAUDE_CODE_USE_FOUNDRY = original;
	});
	it("returns false for '  true  ' with whitespace (trimmed)", () => {
		const original = process.env.CLAUDE_CODE_USE_FOUNDRY;
		process.env.CLAUDE_CODE_USE_FOUNDRY = "  true  ";
		expect(isFoundryEnabled()).toBe(true);
		process.env.CLAUDE_CODE_USE_FOUNDRY = original;
	});
});

describe("createSdkStreamRequestOptions", () => {
	it("returns signal only when timeout is undefined", () => {
		const controller = new AbortController();
		const result = createSdkStreamRequestOptions(controller.signal, undefined);
		expect(result.signal).toBe(controller.signal);
		expect(result.timeout).toBeUndefined();
		expect(result.maxRetries).toBeUndefined();
	});
	it("returns signal only when timeout is not finite", () => {
		const controller = new AbortController();
		const result = createSdkStreamRequestOptions(controller.signal, Number.POSITIVE_INFINITY);
		expect(result.timeout).toBeUndefined();
	});
	it("returns signal only when timeout is <= 0", () => {
		const controller = new AbortController();
		const result = createSdkStreamRequestOptions(controller.signal, 0);
		expect(result.timeout).toBeUndefined();
	});
	it("returns signal only when timeout is negative", () => {
		const controller = new AbortController();
		const result = createSdkStreamRequestOptions(controller.signal, -100);
		expect(result.timeout).toBeUndefined();
	});
	it("returns timeout and maxRetries: 0 for valid timeout", () => {
		const controller = new AbortController();
		const result = createSdkStreamRequestOptions(controller.signal, 5000);
		expect(result.timeout).toBe(5000);
		expect(result.maxRetries).toBe(0);
	});
	it("truncates fractional timeout", () => {
		const controller = new AbortController();
		const result = createSdkStreamRequestOptions(controller.signal, 5000.7);
		expect(result.timeout).toBe(5000);
	});
});

describe("getStreamIdleTimeoutMs", () => {
	it("returns default fallback when env not set", () => {
		const result = getStreamIdleTimeoutMs();
		expect(typeof result).toBe("number");
		expect(result).toBeGreaterThan(0);
	});
	it("returns custom fallback", () => {
		const result = getStreamIdleTimeoutMs(60000);
		expect(result).toBe(60000);
	});
});

describe("getOpenAIStreamIdleTimeoutMs", () => {
	it("returns default fallback when env not set", () => {
		const result = getOpenAIStreamIdleTimeoutMs();
		expect(typeof result).toBe("number");
		expect(result).toBeGreaterThan(0);
	});
});

describe("getStreamFirstEventTimeoutMs", () => {
	it("returns default fallback when env not set", () => {
		const result = getStreamFirstEventTimeoutMs();
		expect(typeof result).toBe("number");
		expect(result).toBeGreaterThan(0);
	});
	it("returns max of fallback and idleTimeout when idleTimeout is provided", () => {
		const result = getStreamFirstEventTimeoutMs(200000, 100000);
		expect(result).toBe(200000);
	});
});

describe("getOpenAIStreamFirstEventTimeoutMs", () => {
	it("returns default fallback when env not set", () => {
		const result = getOpenAIStreamFirstEventTimeoutMs();
		expect(typeof result).toBe("number");
		expect(result).toBeGreaterThan(0);
	});
});

describe("DEFAULT_MAX_LOCAL_WORK_HOLD_MS", () => {
	it("is 90 minutes in milliseconds", () => {
		expect(DEFAULT_MAX_LOCAL_WORK_HOLD_MS).toBe(90 * 60_000);
	});
});
