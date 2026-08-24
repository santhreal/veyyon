// WHY: `read('.')` on a large workspace used to emit the full recursive
// listing when the model only needed the top-level convention, burning
// thousands of tokens per call. This suite closes the class "a directory
// read answers at a depth, or with a cap, other than the one it was asked":
// the session working directory root must default to a concise top-level
// listing with subdirectory entry counts, explicit `depth`/`limit` must be
// honored exactly (per entry in a multi-path read), and every truncation
// must say what was omitted and name the arguments that reveal it.
// It does not catch: per-directory recency caps (the pre-existing
// "… N more" markers), native walker truncation, or selector-slice (`:N-M`)
// interplay with the concise root listing.
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
