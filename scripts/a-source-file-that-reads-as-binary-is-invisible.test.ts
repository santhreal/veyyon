/**
 * Every hand-written source file survives a text scan.
 *
 * WHAT WENT WRONG, TWICE. `crates/veyyon-text/src/lib.rs` carried two raw 0x00 bytes in a doc
 * comment, where the author meant to name the NUL byte and wrote the byte itself.
 * `packages/coding-agent/test/gallery-cli.test.ts` carried two raw 0x1b bytes in
 * `expect(...).toContain("<ESC>[")`, where `"\x1b["` was meant. Neither broke anything a build or a
 * test run can see: a NUL in a comment is whitespace to `rustc`, and a raw ESC in a string literal
 * is a perfectly good character to a JavaScript engine.
 *
 * WHY IT MATTERS ANYWAY. `rg` and `grep` classify a file containing a control byte as BINARY and
 * skip it. Those two files therefore dropped out of every repo-wide text scan without a word: `rg`
 * printed "binary file matches" instead of the matching lines, and `grep -c '#\[test\]'` returned
 * nothing at all, so a coverage survey reported the 2679-line text crate as having ZERO tests when
 * it had fifty-one. Every audit built on searching the tree silently excluded them. A file that
 * cannot be searched cannot be reviewed, and nothing in CI would ever have said so.
 *
 * WHAT THIS PINS. No source file under `packages/`, `crates/` or `scripts/` contains a control byte
 * that a text tool treats as a binary marker. Tab, newline and carriage return are ordinary source
 * bytes; everything else below 0x20, plus the 0x7f delete, is not. The rule is about the FILE and
 * not about string literals, because both real defects were places no linter looks: one in a
 * comment, one inside a string a formatter is happy to leave alone.
 *
 * The walk goes over the filesystem rather than `git ls-files`. Only `crates/vendor/**` is tracked
 * in this repository, so a git-based enumeration covers none of our own Rust crates, which is where
 * the first defect lived.
 *
 * Write the byte's NAME in prose ("NUL", "ESC", "0x1b") and an ESCAPE in code (`"\x1b["`, `'\0'`).
 * Both are ASCII text and neither trips the classifier.
 *
 * The Rust half of the same rule lives in
 * `crates/veyyon-shell/tests/a_source_file_that_reads_as_binary_is_invisible.rs`, because a cargo
 * test can fail a Rust developer's gate without a bun run. That one covers the `.rs` files under
 * `crates`; this one covers every source extension in every root, so the two overlap there on
 * purpose.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

/** Extensions this rule covers: source and source-adjacent text a human edits by hand. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".rs", ".py", ".sh"];

/** The trees walked. All three hold hand-written source; everything else at the root is output. */
const ROOTS = ["packages", "crates", "scripts"];

/**
 * Directory names that hold generated or foreign content, skipped wherever they appear.
 *
 * The rule is about source a human types here. Three kinds of content are legitimately outside it,
 * and all three really do contain control bytes:
 *
 * - Generated output. `docs/handbook/book` is mdBook OUTPUT whose minified highlight.js carries 0x7f,
 *   and `devin-gen` is protobuf codegen. Regenerating them is the only way to change them.
 * - Foreign code. `vendor` trees are read-only snapshots, and `repo-cache` is where deepswe-bench
 *   clones upstream repositories to run benchmarks against. Editing either is meaningless: the
 *   vendored copy is clobbered on re-vendor and the cache is re-cloned. Between them they account for
 *   every offender this rule found outside our own source, including test fixtures that contain raw
 *   0x1b on purpose because they are testing a terminal reporter.
 * - Build artefacts: `target`, `dist`, `build`, `node_modules`.
 *
 * Kept as an explicit, short list rather than a pattern, so adding to it is a decision a reader can
 * question, and capped by a test below so it cannot grow into a hole big enough to hide the rule. A
 * fixture of OURS that needs a control byte does not belong here: build it from escapes, which is
 * what all thirteen files this rule found were fixed to do.
 */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"target",
	"dist",
	"build",
	"vendor",
	"repo-cache",
	"devin-gen",
	"book",
]);

/** Every source file under the walked roots, as raw bytes. */
function trackedSources(): Array<{ file: string; bytes: Buffer }> {
	const found: Array<{ file: string; bytes: Buffer }> = [];
	for (const root of ROOTS) {
		collect(path.join(repoRoot, root), found);
	}
	return found;
}

function collect(dir: string, found: Array<{ file: string; bytes: Buffer }>): void {
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(dir, { withFileTypes: true }) as never;
	} catch {
		return;
	}
	for (const entry of entries as unknown as Array<{ name: string; isDirectory(): boolean }>) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) {
				collect(full, found);
			}
			continue;
		}
		if (!SOURCE_EXTENSIONS.some(extension => entry.name.endsWith(extension))) {
			continue;
		}
		try {
			found.push({ file: path.relative(repoRoot, full).replaceAll("\\", "/"), bytes: readFileSync(full) });
		} catch {
			// A path that is not readable right now (a symlink to nowhere, a file
			// another agent is mid-write on) is not this rule's business.
		}
	}
}

/**
 * The bytes a text tool reads as a binary marker.
 *
 * This is the classification `grep` and `rg` apply, which is what makes the rule worth having: the
 * set is not "characters I find ugly", it is the set that makes a file disappear from a search.
 */
function isBinaryMarker(byte: number): boolean {
	return (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f;
}

/** Report every offending byte as `line:0xNN`, with 1-based line numbers. */
function binaryMarkers(bytes: Uint8Array): string[] {
	const hits: string[] = [];
	let line = 1;
	for (const byte of bytes) {
		if (byte === 0x0a) {
			line += 1;
			continue;
		}
		if (isBinaryMarker(byte)) {
			hits.push(`${line}:0x${byte.toString(16).padStart(2, "0")}`);
		}
	}
	return hits;
}

describe("a source file that reads as binary is invisible", () => {
	/**
	 * THE RULE. The file count is asserted first: a scan that stopped finding files would otherwise
	 * pass by having nothing to check, which is the failure mode every source-scanning gate has, and
	 * this gate exists precisely because two files went missing from a scan.
	 */
	it("finds no control byte in any hand-written source file", () => {
		const sources = trackedSources();
		expect(sources.length).toBeGreaterThan(2000);

		const offenders = sources
			.map(({ file, bytes }) => ({ file, hits: binaryMarkers(bytes) }))
			.filter(({ hits }) => hits.length > 0)
			.map(({ file, hits }) => `${file} (${hits.join(", ")})`);

		expect(offenders).toEqual([]);
	});

	/**
	 * The two files that carried the defect are REACHED by this scan.
	 *
	 * Named explicitly, because "no file offends" is satisfied by a walker that never opens the ones
	 * that did. Both are also checked to be non-trivial in size, so a truncated read cannot pass.
	 */
	it("scans the two files that carried the defect", () => {
		const sources = trackedSources();
		for (const [name, minimumBytes] of [
			["crates/veyyon-text/src/lib.rs", 50_000],
			["packages/coding-agent/test/gallery-cli.test.ts", 1_000],
		] as const) {
			const found = sources.find(({ file }) => file === name);
			expect(found, `${name} must be part of the scan`).toBeDefined();
			expect(found?.bytes.length ?? 0).toBeGreaterThan(minimumBytes);
			expect(binaryMarkers(found?.bytes ?? new Uint8Array())).toEqual([]);
		}
	});

	/**
	 * Both real defects, reproduced: the detector finds them in a comment and in a string literal.
	 *
	 * The offending bytes are BUILT FROM ESCAPES rather than written out. A test for this rule that
	 * pasted the real bytes into its own fixtures would make itself unsearchable and would be caught
	 * by its own first assertion, so composing them keeps this file scannable alongside every other.
	 */
	it("reports a control byte from a comment and from a string literal", () => {
		const encode = (text: string) => new TextEncoder().encode(text);
		const NUL = "\u0000";
		const ESC = "\u001b";

		// The Rust defect: a NUL inside a doc comment.
		expect(binaryMarkers(encode(`/// a trailing \`${NUL}\`:\n`))).toEqual(["1:0x00"]);

		// The TypeScript defect: a raw ESC inside an assertion's expected string.
		expect(binaryMarkers(encode(`expect(x).toContain("${ESC}[");\n`))).toEqual(["1:0x1b"]);

		// Line numbers count newlines and are 1-based.
		expect(binaryMarkers(encode(`a\nb\nc ${NUL}\n`))).toEqual(["3:0x00"]);

		// Every marker is reported, not just the first, so one fix per line is visible.
		expect(binaryMarkers(encode(`${ESC} x ${ESC}\n`))).toEqual(["1:0x1b", "1:0x1b"]);
	});

	/**
	 * THE NEGATIVE HALF. The escaped forms are the CORRECT way to write these bytes and are what most
	 * of this repository already contains, so a rule that flagged them would be unusable. Tabs,
	 * newlines, carriage returns and non-ASCII text are all ordinary source.
	 */
	it("leaves escapes, whitespace controls and non-ASCII text alone", () => {
		const encode = (text: string) => new TextEncoder().encode(text);

		expect(binaryMarkers(encode(String.raw`expect(x).toContain("\x1b[");`))).toEqual([]);
		expect(binaryMarkers(encode(String.raw`let nul = '\0';`))).toEqual([]);
		expect(binaryMarkers(encode("function f() {\n\treturn 1;\r\n}\n"))).toEqual([]);
		expect(binaryMarkers(encode('const s = "héllo ☃ 🎉";\n'))).toEqual([]);
		expect(binaryMarkers(new Uint8Array())).toEqual([]);
	});

	/**
	 * The classifier's boundary as values rather than as an inference from the cases above: 0x00
	 * through 0x1f are markers except the three whitespace ones, 0x20 through 0x7e are not, 0x7f is,
	 * and everything above is UTF-8 that a text tool reads as text.
	 */
	it("classifies exactly the bytes a text tool rejects", () => {
		for (let byte = 0x00; byte <= 0x1f; byte += 1) {
			const allowed = byte === 0x09 || byte === 0x0a || byte === 0x0d;
			expect(isBinaryMarker(byte), `byte 0x${byte.toString(16)}`).toBe(!allowed);
		}
		for (let byte = 0x20; byte <= 0x7e; byte += 1) {
			expect(isBinaryMarker(byte), `printable 0x${byte.toString(16)}`).toBe(false);
		}
		expect(isBinaryMarker(0x7f)).toBe(true);
		for (const byte of [0x80, 0xc3, 0xe2, 0xf0, 0xff]) {
			expect(isBinaryMarker(byte), `high byte 0x${byte.toString(16)}`).toBe(false);
		}
	});

	/**
	 * The skip list cannot be widened into a hole big enough to hide the rule.
	 *
	 * A gate that scans nothing passes trivially, and the cheapest way to get there is to keep adding
	 * directory names until the offenders are all outside the walk. So the list is capped, and the
	 * names that would swallow whole source trees are asserted absent by name. `vendor` is the one
	 * entry that names foreign code; the rest are build output.
	 */
	it("keeps the skip list too small to hide the rule", () => {
		expect(SKIP_DIRS.size).toBeLessThanOrEqual(10);
		for (const name of ["src", "test", "tests", "packages", "crates", "scripts", "lib", "core"]) {
			expect(SKIP_DIRS.has(name), `skipping ${name} would gut the scan`).toBe(false);
		}
	});

	/**
	 * The walk reaches both languages and both roots, at depth.
	 *
	 * The count assertion above is satisfied by two thousand TypeScript files alone, so it does not
	 * prove `crates/` is covered. That mattered here: the first version of this gate enumerated with
	 * `git ls-files`, and because only `crates/vendor/**` is tracked, every one of our own Rust crates
	 * was outside the scan while the count still looked healthy. The file that started this whole rule
	 * is a `.rs` file, so a gate blind to Rust would have been decoration.
	 */
	it("reaches both roots and both languages", () => {
		const sources = trackedSources();
		const rust = sources.filter(({ file }) => file.endsWith(".rs"));
		const typescript = sources.filter(({ file }) => file.endsWith(".ts") || file.endsWith(".tsx"));

		// Floors, not exact counts, so adding a crate or a module does not fail this. They sit close
		// enough to the real numbers (139 Rust, 6352 TypeScript at the time of writing) that losing a
		// whole crate or a whole package tree from the walk trips them.
		expect(rust.length).toBeGreaterThan(120);
		expect(typescript.length).toBeGreaterThan(5000);
		expect(rust.filter(({ file }) => file.startsWith("crates/")).length).toBeGreaterThan(120);
		expect(sources.some(({ file }) => file.startsWith("packages/"))).toBe(true);
		expect(sources.some(({ file }) => file.startsWith("scripts/"))).toBe(true);

		// A `.rs` outside `crates/` is a test fixture rather than a compiled crate, and it is in scope
		// for exactly the same reason: a control byte in it would make the fixture unsearchable too.
		expect(rust.some(({ file }) => file.startsWith("packages/"))).toBe(true);

		// Nothing from a skipped tree slipped in, whatever depth it sits at.
		for (const skipped of SKIP_DIRS) {
			expect(
				sources.filter(({ file }) => file.split("/").includes(skipped)),
				`${skipped} must be skipped wherever it appears`,
			).toEqual([]);
		}
	});
});
