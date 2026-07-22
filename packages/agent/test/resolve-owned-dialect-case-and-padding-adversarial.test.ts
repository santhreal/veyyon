/**
 * resolveOwnedDialectFromEnv: case, padding, unicode, numeric lookalikes reject.
 * Why: only exact accepted dialect tokens enable dialect tools; fail closed else.
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

describe("resolveOwnedDialectFromEnv case and padding adversarial", () => {
	for (const d of ACCEPTED) {
		it(`upper ${d}`, () => {
			expect(resolveOwnedDialectFromEnv(d.toUpperCase())).toBeUndefined();
		});
		it(`title ${d}`, () => {
			const title = d[0]!.toUpperCase() + d.slice(1);
			expect(resolveOwnedDialectFromEnv(title)).toBeUndefined();
		});
		it(`pad left ${d}`, () => {
			expect(resolveOwnedDialectFromEnv(` ${d}`)).toBeUndefined();
		});
		it(`pad right ${d}`, () => {
			expect(resolveOwnedDialectFromEnv(`${d} `)).toBeUndefined();
		});
		it(`tab pad ${d}`, () => {
			expect(resolveOwnedDialectFromEnv(`\t${d}`)).toBeUndefined();
		});
	}

	const more = [
		"true ",
		" true",
		"TRUE",
		"True",
		"1 ",
		" 1",
		"01",
		"yes",
		"on",
		"enabled",
		"glm\n",
		"glm\0",
		"glm,",
		"glm;hermes",
		"hermes,kimi",
		"qwen",
		"qwen-3",
		"claude",
		"openai",
		"gpt",
		"oai",
		"native",
		"pi_native",
		"piNative",
		"Pi-Native",
		"undefined",
		"null",
		"NaN",
		"🚀",
		"гlm",
	];
	for (const v of more) {
		it(`reject ${JSON.stringify(v)}`, () => {
			expect(resolveOwnedDialectFromEnv(v)).toBeUndefined();
		});
	}
});
