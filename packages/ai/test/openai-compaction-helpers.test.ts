import { describe, expect, it } from "bun:test";
import { resetServerCompactionRouteCache, SERVER_COMPACTION_WIRE_APIS } from "../src/providers/openai-compaction";

describe("SERVER_COMPACTION_WIRE_APIS", () => {
	it("includes openai-responses", () => {
		expect(SERVER_COMPACTION_WIRE_APIS["openai-responses"]).toBe(true);
	});
	it("includes azure-openai-responses", () => {
		expect(SERVER_COMPACTION_WIRE_APIS["azure-openai-responses"]).toBe(true);
	});
	it("includes openai-codex-responses", () => {
		expect(SERVER_COMPACTION_WIRE_APIS["openai-codex-responses"]).toBe(true);
	});
	it("does not include anthropic-messages", () => {
		expect(SERVER_COMPACTION_WIRE_APIS["anthropic-messages"]).toBeUndefined();
	});
	it("does not include openai-completions", () => {
		expect(SERVER_COMPACTION_WIRE_APIS["openai-completions"]).toBeUndefined();
	});
});

describe("resetServerCompactionRouteCache", () => {
	it("does not throw", () => {
		expect(() => resetServerCompactionRouteCache()).not.toThrow();
	});
	it("can be called multiple times safely", () => {
		resetServerCompactionRouteCache();
		resetServerCompactionRouteCache();
		// no throw
	});
});
