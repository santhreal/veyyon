import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { editFilesystemTargets } from "@veyyon/coding-agent/edit";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { astEditFilesystemTargets } from "@veyyon/coding-agent/tools/ast-edit";
import {
	cwdEscapingTargets,
	formatCwdBoundaryReason,
	hasFilesystemTargets,
	searchPathFilesystemTargets,
} from "@veyyon/coding-agent/tools/cwd-boundary";
import { inspectImageFilesystemTargets } from "@veyyon/coding-agent/tools/inspect-image";
import { isPathWithinCwd } from "@veyyon/coding-agent/tools/path-utils";
import { readFilesystemTargets } from "@veyyon/coding-agent/tools/read";
import { writeFilesystemTargets } from "@veyyon/coding-agent/tools/write";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

/** A stand-in filesystem tool: the boundary only needs `filesystemTargets`. */
function toolWith(fn: (args: unknown) => string[]): { name: string; filesystemTargets: (args: unknown) => string[] } {
	return { name: "fs-tool", filesystemTargets: fn };
}
/** Mirrors read/write's simplest extraction: a single `path` arg, verbatim. */
const pathArgTool = toolWith(readFilesystemTargets);

// These suites lock the filesystem cwd boundary (BACKLOG DOG-R2-2): a read/write
// whose target escapes the session working directory must require permission in
// every non-yolo mode, while yolo bypasses it. The bug being prevented is silent
// out-of-cwd filesystem access — `read /etc/passwd` and `write /etc/cron.d/x`
// ran with no prompt because the read/write approval *tier* auto-approves by tier
// and never inspected the path.

const CWD = "/home/user/project";

describe("isPathWithinCwd containment predicate", () => {
	// Locks the single containment rule shared by the display path and the
	// permission gate: equal-to-cwd and descendants are inside; a `..`-escaping or
	// absolute-elsewhere path is outside.
	it("treats the cwd itself and its descendants as inside", () => {
		expect(isPathWithinCwd(CWD, CWD)).toBe(true);
		expect(isPathWithinCwd(`${CWD}/src/a.ts`, CWD)).toBe(true);
		expect(isPathWithinCwd(`${CWD}/deeply/nested/file`, CWD)).toBe(true);
	});

	it("treats a sibling or ancestor path as outside", () => {
		expect(isPathWithinCwd("/home/user/other", CWD)).toBe(false);
		expect(isPathWithinCwd("/home/user", CWD)).toBe(false);
		expect(isPathWithinCwd("/etc/passwd", CWD)).toBe(false);
	});

	it("is not fooled by a cwd-prefix that is a different directory", () => {
		// `/home/user/project-secrets` shares the string prefix but is a sibling.
		expect(isPathWithinCwd("/home/user/project-secrets/x", CWD)).toBe(false);
	});

	it("rejects trailing-slash sibling spoof and accepts trailing-slash self", () => {
		expect(isPathWithinCwd(`${CWD}/`, CWD)).toBe(true);
		expect(isPathWithinCwd("/home/user/projectX/a", CWD)).toBe(false);
	});

	it("treats windows-style different roots as outside when absolute elsewhere", () => {
		// On posix hosts resolve still yields an absolute path outside CWD.
		expect(isPathWithinCwd("/var/log/syslog", CWD)).toBe(false);
	});
});

describe("cwdEscapingTargets containment policy", () => {
	it("returns no escapes for an in-cwd target", () => {
		expect(cwdEscapingTargets(pathArgTool, { path: "src/a.ts" }, CWD)).toEqual([]);
		expect(cwdEscapingTargets(pathArgTool, { path: `${CWD}/src/a.ts` }, CWD)).toEqual([]);
	});

	it("flags an absolute out-of-cwd target with its resolved path", () => {
		expect(cwdEscapingTargets(pathArgTool, { path: "/etc/passwd" }, CWD)).toEqual(["/etc/passwd"]);
	});

	it("flags a `..`-traversal that escapes cwd", () => {
		// /home/user/project + ../../../etc/passwd climbs past cwd to the root.
		expect(cwdEscapingTargets(pathArgTool, { path: "../../../etc/passwd" }, CWD)).toEqual(["/etc/passwd"]);
		expect(cwdEscapingTargets(pathArgTool, { path: "../sibling/x" }, CWD)).toEqual(["/home/user/sibling/x"]);
	});

	it("keeps a line-range/archive selector attached without changing the verdict", () => {
		// The selector appends to the filename; the base file is what is touched.
		expect(cwdEscapingTargets(pathArgTool, { path: "/etc/passwd:1-3" }, CWD)[0]).toStartWith("/etc/passwd");
		expect(cwdEscapingTargets(pathArgTool, { path: "src/a.ts:1-3" }, CWD)).toEqual([]);
	});

	it("flags every out-of-cwd target when a tool reports several", () => {
		const multi = toolWith(() => ["src/in.ts", "/etc/a", "/etc/b"]);
		expect(cwdEscapingTargets(multi, {}, CWD)).toEqual(["/etc/a", "/etc/b"]);
	});

	it("writeFilesystemTargets and readFilesystemTargets agree on bare path extraction", () => {
		expect(writeFilesystemTargets({ path: "src/a.ts", content: "x" })).toEqual(["src/a.ts"]);
		expect(readFilesystemTargets({ path: "src/a.ts" })).toEqual(["src/a.ts"]);
		expect(cwdEscapingTargets(toolWith(writeFilesystemTargets), { path: "/etc/shadow", content: "x" }, CWD)).toEqual([
			"/etc/shadow",
		]);
	});

	it("formatCwdBoundaryReason names the cwd and at least one escape", () => {
		const reason = formatCwdBoundaryReason(CWD, ["/etc/passwd"]);
		expect(reason).toContain(CWD);
		expect(reason).toContain("/etc/passwd");
	});

	it("ignores non-filesystem destinations (URL, ssh, internal scheme)", () => {
		expect(cwdEscapingTargets(pathArgTool, { path: "https://example.com/page" }, CWD)).toEqual([]);
		expect(cwdEscapingTargets(pathArgTool, { path: "www.example.com" }, CWD)).toEqual([]);
		expect(cwdEscapingTargets(pathArgTool, { path: "ssh://host/etc/passwd" }, CWD)).toEqual([]);
		expect(cwdEscapingTargets(pathArgTool, { path: "memory://note" }, CWD)).toEqual([]);
	});

	it("treats a bare root `/` as the workspace-root alias (in-bounds)", () => {
		expect(cwdEscapingTargets(pathArgTool, { path: "/" }, CWD)).toEqual([]);
	});

	it("returns nothing for a tool with no filesystemTargets or when cwd is unknown", () => {
		expect(cwdEscapingTargets({ name: "bash" }, { command: "cat /etc/passwd" }, CWD)).toEqual([]);
		expect(hasFilesystemTargets({ name: "bash" })).toBe(false);
		expect(cwdEscapingTargets(pathArgTool, { path: "/etc/passwd" }, "")).toEqual([]);
		expect(cwdEscapingTargets(pathArgTool, {}, CWD)).toEqual([]);
	});
});

describe("cwdEscapingTargets symlink-escape (physical containment)", () => {
	// Locks FINDING-CWD-BOUNDARY-SYMLINK-ESCAPE: the lexical containment check
	// alone would judge a path whose spelled form sits inside cwd but traverses a
	// symlink pointing OUTSIDE as "inside" and auto-approve it, physically escaping
	// the gate. The boundary now resolves the nearest existing ancestor's realpath,
	// so a symlink escape is flagged (prompted) while ordinary in-cwd files — even
	// not-yet-created write targets — still auto-approve. Uses a real on-disk tree
	// because the bug only manifests against actual symlinks, not string paths.
	let root: string;
	let cwd: string;
	let outsideDir: string;

	beforeAll(() => {
		// fs.realpathSync on the tmp base so macOS /tmp -> /private/tmp does not by
		// itself read as an escape (the boundary resolves cwd's realpath too).
		root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cwdb-symlink-"));
		cwd = path.join(root, "project");
		outsideDir = path.join(root, "outside");
		fs.mkdirSync(cwd);
		fs.mkdirSync(outsideDir);
		fs.writeFileSync(path.join(outsideDir, "secret.txt"), "SECRET");
		fs.writeFileSync(path.join(cwd, "real.txt"), "ok");
		// `escape` lives inside cwd but points at the sibling `outside` dir.
		fs.symlinkSync(outsideDir, path.join(cwd, "escape"));
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("flags a read through an in-cwd symlink to an existing outside file", () => {
		const target = path.join(cwd, "escape", "secret.txt");
		// Lexically inside cwd, physically /…/outside/secret.txt — must be flagged.
		expect(isPathWithinCwd(target, cwd)).toBe(true);
		const escaping = cwdEscapingTargets(pathArgTool, { path: target }, cwd);
		expect(escaping).toEqual([target]);
	});

	it("flags a write to a NOT-YET-EXISTING file behind an in-cwd symlink", () => {
		// The tail does not exist, so the nearest existing ancestor (the symlink
		// dir) is realpathed and the literal tail re-appended: still an escape.
		const target = path.join(cwd, "escape", "newfile.txt");
		expect(fs.existsSync(target)).toBe(false);
		expect(cwdEscapingTargets(toolWith(writeFilesystemTargets), { path: target }, cwd)).toEqual([target]);
	});

	it("flags the in-cwd symlink directory entry itself", () => {
		const target = path.join(cwd, "escape");
		expect(cwdEscapingTargets(pathArgTool, { path: target }, cwd)).toEqual([target]);
	});

	it("still auto-approves an ordinary in-cwd file (existing and new)", () => {
		expect(cwdEscapingTargets(pathArgTool, { path: path.join(cwd, "real.txt") }, cwd)).toEqual([]);
		expect(
			cwdEscapingTargets(toolWith(writeFilesystemTargets), { path: path.join(cwd, "brand-new.txt") }, cwd),
		).toEqual([]);
	});
});

describe("per-tool filesystemTargets extraction", () => {
	it("read/write take the single `path` arg; write unwraps a hashline header", () => {
		expect(readFilesystemTargets({ path: "/etc/passwd:1-3" })).toEqual(["/etc/passwd:1-3"]);
		expect(readFilesystemTargets({})).toEqual([]);
		expect(writeFilesystemTargets({ path: "/etc/cron.d/x" })).toEqual(["/etc/cron.d/x"]);
		// `[path#TAG]` must be unwrapped, or it resolves as a relative name inside
		// cwd and silently dodges the boundary.
		expect(writeFilesystemTargets({ path: "[/etc/cron.d/x#AB12]" })).toEqual(["/etc/cron.d/x"]);
		expect(cwdEscapingTargets(toolWith(writeFilesystemTargets), { path: "[/etc/cron.d/x#AB12]" }, CWD)).toEqual([
			"/etc/cron.d/x",
		]);
	});

	it("ast_edit reports every path it edits, dropping non-strings", () => {
		expect(astEditFilesystemTargets({ paths: ["src/a.ts", "/etc/b.ts", 5] })).toEqual(["src/a.ts", "/etc/b.ts"]);
		expect(astEditFilesystemTargets({})).toEqual([]);
	});

	it("inspect_image reports a file path but NOT an in-memory attachment reference", () => {
		// inspect_image reads a file by path exactly like `read`, so an out-of-cwd
		// image must be gated the same way — closing the read asymmetry DOG-R2-2
		// forbids. Attachment references (`Image #N`, `attachment://N`, `image://N`)
		// load from the turn's in-memory attachments, not the filesystem.
		expect(inspectImageFilesystemTargets({ path: "screenshots/a.png" })).toEqual(["screenshots/a.png"]);
		expect(inspectImageFilesystemTargets({ path: "/etc/secret.png" })).toEqual(["/etc/secret.png"]);
		expect(inspectImageFilesystemTargets({ path: "Image #2" })).toEqual([]);
		expect(inspectImageFilesystemTargets({ path: "[Image #2]" })).toEqual([]);
		expect(inspectImageFilesystemTargets({ path: "attachment://3" })).toEqual([]);
		expect(inspectImageFilesystemTargets({ path: "image://3" })).toEqual([]);
		expect(inspectImageFilesystemTargets({})).toEqual([]);
		// The boundary flags the out-of-cwd image and ignores the in-cwd one.
		expect(cwdEscapingTargets(toolWith(inspectImageFilesystemTargets), { path: "/etc/secret.png" }, CWD)).toEqual([
			"/etc/secret.png",
		]);
		expect(cwdEscapingTargets(toolWith(inspectImageFilesystemTargets), { path: "screenshots/a.png" }, CWD)).toEqual(
			[],
		);
		// An attachment reference is never treated as a cwd escape.
		expect(cwdEscapingTargets(toolWith(inspectImageFilesystemTargets), { path: "Image #2" }, CWD)).toEqual([]);
	});

	it("edit reports the path arg AND every file named by an apply-patch body", () => {
		expect(editFilesystemTargets({ path: "src/a.ts" })).toEqual(["src/a.ts"]);
		// A single apply-patch call can mutate several files — all must be gated.
		const input = "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: /etc/evil.sh\n*** End Patch";
		expect(editFilesystemTargets({ input })).toEqual(["src/a.ts", "/etc/evil.sh"]);
		// The out-of-cwd member of a multi-file patch is flagged by the boundary.
		expect(cwdEscapingTargets(toolWith(editFilesystemTargets), { input }, CWD)).toEqual(["/etc/evil.sh"]);
	});

	it("edit reports a move DESTINATION so an out-of-cwd move cannot dodge the gate", () => {
		// A move writes the file to a NEW path. Both edit formats can move, and the
		// SOURCE being in-cwd must not let the destination escape unprompted.
		// apply-patch `*** Move to:` — source in cwd, destination outside.
		const applyPatch =
			"*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: /etc/cron.d/evil\n@@\n-x\n+y\n*** End Patch";
		expect(editFilesystemTargets({ input: applyPatch })).toEqual(["src/a.ts", "/etc/cron.d/evil"]);
		expect(cwdEscapingTargets(toolWith(editFilesystemTargets), { input: applyPatch }, CWD)).toEqual([
			"/etc/cron.d/evil",
		]);
		// hashline `MV <dest>` line inside a `[path]` block — same escape vector.
		const hashline = "[src/a.ts]\nMV /etc/cron.d/evil2\n";
		expect(editFilesystemTargets({ input: hashline })).toEqual(["src/a.ts", "/etc/cron.d/evil2"]);
		expect(cwdEscapingTargets(toolWith(editFilesystemTargets), { input: hashline }, CWD)).toEqual([
			"/etc/cron.d/evil2",
		]);
		// An in-cwd move stays in-bounds (both directions inside cwd).
		const inCwd = "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n*** End Patch";
		expect(cwdEscapingTargets(toolWith(editFilesystemTargets), { input: inCwd }, CWD)).toEqual([]);
	});

	it("grep/glob/ast_grep search roots escape when the path base is outside cwd", () => {
		// Policy (FINDING-CWD-BOUNDARY-SEARCH-TOOLS): search tools gate like point
		// reads — an out-of-cwd search root prompts in non-yolo modes. Bases come
		// from globSearchBase (literal path, or the fixed prefix before the first
		// glob meta). Omitted path / bare relative patterns stay in-bounds.
		expect(searchPathFilesystemTargets({ path: "/etc/passwd" })).toEqual(["/etc/passwd"]);
		expect(searchPathFilesystemTargets({ path: "/etc/**" })).toEqual(["/etc"]);
		expect(searchPathFilesystemTargets({ path: "src;/etc" })).toEqual(["src", "/etc"]);
		expect(searchPathFilesystemTargets({ paths: ["/var/log", "src"] })).toEqual(["/var/log", "src"]);
		expect(searchPathFilesystemTargets({ path: "*.ts" })).toEqual([""]);
		expect(searchPathFilesystemTargets({})).toEqual([]);

		const search = toolWith(searchPathFilesystemTargets);
		expect(cwdEscapingTargets(search, { path: "/etc/passwd" }, CWD)).toEqual(["/etc/passwd"]);
		expect(cwdEscapingTargets(search, { path: "/etc/**" }, CWD)).toEqual(["/etc"]);
		expect(cwdEscapingTargets(search, { path: "src;/etc" }, CWD)).toEqual(["/etc"]);
		expect(cwdEscapingTargets(search, { path: "src" }, CWD)).toEqual([]);
		expect(cwdEscapingTargets(search, { path: "*.ts" }, CWD)).toEqual([]);
		expect(cwdEscapingTargets(search, {}, CWD)).toEqual([]);
	});
});

describe("formatCwdBoundaryReason", () => {
	it("names the cwd, the offending path, and both ways forward", () => {
		const reason = formatCwdBoundaryReason(CWD, ["/etc/passwd"]);
		expect(reason).toContain(CWD);
		expect(reason).toContain("/etc/passwd");
		expect(reason).toContain("outside the session working directory");
		expect(reason).toContain("yolo");
	});
});

describe("filesystem cwd boundary through the approval gate", () => {
	// End-to-end: the boundary must fire inside ExtensionToolWrapper (the single
	// approval chokepoint) for real read/write tools. Differential design: an
	// in-cwd read auto-approves in `ask` mode (proving the read tier is NOT the
	// blocker), while the same-mode out-of-cwd read is blocked (proving the
	// boundary IS). yolo bypasses both.
	let tempDir: string;
	let cwd: string;
	let insideFile: string;
	let outsideFile: string;
	let sessionManager: SessionManager;
	let session: AgentSession;

	const BASE_SETTINGS = {
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"bashInterceptor.enabled": false,
	} as const;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-cwd-boundary-${Snowflake.next()}-`));
		cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		insideFile = path.join(cwd, "inside.txt");
		fs.writeFileSync(insideFile, "INSIDE_CONTENT");
		// A sibling of cwd, deliberately NOT under it.
		outsideFile = path.join(tempDir, "outside.txt");
		fs.writeFileSync(outsideFile, "OUTSIDE_CONTENT");

		sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated(BASE_SETTINGS),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "write", "edit", "grep", "glob"],
		});
		session = created.session;
	});

	afterAll(async () => {
		await session.dispose();
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				removeSyncWithRetries(tempDir);
				break;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw err;
				if (attempt === 4) break;
				await Bun.sleep(50 * (attempt + 1));
			}
		}
	});

	function ctx(extraSettings: Record<string, unknown> = {}, extra: Partial<AgentToolContext> = {}): AgentToolContext {
		return {
			settings: Settings.isolated({ ...BASE_SETTINGS, ...extraSettings }),
			sessionManager,
			...extra,
		} as AgentToolContext;
	}

	function tool(name: "read" | "write" | "edit" | "grep" | "glob") {
		const t = session.getToolByName(name);
		if (!t) throw new Error(`expected ${name} tool`);
		return t;
	}

	function textOf(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
		for (const block of result.content ?? []) {
			if (block.type === "text" && typeof block.text === "string") return block.text;
		}
		return "";
	}

	it("auto-approves an in-cwd read in ask mode (read tier is not the blocker)", async () => {
		const result = await tool("read").execute(
			"in-ask",
			{ path: insideFile },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "ask" }),
		);
		expect(textOf(result)).toContain("INSIDE_CONTENT");
	});

	it("blocks an out-of-cwd read in ask mode, naming the boundary", async () => {
		await expect(
			tool("read").execute(
				"out-ask",
				{ path: outsideFile },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "ask" }),
			),
		).rejects.toThrow(/outside the session working directory/);
	});

	it("bypasses the boundary for an out-of-cwd read in yolo mode", async () => {
		const result = await tool("read").execute(
			"out-yolo",
			{ path: outsideFile },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "yolo" }),
		);
		expect(textOf(result)).toContain("OUTSIDE_CONTENT");
	});

	it("also bypasses the boundary when CLI --auto-approve is set", async () => {
		const result = await tool("read").execute(
			"out-autoapprove",
			{ path: outsideFile },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "ask" }, { autoApprove: true }),
		);
		expect(textOf(result)).toContain("OUTSIDE_CONTENT");
	});

	it("auto-approves an in-cwd write in auto-edit mode", async () => {
		const target = path.join(cwd, "written-inside.txt");
		await tool("write").execute(
			"win-autoedit",
			{ path: target, content: "hi" },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "auto-edit" }),
		);
		expect(fs.readFileSync(target, "utf8")).toBe("hi");
	});

	it("blocks an out-of-cwd write in auto-edit mode (write tier alone would have allowed it)", async () => {
		const target = path.join(tempDir, "written-outside.txt");
		await expect(
			tool("write").execute(
				"wout-autoedit",
				{ path: target, content: "nope" },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "auto-edit" }),
			),
		).rejects.toThrow(/outside the session working directory/);
		expect(fs.existsSync(target)).toBe(false);
	});

	it("allows an out-of-cwd write in yolo mode", async () => {
		const target = path.join(tempDir, "written-outside-yolo.txt");
		await tool("write").execute(
			"wout-yolo",
			{ path: target, content: "ok" },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "yolo" }),
		);
		expect(fs.readFileSync(target, "utf8")).toBe("ok");
	});

	it("blocks an out-of-cwd edit in auto-edit mode (the boundary fires before execute)", async () => {
		// The approval gate runs before execute, so no valid patch body is needed —
		// this proves `edit` (write-tier, like write) is wired into the boundary and
		// closes the read/write/edit asymmetry.
		const target = path.join(tempDir, "edited-outside.txt");
		fs.writeFileSync(target, "before");
		await expect(
			tool("edit").execute(
				"eout-autoedit",
				{ path: target, old_string: "before", new_string: "after" },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "auto-edit" }),
			),
		).rejects.toThrow(/outside the session working directory/);
		expect(fs.readFileSync(target, "utf8")).toBe("before");
	});

	it("blocks an out-of-cwd grep in ask mode (search tools honor the same boundary as read)", async () => {
		// Differential: in-cwd grep auto-approves (read tier alone is not the blocker);
		// out-of-cwd path is blocked by the cwd boundary before content leaks.
		const inside = await tool("grep").execute(
			"gin-ask",
			{ pattern: "INSIDE", path: cwd },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "ask" }),
		);
		expect(textOf(inside)).toContain("INSIDE_CONTENT");
		await expect(
			tool("grep").execute(
				"gout-ask",
				{ pattern: "OUTSIDE", path: outsideFile },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "ask" }),
			),
		).rejects.toThrow(/outside the session working directory/);
	});

	it("blocks an out-of-cwd glob in ask mode", async () => {
		await expect(
			tool("glob").execute(
				"glob-out-ask",
				{ path: path.join(tempDir, "*") },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "ask" }),
			),
		).rejects.toThrow(/outside the session working directory/);
	});
});
