/**
 * Hashline conformance corpus (TS-SUITE-2 reference wiring). The vectors in
 * ./vectors are the language-neutral record of tokenizer/normalize behavior:
 * the future Rust port replays the SAME files through the runner spec in
 * docs/migration/conformance-format.md. This suite proves the TS oracle is
 * green against its own corpus, so any divergence a port shows is a port bug,
 * not corpus drift. A malformed or missing vector file fails loudly here —
 * a silently shrinking corpus must never look like a pass.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertConformance } from "@veyyon/utils";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../../src/normalize";
import { parseLid, splitHashlineLines } from "../../src/tokenizer";

const VECTOR_DIR = join(import.meta.dir, "vectors");

/** The public boundary the corpus targets. Adding a vector file for a
 * function not listed here is a loud runner error, never a skip. */
const BOUNDARY = {
	splitHashlineLines,
	parseLid,
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
};

describe("hashline conformance corpus", () => {
	test("every recorded vector replays exactly against the TS implementation", () => {
		const report = assertConformance(BOUNDARY, VECTOR_DIR);
		// Pin the corpus size so a vector file dropped from disk (or a rename
		// that orphans one) cannot silently pass as "fewer vectors, all green".
		// The corpus is generated: regenerate with
		// `bun scripts/record-conformance.ts hashline` and update these counts
		// in the same reviewed change (TS-SUITE-3).
		expect(report.files).toBe(6);
		expect(report.vectors).toBe(153);
	});
});
