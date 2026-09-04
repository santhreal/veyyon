/**
 * A MISCONFIGURED embedding setup must not look like a memory store with embeddings switched off.
 *
 * WHY THIS SUITE EXISTS, and why it is separate from `embedding-failure-is-reported.test.ts`. That suite
 * covers a provider that was reached and FAILED. This one covers the two routes that were never even
 * attempted, and they were the quietest of the lot: both returned `null` with nothing written at any log
 * level, not even debug. `embed`'s `null` means "keyword-only search from here on", which is byte-for-byte
 * what `MNEMOPI_NO_EMBEDDINGS=1` produces, so a person who had deliberately configured semantic memory got
 * a memory system with no semantic recall, no warning, and no line in any log to find later.
 *
 * The two routes:
 *
 * - A local model name that is not one of the models this build can actually load. `getLocalModel` looked
 *   the name up, got nothing, and returned `null`. Typing `BAAI/bge-small-en-v1.6` for `v1.5` is the whole
 *   bug, and it is unobservable: recall simply gets worse.
 * - An API embedding model against OpenRouter with no API key. `embedApi` returned `null` before the
 *   request. The sibling branches five lines down (`!response.ok`, no `data` array, a thrown request) all
 *   report through `reportEmbeddingFailure`, whose `fix` text says to "Check the embedding base URL and API
 *   key" — the credentials case, the single most actionable one, was the only one that said nothing.
 *
 * Both now go through `reportEmbeddingFailure`, the module's stated "one place that reports a failed
 * embedding request", whose doc already says every caller "owes the operator the same explanation".
 *
 * `null` is still returned, exactly as before. Keyword-only search is a real fallback and a memory lookup
 * must not start failing because a vector could not be produced; the report is the entire fix.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { embed, resetEmbeddingProviderForTests } from "@veyyon/mnemopi/core/embeddings";
import { logger } from "@veyyon/utils";
import { useMnemopiTestEnv } from "./setup";

useMnemopiTestEnv();

/**
 * Every variable that can move the embedding route, cleared so the case under test is the only reason a
 * route is chosen. `NODE_ENV`/`BUN_ENV` are in the list because `inTestRuntime()` short-circuits the local
 * path ahead of the model-name lookup, so under `bun test` the branch being pinned is otherwise dead code.
 */
const ENV_KEYS = [
	"NODE_ENV",
	"BUN_ENV",
	"MNEMOPI_NO_EMBEDDINGS",
	"MNEMOPI_EMBEDDING_MODEL",
	"MNEMOPI_EMBEDDING_API_URL",
	"MNEMOPI_EMBEDDING_API_KEY",
	"OPENROUTER_BASE_URL",
	"OPENROUTER_API_KEY",
	"OPENAI_API_KEY",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

/** Captured `logger.warn` calls: the message and its structured fields. */
type Warning = { message: string; meta: Record<string, unknown> };

async function withEmbeddingEnv<T>(
	env: Partial<Record<EnvKey, string>>,
	fn: (reports: () => Warning[]) => Promise<T>,
): Promise<T> {
	const snapshot: Partial<Record<EnvKey, string>> = {};
	for (const key of ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) snapshot[key] = value;
		delete process.env[key];
	}
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
	resetEmbeddingProviderForTests();

	const warnings: Warning[] = [];
	const warnSpy = spyOn(logger, "warn").mockImplementation(((message: string, meta?: Record<string, unknown>) => {
		warnings.push({ message, meta: meta ?? {} });
	}) as never);
	const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
	try {
		return await fn(() => warnings.filter(warning => warning.message.includes("Memory embedding failed")));
	} finally {
		debugSpy.mockRestore();
		warnSpy.mockRestore();
		for (const key of ENV_KEYS) {
			const value = snapshot[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetEmbeddingProviderForTests();
	}
}

afterEach(() => {
	resetEmbeddingProviderForTests();
});

describe("a local embedding model this build cannot load", () => {
	/**
	 * The regression. A real bad input: a plausible near-miss of a real model name, which is what a typo
	 * actually looks like. The caller still gets `null` so keyword-only search takes over; the report is
	 * the only thing separating this from embeddings being deliberately off.
	 */
	it("returns null and reports the loss", async () => {
		await withEmbeddingEnv({ MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.6" }, async reports => {
			expect(await embed(["remember this"])).toBeNull();
			expect(reports()).toHaveLength(1);
		});
	});

	/**
	 * The name the operator typed has to be IN the report. "Embedding failed" against a config file with
	 * one model line in it is not a diagnosis; the misspelled string next to the word "model" is.
	 */
	it("names the model that could not be resolved", async () => {
		await withEmbeddingEnv({ MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.6" }, async reports => {
			await embed(["remember this"]);

			const report = reports()[0];
			expect(String(report?.meta.cause)).toContain("BAAI/bge-small-en-v1.6");
			expect(String(report?.meta.target)).toContain("BAAI/bge-small-en-v1.6");
			expect(String(report?.meta.impact)).toContain("Semantic recall");
			expect(String(report?.meta.fix)).not.toBe("");
		});
	});

	/**
	 * The case the reporting must NOT be attached to. A model name this build DOES know takes the ordinary
	 * load path, and whatever happens there is that path's business — reporting here as well would fire on
	 * every healthy start and train the reader to ignore the line that matters above.
	 */
	it("stays quiet for a model name this build knows", async () => {
		await withEmbeddingEnv({ MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5" }, async reports => {
			await embed(["remember this"]);
			expect(reports()).toEqual([]);
		});
	});

	/**
	 * Explicitly disabling embeddings is not a misconfiguration and must stay silent, even with a model
	 * name that would otherwise be unresolvable. This is the case whose legitimate silence made the
	 * unresolvable-name silence look reasonable.
	 */
	it("stays quiet when embeddings are switched off", async () => {
		await withEmbeddingEnv(
			{ MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.6", MNEMOPI_NO_EMBEDDINGS: "1" },
			async reports => {
				expect(await embed(["remember this"])).toBeNull();
				expect(reports()).toEqual([]);
			},
		);
	});
});

describe("an API embedding model with no API key", () => {
	/**
	 * The second regression, and the one whose remedy text already existed. `embedApi` bailed before the
	 * request, so none of the branches that DO report could be reached.
	 */
	it("returns null and reports the missing credential", async () => {
		await withEmbeddingEnv(
			{
				MNEMOPI_EMBEDDING_MODEL: "openai/text-embedding-3-small",
				MNEMOPI_EMBEDDING_API_URL: "https://openrouter.ai/api/v1",
			},
			async reports => {
				expect(await embed(["remember this"])).toBeNull();

				const report = reports()[0];
				expect(reports()).toHaveLength(1);
				expect(String(report?.meta.cause)).toContain("API key");
				expect(String(report?.meta.target)).toContain("openrouter.ai");
				expect(String(report?.meta.impact)).toContain("Semantic recall");
			},
		);
	});

	/**
	 * A key that IS configured must take the request path, whatever the request then does. Reporting on a
	 * configured key would make the missing-key report meaningless.
	 */
	it("does not report a missing credential when one is configured", async () => {
		await withEmbeddingEnv(
			{
				MNEMOPI_EMBEDDING_MODEL: "openai/text-embedding-3-small",
				MNEMOPI_EMBEDDING_API_URL: "https://openrouter.ai/api/v1",
				MNEMOPI_EMBEDDING_API_KEY: "sk-configured",
			},
			async reports => {
				await embed(["remember this"]);
				for (const report of reports()) expect(String(report.meta.cause)).not.toContain("API key");
			},
		);
	});
});
