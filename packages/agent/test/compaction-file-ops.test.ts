import { describe, expect, it } from "bun:test";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	isUrlSchemePath,
	stripReadSelector,
	upsertFileOperations,
} from "../src/compaction/utils";
import { createAssistantMessage } from "./helpers";

function readCall(id: string, path: string) {
	return { type: "toolCall" as const, id, name: "read", arguments: { path } };
}

function writeCall(id: string, path: string) {
	return { type: "toolCall" as const, id, name: "write", arguments: { path } };
}

describe("stripReadSelector", () => {
	it("strips line-range and raw selectors in every supported shape", () => {
		expect(stripReadSelector("src/foo.ts:50")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:50-")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:50-200")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:50+150")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:5-16,960-973")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:2724..2727")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:raw")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:conflicts")).toBe("src/foo.ts");
		// Compound raw+range, either order.
		expect(stripReadSelector("src/foo.ts:100-170:raw")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:raw:2-4")).toBe("src/foo.ts");
	});

	it("keeps archive member paths, stripping only the trailing selector", () => {
		expect(stripReadSelector("archive.zip:dir/file.ts:50-60")).toBe("archive.zip:dir/file.ts");
		expect(stripReadSelector("archive.zip:dir/file.ts")).toBe("archive.zip:dir/file.ts");
	});

	it("leaves non-selector colons untouched", () => {
		expect(stripReadSelector("db.sqlite:users")).toBe("db.sqlite:users");
		expect(stripReadSelector("local://ctx.md")).toBe("local://ctx.md");
		expect(stripReadSelector("https://example.com/page")).toBe("https://example.com/page");
		expect(stripReadSelector("src/foo.ts")).toBe("src/foo.ts");
	});
});

describe("extractFileOpsFromMessage", () => {
	it("dedupes the same file read through different selectors to one entry", () => {
		const fileOps = createFileOps();
		const message = createAssistantMessage([
			readCall("r1", "docs/compaction.md:100-170:raw"),
			readCall("r2", "docs/compaction.md:8-16,128-139,384-388"),
			readCall("r3", "docs/compaction.md:raw"),
			readCall("r4", "docs/compaction.md"),
		]);
		extractFileOpsFromMessage(message, fileOps);
		expect([...fileOps.read]).toEqual(["docs/compaction.md"]);
	});

	it("matches selector-suffixed reads against modified paths", () => {
		const fileOps = createFileOps();
		const message = createAssistantMessage([
			readCall("r1", "src/login.ts:30-80"),
			{ type: "toolCall" as const, id: "w1", name: "write", arguments: { path: "src/login.ts" } },
		]);
		extractFileOpsFromMessage(message, fileOps);
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		expect(readFiles).toEqual([]);
		expect(modifiedFiles).toEqual(["src/login.ts"]);
	});

	it("skips internal URLs and web URLs so they never enter <files>", () => {
		const fileOps = createFileOps();
		const message = createAssistantMessage([
			readCall("r1", "src/keep.ts"),
			readCall("r2", "artifact://7"),
			readCall("r3", "local://ctx.md"),
			readCall("r4", "https://example.com/page"),
			writeCall("w1", "conflict://1"),
			writeCall("w2", "conflict://*"),
			// Tolerated `<file>:conflict://N` prefix typo form the write tool accepts.
			writeCall("w3", "src/login.ts:conflict://3"),
			{ type: "toolCall" as const, id: "e1", name: "edit", arguments: { path: "agent://abc" } },
		]);
		extractFileOpsFromMessage(message, fileOps);
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		expect(readFiles).toEqual(["src/keep.ts"]);
		expect(modifiedFiles).toEqual([]);
	});

	it("records an edit tool call as a modified file, not a read", () => {
		const fileOps = createFileOps();
		const message = createAssistantMessage([
			readCall("r1", "src/reader.ts"),
			{ type: "toolCall" as const, id: "e1", name: "edit", arguments: { path: "src/patched.ts" } },
		]);
		extractFileOpsFromMessage(message, fileOps);
		expect([...fileOps.edited]).toEqual(["src/patched.ts"]);
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		expect(readFiles).toEqual(["src/reader.ts"]);
		expect(modifiedFiles).toEqual(["src/patched.ts"]);
	});
});

describe("computeFileLists", () => {
	it("drops scheme:// URLs rehydrated from legacy compaction details", () => {
		const fileOps = createFileOps();
		// Simulate a pre-fix summary's details.readFiles/modifiedFiles fed straight
		// into fileOps without going through extractFileOpsFromMessage.
		fileOps.read.add("src/read-only.ts");
		fileOps.read.add("artifact://7");
		fileOps.edited.add("src/edited.ts");
		fileOps.edited.add("conflict://1");
		fileOps.written.add("local://ctx.md");
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		expect(readFiles).toEqual(["src/read-only.ts"]);
		expect(modifiedFiles).toEqual(["src/edited.ts"]);
	});
});

describe("formatFileOperations", () => {
	it("renders one grouped <files> tree with Read/Write/RW markers", () => {
		const rendered = formatFileOperations(
			["src/a.ts", "src/b.ts"],
			["src/c.ts", "src/d.ts"],
			new Set(["src/a.ts", "src/b.ts", "src/c.ts"]),
		);
		expect(rendered).toBe(
			["<files>", "# src/", "a.ts (Read)", "b.ts (Read)", "c.ts (RW)", "d.ts (Write)", "</files>"].join("\n"),
		);
	});

	it("marks modified files Write when no read set is provided", () => {
		const rendered = formatFileOperations([], ["c.ts"]);
		expect(rendered).toBe(["<files>", "c.ts (Write)", "</files>"].join("\n"));
	});

	it("caps the tree at 20 files and appends an elided-count marker", () => {
		// 25 read files: only the first 20 (after sort) render; the remaining 5 are
		// summarized by a single trailing marker line.
		const readFiles = Array.from({ length: 25 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);
		const rendered = formatFileOperations(readFiles, []);
		expect(rendered).toContain("f00.ts (Read)");
		expect(rendered).toContain("f19.ts (Read)");
		expect(rendered).not.toContain("f20.ts (Read)");
		expect(rendered).toContain("[…5 files elided…]");
	});
});

describe("upsertFileOperations", () => {
	it("strips a stale <files> block and appends the freshly computed one", () => {
		const summary = "Prose about the change.\n\n<files>\n# old/\nstale.ts (Read)\n</files>";
		const out = upsertFileOperations(summary, ["src/a.ts"], []);
		expect(out).toBe("Prose about the change.\n\n<files>\n# src/\na.ts (Read)\n</files>");
		expect(out).not.toContain("stale.ts");
	});

	it("self-heals legacy <read-files>/<modified-files> tags into the combined tag", () => {
		const summary =
			"Body.\n\n<read-files>\nold-read.ts\n</read-files>\n<modified-files>\nold-mod.ts\n</modified-files>";
		const out = upsertFileOperations(summary, [], ["src/w.ts"]);
		expect(out).toBe("Body.\n\n<files>\n# src/\nw.ts (Write)\n</files>");
		expect(out).not.toContain("old-read.ts");
		expect(out).not.toContain("<read-files>");
	});

	it("returns the base summary unchanged when there are no file operations", () => {
		const out = upsertFileOperations("Just prose.", [], []);
		expect(out).toBe("Just prose.");
	});

	it("returns only the file block when the base summary is empty", () => {
		const out = upsertFileOperations("", ["src/only.ts"], []);
		expect(out).toBe("<files>\n# src/\nonly.ts (Read)\n</files>");
	});
});

describe("isUrlSchemePath", () => {
	it("flags internal URIs and web URLs", () => {
		expect(isUrlSchemePath("conflict://1")).toBe(true);
		expect(isUrlSchemePath("conflict://*")).toBe(true);
		expect(isUrlSchemePath("artifact://7")).toBe(true);
		expect(isUrlSchemePath("local://ctx.md")).toBe(true);
		expect(isUrlSchemePath("history://AuthLoader")).toBe(true);
		expect(isUrlSchemePath("https://example.com/page")).toBe(true);
		// Prefixed conflict typo form — scheme appears after a colon, not at start.
		expect(isUrlSchemePath("src/login.ts:conflict://3")).toBe(true);
	});

	it("leaves real filesystem paths untouched", () => {
		expect(isUrlSchemePath("src/foo.ts")).toBe(false);
		expect(isUrlSchemePath("C:/Users/me/file.ts")).toBe(false);
		expect(isUrlSchemePath("db.sqlite:users")).toBe(false);
		expect(isUrlSchemePath("archive.zip:dir/file.ts")).toBe(false);
		expect(isUrlSchemePath("docs/compaction.md:100-170:raw")).toBe(false);
	});
});
