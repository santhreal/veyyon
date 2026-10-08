/**
 * A context file in which no `@` import resolves comes back from `expandAtImports` as the string it
 * was given, so the heap holds its text once.
 *
 * WHY THIS SUITE EXISTS. `expand` split every file into fenced and unfenced segments and joined them
 * back whether or not anything was inlined. The join built a second flat string equal to the first,
 * and the session holds both for its lifetime: the discovery file cache holds the text it read, and
 * the loaded context entry holds the joined copy. For this repository's 48,191-character AGENTS.md
 * that was 94 KiB of duplicate heap in every session, measured by counting whole-text heap strings
 * after `loadProjectContextFilesWithWarnings`.
 *
 * THE CLASS, NOT THE INCIDENT. An `@` stays verbatim for six reasons: none is present, it sits in a
 * fenced block, in an inline code span or mid-token, the import names a missing file, it names a file
 * already on the include path, or the depth cap is reached. Each case below is one of them, every
 * fixture carries a fenced block so the text spans several segments, and each must leave exactly
 * one whole copy of its text on the heap. The resolving case is the control: an inlined import
 * builds a new string, so it must show two copies, which proves the probe sees a copy when one
 * exists rather than passing because it sees none.
 *
 * WHAT IT DOES NOT CATCH. Only whole-text copies are counted. Per-line and per-segment strings the
 * expansion allocates and drops are not observed, and a caller that copies the returned string is
 * not covered here.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@veyyon/utils";

interface ProbeCase {
	name: string;
	file: string;
	maxDepth?: number;
}

/** Lines that make the text UTF-16 and several segments long, shared by every fixture. */
const FILLER = `${"A rule — keep the session lean.\n".repeat(400)}\`\`\`sh\nbun run check\n\`\`\`\n`;

/** Each reason an `@` is left verbatim, as the body that follows the shared filler. */
const VERBATIM: Record<string, (self: string) => string> = {
	"no @ anywhere": () => "Nothing to import.\n",
	"an @ inside a fenced code block": () => "```sh\nnpm install @types/node\n```\n",
	"an @ inside an inline code span": () => "Run `cat @./present.md` by hand.\n",
	"an @ mid-token": () => "Mail admin@example.com or clone git@github.com:o/r.git.\n",
	"an import of a missing file": () => "See @./missing.md\n",
	"an import of the file itself": self => `See @./${self}\n`,
	"an import past the depth cap": () => "See @./present.md\n",
};

/**
 * Expands every case in a fresh process with both strings held, collects, and counts per case the
 * heap strings that are the case's whole text: a string node that starts with the case's marker
 * line and whose self size covers the input. The V8 snapshot truncates a node's name, not its size.
 */
const HEAP_PROBE = `
const fs = await import("node:fs");
const { expandAtImports } = await import("@veyyon/coding-agent/discovery/at-imports");
const cases = JSON.parse(process.env.PROBE_CASES);
const held = [];
for (const c of cases) {
	const input = fs.readFileSync(c.file, "utf8");
	const output = await expandAtImports(input, c.file, c.maxDepth === undefined ? {} : { maxDepth: c.maxDepth });
	held.push(input, output);
}
Bun.gc(true);
const snap = JSON.parse(Bun.generateHeapSnapshot("v8"));
const fields = snap.snapshot.meta.node_fields;
const stride = fields.length;
const typeAt = fields.indexOf("type");
const nameAt = fields.indexOf("name");
const sizeAt = fields.indexOf("self_size");
const stringType = snap.snapshot.meta.node_types[0].indexOf("string");
const copies = Object.fromEntries(cases.map(c => [c.name, 0]));
for (let i = 0; i < snap.nodes.length; i += stride) {
	if (snap.nodes[i + typeAt] !== stringType) continue;
	const value = snap.strings[snap.nodes[i + nameAt]];
	for (let k = 0; k < cases.length; k++) {
		if (value.startsWith("<!-- " + cases[k].name + " -->") && snap.nodes[i + sizeAt] >= held[2 * k].length) {
			copies[cases[k].name]++;
		}
	}
}
process.stdout.write(JSON.stringify(copies));
`;

describe("a context file with nothing to import is held once", () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-at-import-copies-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmp);
	});

	it("leaves one copy of the text for every reason an @ stays verbatim, and two when an import resolves", async () => {
		await fs.writeFile(path.join(tmp, "present.md"), "Imported rule.\n");
		const cases: ProbeCase[] = [];
		const write = async (name: string, body: (self: string) => string, maxDepth?: number): Promise<void> => {
			const self = `case-${cases.length}.md`;
			const file = path.join(tmp, self);
			await fs.writeFile(file, `<!-- ${name} -->\n${FILLER}${body(self)}`);
			cases.push({ name, file, maxDepth });
		};
		for (const [name, body] of Object.entries(VERBATIM)) {
			await write(name, body, name === "an import past the depth cap" ? 0 : undefined);
		}
		await write("an import that resolves", () => "See @./present.md\n");

		const probe = spawnSync(process.execPath, ["-e", HEAP_PROBE], {
			cwd: path.join(import.meta.dirname, "..", ".."),
			encoding: "utf8",
			env: { ...process.env, PROBE_CASES: JSON.stringify(cases) },
		});
		expect(probe.stderr).toBe("");
		expect(JSON.parse(probe.stdout)).toEqual({
			...Object.fromEntries(Object.keys(VERBATIM).map(name => [name, 1])),
			"an import that resolves": 2,
		});
	});
});
