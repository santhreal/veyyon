/**
 * WHY: the advisor's tools ran against `{ ...toolSession, ...overrides }`. A spread copies a
 * getter's value at the moment of the copy and never sees a later write, so the advisor's
 * `notify` stayed undefined after the host installed a notifier, its `sideComplete` stayed
 * undefined after the session existed, and its `contextFiles`, `workspaceTree`, `skills` and
 * `rules` kept their launch values after a working-directory change moved the primary's.
 *
 * The class this closes: any field of the primary tool session the advisor reads a stale copy
 * of. The sweep enumerates the primary's own properties at run time, so a field added to the
 * tool session is covered without being named here, and the advisor's own properties are pinned
 * by exact equality, so a new override fails until it is recorded below. The per-session state a
 * tool attaches on first use is the opposite contract: the advisor builds its own, driven here
 * through the real lazy initializers.
 *
 * What it does not catch: a tool that attaches a new lazily created field to its session without
 * declaring it in `ToolSessionLocalState`. The advisor would read the primary's instance of it.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getFileSnapshotStore } from "@veyyon/coding-agent/edit/file-snapshot-store";
import { getNoopLoopGuard } from "@veyyon/coding-agent/edit/hashline/noop-loop-guard";
import { getDiagnosticsLedger } from "@veyyon/coding-agent/lsp/diagnostics-ledger";
import { BUILTIN_TOOLS, createAgentSession } from "@veyyon/coding-agent/sdk";
import type { CreateAgentSessionResult } from "@veyyon/coding-agent/session/factory-options";
import { TOOL_SESSION_LOCAL_STATE_KEYS, type ToolSession } from "@veyyon/coding-agent/tools";
import { getConflictHistory } from "@veyyon/coding-agent/tools/fs/conflict-detect";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

/** The fields the advisor replaces. Every other field reads the primary's. */
const ADVISOR_OVERRIDES = ["getAgentId", "getSessionId", "hasEditTool", "requireYieldTool"];

interface Launched {
	result: CreateAgentSessionResult;
	primary: ToolSession;
	advisor: ToolSession;
}

const tempDirs: TempDir[] = [];
const authStorages: AuthStorage[] = [];
const launched: Launched[] = [];

afterEach(async () => {
	for (const { result } of launched.splice(0)) await result.session.dispose();
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	for (const tempDir of tempDirs.splice(0)) await tempDir.remove();
});

async function launch(): Promise<Launched> {
	const tempDir = TempDir.createSync("@veyyon-advisor-tool-session-");
	tempDirs.push(tempDir);
	const cwd = tempDir.join("project");
	await Bun.write(`${cwd}/.keep`, "");
	const authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
	authStorages.push(authStorage);
	authStorage.setRuntimeApiKey("openai", "test-key");
	const settings = Settings.isolated({ "async.enabled": false, "advisor.enabled": true });
	settings.setModelRole("advisor", "openai/gpt-4o-mini");

	const sessions: ToolSession[] = [];
	const buildRead = BUILTIN_TOOLS.read;
	const readFactory = spyOn(BUILTIN_TOOLS, "read").mockImplementation(session => {
		sessions.push(session);
		return buildRead(session);
	});
	let result: CreateAgentSessionResult;
	try {
		result = await createAgentSession({
			cwd,
			agentDir: tempDir.path(),
			sessionManager: SessionManager.create(cwd, tempDir.join("sessions")),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
	} finally {
		readFactory.mockRestore();
	}
	const advisor = sessions.find(session => session.getAgentId?.() === "advisor");
	const primary = sessions.find(session => session.getAgentId?.() !== "advisor");
	if (!primary || !advisor) throw new Error("createAgentSession built no read tool for the primary or the advisor.");
	const entry = { result, primary, advisor };
	launched.push(entry);
	return entry;
}

// The keys are enumerated at run time and have no static type to index by.
function read(session: ToolSession, key: string): unknown {
	return (session as unknown as Record<string, unknown>)[key];
}

/** Keys of the primary the advisor reads through: every own property minus the overrides. */
function sharedKeys(primary: ToolSession): string[] {
	const excluded = new Set<string>([...ADVISOR_OVERRIDES, ...TOOL_SESSION_LOCAL_STATE_KEYS]);
	return Object.getOwnPropertyNames(primary).filter(key => !excluded.has(key));
}

describe("the advisor's tool session", () => {
	it("reads the value the primary resolves late, after the session exists and the host installs a notifier", async () => {
		const { result, primary, advisor } = await launch();
		const notify = () => {};
		result.setToolNotifier(notify);

		expect(primary.notify).toBe(notify);
		expect(primary.sideComplete).toBe(result.session.sideComplete);
		const diverged = sharedKeys(primary).filter(key => read(advisor, key) !== read(primary, key));
		expect(diverged).toEqual([]);
	});

	it("reads every field the primary is reassigned after startup", async () => {
		const { primary, advisor } = await launch();
		const writable = sharedKeys(primary).filter(
			key => Object.getOwnPropertyDescriptor(primary, key)?.writable === true,
		);
		expect(writable).toContain("skills");
		const stale: string[] = [];
		for (const key of writable) {
			const target = primary as unknown as Record<string, unknown>;
			const previous = target[key];
			const sentinel = { sentinel: key };
			target[key] = sentinel;
			if (read(advisor, key) !== sentinel) stale.push(key);
			target[key] = previous;
		}
		expect(stale).toEqual([]);
	});

	it("replaces exactly its own identity and capability fields", async () => {
		const { result, primary, advisor } = await launch();
		const own = Object.getOwnPropertyNames(advisor).filter(
			key => !(TOOL_SESSION_LOCAL_STATE_KEYS as readonly string[]).includes(key),
		);
		expect(own.sort()).toEqual([...ADVISOR_OVERRIDES].sort());
		expect(advisor.getAgentId?.()).toBe("advisor");
		expect(advisor.getSessionId?.()).toBe(`${result.session.sessionManager.getSessionId()}-advisor`);
		expect(primary.getSessionId?.()).toBe(result.session.sessionManager.getSessionId());
		expect(advisor.hasEditTool).toBe(true);
		expect(advisor.requireYieldTool).toBe(false);
	});

	it("builds its own per-session tool state rather than reading the primary's", async () => {
		const { primary, advisor } = await launch();
		const primaryState = {
			fileSnapshotStore: getFileSnapshotStore(primary),
			conflictHistory: getConflictHistory(primary),
			diagnosticsLedger: getDiagnosticsLedger(primary),
			noopLoopGuard: getNoopLoopGuard(primary),
		};
		expect(Object.keys(primaryState).sort()).toEqual([...TOOL_SESSION_LOCAL_STATE_KEYS].sort());

		const advisorState = {
			fileSnapshotStore: getFileSnapshotStore(advisor),
			conflictHistory: getConflictHistory(advisor),
			diagnosticsLedger: getDiagnosticsLedger(advisor),
			noopLoopGuard: getNoopLoopGuard(advisor),
		};
		for (const key of TOOL_SESSION_LOCAL_STATE_KEYS) {
			expect(advisorState[key]).not.toBe(primaryState[key]);
			expect(read(primary, key)).toBe(primaryState[key]);
			expect(read(advisor, key)).toBe(advisorState[key]);
		}
	});
});
