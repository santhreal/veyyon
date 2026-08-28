/**
 * WHY: the write tool and the hashline parser each declared a `BARE_LITERAL_VALUE_RE` deciding the
 * same question — is a uniformly `N:`-prefixed body a numeric-keyed dict/JSON/YAML mapping, or is it
 * content pasted out of `read` output? — and the two copies disagreed. The write tool accepted
 * `true`, `false` and `null` as mapping values; the hashline copy did not. Whichever layer a body
 * reached decided its fate, so a JSON body of keywords was written by one and mangled by the other.
 *
 * THE CLASS: one shape, two owners. Hashline is the single definition now, and this suite drives the
 * write tool over the whole value grammar rather than the value form somebody had in mind. The
 * expectation is DERIVED from the exported shape, not restated here, so a write tool that goes back
 * to its own copy turns this red on the first value the two disagree about.
 *
 * WHAT IT DOES NOT CATCH: the parser's own half of the agreement, which
 * `packages/hashline/test/one-reader-decides-what-a-bare-literal-row-looks-like.test.ts` covers, and
 * a body whose rows are not uniformly prefixed, which neither layer treats as a mapping.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ToolError } from "@veyyon/coding-agent/tools/tool-errors";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { BARE_LITERAL_VALUE_RE } from "@veyyon/hashline";
import { removeWithRetries } from "@veyyon/utils";

/** One value per grammar a numeric-keyed mapping can carry, plus the forms that are not literals. */
const CANDIDATE_VALUES: string[] = [
	'"one"',
	'""',
	"'one'",
	"42",
	"0",
	"-42",
	"+42",
	"3.5",
	"-0.5",
	"true",
	"false",
	"null",
	"const x = 1;",
	"return null;",
	"truent",
	"nullify",
	"falsey",
	'{ "a": 1 }',
	"[1, 2]",
	"1 + 1",
];

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated({
			"edit.mode": "hashline",
			"lsp.formatOnWrite": false,
			"lsp.diagnosticsOnWrite": false,
		}),
		enableLsp: false,
	};
}

describe("a numeric-keyed mapping is not a read paste", () => {
	let tmpDir: string;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-mapping-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it.each(CANDIDATE_VALUES)("agrees with the shared shape on a body of %p", async value => {
		const isMapping = BARE_LITERAL_VALUE_RE.test(`${value},`) && BARE_LITERAL_VALUE_RE.test(value);
		const content = `1: ${value},\n2: ${value},\n3: ${value}\n`;
		const target = path.join(tmpDir, "config.json");
		const tool = new WriteTool(createSession(tmpDir));

		let error: ToolError | undefined;
		try {
			await tool.execute("call-1", { path: "config.json", content });
		} catch (e) {
			if (e instanceof ToolError) error = e;
			else throw e;
		}

		if (isMapping) {
			expect(error, `a mapping of ${value} must be written, not refused`).toBeUndefined();
			expect(await fs.readFile(target, "utf8")).toBe(content);
			return;
		}
		expect(error, `a read paste of ${value} must be refused`).toBeDefined();
		expect(error?.message).toMatch(/detected read tool line-number prefix '1:' on line 1/);
		await expect(fs.readFile(target, "utf8")).rejects.toThrow();
	});

	it("refuses a body whose rows are prefixed but only some are literals", async () => {
		const tool = new WriteTool(createSession(tmpDir));
		await expect(
			tool.execute("call-1", { path: "config.json", content: '1: "one",\n2: const x = 1;\n' }),
		).rejects.toThrow(/detected read tool line-number prefix/);
	});
});
