import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

	test("stamps whatever the constant says, at both sites, so neither duplicates the literal", async () => {
		// The lock, and the only test here that can fail TODAY if the fix is reverted. Every behavioral
		// assertion above still passes with a hardcoded `1` while the constant is 1; they only start
		// failing on the bump, which is far too late.
		//
		// So this one MOVES the constant instead of reading the generator's characters. `generate.ts`
		// reaches only `constants.ts` and `types.ts`, so a three-file copy with a different
		// `SUPPORTED_VERSION` is the whole generator running against a bumped format. A hardcoded
		// literal keeps emitting the old number and goes red here immediately; a rename, a reflow, or a
		// changed comment in the generator moves nothing.
		const bumped = SUPPORTED_VERSION + 41;
		const dir = await mkdtemp(join(tmpdir(), "argot-version-"));
		try {
			for (const name of ["generate.ts", "constants.ts", "types.ts"]) {
				await copyFile(join(import.meta.dir, "..", "src", name), join(dir, name));
			}
			const constantsPath = join(dir, "constants.ts");
			const patched = (await readFile(constantsPath, "utf8")).replace(
				/export const SUPPORTED_VERSION = \d+;/,
				`export const SUPPORTED_VERSION = ${bumped};`,
			);
			// If the substitution missed, every assertion below would compare the old number to itself
			// and pass while proving nothing.
			expect(patched).toContain(`export const SUPPORTED_VERSION = ${bumped};`);
			await writeFile(constantsPath, patched);

			// Runtime-selected by construction: the module under test is a patched copy at a temp path
			// that does not exist at author time, which is the entire mechanism. A static import would
			// load the unpatched generator and make the case vacuous.
			const bumpedGenerate = (await import(join(dir, "generate.ts"))) as {
				generateDictFromRepo: typeof generateDictFromRepo;
			};

			// The default-sigil branch, which builds its header one way...
			const plain = bumpedGenerate.generateDictFromRepo(FILES, { naming: "mnemonic" });
			expect(plain.toml).toContain(`version = ${bumped}`);
			expect(plain.vocab.version).toBe(bumped);

			// ...and the non-default-sigil branch, which builds it separately and held the second copy.
			const sigil = bumpedGenerate.generateDictFromRepo(FILES, { naming: "mnemonic", sigil: "@" });
			expect(sigil.toml).toContain(`version = ${bumped}`);
			expect(sigil.vocab.version).toBe(bumped);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
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
