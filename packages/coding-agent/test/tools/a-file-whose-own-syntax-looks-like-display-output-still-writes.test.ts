/**
 * A real file must not be rejected for resembling a display surface.
 *
 * WHY THIS SUITE EXISTS. The write tool writes whole files, so pasting `read` or
 * `grep` output into it silently corrupts the file with line numbers and match
 * markers. `assertValidWriteContent` therefore refuses content that carries a
 * display prefix. Each guard is a regex over one line, and a regex loose enough
 * to catch the display shape is loose enough to catch ordinary source that
 * happens to share it.
 *
 * That is not a theoretical cost. The search-prefix guard was
 * `/^\s*(?:\*\d+:|\s\d+:|>>>\s*\d+:)/`: the leading `\s*` let the one-space
 * context marker ` 43:code` match ANY indented numeric mapping key, so a
 * docker-compose `  80: http`, a Kubernetes container port and an nginx numeric
 * block were all rejected as pasted search output. The whole write failed, and
 * the message told the author to strip prefixes that were never there.
 *
 * The class this closes is both directions at once, because tightening a guard
 * is how the paste it was written for gets back in:
 *
 *   - REJECTED still holds for genuine display output from every surface the
 *     model sees: hashline headers and ops, unified diff hunks, apply-patch
 *     markers, read truncation notices, grep match and context lines, and a
 *     wholly line-numbered paste.
 *   - ACCEPTED holds for source files whose own syntax collides with those
 *     shapes: indented numeric keys, a dict literal keyed by port, a Markdown
 *     table of line numbers.
 *
 * Both tables are asserted through the real `WriteTool` against a real
 * filesystem, and an ACCEPTED case additionally asserts the bytes on disk are
 * exactly what was passed, since a guard that strips rather than refuses would
 * otherwise pass a test that only checks for the absence of an error.
 *
 * WHAT THIS SUITE DOES NOT CATCH. The guard regexes are module-private, so the
 * REJECTED table is a written list rather than a run-time sweep of them: adding
 * an eighth guard does not turn this suite red on its own. It is pinned instead
 * by exact equality on the set of refusal reasons the tool can produce, so a new
 * guard whose message reuses an existing reason is invisible here.
 *
 * Two rewrites of the search-prefix regex leave every case here green because
 * they are equivalent, not because they are missed: widening `[ ]` to `\s`, and
 * widening `(?! )` to `(?!\s)`. The negative lookahead carries the whole
 * discrimination, and the column anchor carries the rest — restoring a leading
 * `\s*` is refused by the compact-dict case.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { WriteTool } from "@veyyon/coding-agent/tools/fs/write";
import { removeWithRetries } from "@veyyon/utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

/** The distinct refusal reasons `assertValidWriteContent` can state. */
const REASONS = {
	hashlineHeader: "detected hashline section header",
	hashlineOp: "detected hashline patch operation",
	unifiedDiff: "detected unified diff hunk header",
	applyPatch: "detected patch marker",
	truncationNotice: "detected read tool truncation notice",
	searchPrefix: "detected search/read display prefix",
	linePrefix: "detected read tool line-number prefix",
} as const;

/** Genuine display output. Each must still be refused, for the stated reason. */
const REJECTED: Array<[name: string, content: string, reason: string]> = [
	["a hashline section header", "[src/foo.ts#1A2B]\nSWAP 1.=1:\n+x\n", REASONS.hashlineHeader],
	["a hashline op without its header", "SWAP 12.=14:\n+const x = 1;\n", REASONS.hashlineOp],
	["a hashline delete op", "DEL 4\n", REASONS.hashlineOp],
	["a unified diff hunk header", "@@ -1,4 +1,6 @@\n context\n+added\n", REASONS.unifiedDiff],
	["an apply-patch marker", "*** Update File: src/foo.ts\n@@\n-a\n+b\n", REASONS.applyPatch],
	["a read truncation notice", "[Showing lines 1-40 of 900. Use :41 to continue]\n", REASONS.truncationNotice],
	["a grep match line", "*42:if (user.id) {\nreturn user;\n", REASONS.searchPrefix],
	["a grep context line", " 43:return user;\nconst x = 1;\n", REASONS.searchPrefix],
	["a chevron search prefix", ">>> 12: match here\ncontent\n", REASONS.searchPrefix],
	["a wholly line-numbered paste", "1:export const a = 1;\n2:export const b = 2;\n", REASONS.linePrefix],
	// Prose opening `*42:` at column 0 is byte-identical to a grep match line.
	// There is nothing left to discriminate on, so it is refused, and the author
	// indents it or writes the file through the edit tool.
	["prose opening with a starred number", "# Notes\n\n*42:1 is the ratio.\n", REASONS.searchPrefix],
];

/**
 * Source whose own syntax collides with a display shape. Each must be written
 * through verbatim.
 */
const ACCEPTED: Array<[name: string, filename: string, content: string]> = [
	[
		"a docker-compose port mapping",
		"docker-compose.yml",
		"services:\n  web:\n    image: nginx\n    ports:\n      80: http\n      443: https\n",
	],
	[
		"a Kubernetes container port block",
		"deployment.yaml",
		"spec:\n  containers:\n    - name: api\n      ports:\n        8080: proxy\n        9090: metrics\n",
	],
	["a single-space indented numeric key", "ports.yml", "listen:\n 80: http\n 8443: alt\n"],
	["a tab-indented numeric key", "tabbed.yml", "listen:\n\t8080: proxy\n\t8081: admin\n"],
	["a dict literal keyed by port number", "ports.py", 'PORTS = {\n    80: "http",\n    443: "https",\n}\n'],
	[
		"a Markdown table quoting line numbers",
		"notes.md",
		"| line | text |\n| --- | --- |\n| 42: | the call site |\n| 43: | its caller |\n",
	],
	["a numeric key whose value is a bare literal", "weights.yml", "weights:\n  80: 1\n  443: 2\n"],
	[
		// Indented, and with NO space after the colon, so only the column anchor
		// separates it from a context line. Restoring a leading `\s*` refuses it.
		"a compact dict literal with no space after the colon",
		"compact.py",
		'PORTS = {\n    80:"http",\n    443:"https",\n}\n',
	],
];

describe("a file whose own syntax looks like display output still writes", () => {
	let tmpDir: string;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-display-guard-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it.each(ACCEPTED)("writes %s verbatim", async (_name, filename, content) => {
		const filePath = path.join(tmpDir, filename);
		const tool = new WriteTool(createSession(tmpDir));

		await tool.execute("call-1", { path: filePath, content });

		// Refusal is not the only failure: a guard that stripped the offending
		// prefix would leave a file that differs from what was passed.
		expect(await fs.readFile(filePath, "utf8")).toBe(content);
	});

	it.each(REJECTED)("still refuses %s", async (_name, content, reason) => {
		const filePath = path.join(tmpDir, "target.ts");
		const tool = new WriteTool(createSession(tmpDir));

		await expect(tool.execute("call-1", { path: filePath, content })).rejects.toThrow(reason);

		// A refused write leaves nothing behind.
		expect(fs.access(filePath)).rejects.toThrow();
	});

	it("states one of the known refusal reasons and no other", async () => {
		const tool = new WriteTool(createSession(tmpDir));
		const observed = new Set<string>();

		for (const [name, content] of REJECTED.map(([n, c]) => [n, c] as const)) {
			const filePath = path.join(tmpDir, "reason-probe.ts");
			let message = "";
			try {
				await tool.execute("call-1", { path: filePath, content });
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			const matched = Object.values(REASONS).filter(r => message.includes(r));
			expect(matched, `${name} stated: ${message}`).toHaveLength(1);
			observed.add(matched[0]!);
		}

		// Every declared reason is reachable, so a reason that stops firing —
		// because its guard was loosened away — turns this red.
		expect([...observed].sort()).toEqual(Object.values(REASONS).toSorted());
	});
});
