/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. The compiled binary replaces `process.env.VEYYON_DOCS_EMBED` with the docs
 * index, a 1.4 MB string literal. `internal-urls/docs-index.ts` read it into a module-level
 * constant, and the interactive session loads that module, so every session held the string on its
 * heap for a `veyyon://` URL nobody resolved. JSC materializes a module's top-level constants when
 * the module loads and a function's constants on the function's first call, so the read now sits in
 * the function that builds the index.
 *
 * THE CLASS. Any placement of the read that runs when the module loads: a top-level `const`, a
 * top-level default, or an eager call to the index builder. The suite compiles the real module into a
 * bytecode binary with the real payload, as the release build does, and measures the heap.
 *
 * WHAT IT DOES NOT CATCH. A second large build-time define read at module level elsewhere; the
 * docs index is the only large one the binary build defines.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TempDir } from "@veyyon/utils";
import { buildDocsIndexPayload } from "../scripts/generate-docs-index";

const DOCS_INDEX = resolve(import.meta.dirname, "../src/internal-urls/docs-index.ts");

interface HeapSample {
	bytes: number;
	filenames: number;
}

let tempDir: TempDir;
let payloadLength: number;

function sample(mode: "idle" | "read"): HeapSample {
	return JSON.parse(
		execFileSync(join(tempDir.path(), "docs-embed-probe"), [mode], { encoding: "utf8" }),
	) as HeapSample;
}

beforeAll(async () => {
	tempDir = TempDir.createSync("@docs-embed-heap-");
	const entry = join(tempDir.path(), "entry.ts");
	writeFileSync(
		entry,
		`import { heapStats } from "bun:jsc";
import { getDocFilenames } from ${JSON.stringify(DOCS_INDEX)};
// Listing parses the file names and keeps the payload for a later body read; it inflates nothing.
const filenames = process.argv[2] === "read" ? getDocFilenames().length : 0;
Bun.gc(true);
const stats = heapStats();
console.log(JSON.stringify({ bytes: stats.heapSize + stats.extraMemorySize, filenames }));
`,
	);
	const payload = (await buildDocsIndexPayload()).payload;
	payloadLength = payload.length;
	const binary = join(tempDir.path(), "docs-embed-probe");
	const output = await Bun.build({
		entrypoints: [entry],
		define: { "process.env.VEYYON_DOCS_EMBED": JSON.stringify(payload) },
		format: "esm",
		bytecode: true,
		compile: { outfile: binary, autoloadBunfig: false, autoloadDotenv: false },
		throw: false,
	});
	if (!output.success) throw new Error(output.logs.map(log => log.message).join("\n"));
}, 120_000);

afterAll(() => {
	tempDir?.removeSync();
});

describe("embedded docs index", () => {
	test("stays off the heap until a veyyon:// read, then holds every document", () => {
		const idle = sample("idle");
		const read = sample("read");
		expect(payloadLength).toBeGreaterThan(512 * 1024);
		expect(read.filenames).toBeGreaterThan(100);
		// The payload is Latin-1, one byte per character; a copy on the idle heap closes the gap.
		expect(read.bytes - idle.bytes).toBeGreaterThan(payloadLength * 0.9);
	});
});
