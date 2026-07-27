/**
 * The width of an embedding vector is decided by one table.
 *
 * WHY THIS EXISTS. `core/embeddings.ts` carried `MODEL_DIMS`, a byte-identical
 * seventeen-entry copy of `EMBEDDING_DIMS` in `config.ts`, and both were consulted to
 * size real vectors: `config.embeddingDim()` feeds `core/binary-vectors.ts`, which
 * derives `BYTES_PER_VECTOR` and packs vectors into sqlite, while
 * `embeddings.embeddingDimFor()` decides how wide the embedder's output is expected to
 * be. Two hardcoded tables that must agree are a defect waiting on the first person to
 * add a model to one of them: the store would pack a width the embedder does not
 * produce, and nothing in the system reports a width mismatch. It would surface as bad
 * similarity results, not as an error.
 *
 * The copy is gone. These tests hold the line in both directions: the two resolvers
 * agree for every listed model and for an unlisted one, and no second table may
 * reappear in the package source.
 *
 * WHAT THESE TESTS DO NOT CLAIM. The two resolvers still resolve the MODEL NAME
 * differently: `embeddingDimFor` is called with `DEFAULT_MODEL`, which consults the
 * active `withMnemopiRuntimeOptions` scope, and `config.embeddingDim()` reads only
 * `MNEMOPI_EMBEDDING_MODEL`. That divergence is real but latent, because no caller
 * sets a scope model today. It is filed as `EMBED-DIM-TWO-RESOLVERS` and is deliberately
 * out of scope here: unifying the tables is safe and removes the drift hazard, while
 * changing name resolution changes behavior on a live path.
 */

import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { EMBEDDING_DIMS, embeddingDim, FALLBACK_EMBEDDING_DIM } from "@veyyon/mnemopi/config";
import { embeddingDimFor } from "@veyyon/mnemopi/core/embeddings";

const SRC = path.join(import.meta.dir, "..", "src");

/** Every `.ts` file under `packages/mnemopi/src`. */
async function sourceFiles(dir: string = SRC): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(full);
	}
	return found;
}

describe("the two dimension resolvers agree", () => {
	/**
	 * THE regression. Both resolvers size the same vectors, so for every model the
	 * table names they must return the same number. When the tables were separate this
	 * passed by coincidence; now it passes by construction, and this test is what makes
	 * a future divergence fail immediately rather than corrupt a vector store.
	 */
	it("returns the same width for every listed model", () => {
		const models = Object.keys(EMBEDDING_DIMS);
		expect(models.length).toBeGreaterThan(10);

		for (const model of models) {
			expect(embeddingDimFor(model), `dimension for ${model}`).toBe(
				embeddingDim({ MNEMOPI_EMBEDDING_MODEL: model }),
			);
		}
	});

	/**
	 * The fallback has to be shared too, and it is the subtler half: an unlisted model
	 * is exactly the case where two hand-written `?? 384`s could drift apart, and it is
	 * the case a new model hits first.
	 */
	it("falls back to the same width for a model neither knows", () => {
		const unknown = "some-vendor/not-a-real-model-v9";
		expect(EMBEDDING_DIMS[unknown]).toBeUndefined();

		expect(embeddingDimFor(unknown)).toBe(FALLBACK_EMBEDDING_DIM);
		expect(embeddingDim({ MNEMOPI_EMBEDDING_MODEL: unknown })).toBe(FALLBACK_EMBEDDING_DIM);
	});

	/**
	 * The fallback is the default model's own width, so an unlisted model behaves like
	 * the default rather than producing a width nothing else in the system uses.
	 */
	it("the fallback is the default model's width", () => {
		expect(EMBEDDING_DIMS["BAAI/bge-small-en-v1.5"]).toBe(FALLBACK_EMBEDDING_DIM);
	});

	/**
	 * Real values, not just internal agreement: a test that only compared the two
	 * functions would still pass if the table were wrong everywhere at once.
	 */
	it("carries the published dimensions of the models it lists", () => {
		expect(EMBEDDING_DIMS["BAAI/bge-small-en-v1.5"]).toBe(384);
		expect(EMBEDDING_DIMS["BAAI/bge-base-en-v1.5"]).toBe(768);
		expect(EMBEDDING_DIMS["BAAI/bge-large-en-v1.5"]).toBe(1024);
		expect(EMBEDDING_DIMS["BAAI/bge-m3"]).toBe(1024);
		expect(EMBEDDING_DIMS["openai/text-embedding-3-small"]).toBe(1536);
		expect(EMBEDDING_DIMS["openai/text-embedding-3-large"]).toBe(3072);
		expect(EMBEDDING_DIMS["BAAI/bge-multilingual-gemma2"]).toBe(3584);
	});

	/**
	 * A model published under both a bare and a vendor-prefixed name must resolve
	 * identically, or the same model configured two ways packs two widths.
	 */
	it("resolves prefixed and bare OpenAI names to one width", () => {
		expect(embeddingDimFor("text-embedding-3-large")).toBe(embeddingDimFor("openai/text-embedding-3-large"));
		expect(embeddingDimFor("text-embedding-3-small")).toBe(embeddingDimFor("openai/text-embedding-3-small"));
	});
});

describe("the explicit override", () => {
	/**
	 * `MNEMOPI_EMBEDDING_DIM` beats the table in `config.embeddingDim`. Pinned because
	 * an operator who sets it has a store already written at that width, and a resolver
	 * that quietly preferred the table would mis-size every read.
	 */
	it("wins over the table", () => {
		expect(embeddingDim({ MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-large-en-v1.5", MNEMOPI_EMBEDDING_DIM: "77" })).toBe(77);
	});

	/** And a non-numeric value is ignored rather than yielding NaN as a vector width. */
	it("ignores a value that is not a number", () => {
		expect(embeddingDim({ MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-large-en-v1.5", MNEMOPI_EMBEDDING_DIM: "wide" })).toBe(
			1024,
		);
	});
});

describe("no second dimension table", () => {
	/**
	 * The structural lock. Agreement tests prove the two resolvers match TODAY; only a
	 * source lock stops a third copy from being pasted in tomorrow, which is exactly how
	 * `MODEL_DIMS` came to exist. Any object literal mapping a known model name to a
	 * number is a dimension table, wherever it is declared.
	 */
	it("only config.ts declares one", async () => {
		const files = await sourceFiles();
		// NON-VACUITY: the walk really read the package.
		expect(files.length).toBeGreaterThan(20);

		const offenders: string[] = [];
		for (const file of files) {
			const text = await readFile(file, "utf8");
			// A table is a literal binding the canonical model name to its width.
			if (!/"BAAI\/bge-small-en-v1\.5"\s*:\s*384/.test(text)) continue;
			const rel = path.relative(SRC, file);
			if (rel === "config.ts") continue;
			offenders.push(rel);
		}

		expect(offenders, "a second embedding-dimension table — import EMBEDDING_DIMS from ../config instead").toEqual(
			[],
		);
	});

	/**
	 * The lock above is only meaningful if the file it exempts still holds the table.
	 * An exemption for a file that stopped declaring one is a hole that opens quietly,
	 * ready to excuse a copy that lands at that path later.
	 */
	it("and config.ts really still holds it", async () => {
		const text = await readFile(path.join(SRC, "config.ts"), "utf8");

		expect(text).toMatch(/"BAAI\/bge-small-en-v1\.5"\s*:\s*384/);
		expect(Object.keys(EMBEDDING_DIMS).length).toBeGreaterThan(10);
	});
});
