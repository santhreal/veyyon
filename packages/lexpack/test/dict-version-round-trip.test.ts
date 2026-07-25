import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_VERSION } from "../src/constants.js";
import { generateDictFromRepo } from "../src/generate.js";
import { parseDict } from "../src/parse.js";

/**
 * CACHE-5: the dictionary format version must survive a bump.
 *
 * The loader refuses a file whose `version` is newer than it understands, and
 * that single rule is the entire forward-compatibility story: an old build
 * reading a newer build's cache entry fails loudly with "upgrade argot" instead
 * of misreading a format it does not know. Everything depends on the generator
 * writing the version it actually generated.
 *
 * It did not. `generate.ts` wrote the literal `version = 1` in two places while
 * the loader compared against `SUPPORTED_VERSION`, so the day that constant
 * moved to 2 the generator would have gone on stamping every new entry as
 * version 1. Old builds would then happily read v2 content believing it was v1,
 * which is precisely the silent misread the guard exists to prevent, and it
 * would have shipped without a single test failing.
 *
 * These tests bind the two together. They deliberately assert against the
 * CONSTANT rather than the number 1, so they keep testing the real contract
 * after a bump instead of pinning today's value forever.
 *
 * Note on what is NOT invalidated: a NEWER build reading an OLDER entry is
 * accepted on purpose. Handles already written into live transcripts must keep
 * meaning what they meant, so entries are not discarded on upgrade. Only the
 * unreadable direction fails. See the corrupt-entry suite for the same reasoning
 * applied to damaged files.
 */
describe("the generated dictionary declares the version the loader expects", () => {
	const FILES = [{ path: "src/routes/index.ts" }, { path: "src/database/connection.ts" }];

	test("the generated TOML stamps SUPPORTED_VERSION, not a hardcoded number", () => {
		const { toml } = generateDictFromRepo(FILES, { naming: "mnemonic" });

		expect(toml).toContain(`version = ${SUPPORTED_VERSION}`);
	});

	test("the in-memory vocabulary declares the same version as the TOML it serializes to", () => {
		// The second half of the same bug. `generateDict` built its returned
		// Vocabulary with a literal `version: 1` while writing the TOML from the
		// constant, so after a bump the object and the file it produced would have
		// disagreed about what format the caller was holding.
		const { vocab, toml } = generateDictFromRepo(FILES, { naming: "mnemonic" });

		expect(vocab.version).toBe(SUPPORTED_VERSION);
		expect(parseDict(toml, "generated.dict").version).toBe(vocab.version);
	});

	test("generated output round-trips through the parser with identical handles", () => {
		// The end-to-end statement of the contract: whatever the generator writes,
		// this build's own loader must accept, and must read back as the same
		// vocabulary. A mismatch between the two is exactly the bug this suite was
		// written for.
		const { toml, vocab } = generateDictFromRepo(FILES, { naming: "mnemonic" });

		const parsed = parseDict(toml, "generated.dict");

		expect(parsed.version).toBe(SUPPORTED_VERSION);
		expect(parsed.sigil).toBe(vocab.sigil);
		expect([...parsed.handles.entries()].sort()).toEqual([...vocab.handles.entries()].sort());
		// Not merely "equal to itself": the corpus really does mint handles, so an
		// empty-in/empty-out round trip cannot make the comparison above vacuous.
		expect(parsed.handles.size).toBeGreaterThan(0);
		expect([...parsed.handles.values()].sort()).toEqual(["src/database/connection.ts", "src/routes/index.ts"]);
	});

	test("a non-default sigil still stamps the version from the constant", () => {
		// The second hardcoded site lived on this branch, so it needs its own test:
		// the sigil path built its header string separately and would have kept the
		// literal after the other one was fixed.
		const { toml } = generateDictFromRepo(FILES, { naming: "mnemonic", sigil: "@" });

		expect(toml).toContain(`version = ${SUPPORTED_VERSION}`);
		expect(parseDict(toml, "generated.dict").version).toBe(SUPPORTED_VERSION);
	});

	test("the generator hardcodes no version literal any more", () => {
		// The lock, and the only test here that can fail TODAY if the fix is reverted.
		// Every behavioral assertion above still passes with a hardcoded `1` while the
		// constant is 1; they only start failing on the bump, which is far too late.
		// This one fails immediately.
		const generate = readFileSync(join(import.meta.dir, "..", "src", "generate.ts"), "utf8");

		// Both spellings the bug appeared in: the emitted TOML line and the object
		// literal on the returned Vocabulary.
		expect(generate).not.toMatch(/version\s*=\s*\d/);
		expect(generate).not.toMatch(/version\s*:\s*\d/);
		expect(generate).toContain("version = ${SUPPORTED_VERSION}");
		expect(generate).toContain("version: SUPPORTED_VERSION");
	});

	test("a file targeting a NEWER version is refused with an upgrade hint", () => {
		// The direction that must stay loud, stated in terms of the constant so it
		// keeps meaning "newer than this build" after a bump.
		const future = `version = ${SUPPORTED_VERSION + 1}\n\n[handles]\nrou = "src/routes"\n`;

		expect(() => parseDict(future, "future.dict")).toThrow(/upgrade argot/);
	});

	test("a file targeting the CURRENT version is accepted", () => {
		// The control, without which the refusal above could pass by everything being
		// rejected.
		const current = `version = ${SUPPORTED_VERSION}\n\n[handles]\nrou = "src/routes"\n`;

		expect(parseDict(current, "current.dict").version).toBe(SUPPORTED_VERSION);
	});
});
