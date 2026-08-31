/**
 * WHY THIS SUITE EXISTS. Six local-model settings and the embeddings kill switch
 * were read by two modules each: `src/config.ts`, which every other setting goes
 * through, and the layered readers in `core/local-llm-config.ts` and
 * `core/embeddings.ts`, which add a runtime-options override on top. The second
 * copy re-read the variable itself, so the two answers could disagree, and one
 * did: `MNEMOPI_NO_EMBEDDINGS=0` disabled embeddings through `config.ts` (any
 * non-empty value counted) and left them on through `core/embeddings.ts` (the
 * truthy table). The layered reader now delegates its environment half.
 *
 * THE CLASS THIS CLOSES. A settings name exported by both `config.ts` and a
 * layered module, answering differently for some spelling of the value. The
 * colliding-name set is derived from the modules at run time and pinned by exact
 * equality, so a new collision fails here until someone records what it is.
 *
 * WHAT IT DOES NOT CATCH. A second reader that spells the variable name into a
 * module neither of these three owns, and a divergence in a setting whose name
 * differs between the two layers (`llmContext` / `llmContextTokens`,
 * `llmModel` / `llmModelName`).
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as config from "@veyyon/mnemopi/config";
import * as embeddings from "@veyyon/mnemopi/core/embeddings";
import * as localLlmConfig from "@veyyon/mnemopi/core/local-llm-config";
import { withMnemopiRuntimeOptions } from "@veyyon/mnemopi/core/runtime-options";

/** Every spelling a boolean-ish variable is worth disagreeing about. */
const FLAG_SPELLINGS = ["1", "0", "true", "false", "yes", "no", "on", "off", "", "  1  ", "garbage"];
const TEXT_SPELLINGS = ["", "sk-1", "https://llm.local/v1///", "  padded  "];
const NUMBER_SPELLINGS = ["", "512", "0", "-1", "not-a-number"];

interface SharedReader {
	/** The exported name both modules carry. */
	readonly name: string;
	/** The variable the pair reads. */
	readonly variable: string;
	readonly spellings: readonly string[];
	readonly layered: () => unknown;
	readonly fromEnv: () => unknown;
}

const LLM_READERS: readonly SharedReader[] = [
	{
		name: "llmEnabled",
		variable: "MNEMOPI_LLM_ENABLED",
		spellings: FLAG_SPELLINGS,
		layered: localLlmConfig.llmEnabled,
		fromEnv: config.llmEnabled,
	},
	{
		name: "hostLlmEnabled",
		variable: "MNEMOPI_HOST_LLM_ENABLED",
		spellings: FLAG_SPELLINGS,
		layered: localLlmConfig.hostLlmEnabled,
		fromEnv: config.hostLlmEnabled,
	},
	{
		name: "llmMaxTokens",
		variable: "MNEMOPI_LLM_MAX_TOKENS",
		spellings: NUMBER_SPELLINGS,
		layered: localLlmConfig.llmMaxTokens,
		fromEnv: config.llmMaxTokens,
	},
	{
		name: "llmBaseUrl",
		variable: "MNEMOPI_LLM_BASE_URL",
		spellings: TEXT_SPELLINGS,
		layered: localLlmConfig.llmBaseUrl,
		fromEnv: config.llmBaseUrl,
	},
	{
		name: "llmApiKey",
		variable: "MNEMOPI_LLM_API_KEY",
		spellings: TEXT_SPELLINGS,
		layered: localLlmConfig.llmApiKey,
		fromEnv: config.llmApiKey,
	},
	{
		name: "sleepPrompt",
		variable: "MNEMOPI_SLEEP_PROMPT",
		spellings: TEXT_SPELLINGS,
		layered: localLlmConfig.sleepPrompt,
		fromEnv: config.sleepPrompt,
	},
];

const EMBEDDING_READERS: readonly SharedReader[] = [
	{
		name: "embeddingsDisabled",
		variable: "MNEMOPI_NO_EMBEDDINGS",
		spellings: FLAG_SPELLINGS,
		layered: embeddings.embeddingsDisabled,
		fromEnv: config.embeddingsDisabled,
	},
];

/** A name both modules export whose two answers are the same object, not two readers. */
const PURE_REEXPORTS = ["embeddingDimFor"];

function functionNames(module: Record<string, unknown>): string[] {
	return Object.keys(module)
		.filter(name => typeof module[name] === "function")
		.sort();
}

function collidingNames(layered: Record<string, unknown>): string[] {
	const owner = new Set(functionNames(config as unknown as Record<string, unknown>));
	return functionNames(layered).filter(name => owner.has(name));
}

const touched = new Set<string>();

function withVariable(name: string, value: string): void {
	touched.add(name);
	process.env[name] = value;
}

afterEach(() => {
	for (const name of touched) delete process.env[name];
	touched.clear();
});

describe("a mnemopi setting has one reader", () => {
	it("reads exactly the settings names both the owner and the local-model layer export", () => {
		expect(collidingNames(localLlmConfig as unknown as Record<string, unknown>)).toEqual(
			LLM_READERS.map(reader => reader.name).sort(),
		);
	});

	it("reads exactly the settings names both the owner and the embedder export", () => {
		expect(collidingNames(embeddings as unknown as Record<string, unknown>)).toEqual(
			[...EMBEDDING_READERS.map(reader => reader.name), ...PURE_REEXPORTS].sort(),
		);
	});

	it("hands a pure re-export straight through, so there is one function and not two", () => {
		for (const name of PURE_REEXPORTS) {
			expect((embeddings as unknown as Record<string, unknown>)[name]).toBe(
				(config as unknown as Record<string, unknown>)[name],
			);
		}
	});

	for (const reader of [...LLM_READERS, ...EMBEDDING_READERS]) {
		it(`answers ${reader.name} the same way through both modules, for every spelling of ${reader.variable}`, () => {
			for (const spelling of reader.spellings) {
				withVariable(reader.variable, spelling);
				expect({ spelling, value: reader.layered() }).toEqual({ spelling, value: reader.fromEnv() });
			}
			delete process.env[reader.variable];
			expect(reader.layered()).toEqual(reader.fromEnv());
		});
	}

	// Delegation must not swallow the layer above it: a caller that named a value
	// still beats the environment.
	it("prefers what the caller configured over what the environment says", () => {
		withVariable("MNEMOPI_LLM_ENABLED", "1");
		withVariable("MNEMOPI_LLM_MAX_TOKENS", "512");
		withVariable("MNEMOPI_LLM_BASE_URL", "https://from-env.local/v1");

		withMnemopiRuntimeOptions(
			{ llm: { enabled: false, maxTokens: 64, baseUrl: "https://from-caller.local/v1/" } },
			() => {
				expect(localLlmConfig.llmEnabled()).toBe(false);
				expect(localLlmConfig.llmMaxTokens()).toBe(64);
				expect(localLlmConfig.llmBaseUrl()).toBe("https://from-caller.local/v1");
			},
		);

		expect(localLlmConfig.llmEnabled()).toBe(true);
		expect(localLlmConfig.llmMaxTokens()).toBe(512);
		expect(localLlmConfig.llmBaseUrl()).toBe("https://from-env.local/v1");
	});

	it("prefers a caller's embeddings decision over the variable", () => {
		withVariable("MNEMOPI_NO_EMBEDDINGS", "1");

		withMnemopiRuntimeOptions({ embeddings: { disabled: false } }, () => {
			expect(embeddings.embeddingsDisabled()).toBe(false);
		});

		expect(embeddings.embeddingsDisabled()).toBe(true);
	});
});
