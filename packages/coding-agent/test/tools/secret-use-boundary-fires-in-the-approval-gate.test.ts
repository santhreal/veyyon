/**
 * The secret-use boundary, end to end through the single approval chokepoint.
 *
 * `secret-use-needs-approval-outside-yolo.test.ts` pins the decision. This suite pins that the
 * decision is actually CONSULTED, inside `ExtensionToolWrapper`, by a real tool from a real session.
 * The two halves are separate on purpose: a boundary that computes the right answer and is never
 * called is the failure mode a unit test cannot see, and it is how the gap being closed here came
 * about in the first place (expansion was audited and never gated).
 *
 * DIFFERENTIAL BY DESIGN, in the same shape as the cwd-boundary suite. A write with no credential in
 * it auto-approves in `auto-edit`, which proves the write TIER is not the blocker. The same write
 * carrying a credential is blocked in the same mode, which proves the boundary is. `yolo`, CLI
 * `--auto-approve`, and the `/yolo` session bypass all let it through, which is the "yolo bypasses
 * everything" posture stated as a test rather than as a comment.
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
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

/** The credential a tool call would spend. Long enough to clear the obfuscation floor. */
const TOKEN = "ghp_boundarygatecredential1234567890";

const BASE_SETTINGS = {
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"bashInterceptor.enabled": false,
} as const;

let tempDir: string;
let cwd: string;
let sessionManager: SessionManager;
let session: AgentSession;

beforeAll(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `secret-use-gate-${Snowflake.next()}-`));
	cwd = path.join(tempDir, "cwd");
	fs.mkdirSync(cwd, { recursive: true });
	sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
	const created = await createAgentSession({
		cwd,
		agentDir: tempDir,
		sessionManager,
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
		toolNames: ["read", "write"],
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
		}
	}
});

/**
 * A context carrying a redactor that knows exactly one credential.
 *
 * The wrapper asks the context for the session's redactor, so a stub is the whole seam and this
 * suite needs no vault on disk. What it is proving is the wiring, not the obfuscator.
 */
function ctx(extraSettings: Record<string, unknown> = {}, extra: Partial<AgentToolContext> = {}): AgentToolContext {
	return {
		settings: Settings.isolated({ ...BASE_SETTINGS, ...extraSettings }),
		sessionManager,
		obfuscateProviderText: (text: string) => text.replaceAll(TOKEN, "#DEPLOY_TOKEN#"),
		...extra,
	} as AgentToolContext;
}

function writeTool() {
	const tool = session.getToolByName("write");
	if (!tool) throw new Error("expected write tool");
	return tool;
}

describe("a credential-bearing call at the approval gate", () => {
	/** The control. Same tool, same mode, no credential: the write tier alone lets it run. */
	it("auto-approves a write with no credential in auto-edit mode", async () => {
		const target = path.join(cwd, "ordinary.txt");
		await writeTool().execute(
			"ordinary",
			{ path: target, content: "nothing secret here" },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "auto-edit" }),
		);
		expect(fs.readFileSync(target, "utf8")).toBe("nothing secret here");
	});

	/** THE GATE. Identical call plus a credential, blocked, with the secret named in the error. */
	it("blocks the same write when its content carries a credential", async () => {
		const target = path.join(cwd, "with-secret.txt");
		await expect(
			writeTool().execute(
				"carries-secret",
				{ path: target, content: `token=${TOKEN}` },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "auto-edit" }),
			),
		).rejects.toThrow(/uses stored secret: DEPLOY_TOKEN/);
		expect(fs.existsSync(target)).toBe(false);
	});

	/** The credential must not reach the error text, which is what a headless run logs. */
	it("does not put the credential in the blocking error", async () => {
		let message = "";
		try {
			await writeTool().execute(
				"no-leak",
				{ path: path.join(cwd, "no-leak.txt"), content: TOKEN },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "ask" }),
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("DEPLOY_TOKEN");
		expect(message).not.toContain(TOKEN);
	});

	/** It holds in every non-yolo mode, not only the one the first case used. */
	it.each(["plan", "ask", "auto-edit"] as const)("blocks a credential-bearing write in %s mode", async mode => {
		await expect(
			writeTool().execute(
				`mode-${mode}`,
				{ path: path.join(cwd, `mode-${mode}.txt`), content: TOKEN },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": mode }),
			),
		).rejects.toThrow();
	});
});

describe("what the boundary must not block", () => {
	/** yolo opts out of all permission, so it opts out of this. The shipped default asks nothing. */
	it("lets a credential-bearing write through in yolo mode", async () => {
		const target = path.join(cwd, "yolo.txt");
		await writeTool().execute(
			"yolo",
			{ path: target, content: `token=${TOKEN}` },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "yolo" }),
		);
		expect(fs.readFileSync(target, "utf8")).toBe(`token=${TOKEN}`);
	});

	/** CLI `--auto-approve` resolves to yolo, so it must behave identically. */
	it("lets it through when CLI --auto-approve is set", async () => {
		const target = path.join(cwd, "auto-approve.txt");
		await writeTool().execute(
			"auto-approve",
			{ path: target, content: TOKEN },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "ask" }, { autoApprove: true }),
		);
		expect(fs.readFileSync(target, "utf8")).toBe(TOKEN);
	});

	/** The `/yolo` session bypass is the third form of the same opt-out. */
	it("lets it through under the /yolo session bypass", async () => {
		const target = path.join(cwd, "bypass.txt");
		await writeTool().execute(
			"bypass",
			{ path: target, content: TOKEN },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "ask" }, { bypassAllApprovals: true }),
		);
		expect(fs.readFileSync(target, "utf8")).toBe(TOKEN);
	});

	/**
	 * An unexpanded placeholder is not a credential.
	 *
	 * This is what a call looks like when `secrets.enabled` is false: the text still says
	 * `#DEPLOY_TOKEN#` and no real value is present, so there is nothing to approve.
	 */
	it("lets a write carrying only a placeholder through in auto-edit mode", async () => {
		const target = path.join(cwd, "placeholder.txt");
		await writeTool().execute(
			"placeholder",
			{ path: target, content: "token=#DEPLOY_TOKEN#" },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "auto-edit" }),
		);
		expect(fs.readFileSync(target, "utf8")).toBe("token=#DEPLOY_TOKEN#");
	});

	/** With no redactor on the context nothing is configured to protect, so nothing changes. */
	it("does not block when the session has no redactor", async () => {
		const target = path.join(cwd, "no-redactor.txt");
		await writeTool().execute("no-redactor", { path: target, content: TOKEN }, undefined, undefined, {
			settings: Settings.isolated({ ...BASE_SETTINGS, "tools.approvalMode": "auto-edit" }),
			sessionManager,
		} as unknown as AgentToolContext);
		expect(fs.readFileSync(target, "utf8")).toBe(TOKEN);
	});
});
