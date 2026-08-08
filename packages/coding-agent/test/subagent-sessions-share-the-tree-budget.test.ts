/**
 * The one assumption the inherited budget group rests on, proved against the
 * REAL session composition root rather than against the registry helpers.
 *
 * `agent-session.ts` cannot take a parameter for "join this group instead of
 * opening your own": it belongs to another lane, and the code that knows the
 * answer (the task executor) is several layers above the code that needs it
 * (`AgentSession`'s constructor). The mechanism is therefore an
 * AsyncLocalStorage scope entered around `createAgentSession`, and it works
 * only because the constructor calls `initSessionCpuLimit` SYNCHRONOUSLY, so
 * the store is still visible when the registry reads it.
 *
 * That is a property of code this lane does not own and cannot pin with a
 * unit test of its own helpers: if `AgentSession` ever awaited before
 * registering, every one of those helper tests would stay green while every
 * subagent in production silently opened its own budget group again. So this
 * suite builds two real sessions through the real SDK and checks the group
 * they land in.
 *
 * It also drives `createSubagentSession`, the executor's own factory and the
 * only way production builds a subagent session, so deleting the pin inside
 * that factory turns this suite RED instead of leaving the registry-level
 * helper tests green.
 *
 * What it does NOT prove: that some future creation site bypasses the factory
 * altogether. There is exactly one today, and it pins.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession, type WorkspaceTree } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import {
	resetSessionCpuLimitsForTests,
	sessionCpuBudgetName,
	sessionCpuLimit,
	withInheritedBudgetGroup,
} from "@veyyon/coding-agent/session/cpu-limit";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { createSubagentSession } from "@veyyon/coding-agent/task/executor";
import { Snowflake, setAgentDir, TempDir } from "@veyyon/utils";
import { isolatedAuthStorage } from "./helpers/isolated-auth-storage";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const tempDirs: TempDir[] = [];
const sessions: AgentSession[] = [];
let globals: SettingsTestState | undefined;

function makeTempDir(prefix: string): TempDir {
	const dir = TempDir.createSync(`@veyyon-${prefix}-${Snowflake.next()}-`);
	tempDirs.push(dir);
	return dir;
}

function emptyWorkspaceTree(cwd: string): WorkspaceTree {
	return { rootPath: cwd, rendered: ".", truncated: false, totalLines: 1, agentsMdFiles: [] };
}

beforeEach(() => {
	globals = beginSettingsTest();
	setAgentDir(makeTempDir("budget-agentdir").path());
	resetSessionCpuLimitsForTests();
});

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	resetSessionCpuLimitsForTests();
	restoreSettingsTestState(globals);
	for (const dir of tempDirs.splice(0)) dir.removeSync();
});

/**
 * A real `AgentSession` with everything optional switched off: no MCP, no LSP,
 * no extension discovery, an isolated auth store and a temp agent dir.
 */
async function makeSession(spawn?: {
	parentSessionId?: string;
}): Promise<{ session: AgentSession; sessionId: string }> {
	const project = makeTempDir("budget-project");
	const cwd = project.join("project");
	fs.mkdirSync(cwd, { recursive: true });
	const agentDir = makeTempDir("budget-agent").path();
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected a bundled model");
	const sessionOptions: CreateAgentSessionOptions = {
		cwd,
		agentDir,
		authStorage: await isolatedAuthStorage(agentDir),
		sessionManager: SessionManager.create(cwd, path.join(project.path(), "sessions")),
		settings: Settings.isolated({ "session.cpuLimitCores": 0 }),
		model,
		disableExtensionDiscovery: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		workspaceTree: emptyWorkspaceTree(cwd),
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		toolNames: ["read"],
	};
	// A subagent is built the way the executor builds one, which is what carries
	// the pin. Passing no `spawn` at all is a root session.
	const { session } =
		spawn === undefined
			? await createAgentSession(sessionOptions)
			: await createSubagentSession(spawn.parentSessionId, sessionOptions);
	sessions.push(session);
	const sessionId = session.sessionManager.getSessionId();
	if (!sessionId) throw new Error("Expected the session manager to have minted an id");
	return { session, sessionId };
}

describe("a session created inside a pinned scope joins that group", () => {
	it("registers the subagent as a borrower of the root session's budget", async () => {
		const root = await makeSession();
		const child = await withInheritedBudgetGroup(root.sessionId, () => makeSession());

		const rootLimiter = sessionCpuLimit(root.sessionId);
		expect(rootLimiter).toBeDefined();
		// The constructor registers synchronously inside the scope, which is the
		// whole reason a scope can stand in for a constructor parameter.
		expect(sessionCpuLimit(child.sessionId)).toBe(rootLimiter);
		expect(rootLimiter?.budgetName).toBe(sessionCpuBudgetName(root.sessionId));
	});

	it("gives a session created OUTSIDE the scope its own budget", async () => {
		const root = await makeSession();
		const other = await makeSession();

		const rootLimiter = sessionCpuLimit(root.sessionId);
		const otherLimiter = sessionCpuLimit(other.sessionId);
		expect(rootLimiter).toBeDefined();
		expect(otherLimiter).toBeDefined();
		expect(otherLimiter).not.toBe(rootLimiter);
		expect(otherLimiter?.budgetName).toBe(sessionCpuBudgetName(other.sessionId));
	});

	/**
	 * The link the registry-level tests cannot see. `createSubagentSession` is
	 * what production calls, and its pin is the whole reason a subagent does not
	 * open a second budget group. Delete `withInheritedBudgetGroup` from it and
	 * every helper test stays green while this one fails.
	 */
	it("pins the tree's group from the executor's own subagent factory", async () => {
		const root = await makeSession();
		const child = await makeSession({ parentSessionId: root.sessionId });

		const rootLimiter = sessionCpuLimit(root.sessionId);
		expect(rootLimiter).toBeDefined();
		expect(sessionCpuLimit(child.sessionId)).toBe(rootLimiter);
		expect(rootLimiter?.budgetName).toBe(sessionCpuBudgetName(root.sessionId));
	});

	/**
	 * A spawner that cannot name itself must still not hand out a second budget.
	 * The factory falls back to the first registered session, so an unknown
	 * parent joins the tree rather than escaping it.
	 */
	it("falls back to the first registered session when the spawner is unknown", async () => {
		const root = await makeSession();
		const child = await makeSession({});

		const rootLimiter = sessionCpuLimit(root.sessionId);
		expect(rootLimiter).toBeDefined();
		expect(sessionCpuLimit(child.sessionId)).toBe(rootLimiter);
	});
});
