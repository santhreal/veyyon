/**
 * WHY:
 * A triage finding reported that `write` silently stripped prefixes from content
 * that resembled hashline patch markers or read-output line numbers before writing
 * the file to disk. Silently modifying content damages valid code-bearing content
 * (such as Markdown lists, diff fixtures, or files documenting patch formats) and
 * conceals accidental paste errors where a patch was sent to `write` instead of
 * `edit`.
 *
 * This suite closes the class of silent write mutation by asserting:
 * 1. Content carrying patch markers (hashline headers, hashline hunk ops, unified
 *    diff hunks, apply_patch markers) is rejected with a ToolError naming the
 *    detection, the line, and stating corrective action.
 * 2. Content carrying read/search output echoes (line numbers, search prefixes,
 *    truncation notices) is rejected with a ToolError.
 * 3. Legitimate content starting with punctuation characters (Markdown lists,
 *    TOML tables, INI sections, unary operators, comments, YAML mappings) is
 *    written byte-for-byte unchanged.
 * 4. Rejected writes leave existing target files on disk untouched.
 *
 * What this does not catch:
 * Out-of-band writes to the underlying filesystem performed outside the `write`
 * tool, or binary file corruption not detectable via text prefix analysis.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ToolError } from "@veyyon/coding-agent/tools/tool-errors";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { removeWithRetries } from "@veyyon/utils";

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

describe("write tool refuses patch body and preserves valid content", () => {
	let tmpDir: string;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-refusal-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	describe("refuses patch bodies and read output echoes", () => {
		const patchCases: Array<{ name: string; content: string; expectedMarker: string | RegExp }> = [
			{
				name: "hashline header with 4-hex tag",
				content: "[src/foo.ts#1A2B]\nSWAP 1.=2:\n+const a = 1;\n",
				expectedMarker: /detected hashline section header '\[src\/foo\.ts#1A2B\]' on line 1/,
			},
			{
				name: "hashline header with loose tag",
				content: "[src/foo.ts#loose-tag]\n1:const a = 1;\n",
				expectedMarker: /detected hashline section header '\[src\/foo\.ts#loose-tag\]' on line 1/,
			},
			{
				name: "hashline SWAP operation",
				content: "SWAP 1.=3:\n+const a = 1;\n+const b = 2;\n",
				expectedMarker: /detected hashline patch operation 'SWAP 1\.=3:' on line 1/,
			},
			{
				name: "hashline SWAP single line",
				content: "SWAP 5:\n+const x = 1;\n",
				expectedMarker: /detected hashline patch operation 'SWAP 5:' on line 1/,
			},
			{
				name: "hashline SWAP.BLK operation",
				content: "SWAP.BLK 10:\n+const block = true;\n",
				expectedMarker: /detected hashline patch operation 'SWAP\.BLK 10:' on line 1/,
			},
			{
				name: "hashline DEL range operation",
				content: "DEL 5.=10\n",
				expectedMarker: /detected hashline patch operation 'DEL 5\.=10' on line 1/,
			},
			{
				name: "hashline DEL single line",
				content: "DEL 5\n",
				expectedMarker: /detected hashline patch operation 'DEL 5' on line 1/,
			},
			{
				name: "hashline DEL.BLK operation",
				content: "DEL.BLK 12\n",
				expectedMarker: /detected hashline patch operation 'DEL\.BLK 12' on line 1/,
			},
			{
				name: "hashline INS.PRE operation",
				content: "INS.PRE 5:\n+const prepended = 1;\n",
				expectedMarker: /detected hashline patch operation 'INS\.PRE 5:' on line 1/,
			},
			{
				name: "hashline INS.POST operation",
				content: "INS.POST 10:\n+const appended = 2;\n",
				expectedMarker: /detected hashline patch operation 'INS\.POST 10:' on line 1/,
			},
			{
				name: "hashline INS.HEAD operation",
				content: "INS.HEAD:\n// File header\n",
				expectedMarker: /detected hashline patch operation 'INS\.HEAD:' on line 1/,
			},
			{
				name: "hashline INS.TAIL operation",
				content: "INS.TAIL:\n// File footer\n",
				expectedMarker: /detected hashline patch operation 'INS\.TAIL:' on line 1/,
			},
			{
				name: "hashline INS.BLK.POST operation",
				content: "INS.BLK.POST 8:\n+const sibling = true;\n",
				expectedMarker: /detected hashline patch operation 'INS\.BLK\.POST 8:' on line 1/,
			},
			{
				name: "hashline REM operation",
				content: "REM\n",
				expectedMarker: /detected hashline patch operation 'REM' on line 1/,
			},
			{
				name: "hashline MV operation",
				content: "MV src/dest.ts\n",
				expectedMarker: /detected hashline patch operation 'MV src\/dest\.ts' on line 1/,
			},
			{
				name: "unified diff hunk header",
				content: "@@ -1,5 +1,5 @@\n-const oldVal = 1;\n+const newVal = 2;\n",
				expectedMarker: /detected unified diff hunk header '@@ -1,5 \+1,5 @@' on line 1/,
			},
			{
				name: "apply_patch marker",
				content: "*** Update File: src/main.ts\n",
				expectedMarker: /detected patch marker '\*\*\* Update File: src\/main\.ts' on line 1/,
			},
			{
				name: "read tool truncation notice",
				content: "[Showing lines 1-10 of 50. Use :L11 to continue]\n",
				expectedMarker: /detected read tool truncation notice/,
			},
			{
				name: "grep search match prefix",
				content: "*42:const found = true;\n 43:return found;\n",
				expectedMarker: /detected search\/read display prefix/,
			},
			{
				name: "grep alternation prefix",
				content: ">>>1:echo line\n",
				expectedMarker: /detected search\/read display prefix/,
			},
			{
				name: "full-body read line-number echo",
				content: "1:const a = 1;\n2:const b = 2;\n3:const c = 3;\n",
				expectedMarker: /detected read tool line-number prefix '1:' on line 1/,
			},
		];

		for (const tc of patchCases) {
			it(`refuses ${tc.name} with descriptive error and corrective action`, async () => {
				const session = createSession(tmpDir);
				const tool = new WriteTool(session);

				let error: ToolError | undefined;
				try {
					await tool.execute("call-1", { path: "test-target.ts", content: tc.content });
				} catch (e) {
					if (e instanceof ToolError) {
						error = e;
					}
				}

				expect(error).toBeDefined();
				expect(error?.message).toMatch(tc.expectedMarker);
				expect(error?.message).toMatch(/The write tool writes whole files/);
				expect(error?.message).toMatch(/edit tool|[Pp]ass the (?:raw|complete) file content/);
			});
		}

		it("leaves target file untouched when write is rejected", async () => {
			const session = createSession(tmpDir);
			const tool = new WriteTool(session);
			const targetFile = path.join(tmpDir, "existing.ts");
			const originalContent = "const original = true;\n";
			await fs.writeFile(targetFile, originalContent, "utf8");

			let error: ToolError | undefined;
			try {
				await tool.execute("call-1", {
					path: "existing.ts",
					content: "[existing.ts#1A2B]\n1:const modified = true;\n",
				});
			} catch (e) {
				if (e instanceof ToolError) error = e;
			}

			expect(error).toBeDefined();
			const onDisk = await fs.readFile(targetFile, "utf8");
			expect(onDisk).toBe(originalContent);
		});
	});

	describe("writes legitimate lookalikes byte-for-byte unchanged", () => {
		const legitimateCases: Array<{ name: string; filename: string; content: string }> = [
			{
				name: "JS unary plus function IIFE",
				filename: "iife.js",
				content: "+function() {\n  return 42;\n}();\n",
			},
			{
				name: "CLI flags starting with minus",
				filename: "flags.txt",
				content: "--verbose\n--output=json\n--dry-run\n",
			},
			{
				name: "Markdown unordered list with plus",
				filename: "list-plus.md",
				content: "+ First item\n+ Second item\n+ Third item\n",
			},
			{
				name: "Markdown unordered list with minus",
				filename: "list-minus.md",
				content: "- Item A\n- Item B\n- Item C\n",
			},
			{
				name: "Markdown unordered list with asterisk",
				filename: "list-star.md",
				content: "* Item 1\n* Item 2\n* Item 3\n",
			},
			{
				name: "Markdown ordered list with dot",
				filename: "list-num.md",
				content: "1. Step one\n2. Step two\n3. Step three\n",
			},
			{
				name: "Markdown headings",
				filename: "doc.md",
				content: "# Title\n## Subtitle\n### Section\nContent here\n",
			},
			{
				name: "Shell script with shebang and comments",
				filename: "script.sh",
				content: '#!/bin/bash\n# Script to build\necho "building"\n',
			},
			{
				name: "TOML tables and dependencies",
				filename: "config.toml",
				content: '[package]\nname = "demo"\nversion = "1.0.0"\n\n[dependencies]\nfoo = "1.0"\n',
			},
			{
				name: "INI section configuration",
				filename: "server.ini",
				content: "[server]\nhost = 127.0.0.1\nport = 8080\n\n[database]\nname = main\n",
			},
			{
				name: "Systemd unit definition",
				filename: "demo.service",
				content: "[Unit]\nDescription=My Service\n\n[Service]\nExecStart=/usr/bin/demo\n",
			},
			{
				name: "JSON array with bracket start",
				filename: "data.json",
				content: '[\n  "alpha",\n  "beta",\n  "gamma"\n]\n',
			},
			{
				name: "YAML with numeric mapping keys",
				filename: "mapping.yaml",
				content: '1: "apple"\n2: "banana"\n3: "cherry"\n',
			},
			{
				name: "Code with arithmetic operators",
				filename: "calc.ts",
				content: "const a = +1;\nconst b = -2;\nconst c = a + b;\n",
			},
			{
				name: "C source with block comments and pointers",
				filename: "main.c",
				content: "/* Block comment */\n#include <stdio.h>\n\nint *ptr = NULL;\n",
			},
			{
				name: "Code containing SWAP, DEL, INS words in identifiers and comments",
				filename: "helpers.ts",
				content:
					"// SWAP two elements in array\nexport function swap(a: number, b: number): void {\n  const tmp = a;\n  const DEL = 10;\n  const INS_VAL = 20;\n}\n",
			},
			{
				name: "SQL queries with DELETE",
				filename: "queries.sql",
				content: "DELETE FROM users WHERE id = 1;\nSELECT * FROM users;\n",
			},
			{
				name: "Markdown doc containing patch syntax in backticks",
				filename: "patch-guide.md",
				content: "# Patch Guide\nUse `SWAP 1.=2:` to replace lines in hashline mode.\n",
			},
			{
				name: "Single line file with numeric prefix",
				filename: "single.txt",
				content: "1: single line value\n",
			},
			{
				name: "Empty file",
				filename: "empty.txt",
				content: "",
			},
		];

		for (const tc of legitimateCases) {
			it(`writes ${tc.name} byte-for-byte unchanged`, async () => {
				const session = createSession(tmpDir);
				const tool = new WriteTool(session);
				const targetFile = path.join(tmpDir, tc.filename);

				const result = await tool.execute("call-1", {
					path: tc.filename,
					content: tc.content,
				});

				expect(result.isError).toBeUndefined();
				const written = await fs.readFile(targetFile, "utf8");
				expect(written).toBe(tc.content);
			});
		}
	});
});
