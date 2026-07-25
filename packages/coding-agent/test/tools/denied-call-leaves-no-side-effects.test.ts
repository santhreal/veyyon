/**
 * A refused tool call changes nothing. Not the file, not the directory, not the
 * session.
 *
 * WHY THIS SUITE EXISTS (PERM-3). "The call was denied" is only meaningful if
 * denial happens BEFORE the work. A gate that refuses after the fact returns an
 * error while the file is already on disk, and that is strictly worse than no
 * gate: the transcript says the call was blocked, so nobody goes looking.
 *
 * Every assertion here is therefore about the WORLD, not about the error. The
 * error is checked only enough to confirm the refusal came from the gate and not
 * from the tool failing for some unrelated reason. What is asserted is that the
 * target file does not exist, that an existing file still holds its original
 * bytes, that no stray entry appeared in the directory, and that the session cwd
 * is unchanged.
 *
 * Refusals arrive by three different routes, and each gets its own coverage
 * because they run at different points and could regress independently:
 *
 *   1. plan mode's hard denial of mutating tools,
 *   2. the working-directory boundary in an asking mode, and
 *   3. an explicit `tools.approval.<tool>: deny` policy.
 *
 * The partial-write case is the sharp one. `write` truncates before it writes, so
 * a gate that ran late would leave an EMPTY file where a populated one was. That
 * is asserted directly by writing known content first and reading it back after
 * the refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";

// `executeBash` calls `Settings.init()` itself, reaching past the session stub to
// the real config root. One line isolates the singleton (and the dir resolver and
// env) for this whole file; see the helper for why a session stub is not enough.
useIsolatedGlobalSettings();

const BASE_SETTINGS = {
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"bashInterceptor.enabled": false,
} as const;

/** Content written before each refusal, so a late gate shows up as a change. */
const ORIGINAL = "ORIGINAL-CONTENT-DO-NOT-TOUCH";

let tempDir: string;
let cwd: string;
let sessionManager: SessionManager;
let session: AgentSession;

beforeAll(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-denied-no-side-effects-"));
	cwd = path.join(tempDir, "cwd");
	fs.mkdirSync(cwd, { recursive: true });

	sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
	const created = await createAgentSession({
		cwd,
		agentDir: tempDir,
		sessionManager,
		authStorage: await isolatedAuthStorage(tempDir),
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
		toolNames: ["read", "write", "edit", "bash", "set_cwd"],
	});
	session = created.session;
});

afterAll(async () => {
	await session.dispose();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function ctx(extra: Record<string, unknown>): AgentToolContext {
	return {
		settings: Settings.isolated({ ...BASE_SETTINGS, ...extra }),
		sessionManager,
	} as Partial<AgentToolContext> as AgentToolContext;
}

function tool(name: "read" | "write" | "edit" | "bash" | "set_cwd") {
	const found = session.getToolByName(name);
	if (!found) throw new Error(`expected ${name} tool`);
	return found;
}

/** A file inside cwd holding known content, plus its path. */
function seededFile(name: string): string {
	const file = path.join(cwd, name);
	fs.writeFileSync(file, ORIGINAL);
	return file;
}

describe("a refused write creates nothing", () => {
	/** The simplest side effect: the file must not come into existence. */
	it("leaves a new file uncreated when plan mode denies", async () => {
		const target = path.join(cwd, "never-created-plan.txt");
		await expect(
			tool("write").execute(
				"d1",
				{ path: target, content: "x" },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "plan" }),
			),
		).rejects.toThrow();
		expect(fs.existsSync(target)).toBe(false);
	});

	/** Same, via the boundary rather than the tier. */
	it("leaves a new file uncreated when the boundary denies", async () => {
		const target = path.join(tempDir, "never-created-boundary.txt");
		await expect(
			tool("write").execute(
				"d2",
				{ path: target, content: "x" },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "auto-edit" }),
			),
		).rejects.toThrow(/outside the session working directory/);
		expect(fs.existsSync(target)).toBe(false);
	});

	/** Same, via an explicit deny policy, which is a different branch again. */
	it("leaves a new file uncreated when a deny policy blocks the tool", async () => {
		const target = path.join(cwd, "never-created-deny.txt");
		await expect(
			tool("write").execute(
				"d3",
				{ path: target, content: "x" },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "yolo", "tools.approval": { write: "deny" } }),
			),
		).rejects.toThrow();
		expect(fs.existsSync(target)).toBe(false);
	});

	/** And the directory must not have gained anything at all, which catches a
	 * temp/partial file a per-path existence check would miss. */
	it("adds no entry to the directory", async () => {
		const before = fs.readdirSync(cwd).sort();
		await expect(
			tool("write").execute(
				"d4",
				{ path: path.join(cwd, "ghost.txt"), content: "x" },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "plan" }),
			),
		).rejects.toThrow();
		expect(fs.readdirSync(cwd).sort()).toEqual(before);
	});
});

describe("a refused overwrite preserves the original bytes", () => {
	/**
	 * THE sharp case. `write` truncates before writing, so a gate that ran even
	 * slightly late would leave this file EMPTY while reporting the call denied.
	 * Asserting the exact original content is what distinguishes "denied" from
	 * "denied after damage".
	 */
	it.each([
		["plan mode", { "tools.approvalMode": "plan" }],
		["a deny policy", { "tools.approvalMode": "yolo", "tools.approval": { write: "deny" } }],
		["no UI in ask mode", { "tools.approvalMode": "ask" }],
	])("keeps the file byte-identical when refused by %s", async (label, settings) => {
		const file = seededFile(`overwrite-${label.replace(/\W+/g, "-")}.txt`);
		await expect(
			tool("write").execute("o1", { path: file, content: "REPLACED" }, undefined, undefined, ctx(settings)),
		).rejects.toThrow();
		expect(fs.readFileSync(file, "utf8")).toBe(ORIGINAL);
	});

	/** `edit` is a different tool with the same stakes: a refused edit must not
	 * apply half a patch. */
	it("keeps the file byte-identical when a refused edit targets it", async () => {
		const file = seededFile("edit-refused.txt");
		await expect(
			tool("edit").execute(
				"o2",
				{ path: file, old_string: ORIGINAL, new_string: "REPLACED" },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "plan" }),
			),
		).rejects.toThrow();
		expect(fs.readFileSync(file, "utf8")).toBe(ORIGINAL);
	});
});

describe("a refused exec runs no command", () => {
	/**
	 * The refusal has to happen before the shell starts. A marker file is the only
	 * honest way to check: an error return proves nothing about whether the
	 * command already ran.
	 */
	it("does not run the command when the tier is refused", async () => {
		const marker = path.join(cwd, "exec-marker.txt");
		await expect(
			tool("bash").execute(
				"e1",
				{ command: `printf 'ran' > ${marker}`, timeout: 30 },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "ask" }),
			),
		).rejects.toThrow();
		expect(fs.existsSync(marker)).toBe(false);
	});

	/** And when an explicit deny policy blocks it, which short-circuits earlier. */
	it("does not run the command when a deny policy blocks it", async () => {
		const marker = path.join(cwd, "exec-marker-deny.txt");
		await expect(
			tool("bash").execute(
				"e2",
				{ command: `printf 'ran' > ${marker}`, timeout: 30 },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "yolo", "tools.approval": { bash: "deny" } }),
			),
		).rejects.toThrow();
		expect(fs.existsSync(marker)).toBe(false);
	});
});

describe("a refused re-root leaves the session where it was", () => {
	/**
	 * Session state is a side effect too, and a quieter one than a file: nothing
	 * on disk records that the working directory moved. If a refused `set_cwd`
	 * still applied, every later call would be judged against the new root while
	 * the transcript showed the re-root denied.
	 */
	it("keeps the session cwd unchanged after a refused set_cwd", async () => {
		expect(sessionManager.getCwd()).toBe(cwd);
		await expect(
			tool("set_cwd").execute(
				"s1",
				{ path: tempDir },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "auto-edit" }),
			),
		).rejects.toThrow(/outside the session working directory/);
		expect(sessionManager.getCwd()).toBe(cwd);
	});

	/** The differential: an allowed re-root DOES move it, so the assertion above
	 * is measuring the refusal and not a `set_cwd` that never works. */
	it("moves the session cwd when the re-root is allowed", async () => {
		const nested = path.join(cwd, "nested");
		fs.mkdirSync(nested, { recursive: true });
		await tool("set_cwd").execute(
			"s2",
			{ path: nested },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "auto-edit" }),
		);
		expect(sessionManager.getCwd()).toBe(nested);
		await sessionManager.setCwd?.(cwd, { validate: true });
		expect(sessionManager.getCwd()).toBe(cwd);
	});
});
