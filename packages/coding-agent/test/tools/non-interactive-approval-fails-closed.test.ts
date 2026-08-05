/**
 * With no interactive UI, a tool call that needs approval FAILS. It is never
 * quietly approved.
 *
 * WHY THIS SUITE EXISTS (PERM-1). Print mode, ACP, headless runs and subagents
 * all execute tools with nobody to answer a prompt. There are only two possible
 * designs at that moment: refuse the call, or approve it because no one objected.
 * The second is the dangerous one and it is dangerous precisely because it looks
 * like nothing happened. A run that silently auto-approves produces the same
 * transcript as a run where every call was legitimately allowed.
 *
 * The wrapper picks the first design: `ExtensionToolWrapper.execute` checks
 * `runner.hasUI()` and throws. This suite pins that for EVERY approval mode and
 * for both reasons a call can need approval, because the two arrive by different
 * paths and either could regress alone:
 *
 *   - the TIER (an `exec` tool in `ask`, a `write` tool in `ask`), and
 *   - the WORKING-DIRECTORY BOUNDARY (an in-tier tool aimed outside cwd).
 *
 * A test that only covered the tier would miss a boundary refusal turning into a
 * silent allow, which is the case that actually writes to the wrong file.
 *
 * The differential matters as much as the refusals: `yolo` MUST still run these
 * calls. Without that, a change that broke every non-interactive tool call would
 * satisfy every other assertion here.
 *
 * Subagents are covered by assertion rather than by spawning one: `task/executor`
 * pins `tools.approvalMode: yolo` deliberately, so the parent `task` approval is
 * the authorization boundary. That is a real decision and it is asserted as such,
 * so a silent change to it fails here.
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
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";

// The code under test opens `AgentStorage`, which resolves `agent.db` under the
// ACTIVE PROFILE's agent dir. Without this the suite writes into the developer's
// real `~/.veyyon/profiles/<profile>/agent`.
//
// `globalSettings` rather than a second `useIsolatedGlobalSettings()` call: `executeBash`
// calls `Settings.init()` itself, reaching past the session stub to the real config root,
// so the singleton has to be pre-initialized in memory too. Two file-level helpers would
// restore in registration order and the second would put this file's temp agent dir back
// on the way out, which is exactly the leak this file used to produce.
useIsolatedAgentDir({ globalSettings: true });

/**
 * Modes that gate a mutating call by ASKING. `plan` is deliberately absent: it
 * does not ask, it hard-denies mutating tools before the approval layer is
 * reached, which is a stricter answer and is asserted on its own below. `yolo` is
 * absent because it is the carve-out, also asserted on its own.
 */
const ASKING_MODES: string[] = ["ask", "auto-edit"];

/** Modes that gate a READ outside cwd. Plan belongs here: reads are non-mutating,
 * so plan allows the tier and only the boundary stands in the way. */
const READ_GATING_MODES: string[] = ["plan", "ask", "auto-edit"];

/** Plan mode's own refusal, which fires before any approval prompt. */
const PLAN_DENY = /non-mutating tools only/;

const BASE_SETTINGS = {
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"bashInterceptor.enabled": false,
} as const;

/** The refusal message the wrapper produces when nobody can be asked. */
const NO_UI = /requires approval but no interactive UI available/;
/** The boundary half of a refusal reason, which must LEAD the message. */
const OUTSIDE_CWD = /outside the session working directory/;

let tempDir: string;
let cwd: string;
let outsideFile: string;
let sessionManager: SessionManager;
let session: AgentSession;

beforeAll(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-noninteractive-approval-"));
	cwd = path.join(tempDir, "cwd");
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(path.join(cwd, "inside.txt"), "INSIDE");
	outsideFile = path.join(tempDir, "outside.txt");
	fs.writeFileSync(outsideFile, "OUTSIDE");

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
		toolNames: ["read", "write", "bash"],
	});
	session = created.session;
});

afterAll(async () => {
	await session.dispose();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function ctx(mode: string): AgentToolContext {
	return {
		settings: Settings.isolated({ ...BASE_SETTINGS, "tools.approvalMode": mode }),
		sessionManager,
	} as Partial<AgentToolContext> as AgentToolContext;
}

function tool(name: "read" | "write" | "bash") {
	const found = session.getToolByName(name);
	if (!found) throw new Error(`expected ${name} tool`);
	return found;
}

function textOf(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
	for (const block of result.content ?? []) {
		if (block.type === "text" && typeof block.text === "string") return block.text;
	}
	return "";
}

describe("a tier that requires approval refuses when there is no UI", () => {
	/**
	 * `bash` is exec-tier, which every gating mode prompts for. The call must not
	 * run: an auto-approved shell command in a headless run is the worst version
	 * of this bug.
	 */
	it.each(ASKING_MODES)("refuses an exec tool in %s mode", async mode => {
		const marker = path.join(cwd, `exec-ran-${mode}.txt`);
		await expect(
			tool("bash").execute(
				`exec-${mode}`,
				{ command: `touch ${marker}`, timeout: 30 },
				undefined,
				undefined,
				ctx(mode),
			),
		).rejects.toThrow(NO_UI);
		// The refusal must happen BEFORE the command runs, not after.
		expect(fs.existsSync(marker)).toBe(false);
	});

	/** `ask` prompts for the write tier, so an in-cwd write is refused there on
	 * tier alone. `auto-edit` is excluded because it approves that tier; it is
	 * covered by the boundary block below. */
	it("refuses an in-cwd write in ask mode", async () => {
		const target = path.join(cwd, "tier-write-ask.txt");
		await expect(
			tool("write").execute("w-ask", { path: target, content: "nope" }, undefined, undefined, ctx("ask")),
		).rejects.toThrow(NO_UI);
		expect(fs.existsSync(target)).toBe(false);
	});
});

describe("the working-directory boundary refuses when there is no UI", () => {
	/**
	 * THE case the tier checks cannot catch. In `auto-edit` the write tier is
	 * approved, so only the boundary stands between the model and a file outside
	 * the workspace. If the no-UI path auto-approved instead of refusing, this
	 * write would land.
	 */
	it.each(ASKING_MODES)("refuses an out-of-cwd write in %s mode", async mode => {
		const target = path.join(tempDir, `boundary-write-${mode}.txt`);
		await expect(
			tool("write").execute(`bw-${mode}`, { path: target, content: "nope" }, undefined, undefined, ctx(mode)),
		).rejects.toThrow(OUTSIDE_CWD);
		expect(fs.existsSync(target)).toBe(false);
	});

	/** Reads leak rather than damage, but they leak real file contents, so the
	 * boundary must refuse them on the same terms. */
	it.each(READ_GATING_MODES)("refuses an out-of-cwd read in %s mode", async mode => {
		await expect(
			tool("read").execute(`br-${mode}`, { path: outsideFile }, undefined, undefined, ctx(mode)),
		).rejects.toThrow(OUTSIDE_CWD);
	});

	/**
	 * The message must LEAD with the boundary reason. A headless operator sees
	 * only this string: "approval required" alone sends them to toggle a mode,
	 * while the path tells them what the run actually tried to touch.
	 */
	it("leads the refusal message with the offending path, then the generic reason", async () => {
		let message = "";
		try {
			await tool("read").execute("msg", { path: outsideFile }, undefined, undefined, ctx("ask"));
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain(outsideFile);
		expect(message).toMatch(OUTSIDE_CWD);
		expect(message).toMatch(NO_UI);
		expect(message.indexOf("outside the session working directory")).toBeLessThan(
			message.indexOf("requires approval but no interactive UI"),
		);
	});

	/** And it must name a way forward, or the operator is told only that they are
	 * blocked. */
	it("names the settings that would allow the call", async () => {
		let message = "";
		try {
			await tool("read").execute("msg2", { path: outsideFile }, undefined, undefined, ctx("ask"));
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("tools.approvalMode");
		expect(message).toContain("tools.approval.read");
	});
});

describe("plan mode denies outright rather than asking", () => {
	/**
	 * Found by this suite: plan mode does NOT fall through to the no-UI refusal.
	 * It rejects mutating tools with its own message before the approval layer is
	 * consulted. That is the stronger answer, and it is worth pinning separately,
	 * because a change that routed plan mode through the ordinary approval path
	 * would still "refuse" in a headless run while silently becoming approvable
	 * the moment a UI was present.
	 */
	it("denies an in-cwd write with the plan-autonomy reason, not an approval prompt", async () => {
		const target = path.join(cwd, "plan-write.txt");
		await expect(
			tool("write").execute("plan-w", { path: target, content: "nope" }, undefined, undefined, ctx("plan")),
		).rejects.toThrow(PLAN_DENY);
		expect(fs.existsSync(target)).toBe(false);
	});

	/** Out-of-cwd is denied by the same rule; the boundary never gets a say
	 * because the tier is refused first. */
	it("denies an out-of-cwd write with the same reason", async () => {
		const target = path.join(tempDir, "plan-write-outside.txt");
		await expect(
			tool("write").execute("plan-wo", { path: target, content: "nope" }, undefined, undefined, ctx("plan")),
		).rejects.toThrow(PLAN_DENY);
		expect(fs.existsSync(target)).toBe(false);
	});

	/** The message must say how to proceed, since "denied" without a next step
	 * reads as a bug to whoever hits it. */
	it("names the autonomy level that would allow the call", async () => {
		let message = "";
		try {
			await tool("write").execute("plan-msg", { path: path.join(cwd, "x.txt") }, undefined, undefined, ctx("plan"));
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("ask");
	});

	/** Reads still work in plan mode, or the denial would be indistinguishable
	 * from plan mode simply being broken. */
	it("still allows an in-cwd read", async () => {
		const result = await tool("read").execute(
			"plan-r",
			{ path: path.join(cwd, "inside.txt") },
			undefined,
			undefined,
			ctx("plan"),
		);
		expect(textOf(result)).toContain("INSIDE");
	});
});

describe("yolo is the documented carve-out and still runs", () => {
	/**
	 * The differential. Every refusal above would also pass if non-interactive
	 * runs had simply stopped executing tools; these prove the refusals are the
	 * approval gate doing its job and not a broken execution path.
	 */
	it("runs an out-of-cwd read in yolo mode", async () => {
		const result = await tool("read").execute("y-read", { path: outsideFile }, undefined, undefined, ctx("yolo"));
		expect(textOf(result)).toContain("OUTSIDE");
	});

	it("runs an out-of-cwd write in yolo mode", async () => {
		const target = path.join(tempDir, "yolo-write.txt");
		await tool("write").execute("y-write", { path: target, content: "ok" }, undefined, undefined, ctx("yolo"));
		expect(fs.readFileSync(target, "utf8")).toBe("ok");
	});

	it("runs an exec tool in yolo mode", async () => {
		const result = await tool("bash").execute(
			"y-bash",
			{ command: "printf 'ran\\n'", timeout: 30 },
			undefined,
			undefined,
			ctx("yolo"),
		);
		expect(textOf(result)).toContain("ran");
	});
});
