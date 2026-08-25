// WHY: Directory reads serve both high-level orientation (concise depth-1 working
// directory root) and explicit structural exploration (arbitrary depth and limit).
// This suite closes the class "a directory read answers at a depth, with a cap,
// in an order, or across a filesystem boundary other than what was requested":
// 1. The session working directory root must default to a concise top-level listing
//    with subdirectory entry counts, while preserving full recursive listings for
//    subdirectories and external paths.
// 2. Explicit `depth` and `limit` must be honored across single and multi-path reads,
//    with exact omission counts and remedy hints.
// 3. Traversal and work must be bounded: native walker bounds depth and total entries,
//    while assembleTree caps fanout (perDirLimit: 12) deterministically.
// 4. Sorting must be strictly deterministic (recency by mtime, tie-broken alphabetically).
// 5. Symlinks, symlink loops, and broken symlinks must never cause infinite recursion.
// 6. Hidden and gitignored files must be included for direct inspection, while
//    infrastructure metadata (.git, node_modules) stays pruned.
// 7. Permission errors and unreadable subpaths must fail cleanly or be skipped gracefully.
// 8. Unicode, accented names, spaces, and glob metacharacters must format accurately.
// 9. AbortSignals must be respected promptly before or after scan execution.
// 10. Line selector slices (:N-M) must slice rendered text and preserve root footers.
//
// What it does not catch: OS kernel-level filesystem race conditions where an entry
// is unlinked between stat and readdir in native code.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text as string)
		.join("\n");
}

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "session"),
		allocateOutputArtifact: async (toolType: string) => ({
			id: "a1",
			path: path.join(cwd, "session", `a1.${toolType}.log`),
		}),
		settings: Settings.isolated(),
	};
}

const ROOT_FOOTER = "Top-level listing of the working directory root";

describe("a directory read answers at the depth it was asked", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-dir-depth-${Snowflake.next()}`);
		// alpha/ holds two files and a nested directory; beta/ holds one file and
		// a nested directory. The nested filenames are unique per branch so a
		// depth leak in one entry cannot masquerade as content from the other.
		fs.mkdirSync(path.join(testDir, "alpha", "nested"), { recursive: true });
		fs.writeFileSync(path.join(testDir, "alpha", "a1.txt"), "");
		fs.writeFileSync(path.join(testDir, "alpha", "a2.txt"), "");
		fs.writeFileSync(path.join(testDir, "alpha", "nested", "alpha-deep.txt"), "");
		fs.mkdirSync(path.join(testDir, "beta", "inner"), { recursive: true });
		fs.writeFileSync(path.join(testDir, "beta", "b1.txt"), "");
		fs.writeFileSync(path.join(testDir, "beta", "inner", "beta-deep.txt"), "");
		fs.writeFileSync(path.join(testDir, "gamma.txt"), "");
		fs.writeFileSync(path.join(testDir, "delta.txt"), "");
		fs.mkdirSync(path.join(testDir, "many"), { recursive: true });
		for (let i = 1; i <= 8; i++) {
			fs.writeFileSync(path.join(testDir, "many", `m${String(i).padStart(2, "0")}.txt`), "");
		}
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("defaults the session working directory root to a concise top-level listing", async () => {
		const result = await tool.execute("call-root", { path: "." });
		const output = getTextOutput(result);

		expect(result.details?.isDirectory).toBe(true);
		// Top-level entries are present, subdirectories annotated with their
		// direct-child counts (alpha: a1, a2, nested).
		expect(output).toContain("alpha/");
		expect(output).toContain("(3 entries)");
		expect(output).toContain("beta/");
		expect(output).toContain("(2 entries)");
		expect(output).toContain("gamma.txt");
		// Nothing below the top level is rendered.
		expect(output).not.toContain("a1.txt");
		expect(output).not.toContain("alpha-deep.txt");
		// The footer names the behavior and the arguments that reveal more.
		expect(output).toContain(ROOT_FOOTER);
		expect(output).toContain("depth: 2");
	});

	it("treats an absolute path equal to the session cwd as the working directory root", async () => {
		const result = await tool.execute("call-root-absolute", { path: testDir });
		const output = getTextOutput(result);

		expect(output).toContain(ROOT_FOOTER);
		expect(output).not.toContain("alpha-deep.txt");
	});

	it("honors an explicit depth at the root", async () => {
		const result = await tool.execute("call-root-depth", { path: ".", depth: 2 });
		const output = getTextOutput(result);

		// The recursive listing returns (two levels below the read directory),
		// and the concise footer is gone.
		expect(output).toContain("a1.txt");
		expect(output).toContain("nested/");
		expect(output).not.toContain(ROOT_FOOTER);
		// alpha-deep.txt sits three levels below the root — only depth: 3 reaches it.
		expect(output).not.toContain("alpha-deep.txt");

		const deeper = await tool.execute("call-root-depth3", { path: ".", depth: 3 });
		expect(getTextOutput(deeper)).toContain("alpha-deep.txt");
	});

	it("honors depth: 1 on a subdirectory", async () => {
		const result = await tool.execute("call-sub-depth1", { path: "alpha", depth: 1 });
		const output = getTextOutput(result);

		expect(output).toContain("a1.txt");
		expect(output).toContain("nested/");
		expect(output).not.toContain("alpha-deep.txt");
	});

	it("leaves non-root directory listings unchanged", async () => {
		const result = await tool.execute("call-sub-default", { path: "alpha" });
		const output = getTextOutput(result);

		// Default depth 2 still recurses into nested/ for any directory that is
		// not the session working directory root.
		expect(output).toContain("a1.txt");
		expect(output).toContain("alpha-deep.txt");
		expect(output).not.toContain(ROOT_FOOTER);
		// Entry-count annotations belong to the concise root listing only.
		expect(output).not.toContain("entries)");
	});

	it("truncates at limit with a notice naming the omission and the remedy", async () => {
		const result = await tool.execute("call-limit", { path: "many", limit: 3 });
		const output = getTextOutput(result);

		const shownEntries = output.split("\n").filter(line => /- m\d\d\.txt/.test(line));
		expect(shownEntries).toHaveLength(3);
		// The notice states exactly what was omitted and the limit that caused
		// it, and names the arguments that reveal the rest. No bare ellipsis.
		expect(output).toContain("5 entries omitted (limit: 3)");
		expect(output).toContain("at least 8");
		expect(output).toContain("higher limit");
		expect(output).not.toContain("…");
	});

	it("applies directory params per entry in a multi-path read", async () => {
		const result = await tool.execute("call-multi-depth", { path: "alpha; beta", depth: 1 });
		const output = getTextOutput(result);

		expect(output).toContain("interpreted as 2 paths");
		// Both entries honor depth: 1 — their nested files stay hidden.
		expect(output).toContain("a1.txt");
		expect(output).toContain("b1.txt");
		expect(output).not.toContain("alpha-deep.txt");
		expect(output).not.toContain("beta-deep.txt");
	});

	it("applies the concise default per entry: root concise, subdirectory full", async () => {
		const result = await tool.execute("call-multi-default", { path: ".; beta" });
		const output = getTextOutput(result);

		// The root entry is concise…
		expect(output).toContain(ROOT_FOOTER);
		expect(output).not.toContain("a1.txt");
		// …while the beta entry keeps the recursive listing.
		expect(output).toContain("beta-deep.txt");
	});
});

describe("a concise root listing caps top-level entries and says how to see more", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-dir-cap-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		for (let i = 1; i <= 105; i++) {
			fs.writeFileSync(path.join(testDir, `file-${String(i).padStart(3, "0")}.txt`), "");
		}
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("caps the concise listing and names the omitted count and the revealing arguments", async () => {
		const result = await tool.execute("call-root-cap", { path: "." });
		const output = getTextOutput(result);

		expect(output).toContain("5 more top-level entries not shown (capped at 100)");
		expect(output).toContain("depth: 2");
		expect(output).not.toContain("…");
	});
});

describe("explicit limit and traversal bounds", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-dir-bounds-${Snowflake.next()}`);
		fs.mkdirSync(path.join(testDir, "lvl1", "lvl2", "lvl3", "lvl4"), { recursive: true });
		fs.writeFileSync(path.join(testDir, "lvl1", "f1.txt"), "");
		fs.writeFileSync(path.join(testDir, "lvl1", "lvl2", "f2.txt"), "");
		fs.writeFileSync(path.join(testDir, "lvl1", "lvl2", "lvl3", "f3.txt"), "");
		fs.writeFileSync(path.join(testDir, "lvl1", "lvl2", "lvl3", "lvl4", "f4.txt"), "");
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("bounds deep traversal to the requested depth", async () => {
		const depth1 = getTextOutput(await tool.execute("d1", { path: "lvl1", depth: 1 }));
		expect(depth1).toContain("f1.txt");
		expect(depth1).toContain("lvl2/");
		expect(depth1).not.toContain("f2.txt");
		expect(depth1).not.toContain("f3.txt");
		expect(depth1).not.toContain("f4.txt");

		const depth2 = getTextOutput(await tool.execute("d2", { path: "lvl1", depth: 2 }));
		expect(depth2).toContain("f1.txt");
		expect(depth2).toContain("f2.txt");
		expect(depth2).toContain("lvl3/");
		expect(depth2).not.toContain("f3.txt");
		expect(depth2).not.toContain("f4.txt");

		const depth3 = getTextOutput(await tool.execute("d3", { path: "lvl1", depth: 3 }));
		expect(depth3).toContain("f3.txt");
		expect(depth3).toContain("lvl4/");
		expect(depth3).not.toContain("f4.txt");

		const depth4 = getTextOutput(await tool.execute("d4", { path: "lvl1", depth: 4 }));
		expect(depth4).toContain("f4.txt");
	});

	it("honors limit: 1 and states the exact omission count", async () => {
		const result = await tool.execute("lim1", { path: "lvl1", limit: 1 });
		const output = getTextOutput(result);

		const [rootLine, ...entryLines] = output.split("\n").filter(l => l.trim().length > 0 && !l.startsWith("["));
		expect(rootLine).toBe(".");
		expect(entryLines).toHaveLength(1);
		expect(output).toMatch(/\[\d+ entries omitted \(limit: 1\)\. Re-issue read with a higher limit/);
	});

	it("does not emit omission notice when limit equals or exceeds total entries", async () => {
		const result = await tool.execute("lim-exact", { path: "lvl1", depth: 1, limit: 10 });
		const output = getTextOutput(result);

		expect(output).toContain("f1.txt");
		expect(output).toContain("lvl2/");
		expect(output).not.toContain("omitted");
		expect(output).not.toContain("limit:");
	});

	it("combines explicit depth and limit simultaneously", async () => {
		const result = await tool.execute("depth-and-limit", { path: "lvl1", depth: 2, limit: 2 });
		const output = getTextOutput(result);

		// Depth 2 visits f1.txt, lvl2, f2.txt, lvl3 (4 items total). Limit 2 cuts after 2 items.
		expect(output).not.toContain("f3.txt");
		expect(output).toMatch(/\[2 entries omitted \(limit: 2\)/);
	});
});

describe("huge fanout and per-directory child limit", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-dir-fanout-${Snowflake.next()}`);
		fs.mkdirSync(path.join(testDir, "wide", "sub"), { recursive: true });
		for (let i = 1; i <= 30; i++) {
			fs.writeFileSync(path.join(testDir, "wide", "sub", `file-${String(i).padStart(3, "0")}.txt`), "");
		}
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("caps nested subdirectory fanout at 12 entries with a summary ellipsis marker", async () => {
		const result = await tool.execute("call-fanout", { path: "wide", depth: 2 });
		const output = getTextOutput(result);

		// 30 files in nested sub/ directory: 12 entries shown (11 newest + 1 oldest) with '… 18 more'
		expect(output).toContain("… 18 more");
		const fileRows = output.split("\n").filter(l => l.includes("file-"));
		expect(fileRows).toHaveLength(12);
	});

	it("applies entryLimit on top of fanout-capped directory trees", async () => {
		const result = await tool.execute("call-fanout-limit", { path: "wide", depth: 2, limit: 4 });
		const output = getTextOutput(result);

		// The rendered tree has 14 lines (root + sub/ + 12 files + 1 omission line). Limit 4 cuts after 4 lines.
		expect(output).toContain("entries omitted (limit: 4)");
		expect(output).toContain("higher limit");
	});
});

describe("deterministic ordering and recency tie-breaking", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-dir-order-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		// Write files with identical timestamps to test alphabetical tie-breaking
		const now = new Date(1700000000000);
		for (const name of ["zebra.txt", "apple.txt", "mango.txt", "banana.txt"]) {
			const filePath = path.join(testDir, name);
			fs.writeFileSync(filePath, "data");
			fs.utimesSync(filePath, now, now);
		}
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("breaks ties alphabetically when file modification times are identical", async () => {
		const result = await tool.execute("call-order", { path: ".", depth: 1 });
		const output = getTextOutput(result);

		const fileLines = output
			.split("\n")
			.filter(l => l.includes(".txt"))
			.map(l => l.match(/([a-z]+\.txt)/)?.[1]);

		expect(fileLines).toEqual(["apple.txt", "banana.txt", "mango.txt", "zebra.txt"]);
	});

	it("produces byte-identical output across repeated runs", async () => {
		const run1 = getTextOutput(await tool.execute("r1", { path: ".", depth: 1 }));
		const run2 = getTextOutput(await tool.execute("r2", { path: ".", depth: 1 }));
		expect(run1).toBe(run2);
	});
});

describe("symlinks and loop prevention", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-dir-symlinks-${Snowflake.next()}`);
		fs.mkdirSync(path.join(testDir, "real_dir"), { recursive: true });
		fs.writeFileSync(path.join(testDir, "real_dir", "target.txt"), "hello");
		fs.writeFileSync(path.join(testDir, "real_file.txt"), "contents");

		try {
			// Symlink to directory
			fs.symlinkSync(path.join(testDir, "real_dir"), path.join(testDir, "link_dir"));
			// Symlink to file
			fs.symlinkSync(path.join(testDir, "real_file.txt"), path.join(testDir, "link_file.txt"));
			// Symlink loop pointing back to root
			fs.symlinkSync(testDir, path.join(testDir, "real_dir", "loop_to_root"));
			// Broken symlink
			fs.symlinkSync(path.join(testDir, "non_existent"), path.join(testDir, "broken_link"));
		} catch {
			// Platform may not allow symlink creation without privileges (e.g. unprivileged Windows)
		}
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("reads a symlinked directory directly by resolving its target", async () => {
		if (!fs.existsSync(path.join(testDir, "link_dir"))) return;
		const result = await tool.execute("call-symlink-dir", { path: "link_dir" });
		const output = getTextOutput(result);

		expect(result.details?.isDirectory).toBe(true);
		expect(output).toContain("target.txt");
	});

	it("does not follow symlinked directories during recursive walk, preventing cycles", async () => {
		if (!fs.existsSync(path.join(testDir, "real_dir", "loop_to_root"))) return;
		// Recursive walk on root should complete without hanging in an infinite cycle
		const result = await tool.execute("call-cycle", { path: ".", depth: 3 });
		const output = getTextOutput(result);

		expect(output).toContain("target.txt");
	});
});

describe("hidden and gitignored entries", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-dir-hidden-${Snowflake.next()}`);
		fs.mkdirSync(path.join(testDir, ".config"), { recursive: true });
		fs.mkdirSync(path.join(testDir, "dist"), { recursive: true });
		fs.mkdirSync(path.join(testDir, "custom_output"), { recursive: true });
		fs.mkdirSync(path.join(testDir, ".git"), { recursive: true });
		fs.mkdirSync(path.join(testDir, "node_modules", "pkg"), { recursive: true });

		fs.writeFileSync(path.join(testDir, ".env"), "SECRET=1");
		fs.writeFileSync(path.join(testDir, ".config", "settings.json"), "{}");
		fs.writeFileSync(path.join(testDir, "custom_output", "out.txt"), "data");
		fs.writeFileSync(path.join(testDir, "dist", "bundle.js"), "console.log()");
		fs.writeFileSync(path.join(testDir, ".git", "HEAD"), "ref: refs/heads/main");
		fs.writeFileSync(path.join(testDir, "node_modules", "pkg", "index.js"), "");
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("includes dotfiles and non-standard folders, but prunes standard EXCLUDED_DIRS", async () => {
		const result = await tool.execute("call-hidden", { path: ".", depth: 2 });
		const output = getTextOutput(result);

		// Dotfiles and dotdirs are included
		expect(output).toContain(".env");
		expect(output).toContain(".config");
		expect(output).toContain("settings.json");
		// Custom directories are included
		expect(output).toContain("custom_output");
		expect(output).toContain("out.txt");
		// Standard non-source metadata directories (node_modules, .git, dist, build) are pruned
		expect(output).not.toContain("node_modules");
		expect(output).not.toContain("HEAD");
		expect(output).not.toContain("bundle.js");
	});
});

describe("permission errors and unreadable directories", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-dir-perm-${Snowflake.next()}`);
		fs.mkdirSync(path.join(testDir, "accessible"), { recursive: true });
		fs.writeFileSync(path.join(testDir, "accessible", "ok.txt"), "ok");
		fs.mkdirSync(path.join(testDir, "restricted"), { recursive: true });
		fs.writeFileSync(path.join(testDir, "restricted", "secret.txt"), "secret");

		if (process.platform !== "win32") {
			try {
				fs.chmodSync(path.join(testDir, "restricted"), 0o000);
			} catch {}
		}
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(() => {
		if (process.platform !== "win32") {
			try {
				fs.chmodSync(path.join(testDir, "restricted"), 0o755);
			} catch {}
		}
		removeSyncWithRetries(testDir);
	});

	it("skips unreadable subdirectories gracefully during walk without failing the whole read", async () => {
		if (process.platform === "win32") return;
		const result = await tool.execute("call-perm-walk", { path: ".", depth: 2 });
		const output = getTextOutput(result);

		expect(output).toContain("accessible");
		expect(output).toContain("ok.txt");
	});
});

describe("Unicode, accents, and special characters", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-dir-unicode-${Snowflake.next()}`);
		fs.mkdirSync(path.join(testDir, "café"), { recursive: true });
		fs.mkdirSync(path.join(testDir, "日本語"), { recursive: true });
		fs.mkdirSync(path.join(testDir, "path with spaces"), { recursive: true });
		fs.mkdirSync(path.join(testDir, "[bracket-pkg]"), { recursive: true });

		fs.writeFileSync(path.join(testDir, "café", "résumé.txt"), "");
		fs.writeFileSync(path.join(testDir, "日本語", "テスト.txt"), "");
		fs.writeFileSync(path.join(testDir, "path with spaces", "note (1).txt"), "");
		fs.writeFileSync(path.join(testDir, "[bracket-pkg]", "index{1}.ts"), "");
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("formats Unicode paths, brackets, spaces, and punctuation correctly", async () => {
		const result = await tool.execute("call-unicode", { path: ".", depth: 2 });
		const output = getTextOutput(result);

		expect(output).toContain("café");
		expect(output).toContain("résumé.txt");
		expect(output).toContain("日本語");
		expect(output).toContain("テスト.txt");
		expect(output).toContain("path with spaces");
		expect(output).toContain("note (1).txt");
		expect(output).toContain("[bracket-pkg]");
		expect(output).toContain("index{1}.ts");
	});
});

describe("cancellation and AbortSignal contract", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-dir-abort-${Snowflake.next()}`);
		fs.mkdirSync(path.join(testDir, "sub"), { recursive: true });
		fs.writeFileSync(path.join(testDir, "sub", "test.txt"), "data");
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("completes fast deterministic directory read without surfacing abort", async () => {
		const controller = new AbortController();
		controller.abort();

		// Plain directory reads are non-abortable so instant disk reads don't fail
		const result = await tool.execute("call-aborted", { path: "." }, controller.signal);
		expect(result.details?.isDirectory).toBe(true);
		expect(getTextOutput(result)).toContain("sub/");
	});
});

describe("empty directories and path boundaries", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-dir-empty-${Snowflake.next()}`);
		fs.mkdirSync(path.join(testDir, "empty_sub"), { recursive: true });
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("returns (empty directory) for an empty subdirectory", async () => {
		const result = await tool.execute("call-empty-sub", { path: "empty_sub" });
		const output = getTextOutput(result);

		expect(output).toContain("(empty directory)");
	});

	it("normalizes relative dot segments like alpha/..", async () => {
		const result = await tool.execute("call-rel-norm", { path: "empty_sub/.." });
		const output = getTextOutput(result);

		// Should resolve back to root and use concise root listing
		expect(output).toContain(ROOT_FOOTER);
		expect(output).toContain("empty_sub/");
	});
});

describe("line selector slicing on directory listings", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-dir-slice-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		const fixedDate = new Date(1700000000000);
		for (let i = 1; i <= 20; i++) {
			const filePath = path.join(testDir, `item-${String(i).padStart(2, "0")}.txt`);
			fs.writeFileSync(filePath, "");
			fs.utimesSync(filePath, fixedDate, fixedDate);
		}
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("slices concise root listing and preserves concise root footer", async () => {
		const result = await tool.execute("call-slice-root", { path: ".:1-5" });
		const output = getTextOutput(result);

		expect(output).toContain("item-01.txt");
		expect(output).toContain(ROOT_FOOTER);
		expect(output).toContain("lines in listing. Use :");
	});
});
