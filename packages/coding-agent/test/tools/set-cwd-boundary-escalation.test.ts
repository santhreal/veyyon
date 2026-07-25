/**
 * `set_cwd` cannot be used to escape the boundary that confines `set_cwd`.
 *
 * WHY THIS SUITE EXISTS. The cwd boundary gates every filesystem tool by asking
 * whether the target lies under the session working directory. `set_cwd` is the
 * one tool that CHANGES that directory, and it declared no filesystem targets,
 * so the boundary never looked at it.
 *
 * That made it a privilege escalation, and specifically in `auto-edit`, the rung
 * whose entire contract is "workspace writes are free, anything else asks":
 *
 *   1. `set_cwd <parent-of-cwd>`: write-tier, auto-approved in auto-edit, no
 *      prompt. (Not `/`, which `resolveToCwd` treats as the workspace-root alias
 *      and so resolves back to cwd. That is asserted below.)
 *   2. A write anywhere under that new root: now lexically INSIDE cwd, so the
 *      boundary passes it, and it too is auto-approved by the write tier.
 *
 * Two unremarkable calls, no prompt at either step, and a session advertised as
 * workspace-confined has written to the root filesystem. Nothing in the
 * transcript reads as an escape, which is what makes it worth a dedicated suite
 * rather than a line in the general boundary tests.
 *
 * The escalation is reproduced end to end below (`the escalation this prevents`)
 * so the test fails for the real reason and not merely because a helper stopped
 * returning a string. The narrowing case is asserted just as hard: re-rooting
 * DEEPER into the workspace is a restriction, not an escape, and prompting for
 * it would train the operator to approve without reading.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { cwdEscapingTargets } from "@veyyon/coding-agent/tools/cwd-boundary";
import { setCwdFilesystemTargets } from "@veyyon/coding-agent/tools/set-cwd";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("setCwdFilesystemTargets", () => {
	/** The declaration itself: the boundary only inspects tools that expose
	 * targets, so returning the path is what puts `set_cwd` under the gate. */
	it("reports the requested directory as a filesystem target", () => {
		expect(setCwdFilesystemTargets({ path: "/etc" })).toEqual(["/etc"]);
	});

	/** The tool trims before resolving, so the target must be measured on the
	 * same string the tool will act on, or the two could disagree. */
	it("trims the path so the gate sees what the tool will resolve", () => {
		expect(setCwdFilesystemTargets({ path: "  /etc  " })).toEqual(["/etc"]);
	});

	/** A missing or blank path is rejected by `execute` with "path is required".
	 * Reporting a target here would make the boundary the thing that complains,
	 * and the operator would get a containment prompt for a malformed call. */
	it.each([
		["missing", {}],
		["empty", { path: "" }],
		["whitespace only", { path: "   " }],
		["not a string", { path: 42 }],
		["null args", null],
	])("reports no target for a %s path", (_label, args) => {
		expect(setCwdFilesystemTargets(args)).toEqual([]);
	});
});

describe("the boundary judges a re-root the same way it judges a write", () => {
	let root: string;
	let workspace: string;

	const tool = { filesystemTargets: setCwdFilesystemTargets };
	const escaping = (target: string) => cwdEscapingTargets(tool, { path: target }, workspace);

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-setcwd-boundary-"));
		workspace = path.join(root, "workspace");
		fs.mkdirSync(path.join(workspace, "packages", "app"), { recursive: true });
		fs.mkdirSync(path.join(root, "elsewhere"), { recursive: true });
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	/**
	 * A bare `/` is NOT the escape it looks like: `resolveToCwd` treats it as the
	 * workspace-root alias, so `set_cwd /` resolves to cwd and re-roots nowhere.
	 * Pinned because the obvious reading is the opposite one, and a future change
	 * that made `/` mean the real filesystem root would turn the most natural
	 * spelling of the escape back on while every other test here stayed green.
	 */
	it("treats a bare / as the workspace-root alias, not an escape", () => {
		expect(escaping("/")).toEqual([]);
	});

	/** The parent directory: a single step out is still out, and it is the step
	 * that puts every sibling project in reach. */
	it("reports a re-root to the parent directory as escaping", () => {
		expect(escaping(path.dirname(workspace))).toHaveLength(1);
	});

	/** A sibling tree, which is the realistic case: the model is asked about
	 * another checkout and re-roots to it rather than reading across. */
	it("reports a re-root to a sibling directory as escaping", () => {
		expect(escaping(path.join(root, "elsewhere"))).toHaveLength(1);
	});

	/** Spelled relatively, since `..` is how a re-root out is usually written. */
	it("reports a relative parent traversal as escaping", () => {
		expect(escaping("../elsewhere")).toHaveLength(1);
	});

	/**
	 * NARROWING is not escaping, and this half matters as much. Moving deeper
	 * into the workspace strictly shrinks what the session can touch; prompting
	 * for a restriction is the false positive that teaches operators to approve
	 * blind.
	 */
	it("does not report a re-root deeper into the workspace", () => {
		expect(escaping(path.join(workspace, "packages", "app"))).toEqual([]);
		expect(escaping("packages/app")).toEqual([]);
	});

	/** Re-rooting to the current directory is a no-op the tool handles
	 * explicitly; it must not be dressed up as a containment event. */
	it("does not report a re-root to the current directory", () => {
		expect(escaping(workspace)).toEqual([]);
		expect(escaping(".")).toEqual([]);
	});

	/**
	 * The symlink case, inherited from the boundary rather than reimplemented.
	 * A link inside the workspace pointing out of it reads as inside lexically,
	 * and re-rooting through it would be the same escape wearing a disguise.
	 */
	it("reports a re-root through a symlink that leaves the workspace", () => {
		const link = path.join(workspace, "out-link");
		if (!fs.existsSync(link)) fs.symlinkSync(path.join(root, "elsewhere"), link);
		expect(escaping("out-link")).toHaveLength(1);
	});
});

describe("the escalation this prevents, driven through the real approval gate", () => {
	// Full session, real tools, real wrapper: the assertion is about what the
	// approval chokepoint does with a `set_cwd` call, and a hand-built stub could
	// pass while the shipped path still escaped.
	let tempDir: string;
	let cwd: string;
	let sessionManager: SessionManager;
	let session: AgentSession;
	// `setCwd` re-roots the PROCESS-GLOBAL project dir, so this suite must hand it
	// back before its temp tree is deleted. Without the snapshot, the next test
	// file to call `beginSettingsTest` captures a path inside this suite's temp
	// dir and then fails to chdir into it once `afterAll` has removed it.
	let globals: SettingsTestState | undefined;

	const BASE_SETTINGS = {
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"bashInterceptor.enabled": false,
	} as const;

	beforeAll(async () => {
		globals = beginSettingsTest();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-setcwd-escalation-"));
		cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(path.join(cwd, "nested"), { recursive: true });

		sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager,
			// Isolated store, or session creation falls through to
			// `discoverAuthStorage`, which opens the operator's real machine-wide
			// `~/.veyyon/shared-auth/agent.db` and trips the real-data guard.
			authStorage: await AuthStorage.create(path.join(tempDir, "auth.db")),
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
			toolNames: ["set_cwd", "write"],
		});
		session = created.session;
	});

	afterAll(async () => {
		await session.dispose();
		// Restore BEFORE the rm: the restore chdirs, and the path it chdirs to must
		// still exist.
		restoreSettingsTestState(globals);
		globals = undefined;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function ctx(mode: string): AgentToolContext {
		return {
			settings: Settings.isolated({ ...BASE_SETTINGS, "tools.approvalMode": mode }),
			sessionManager,
		} as Partial<AgentToolContext> as AgentToolContext;
	}

	function setCwdTool() {
		const t = session.getToolByName("set_cwd");
		if (!t) throw new Error("expected set_cwd tool");
		return t;
	}

	/**
	 * STEP 1 OF THE OLD ESCALATION, now blocked. Before this change the write
	 * tier auto-approved this call and it simply succeeded, silently widening the
	 * session to the whole filesystem. There is no interactive UI in a test run,
	 * so a call that now requires approval surfaces as a throw naming the reason.
	 */
	it("refuses to re-root out of the workspace in auto-edit mode", async () => {
		await expect(
			setCwdTool().execute("escalate", { path: tempDir }, undefined, undefined, ctx("auto-edit")),
		).rejects.toThrow(/outside the session working directory/);
	});

	/** The session cwd must be UNCHANGED after the refusal. A gate that blocks
	 * the call but leaves the re-root applied would be worse than none. */
	it("leaves the session cwd untouched after a refused re-root", () => {
		expect(sessionManager.getCwd()).toBe(cwd);
	});

	/** `ask` mode is stricter than auto-edit and must not be looser here. */
	it("refuses to re-root out of the workspace in ask mode", async () => {
		await expect(
			setCwdTool().execute("escalate-ask", { path: tempDir }, undefined, undefined, ctx("ask")),
		).rejects.toThrow(/outside the session working directory/);
	});

	/**
	 * The differential that proves the BOUNDARY is the blocker and not the write
	 * tier: the same tool, the same mode, a target inside cwd, and it succeeds.
	 * Without this, every assertion above would still pass if `set_cwd` had
	 * simply become unusable in auto-edit.
	 */
	it("allows narrowing into a subdirectory in auto-edit mode", async () => {
		const nested = path.join(cwd, "nested");
		await setCwdTool().execute("narrow", { path: nested }, undefined, undefined, ctx("auto-edit"));
		expect(sessionManager.getCwd()).toBe(nested);
		// Restore, so this test does not leak a re-root into the ones after it.
		await sessionManager.setCwd?.(cwd, { validate: true });
	});

	/** yolo opts out of all permission, so it opts out of this too. Asserting it
	 * keeps the change from quietly becoming an unconditional restriction. */
	it("allows an out-of-workspace re-root in yolo mode", async () => {
		await setCwdTool().execute("yolo-reroot", { path: tempDir }, undefined, undefined, ctx("yolo"));
		expect(sessionManager.getCwd()).toBe(tempDir);
		await sessionManager.setCwd?.(cwd, { validate: true });
	});
});
