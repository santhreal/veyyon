/**
 * An embedding is packed at its own width, not at the configured default's.
 *
 * THE BUG. `maximallyInformativeBinarization` capped at `EMBEDDING_DIM`, a
 * module-load constant derived from `config.embeddingDim()`, which maps the configured
 * model name through a seventeen-entry table and falls back to 384 for anything it does
 * not list. Configure any unlisted model, which is every new jina/voyage/cohere release
 * and every local model, and each vector was cut to its first 384 dimensions. A
 * 1536-dimension model kept a quarter of its signal.
 *
 * WHY IT WAS INVISIBLE. Nothing threw and nothing logged: `Math.min` is not an error
 * path. `storeVector` then recorded `original_dim` as the CAPPED value, so the database
 * could not tell a genuine 384-dimension model from a wide one that had been cut down,
 * and `search` clamped to the same constant again on read. The only symptom was recall
 * quietly getting worse, with no signal pointing at the cause. The existing suite did
 * not catch it because every test used a vector at or below the default width, which is
 * exactly the case the cap does not affect.
 *
 * WHY REMOVING THE CAP IS SAFE RATHER THAN A NEW FORMAT. The schema already stores
 * `original_dim` per row and `search` already compares at `min(queryDim, storedDim)`,
 * so rows of differing widths were always supported. The cap was an assumption that
 * every embedding is exactly the configured width, not a storage budget. Narrow rows
 * written before this change keep working at the width they recorded, which the
 * mixed-width case below pins.
 */

import { describe, expect, it } from "bun:test";
import {
	BinaryVectorStore,
	EMBEDDING_DIM,
	hammingDistance,
	maximallyInformativeBinarization,
} from "@veyyon/mnemopi/core/binary-vectors";
import { useMnemopiTestEnv } from "./setup";

useMnemopiTestEnv();

describe("the premise these tests rest on", () => {
	/**
	 * NON-VACUITY. Every number below is chosen because 1536 is wider than the
	 * configured default and 1200 sits past it. If the test environment ever set
	 * `MNEMOPI_EMBEDDING_DIM` (or defaulted to a wide model), the old truncating code
	 * would not have truncated these vectors either, and this whole suite would pass
	 * against the bug it exists to catch. Pinning the premise makes that failure loud
	 * instead of silent.
	 */
	it("runs against the narrow default width the bug depended on", () => {
		expect(EMBEDDING_DIM).toBe(384);
	});
});

/** A vector of `dim` dimensions whose every component is positive. */
function allPositive(dim: number): number[] {
	return Array.from({ length: dim }, () => 1);
}

/** `allPositive`, but with the component at `index` flipped negative. */
function positiveExcept(dim: number, index: number): number[] {
	const out = allPositive(dim);
	out[index] = -1;
	return out;
}

describe("packing a vector wider than the configured default", () => {
	/**
	 * THE regression, stated in bytes. 1536 dimensions is one bit each, so 192 bytes.
	 * Before the fix this produced 48 bytes: the first 384 dimensions and nothing else.
	 */
	it("keeps every dimension of a 1536-dimension embedding", () => {
		const packed = maximallyInformativeBinarization(allPositive(1536));

		expect(packed.length).toBe(192);
	});

	/**
	 * The bytes are not merely present, they carry the right bits. A cap that kept the
	 * length but zero-filled the tail would pass the length assertion above.
	 */
	it("sets a bit for every positive dimension, past the old cutoff", () => {
		const packed = maximallyInformativeBinarization(allPositive(1536));

		expect(Array.from(packed).every(byte => byte === 0xff)).toBe(true);
	});

	/**
	 * A dimension beyond the old 384 cutoff must change the packing. This is the
	 * assertion that fails loudest against the truncating version: with the cap, a flip
	 * at dimension 1000 produced byte-identical output to no flip at all, so two
	 * genuinely different memories were indistinguishable.
	 */
	it("a dimension past the old cutoff still affects the result", () => {
		const unflipped = maximallyInformativeBinarization(allPositive(1536));
		const flipped = maximallyInformativeBinarization(positiveExcept(1536, 1000));

		expect(hammingDistance(unflipped, flipped)).toBe(1);
	});

	/** And a flip below the cutoff behaves as it always did. */
	it("a dimension before the old cutoff still affects the result", () => {
		const unflipped = maximallyInformativeBinarization(allPositive(1536));
		const flipped = maximallyInformativeBinarization(positiveExcept(1536, 12));

		expect(hammingDistance(unflipped, flipped)).toBe(1);
	});

	/** The narrow case is unchanged: a short vector still packs short. */
	it("a vector narrower than the default packs at its own width", () => {
		expect(maximallyInformativeBinarization(allPositive(64)).length).toBe(8);
		expect(maximallyInformativeBinarization([]).length).toBe(0);
	});
});

describe("the width a row records", () => {
	/**
	 * `original_dim` is the row's TRUE width. Recording the capped number made the
	 * truncation unrecoverable: nothing downstream could tell that the vector had been
	 * cut, so no migration could ever repair it.
	 */
	it("stores the embedding's real dimension", () => {
		const store = new BinaryVectorStore();
		store.storeVector("wide", allPositive(1536));

		const row = store.conn.query("SELECT original_dim FROM binary_vectors WHERE memory_id = ?").get("wide") as {
			original_dim: number;
		};

		expect(row.original_dim).toBe(1536);
	});

	/** The blob written is the full-width packing, not a capped prefix. */
	it("stores the full-width blob", () => {
		const store = new BinaryVectorStore();
		store.storeVector("wide", allPositive(1536));

		const row = store.conn.query("SELECT binary_vector FROM binary_vectors WHERE memory_id = ?").get("wide") as {
			binary_vector: Uint8Array;
		};

		expect(row.binary_vector.length).toBe(192);
	});
});

describe("searching a store of wide vectors", () => {
	/**
	 * End to end: an exact match must score as an exact match at full width. With the
	 * cap, the query and the row agreed only on their first 384 dimensions, so any two
	 * memories sharing a prefix were reported identical.
	 */
	it("ranks the exact match first and at zero distance", () => {
		const store = new BinaryVectorStore();
		store.storeVector("same", allPositive(1536));
		store.storeVector("differs-late", positiveExcept(1536, 1200));

		const results = store.search(allPositive(1536), 2);

		expect(results[0]?.memory_id).toBe("same");
		expect(results[0]?.distance).toBe(0);
	});

	/**
	 * THE discrimination the truncation destroyed. Two rows differing only past
	 * dimension 384 were indistinguishable before; now they are ordered correctly.
	 */
	it("separates rows that differ only past the old cutoff", () => {
		const store = new BinaryVectorStore();
		store.storeVector("same", allPositive(1536));
		store.storeVector("differs-late", positiveExcept(1536, 1200));

		const results = store.search(allPositive(1536), 2);
		const late = results.find(row => row.memory_id === "differs-late");

		expect(late?.distance).toBe(1);
	});

	/**
	 * BACKWARD COMPATIBILITY, the property that makes removing the cap safe on an
	 * existing database. A narrow row written earlier is compared at its own recorded
	 * width against a wide query, not clamped to a module constant and not read past
	 * its end.
	 */
	it("still compares a narrow row written earlier", () => {
		const store = new BinaryVectorStore();
		store.storeVector("narrow", allPositive(128));
		store.storeVector("wide", allPositive(1536));

		const results = store.search(allPositive(1536), 2);
		const narrow = results.find(row => row.memory_id === "narrow");

		expect(narrow).toBeDefined();
		expect(narrow?.distance).toBe(0);
	});

	/** A query narrower than the stored rows is the same case in reverse. */
	it("compares a wide row against a narrow query at the query's width", () => {
		const store = new BinaryVectorStore();
		store.storeVector("wide", allPositive(1536));

		const results = store.search(allPositive(64), 1);

		expect(results[0]?.memory_id).toBe("wide");
		expect(results[0]?.distance).toBe(0);
	});
});
