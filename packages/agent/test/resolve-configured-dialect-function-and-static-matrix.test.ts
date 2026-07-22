/**
 * resolveConfiguredDialect: static value, function(model), env fallback.
 * Why: dialect selection must prefer configured then VEYYON_DIALECT.
 */
import { describe, expect, it } from "bun:test";
import {
	resolveConfiguredDialect,
	resolveOwnedDialectFromEnv,
} from "@veyyon/agent-core/agent-loop";

const model = { id: "m", provider: "openai", api: "openai-completions" } as never;

describe("resolveConfiguredDialect function and static matrix", () => {
	const dialects = [
		"glm",
		"hermes",
		"kimi",
		"xml",
		"anthropic",
		"deepseek",
		"harmony",
		"qwen3",
		"gemini",
		"gemma",
		"minimax",
		"pi-native",
	] as const;

	for (const d of dialects) {
		it(`static ${d}`, () => {
			expect(resolveConfiguredDialect(d, model)).toBe(d);
		});
		it(`function returns ${d}`, () => {
			expect(resolveConfiguredDialect(() => d, model)).toBe(d);
		});
	}

	it("undefined configured falls through to env helper shape", () => {
		// may be undefined or env dialect; must not throw
		const got = resolveConfiguredDialect(undefined, model);
		if (got !== undefined) {
			expect(dialects.includes(got as (typeof dialects)[number])).toBe(true);
		}
	});

	it("function returning undefined falls to env", () => {
		const got = resolveConfiguredDialect(() => undefined, model);
		if (got !== undefined) {
			expect(typeof got).toBe("string");
		}
	});

	it("resolveOwnedDialectFromEnv true is glm", () => {
		expect(resolveOwnedDialectFromEnv("true")).toBe("glm");
	});
});
