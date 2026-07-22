/**
 * resolveConfiguredDialect: configured value / function wins; else env;
 * function returning undefined falls through to env.
 */
import { describe, expect, it } from "bun:test";
import { resolveConfiguredDialect, resolveOwnedDialectFromEnv } from "@veyyon/agent-core/agent-loop";
import type { Model } from "@veyyon/ai";

const model = { id: "m", provider: "p" } as Model;

describe("resolveConfiguredDialect precedence", () => {
	const prev = Bun.env.VEYYON_DIALECT;

	it("static configured wins over env", () => {
		Bun.env.VEYYON_DIALECT = "hermes";
		try {
			expect(resolveConfiguredDialect("glm", model)).toBe("glm");
			expect(resolveConfiguredDialect("xml", model)).toBe("xml");
		} finally {
			if (prev === undefined) delete Bun.env.VEYYON_DIALECT;
			else Bun.env.VEYYON_DIALECT = prev;
		}
	});

	it("function configured wins", () => {
		Bun.env.VEYYON_DIALECT = "hermes";
		try {
			expect(resolveConfiguredDialect(() => "kimi", model)).toBe("kimi");
		} finally {
			if (prev === undefined) delete Bun.env.VEYYON_DIALECT;
			else Bun.env.VEYYON_DIALECT = prev;
		}
	});

	it("function undefined falls through to env", () => {
		Bun.env.VEYYON_DIALECT = "glm";
		try {
			expect(resolveConfiguredDialect(() => undefined, model)).toBe("glm");
		} finally {
			if (prev === undefined) delete Bun.env.VEYYON_DIALECT;
			else Bun.env.VEYYON_DIALECT = prev;
		}
	});

	it("undefined configured uses env helper", () => {
		delete Bun.env.VEYYON_DIALECT;
		try {
			expect(resolveConfiguredDialect(undefined, model)).toBe(
				resolveOwnedDialectFromEnv(undefined),
			);
			Bun.env.VEYYON_DIALECT = "true";
			expect(resolveConfiguredDialect(undefined, model)).toBe("glm");
		} finally {
			if (prev === undefined) delete Bun.env.VEYYON_DIALECT;
			else Bun.env.VEYYON_DIALECT = prev;
		}
	});
});
