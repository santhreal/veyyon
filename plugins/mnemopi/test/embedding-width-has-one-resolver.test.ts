/**
 * "How wide is a vector" has ONE answer, and it follows the runtime scope.
 *
 * WHY THIS SUITE EXISTS. Two resolvers answered that question and they resolved the
 * MODEL NAME differently. `core/embeddings.ts` picked the model from the active
 * `withMnemopiRuntimeOptions` scope first and the environment second, which is what
 * the embedder actually runs with. `config.embeddingDim()` read
 * `MNEMOPI_EMBEDDING_MODEL` alone and never saw that scope, and it is the one
 * `core/binary-vectors.ts` sized its packed vectors from. So a scope naming a model
 * of a different width had the embedder produce one width and the packer assume
 * another, with no check anywhere between them: the store filled with vectors whose
 * recorded width was a lie, and it surfaced as similarity scores quietly getting
 * worse rather than as an error.
 *
 * Both were frozen at MODULE LOAD as well, so a scope entered after the first import
 * could not have moved them even if they had agreed.
 *
 * `config.embeddingModel()` is the one resolver now, scope-then-environment, and
 * `binary-vectors` asks for the width at the moment of the call. These tests drive a
 * real scope and assert the two ends agree, because the defect was never visible in
 * either module read on its own.
 */
import { describe, expect, it } from "bun:test";
import { embeddingDim, embeddingDimFor, embeddingModel } from "@veyyon/mnemopi/config";
import {
	BinaryVectorStore,
	bytesPerVector,
	configuredEmbeddingDim,
	maximallyInformativeBinarization,
} from "@veyyon/mnemopi/core/binary-vectors";
import { withMnemopiRuntimeOptions } from "@veyyon/mnemopi/core/runtime-options";
import { useMnemopiTestEnv } from "./setup";

useMnemopiTestEnv();

/** A 1024-dimension model, deliberately not the 384-wide default. */
const WIDE_MODEL = "BAAI/bge-large-en-v1.5";
const WIDE_DIM = 1024;

/** A vector of `dim` positive components, which packs to all-ones. */
function vector(dim: number): number[] {
	return Array.from({ length: dim }, () => 1);
}

describe("the premise these tests rest on", () => {
	/**
	 * NON-VACUITY. Every assertion below distinguishes 1024 from the default width.
	 * If the default ever became 1024, or the table stopped listing this model, the
	 * suite would pass against the very divergence it exists to catch.
	 */
	it("compares a wide model against a narrower default", () => {
		expect(embeddingDimFor(WIDE_MODEL)).toBe(WIDE_DIM);
		expect(configuredEmbeddingDim()).toBeLessThan(WIDE_DIM);
	});
});

describe("a runtime scope naming a different embedding model", () => {
	/** The exact regression: the packer's width followed the environment, not the scope. */
	it("moves the width the vector packer sizes from", () => {
		withMnemopiRuntimeOptions({ embeddings: { model: WIDE_MODEL } }, () => {
			expect(configuredEmbeddingDim()).toBe(WIDE_DIM);
			expect(bytesPerVector()).toBe(WIDE_DIM / 8);
		});
	});

	/** And the model name itself, which is the value the two resolvers disagreed on. */
	it("moves the model name the one resolver reports", () => {
		const outside = embeddingModel();

		withMnemopiRuntimeOptions({ embeddings: { model: WIDE_MODEL } }, () => {
			expect(embeddingModel()).toBe(WIDE_MODEL);
		});

		expect(embeddingModel()).toBe(outside);
	});

	/**
	 * The two ends agree INSIDE the scope, which is the property that matters.
	 * `embeddingDim()` is what the embedder's expected width comes from and
	 * `bytesPerVector()` is what the store packs into; a store sized from one and
	 * filled from the other is the corruption this row was opened for.
	 */
	it("keeps the expected width and the packed width in agreement", () => {
		withMnemopiRuntimeOptions({ embeddings: { model: WIDE_MODEL } }, () => {
			const packed = maximallyInformativeBinarization(vector(embeddingDim()));

			expect(packed.length).toBe(bytesPerVector());
		});
	});

	/** The width is asked for, not frozen: leaving the scope puts it back. */
	it("restores the width when the scope ends", () => {
		const before = configuredEmbeddingDim();
		withMnemopiRuntimeOptions({ embeddings: { model: WIDE_MODEL } }, () => {
			expect(configuredEmbeddingDim()).toBe(WIDE_DIM);
		});

		expect(configuredEmbeddingDim()).toBe(before);
	});

	/** A scope that names no model leaves the environment's answer alone. */
	it("changes nothing when it names no model", () => {
		const before = configuredEmbeddingDim();

		withMnemopiRuntimeOptions({ embeddings: { disabled: false } }, () => {
			expect(configuredEmbeddingDim()).toBe(before);
		});
	});
});

describe("a store written under a scope", () => {
	/**
	 * A round trip at the wide width. The packer, the schema's recorded width and the
	 * search comparison all have to be the same number, and before the fix the first
	 * of those came from a different resolver than the model that produced the vector.
	 */
	it("stores and finds a wide vector at its own width", () => {
		withMnemopiRuntimeOptions({ embeddings: { model: WIDE_MODEL } }, () => {
			const store = new BinaryVectorStore();
			try {
				store.storeVector("wide", vector(WIDE_DIM));
				const [hit] = store.search(vector(WIDE_DIM), 1);

				expect(hit?.memory_id).toBe("wide");
				expect(hit?.distance).toBe(0);
				expect(hit?.score).toBe(1);
			} finally {
				store.close();
			}
		});
	});
});

describe("an embedding with no dimensions", () => {
	/**
	 * FAIL CLOSED. A zero-length embedding packs to an empty blob and records
	 * `original_dim = 0`; `search` then compares nothing against nothing, scores it
	 * `0`, and the row sits in the store forever without ever having held a vector.
	 * An embedder that failed and returned `[]` is the ordinary way to produce one,
	 * and nothing downstream said so.
	 */
	it("is refused rather than stored", () => {
		const store = new BinaryVectorStore();
		try {
			expect(() => store.storeVector("empty", [])).toThrow(/refusing to store an empty embedding for empty/);
		} finally {
			store.close();
		}
	});

	/** The refusal names the width the configuration expects, so it is actionable. */
	it("says what width was expected", () => {
		const store = new BinaryVectorStore();
		try {
			expect(() => store.storeVector("empty", [])).toThrow(new RegExp(`${configuredEmbeddingDim()} dimensions`));
		} finally {
			store.close();
		}
	});

	/** And nothing was written: a refusal that half-wrote would be worse than the bug. */
	it("leaves the store empty", () => {
		const store = new BinaryVectorStore();
		try {
			expect(() => store.storeVector("empty", [])).toThrow();

			expect(store.getStats().total_vectors).toBe(0);
		} finally {
			store.close();
		}
	});

	/** A one-dimension vector is not empty and is stored, so the guard is not over-broad. */
	it("does not refuse a one-dimension vector", () => {
		const store = new BinaryVectorStore();
		try {
			store.storeVector("narrow", [1]);

			expect(store.getStats().total_vectors).toBe(1);
		} finally {
			store.close();
		}
	});
});
