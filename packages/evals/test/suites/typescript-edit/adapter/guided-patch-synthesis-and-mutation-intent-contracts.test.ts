/**
 * WHY:
 * Guided runs and no-change hints depend on exact hashline patch syntax generation
 * and accurate diff comparisons against original fixtures.
 *
 * This suite verifies:
 * 1. buildGuidedHashlinePatch generates valid hashline patches with file headers and ops.
 * 2. buildMutationPreviewAgainstOriginal produces standard line diffs with line numbering.
 * 3. appendNoChangeMutationHint appends helpful previews when a no-change error occurs.
 * 4. evaluateMutationIntent validates target line replacements against metadata snippets.
 *
 * What this does not catch:
 * Upstream AST parsing quirks in third-party linters.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import {
	appendNoChangeMutationHint,
	buildGuidedHashlinePatch,
	buildMutationPreviewAgainstOriginal,
	evaluateMutationIntent,
} from "../../../../suites/typescript-edit/runner/guided";
import type { EditTask } from "../../../../suites/typescript-edit/tasks";

describe("guided hashline patch generation", () => {
	it("returns null when actual matches expected", () => {
		const text = "const a = 1;\nconst b = 2;\n";
		expect(buildGuidedHashlinePatch("foo.ts", text, text)).toBeNull();
	});

	it("generates replacement ops with section header for modified lines", () => {
		const actual = "const a = 1;\nconst b = 2;\n";
		const expected = "const a = 1;\nconst b = 99;\n";
		const patch = buildGuidedHashlinePatch("foo.ts", actual, expected);
		expect(patch).not.toBeNull();
		if (!patch) throw new Error("patch must not be null");
		expect(patch).toContain("foo.ts#");
		expect(patch).toContain("2:\nconst b = 99;");
	});

	it("generates BOF insertion for additions at the beginning of the file", () => {
		const actual = "const b = 2;\n";
		const expected = "const a = 1;\nconst b = 2;\n";
		const patch = buildGuidedHashlinePatch("foo.ts", actual, expected);
		expect(patch).not.toBeNull();
		if (!patch) throw new Error("patch must not be null");
		expect(patch).toContain("BOF↓\nconst a = 1;");
	});

	it("generates deletion ops with exclamation syntax", () => {
		const actual = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
		const expected = "const a = 1;\nconst c = 3;\n";
		const patch = buildGuidedHashlinePatch("foo.ts", actual, expected);
		expect(patch).not.toBeNull();
		if (!patch) throw new Error("patch must not be null");
		expect(patch).toContain("2!");
	});
});

describe("mutation preview against original", () => {
	it("formats line-numbered removed and added lines", () => {
		const original = "function add(a, b) {\n  return a + b;\n}\n";
		const current = "function add(a, b) {\n  return a - b;\n}\n";
		const preview = buildMutationPreviewAgainstOriginal(original, current);
		expect(preview).not.toBeNull();
		expect(preview).toContain("-2:  return a + b;");
		expect(preview).toContain("+2:  return a - b;");
	});

	it("returns null when current matches original", () => {
		const text = "export const x = 1;\n";
		expect(buildMutationPreviewAgainstOriginal(text, text)).toBeNull();
	});
});

describe("no-change mutation hint and mutation intent evaluation", () => {
	it("appends diff preview to No changes made error", async () => {
		const temp = await TempDir.create("hint-test-");
		try {
			const filePath = path.join(temp.path(), "src", "index.ts");
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, "const val = 100;\n");

			const originalFiles = new Map<string, string>();
			originalFiles.set(filePath, "const val = 0;\n");

			const rawError = "No changes made to target file";
			const hinted = await appendNoChangeMutationHint(
				rawError,
				{ path: filePath, input: "patch" },
				temp.path(),
				originalFiles,
			);
			expect(hinted).toContain("No changes made");
			expect(hinted).toContain("-1:const val = 0;");
			expect(hinted).toContain("+1:const val = 100;");
		} finally {
			await temp.remove();
		}
	});

	it("evaluates mutation intent against task metadata and target files", async () => {
		const temp = await TempDir.create("intent-test-");
		try {
			const expectedDir = path.join(temp.path(), "expected");
			const cwd = path.join(temp.path(), "cwd");
			await fs.mkdir(expectedDir, { recursive: true });
			await fs.mkdir(cwd, { recursive: true });

			await fs.writeFile(path.join(expectedDir, "test.ts"), "const target = true;\n");
			await fs.writeFile(path.join(cwd, "test.ts"), "const target = true;\n");

			const task: EditTask = {
				id: "intent_task",
				name: "Intent Task",
				prompt: "Fix target",
				files: ["test.ts"],
				inputDir: cwd,
				expectedDir,
				metadata: {
					fileName: "test.ts",
					lineNumber: 1,
					mutationType: "boolean_flip",
					originalSnippet: "true",
					mutatedSnippet: "false",
				},
			};

			const intent = await evaluateMutationIntent(task, cwd, expectedDir);
			expect(intent).not.toBeNull();
			expect(intent?.matched).toBe(true);
			expect(intent?.reason).toContain("Target line exactly matches expected fixture");
		} finally {
			await temp.remove();
		}
	});
});
