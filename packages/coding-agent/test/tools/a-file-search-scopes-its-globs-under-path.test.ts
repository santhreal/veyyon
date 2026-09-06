// WHY: `path` scopes a text search and a structure search, and a file search
// rejected it outright ("does not accept: path"), so a model that used the
// same call shape it uses everywhere else paid a rejected call and a retry
// with the directory folded into `input` by hand. `path` on a file search is
// now the directory its `input` globs are searched under.
//
// The class this closes: the scope changing what an `input` entry means. Each
// entry keeps the meaning it has on its own — a leading glob stays recursive,
// a directory-prefixed glob keeps its depth, a bare `.` lists the scope — and
// the approval boundary reads the same scoped targets the call scans, so a
// scope cannot smuggle a scan past it. Inputs that have nowhere to be scoped
// (an absolute path, an internal URL) and a scope that is not a directory (a
// glob) are rejected with the spelling that works rather than searched as
// something else.
//
// What it does not catch: a scope or input with a top-level delimiter that
// names a real file, which the delimiter ladder in path-utils owns.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { SearchTool, type SearchToolInput, scopeFilePatterns } from "@veyyon/coding-agent/tools/search/search";
import { removeWithRetries } from "@veyyon/utils";

function createTestSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

/**
 * root.ts at the root, src/top.ts one level down, src/nested/deep.ts two down,
 * lib/other.ts outside the scope.
 */
async function withWorkspace<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-search-scope-"));
	try {
		await fs.mkdir(path.join(dir, "src", "nested"), { recursive: true });
		await fs.mkdir(path.join(dir, "lib"), { recursive: true });
		await fs.writeFile(path.join(dir, "root.ts"), "export const root = 1;\n");
		await fs.writeFile(path.join(dir, "src", "top.ts"), "export const top = 1;\n");
		await fs.writeFile(path.join(dir, "src", "nested", "deep.ts"), "export const deep = 1;\n");
		await fs.writeFile(path.join(dir, "src", "notes.md"), "notes\n");
		await fs.writeFile(path.join(dir, "lib", "other.ts"), "export const other = 1;\n");
		return await body(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

/** The files a search returns, as the tool lists them relative to the session cwd. */
async function searchFiles(cwd: string, args: SearchToolInput): Promise<string[]> {
	const tool = new SearchTool(createTestSession(cwd));
	const result = await tool.execute(`scope-${JSON.stringify(args)}`, args);
	if (result.details?.type !== "files") throw new Error("not a file search result");
	return [...(result.details.result.files ?? [])].sort();
}

describe("a file search scopes its globs under path", () => {
	it("keeps a leading glob recursive under the scope, and out of the scope's siblings", async () => {
		await withWorkspace(async dir => {
			// Negative control: with no scope the same glob reaches the root file
			// and the sibling directory.
			const unscoped = await searchFiles(dir, { type: "files", input: "*.ts" });
			expect(unscoped).toEqual(["lib/other.ts", "root.ts", "src/nested/deep.ts", "src/top.ts"]);

			const scoped = await searchFiles(dir, { type: "files", input: "*.ts", path: "src" });
			expect(scoped).toEqual(["src/nested/deep.ts", "src/top.ts"]);
		});
	});

	it("keeps a directory-prefixed glob at its depth", async () => {
		await withWorkspace(async dir => {
			const scoped = await searchFiles(dir, { type: "files", input: "nested/*.ts", path: "src" });
			expect(scoped).toEqual(["src/nested/deep.ts"]);
		});
	});

	it("lists the scope for a bare dot, and takes a slash-only scope as the root", async () => {
		await withWorkspace(async dir => {
			const listed = await searchFiles(dir, { type: "files", input: ".", path: "src" });
			// The same listing `input: "src"` returns on its own, directories included.
			expect(listed).toEqual(await searchFiles(dir, { type: "files", input: "src" }));
			expect(listed).toEqual(["src/nested/", "src/nested/deep.ts", "src/notes.md", "src/top.ts"]);
			const fromRoot = await searchFiles(dir, { type: "files", input: "*.md", path: "/" });
			expect(fromRoot).toEqual(["src/notes.md"]);
		});
	});

	it("scopes every entry of a delimited input", () => {
		expect(scopeFilePatterns("src", "*.ts; nested/*.md", process.cwd())).toEqual(["src/**/*.ts", "src/nested/*.md"]);
		expect(scopeFilePatterns("src/", "**/*.ts", process.cwd())).toEqual(["src/**/*.ts"]);
		expect(scopeFilePatterns("src", "nested", process.cwd())).toEqual(["src/nested/**/*"]);
	});

	it("rejects a scope that is a pattern and an input that cannot be scoped, naming the spelling that works", async () => {
		await withWorkspace(async dir => {
			const asPattern = await searchFiles(dir, { type: "files", input: "*.ts", path: "src/**" }).catch(
				(error: Error) => error.message,
			);
			expect(asPattern).toContain("`path` is the directory to search under, not a pattern");
			expect(asPattern).toContain("src/**");

			const absolute = await searchFiles(dir, { type: "files", input: "/etc/*.conf", path: "src" }).catch(
				(error: Error) => error.message,
			);
			expect(absolute).toContain("is absolute and cannot be scoped under `path` src");

			const internal = await searchFiles(dir, { type: "files", input: "skill://demo", path: "src" }).catch(
				(error: Error) => error.message,
			);
			expect(internal).toContain("is an internal URL and cannot be scoped under `path`");
		});
	});

	it("reports the scoped directories to the approval boundary, not the bare glob", async () => {
		await withWorkspace(async dir => {
			const tool = new SearchTool(createTestSession(dir));
			// The boundary reads each pattern's literal base: the scope for a glob
			// under it, and the climb itself for an input that leaves it, which
			// `resolveToCwd` later places outside the scope.
			const inside = tool.filesystemTargets({ type: "files", input: "*.ts", path: "src" }, dir);
			expect(inside).toEqual(["src"]);
			const climbing = tool.filesystemTargets({ type: "files", input: "../lib/*.ts", path: "src" }, dir);
			expect(climbing).toEqual(["src/../lib"]);
			// A scope the call rejects still reports both fields, never nothing.
			const rejected = tool.filesystemTargets({ type: "files", input: "/etc/*.conf", path: "src" }, dir);
			expect(rejected).toEqual(["src", "/etc"]);
		});
	});
});
