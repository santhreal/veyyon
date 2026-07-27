/**
 * A local model's two names are paired in one place.
 *
 * WHY THIS EXISTS. Every model mnemopi can run locally answers to two names: the Hugging
 * Face repository you configure it by (`BAAI/bge-small-en-v1.5`) and the identifier
 * fastembed knows it as (`fast-bge-small-en-v1.5`). Both directions are needed, so both
 * were written out: `KNOWN_MODEL_NAMES` in `core/embeddings.ts` mapped repository to
 * identifier, and `FASTEMBED_HF_REPOS` in `core/fastembed-model-cache.ts` mapped
 * identifier back to repository. Seven entries each, exact inverses, two files, both
 * maintained by hand.
 *
 * WHAT WENT WRONG WHEN THEY DRIFTED. Adding a model to the first table alone made
 * `fastembedModelName` resolve it, and then `ensureFastembedModelSidecars` could not find
 * the repository to fetch its `config.json` and `tokenizer.json` from and returned
 * `false`, which the caller turns into the ORIGINAL initialisation error being rethrown.
 * So the symptom of a missing table row is a model that will not start, reported as
 * whatever fastembed happened to fail with, pointing nowhere near the table.
 *
 * Both directions are now derived from one list of pairs. These tests pin that they stay
 * exact inverses, that they carry real repository names rather than merely agreeing with
 * each other, and that no second table reappears in the package source.
 *
 * The default model name is the same class of duplicate and is covered here too:
 * `defaultModel()` in `core/embeddings.ts` spelled `"BAAI/bge-small-en-v1.5"` inline
 * rather than reading `DEFAULT_EMBEDDING_MODEL`, the constant `config.embeddingModel()`
 * uses, so the default had two homes.
 */

import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { DEFAULT_EMBEDDING_MODEL, embeddingModel } from "@veyyon/mnemopi/config";
import { currentEmbeddingModel } from "@veyyon/mnemopi/core/embeddings";
import {
	FASTEMBED_ID_BY_HF_REPO,
	HF_REPO_BY_FASTEMBED_ID,
} from "@veyyon/mnemopi/core/fastembed-model-cache";

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

describe("the two name directions are exact inverses", () => {
	/**
	 * NON-VACUITY. Both tables are derived, so a bug that produced two EMPTY objects
	 * would satisfy every round-trip assertion below. Pin the count first.
	 */
	it("cover the same models", () => {
		expect(Object.keys(FASTEMBED_ID_BY_HF_REPO).length).toBe(7);
		expect(Object.keys(HF_REPO_BY_FASTEMBED_ID).length).toBe(7);
	});

	/**
	 * THE regression, forward. Every repository resolves to an identifier that resolves
	 * back to the same repository. When the tables were separate this held by hand; now
	 * it holds by construction, and this test is what catches a future hand-written copy.
	 */
	it("round-trip from the repository name and back", () => {
		for (const [hfRepo, fastembedId] of Object.entries(FASTEMBED_ID_BY_HF_REPO)) {
			expect(HF_REPO_BY_FASTEMBED_ID[fastembedId], `${hfRepo} via ${fastembedId}`).toBe(hfRepo);
		}
	});

	/** And the same in reverse, which is the direction the sidecar download uses. */
	it("round-trip from the fastembed identifier and back", () => {
		for (const [fastembedId, hfRepo] of Object.entries(HF_REPO_BY_FASTEMBED_ID)) {
			expect(FASTEMBED_ID_BY_HF_REPO[hfRepo], `${fastembedId} via ${hfRepo}`).toBe(fastembedId);
		}
	});

	/**
	 * Real values, not just internal agreement: two derived tables built from one wrong
	 * list would round-trip perfectly and still name repositories that do not exist.
	 * These are the seven pairs as published.
	 */
	it("carry the published names of the models they list", () => {
		expect(FASTEMBED_ID_BY_HF_REPO["BAAI/bge-small-en-v1.5"]).toBe("fast-bge-small-en-v1.5");
		expect(FASTEMBED_ID_BY_HF_REPO["BAAI/bge-base-en-v1.5"]).toBe("fast-bge-base-en-v1.5");
		expect(FASTEMBED_ID_BY_HF_REPO["BAAI/bge-small-en"]).toBe("fast-bge-small-en");
		expect(FASTEMBED_ID_BY_HF_REPO["BAAI/bge-base-en"]).toBe("fast-bge-base-en");
		expect(FASTEMBED_ID_BY_HF_REPO["BAAI/bge-small-zh-v1.5"]).toBe("fast-bge-small-zh-v1.5");
		expect(FASTEMBED_ID_BY_HF_REPO["intfloat/multilingual-e5-large"]).toBe("fast-multilingual-e5-large");
		expect(FASTEMBED_ID_BY_HF_REPO["sentence-transformers/all-MiniLM-L6-v2"]).toBe("fast-all-MiniLM-L6-v2");
	});

	/**
	 * Every fastembed identifier begins with `fast-` and every repository is
	 * `owner/name`. Nothing enforces which column a new pair goes in, and a pair entered
	 * the wrong way round would round-trip cleanly while resolving to nonsense.
	 */
	it("keep the two columns the right way round", () => {
		for (const [hfRepo, fastembedId] of Object.entries(FASTEMBED_ID_BY_HF_REPO)) {
			expect(hfRepo, `${hfRepo} should be an owner/name repository`).toInclude("/");
			expect(fastembedId, `${fastembedId} should be a fastembed identifier`).toStartWith("fast-");
			expect(fastembedId).not.toInclude("/");
		}
	});

	/** A model nobody runs locally is absent from both, not mapped to something plausible. */
	it("do not resolve a model that has no local build", () => {
		expect(FASTEMBED_ID_BY_HF_REPO["openai/text-embedding-3-large"]).toBeUndefined();
		expect(HF_REPO_BY_FASTEMBED_ID["fast-not-a-real-model"]).toBeUndefined();
	});
});

describe("the default model has one home", () => {
	/**
	 * `defaultModel()` in `core/embeddings.ts` used to spell the default out as a bare
	 * string, so the model the embedder falls back to and the one `config` reports were
	 * two independent literals that only happened to match.
	 */
	it("is the same for the embedder and for config", () => {
		expect(currentEmbeddingModel()).toBe(DEFAULT_EMBEDDING_MODEL);
		expect(embeddingModel({})).toBe(DEFAULT_EMBEDDING_MODEL);
	});

	/** Its real value, so the shared constant cannot drift to something unshipped. */
	it("is the bundled fastembed model", () => {
		expect(DEFAULT_EMBEDDING_MODEL).toBe("BAAI/bge-small-en-v1.5");
	});

	/** And the default is one mnemopi can actually run locally, or nothing works offline. */
	it("has a local build", () => {
		expect(FASTEMBED_ID_BY_HF_REPO[DEFAULT_EMBEDDING_MODEL]).toBe("fast-bge-small-en-v1.5");
	});
});

describe("no second name table", () => {
	/**
	 * The structural lock. Round-trip tests prove the two directions agree TODAY; only a
	 * source lock stops a third hand-written copy from being pasted in tomorrow, which is
	 * exactly how `KNOWN_MODEL_NAMES` came to exist. Any literal binding a repository
	 * name to a fastembed identifier is a name table, wherever it is declared.
	 */
	it("only fastembed-model-cache.ts declares one", async () => {
		const files = await sourceFiles();
		// NON-VACUITY: the walk really read the package.
		expect(files.length).toBeGreaterThan(20);

		const offenders: string[] = [];
		for (const file of files) {
			const text = await readFile(file, "utf8");
			// The pairing on one line, however it is spelled: `"a": "b"`, `"a", "b"`, or a
			// record row naming both columns.
			if (!/"BAAI\/bge-small-en-v1\.5"[^\n]*"fast-bge-small-en-v1\.5"/.test(text)) continue;
			const rel = path.relative(SRC, file);
			if (rel === path.join("core", "fastembed-model-cache.ts")) continue;
			offenders.push(rel);
		}

		expect(
			offenders,
			"a second model-name table — import FASTEMBED_ID_BY_HF_REPO from ./fastembed-model-cache instead",
		).toEqual([]);
	});

	/**
	 * The lock above is only meaningful if the file it exempts still holds the table. An
	 * exemption for a file that stopped declaring one is a hole that opens quietly, ready
	 * to excuse a copy that lands at that path later.
	 */
	it("and fastembed-model-cache.ts really still holds it", async () => {
		const text = await readFile(path.join(SRC, "core", "fastembed-model-cache.ts"), "utf8");

		expect(text).toMatch(/"BAAI\/bge-small-en-v1\.5"[^\n]*"fast-bge-small-en-v1\.5"/);
	});

	/**
	 * The default model name is locked the same way: it may be spelled once, in
	 * `config.ts`, and read from there everywhere else.
	 */
	it("only config.ts spells the default model name", async () => {
		const files = await sourceFiles();
		const offenders: string[] = [];
		for (const file of files) {
			const text = await readFile(file, "utf8");
			const rel = path.relative(SRC, file);
			if (rel === "config.ts" || rel === path.join("core", "fastembed-model-cache.ts")) continue;
			// Code only: a mention inside a comment documents the constant, it does not
			// declare a second one.
			const code = text
				.split("\n")
				.filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
				.join("\n");
			if (code.includes('"BAAI/bge-small-en-v1.5"')) offenders.push(rel);
		}

		expect(offenders, "the default model name — import DEFAULT_EMBEDDING_MODEL from ../config instead").toEqual([]);
	});
});
