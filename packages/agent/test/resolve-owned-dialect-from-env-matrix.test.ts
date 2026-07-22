/**
 * resolveOwnedDialectFromEnv is the sole owner of VEYYON_DIALECT parsing.
 * Fail-closed: unknown / cased / padded values return undefined (native tools).
 */
import { describe, expect, it } from "bun:test";
import { resolveOwnedDialectFromEnv } from "@veyyon/agent-core/agent-loop";

const ACCEPTED = [
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

describe("resolveOwnedDialectFromEnv matrix", () => {
	it("1 and true map to glm", () => {
		expect(resolveOwnedDialectFromEnv("1")).toBe("glm");
		expect(resolveOwnedDialectFromEnv("true")).toBe("glm");
	});

	for (const d of ACCEPTED) {
		it(`accepts exact ${d}`, () => {
			expect(resolveOwnedDialectFromEnv(d)).toBe(d);
		});
	}

	const rejected = [
		undefined,
		"",
		" ",
		"GLM",
		"True",
		"TRUE",
		"false",
		"0",
		"yes",
		" glm",
		"glm ",
		"bogus",
		"openai",
		"native",
		"pi",
		"xml ",
	];
	for (const v of rejected) {
		it(`rejects ${JSON.stringify(v)}`, () => {
			expect(resolveOwnedDialectFromEnv(v)).toBeUndefined();
		});
	}
});
