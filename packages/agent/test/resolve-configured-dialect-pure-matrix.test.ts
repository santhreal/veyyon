/**
 * resolveConfiguredDialect: static string and function forms; env fallback.
 * Why: dialect mis-resolution sends wrong tool-call wire format to the model.
 */
import { describe, expect, it } from "bun:test";
import { resolveConfiguredDialect, resolveOwnedDialectFromEnv } from "@veyyon/agent-core/agent-loop";
import type { Model } from "@veyyon/ai";

const model = { id: "m", provider: "p" } as Model;

describe("resolveConfiguredDialect pure matrix", () => {
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

	const prev = Bun.env.VEYYON_DIALECT;

	for (const d of dialects) {
		it(`static ${d}`, () => {
			Bun.env.VEYYON_DIALECT = "xml";
			try {
				expect(resolveConfiguredDialect(d, model)).toBe(d);
			} finally {
				if (prev === undefined) delete Bun.env.VEYYON_DIALECT;
				else Bun.env.VEYYON_DIALECT = prev;
			}
		});

		it(`function returns ${d}`, () => {
			Bun.env.VEYYON_DIALECT = "xml";
			try {
				expect(resolveConfiguredDialect(() => d, model)).toBe(d);
			} finally {
				if (prev === undefined) delete Bun.env.VEYYON_DIALECT;
				else Bun.env.VEYYON_DIALECT = prev;
			}
		});
	}

	it("undefined configured equals env helper", () => {
		delete Bun.env.VEYYON_DIALECT;
		try {
			expect(resolveConfiguredDialect(undefined, model)).toBe(
				resolveOwnedDialectFromEnv(undefined),
			);
		} finally {
			if (prev === undefined) delete Bun.env.VEYYON_DIALECT;
			else Bun.env.VEYYON_DIALECT = prev;
		}
	});

	it("function undefined falls to env", () => {
		Bun.env.VEYYON_DIALECT = "hermes";
		try {
			expect(resolveConfiguredDialect(() => undefined, model)).toBe("hermes");
		} finally {
			if (prev === undefined) delete Bun.env.VEYYON_DIALECT;
			else Bun.env.VEYYON_DIALECT = prev;
		}
	});
});
