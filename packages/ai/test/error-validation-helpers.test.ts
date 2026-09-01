import { describe, expect, it } from "bun:test";
import { ConfigurationError, StreamTimeoutError, ToolNotFoundError, ValidationError } from "../src/error/validation";

describe("ValidationError", () => {
	it("sets name to ValidationError", () => {
		const err = new ValidationError("bad input");
		expect(err.name).toBe("ValidationError");
	});
	it("preserves message", () => {
		const err = new ValidationError("bad input");
		expect(err.message).toBe("bad input");
	});
	it("is an Error instance", () => {
		expect(new ValidationError("test") instanceof Error).toBe(true);
	});
	it("attaches cause when provided", () => {
		const cause = new Error("root cause");
		const err = new ValidationError("bad input", { cause });
		expect(err.cause).toBe(cause);
	});
	it("does not set cause when undefined", () => {
		const err = new ValidationError("bad input");
		expect(err.cause).toBeUndefined();
	});
});

describe("ToolNotFoundError", () => {
	it("includes available tools in message", () => {
		const err = new ToolNotFoundError("missing", ["read", "write"]);
		expect(err.message).toContain("read");
		expect(err.message).toContain("write");
		expect(err.message).toContain("missing");
	});
	it("provides guidance when no tools available", () => {
		const err = new ToolNotFoundError("missing");
		expect(err.message).toContain("missing");
		expect(err.message).toContain("not in this session");
	});
	it("provides guidance when empty tools list", () => {
		const err = new ToolNotFoundError("missing", []);
		expect(err.message).toContain("not in this session");
	});
	it("is a ValidationError", () => {
		const err = new ToolNotFoundError("missing");
		expect(err instanceof ValidationError).toBe(true);
	});
	it("sorts available tools", () => {
		const err = new ToolNotFoundError("missing", ["write", "read", "edit"]);
		const msg = err.message;
		const readPos = msg.indexOf("read");
		const writePos = msg.indexOf("write");
		expect(readPos).toBeLessThan(writePos);
	});
	it("truncates long tool lists", () => {
		const tools = Array.from({ length: 50 }, (_, i) => `tool_${i}`);
		const err = new ToolNotFoundError("missing", tools);
		expect(err.message).toContain("more");
	});
});

describe("ConfigurationError", () => {
	it("sets name to ConfigurationError", () => {
		const err = new ConfigurationError("bad config");
		expect(err.name).toBe("ConfigurationError");
	});
	it("preserves message", () => {
		expect(new ConfigurationError("bad config").message).toBe("bad config");
	});
	it("is an Error instance", () => {
		expect(new ConfigurationError("test") instanceof Error).toBe(true);
	});
	it("attaches cause", () => {
		const cause = new Error("root");
		const err = new ConfigurationError("bad config", { cause });
		expect(err.cause).toBe(cause);
	});
});

describe("StreamTimeoutError", () => {
	it("sets name to StreamTimeoutError", () => {
		const err = new StreamTimeoutError();
		expect(err.name).toBe("StreamTimeoutError");
	});
	it("has default message", () => {
		const err = new StreamTimeoutError();
		expect(err.message.length).toBeGreaterThan(0);
		expect(err.message).toContain("timed out");
	});
	it("accepts custom message", () => {
		const err = new StreamTimeoutError("custom timeout");
		expect(err.message).toBe("custom timeout");
	});
	it("is an Error instance", () => {
		expect(new StreamTimeoutError() instanceof Error).toBe(true);
	});
});
