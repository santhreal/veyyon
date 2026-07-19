import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DEFAULT_TAB_WIDTH, getEditorConfigFormatting, MAX_TAB_WIDTH, MIN_TAB_WIDTH } from "../src/tab-spacing";

// getEditorConfigFormatting resolves real `.editorconfig` files by walking the
// directory chain from the file up to a `root = true` marker, so every case
// needs an on-disk fixture. The module memoizes parsed configs by absolute
// path; each test gets its own mkdtemp dir so those caches never collide.

const created: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
	const base = await mkdtemp(path.join(tmpdir(), "tab-spacing-"));
	created.push(base);
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(base, rel);
		await mkdir(path.dirname(full), { recursive: true });
		await writeFile(full, content);
	}
	return base;
}

afterAll(async () => {
	await Promise.all(created.map(dir => rm(dir, { recursive: true, force: true })));
});

describe("width constants", () => {
	it("pins the documented clamp range and default", () => {
		expect(MIN_TAB_WIDTH).toBe(1);
		expect(MAX_TAB_WIDTH).toBe(16);
		expect(DEFAULT_TAB_WIDTH).toBe(3);
	});
});

describe("getEditorConfigFormatting — empty/guard cases", () => {
	it("returns {} for missing/blank file arguments", () => {
		expect(getEditorConfigFormatting(undefined)).toEqual({});
		expect(getEditorConfigFormatting(null)).toEqual({});
		expect(getEditorConfigFormatting("")).toEqual({});
	});

	it("returns {} when no .editorconfig exists in the chain", async () => {
		const dir = await fixture({ "code.ts": "x\n" });
		expect(getEditorConfigFormatting("code.ts", dir)).toEqual({});
	});

	it("returns {} for a path with an overlong component instead of throwing ENAMETOOLONG", async () => {
		const dir = await fixture({ ".editorconfig": "root = true\n[*]\nindent_size = 4\n" });
		const overlong = `${"a".repeat(300)}.ts`;
		expect(getEditorConfigFormatting(overlong, dir)).toEqual({});
	});
});

describe("getEditorConfigFormatting — indent style and size", () => {
	it("reads indent_style = space + indent_size", async () => {
		const dir = await fixture({ ".editorconfig": "root = true\n[*.ts]\nindent_style = space\nindent_size = 4\n" });
		expect(getEditorConfigFormatting("a.ts", dir)).toEqual({ tabSize: 4, insertSpaces: true });
	});

	it("reads indent_style = tab + tab_width", async () => {
		const dir = await fixture({ ".editorconfig": "root = true\n[*.ts]\nindent_style = tab\ntab_width = 8\n" });
		expect(getEditorConfigFormatting("a.ts", dir)).toEqual({ tabSize: 8, insertSpaces: false });
	});

	it("treats indent_size = tab as tab indentation (insertSpaces false)", async () => {
		const dir = await fixture({ ".editorconfig": "root = true\n[*.ts]\nindent_size = tab\ntab_width = 2\n" });
		expect(getEditorConfigFormatting("a.ts", dir)).toEqual({ tabSize: 2, insertSpaces: false });
	});

	it("infers space indentation when only indent_size = N is given (VSCode/Sublime behavior)", async () => {
		const dir = await fixture({ ".editorconfig": "root = true\n[*.ts]\nindent_size = 2\n" });
		expect(getEditorConfigFormatting("a.ts", dir)).toEqual({ tabSize: 2, insertSpaces: true });
	});

	it("prefers indent_size over tab_width for the resolved column width", async () => {
		const dir = await fixture({
			".editorconfig": "root = true\n[*.ts]\nindent_style = space\nindent_size = 2\ntab_width = 8\n",
		});
		expect(getEditorConfigFormatting("a.ts", dir)).toEqual({ tabSize: 2, insertSpaces: true });
	});
});

describe("getEditorConfigFormatting — value clamping and rejection", () => {
	it("clamps an oversized indent_size to MAX_TAB_WIDTH", async () => {
		const dir = await fixture({ ".editorconfig": "root = true\n[*.ts]\nindent_style = space\nindent_size = 999\n" });
		expect(getEditorConfigFormatting("a.ts", dir)).toEqual({ tabSize: MAX_TAB_WIDTH, insertSpaces: true });
	});

	it("ignores indent_size = 0 (treated as unset) so no tabSize is emitted", async () => {
		const dir = await fixture({ ".editorconfig": "root = true\n[*.ts]\nindent_style = space\nindent_size = 0\n" });
		expect(getEditorConfigFormatting("a.ts", dir)).toEqual({ insertSpaces: true });
	});

	it("ignores a non-numeric tab_width", async () => {
		const dir = await fixture({ ".editorconfig": "root = true\n[*.ts]\nindent_style = tab\ntab_width = wide\n" });
		expect(getEditorConfigFormatting("a.ts", dir)).toEqual({ insertSpaces: false });
	});
});

describe("getEditorConfigFormatting — section matching", () => {
	it("applies a section only to files whose name matches the glob", async () => {
		const dir = await fixture({
			".editorconfig": "root = true\n[*.py]\nindent_style = space\nindent_size = 4\n",
		});
		expect(getEditorConfigFormatting("a.ts", dir)).toEqual({});
		expect(getEditorConfigFormatting("a.py", dir)).toEqual({ tabSize: 4, insertSpaces: true });
	});

	it("matches a bare filename pattern recursively at any depth", async () => {
		const dir = await fixture({
			".editorconfig": "root = true\n[Makefile]\nindent_style = tab\ntab_width = 4\n",
			Makefile: "all:\n",
		});
		expect(getEditorConfigFormatting("Makefile", dir)).toEqual({ tabSize: 4, insertSpaces: false });
	});

	it("skips comment lines and honors a later section overriding an earlier one", async () => {
		const dir = await fixture({
			".editorconfig": [
				"root = true",
				"# global default",
				"[*]",
				"indent_style = space",
				"indent_size = 2",
				"; ts override",
				"[*.ts]",
				"indent_size = 4",
				"",
			].join("\n"),
		});
		// [*] sets 2-space; [*.ts] appears later and overrides indent_size to 4.
		expect(getEditorConfigFormatting("a.ts", dir)).toEqual({ tabSize: 4, insertSpaces: true });
		// A non-.ts file keeps the [*] default.
		expect(getEditorConfigFormatting("a.md", dir)).toEqual({ tabSize: 2, insertSpaces: true });
	});
});

describe("getEditorConfigFormatting — chain and root", () => {
	it("lets the closest .editorconfig override a parent in the chain", async () => {
		const dir = await fixture({
			".editorconfig": "root = true\n[*]\nindent_style = space\nindent_size = 2\n",
			"sub/.editorconfig": "[*]\nindent_style = space\nindent_size = 8\n",
			"sub/a.ts": "x\n",
		});
		// sub/a.ts sees root (2) then sub (8); the deeper config wins.
		expect(getEditorConfigFormatting(path.join("sub", "a.ts"), dir)).toEqual({ tabSize: 8, insertSpaces: true });
		// A sibling at the root keeps the root value.
		const dir2 = await fixture({ ".editorconfig": "root = true\n[*]\nindent_style = space\nindent_size = 2\n" });
		expect(getEditorConfigFormatting("a.ts", dir2)).toEqual({ tabSize: 2, insertSpaces: true });
	});
});
