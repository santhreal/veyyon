import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import type { CustomMessageEntry } from "@veyyon/coding-agent/session/session-entries";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { getProjectDir, setProjectDir, TempDir } from "@veyyon/utils";

/**
 * Moving the working directory has to re-scope the session in EVERY mode.
 *
 * WHY THIS SUITE EXISTS. All of it once lived in `InteractiveMode.applyCwdChange`
 * and only there, reached through the TUI's `cwd_changed` handler. An SDK session,
 * an ACP session, a headless run and every subagent therefore re-rooted with the
 * previous project's settings, provider exclusions, plugin roots, capabilities and
 * base system prompt still live. The prompt is the sharpest of those: it states
 * the working directory verbatim, so those modes went on naming a directory the
 * session had left, and the model followed the old project's AGENTS.md while
 * resolving relative paths against the new directory. Nothing failed loudly; the
 * model simply believed what it was told.
 *
 * The re-scope now lives on `AgentSession`, which every mode has, and the TUI
 * calls the same owner for the parts it does not own. That created a second thing
 * to prove: the TUI reaches the owner TWICE for one move, once through `setCwd`
 * and once through the `cwd_changed` handler, so the owner must do the work once.
 * A second pass would reload settings, reset capabilities and rebuild the prompt
 * again, and a prompt rebuild is a full provider prompt-cache invalidation.
 */

describe("AgentSession re-scopes to the destination directory", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let originalProjectDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		// Re-scoping calls `setProjectDir`, which really chdirs the process. Without
		// putting it back, this suite leaves the process sitting inside a temp
		// directory it is about to delete, and the NEXT suite to restore its own
		// settings state fails with ENOENT on a directory it never created.
		originalProjectDir = getProjectDir();
		tempDir = TempDir.createSync("@pi-rescope-cwd-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		setProjectDir(originalProjectDir);
		tempDir.removeSync();
	});

	/** A real directory, because `setCwd` validates that the destination exists. */
	function makeDir(name: string): string {
		const dir = path.join(tempDir.path(), name);
		fs.mkdirSync(dir, { recursive: true });
		return fs.realpathSync(dir);
	}

	async function createSession(cwd: string): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled anthropic model to exist");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: undefined },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `auth-${authStorages.length}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		await sessionManager.setCwd(cwd);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		return session;
	}

	/**
	 * The headline: a re-root rebuilds the prompt for the destination. Without this
	 * the base prompt keeps naming the directory the session started in, which is
	 * the one claim the model cannot check for itself.
	 */
	it("rebuilds the base system prompt when the session moves", async () => {
		const origin = makeDir("origin");
		const destination = makeDir("destination");
		const agentSession = await createSession(origin);
		const rebuild = vi.spyOn(agentSession, "refreshBaseSystemPrompt").mockResolvedValue([]);

		await agentSession.setCwd(destination);

		expect(rebuild).toHaveBeenCalledTimes(1);
		expect(agentSession.sessionManager.getCwd()).toBe(destination);
	});

	/**
	 * The tool set moves too. `refreshSshTool` re-resolves whether the destination
	 * project has an ssh target at all, so leaving it pinned offered the previous
	 * project's remote from the new one.
	 */
	it("refreshes the ssh tool for the destination", async () => {
		const origin = makeDir("origin");
		const destination = makeDir("destination");
		const agentSession = await createSession(origin);
		vi.spyOn(agentSession, "refreshBaseSystemPrompt").mockResolvedValue([]);
		const refreshSsh = vi.spyOn(agentSession, "refreshSshTool").mockResolvedValue();

		await agentSession.setCwd(destination);

		expect(refreshSsh).toHaveBeenCalledTimes(1);
		expect(refreshSsh.mock.calls[0]?.[0]).toEqual({ activateIfAvailable: true });
	});

	/**
	 * The process project dir is what status-line and discovery readers consult, so
	 * it has to agree with the session root or the two disagree about which project
	 * is open.
	 */
	it("aligns the process project directory", async () => {
		const origin = makeDir("origin");
		const destination = makeDir("destination");
		const agentSession = await createSession(origin);
		vi.spyOn(agentSession, "refreshBaseSystemPrompt").mockResolvedValue([]);

		await agentSession.setCwd(destination);

		expect(getProjectDir()).toBe(destination);
	});

	/**
	 * The de-duplication that lets the TUI keep its own entry point. `setCwd`
	 * re-scopes and then emits `cwd_changed`, whose handler calls `applyCwdChange`,
	 * which calls the owner again for the same destination. Repeating the work
	 * would rebuild the prompt a second time for no change, and every rebuild is a
	 * full prompt-cache invalidation.
	 */
	it("does the work once when the same destination is re-scoped twice", async () => {
		const origin = makeDir("origin");
		const destination = makeDir("destination");
		const agentSession = await createSession(origin);
		const rebuild = vi.spyOn(agentSession, "refreshBaseSystemPrompt").mockResolvedValue([]);

		await agentSession.setCwd(destination);
		await agentSession.rescopeToCwd(destination);
		await agentSession.rescopeToCwd(destination);

		expect(rebuild).toHaveBeenCalledTimes(1);
	});

	/**
	 * The guard remembers the LAST directory, not every directory seen, and that
	 * distinction is the whole reason it is safe. Moving away and back is a real
	 * move: the settings, capabilities and prompt in force are the middle
	 * directory's, so returning has to re-scope even though this destination has
	 * been visited before.
	 */
	it("re-scopes again after moving away and back", async () => {
		const origin = makeDir("origin");
		const middle = makeDir("middle");
		const agentSession = await createSession(origin);
		const rebuild = vi.spyOn(agentSession, "refreshBaseSystemPrompt").mockResolvedValue([]);

		await agentSession.setCwd(middle);
		await agentSession.setCwd(origin);

		expect(rebuild).toHaveBeenCalledTimes(2);
	});

	/**
	 * A move that does not move is not a move. `setCwd` returns early when the
	 * destination resolves to the directory already in force, so nothing is
	 * re-scoped and no `cwd_changed` note joins the transcript.
	 */
	it("re-scopes nothing when the destination is the current directory", async () => {
		const origin = makeDir("origin");
		const agentSession = await createSession(origin);
		const rebuild = vi.spyOn(agentSession, "refreshBaseSystemPrompt").mockResolvedValue([]);

		const result = await agentSession.setCwd(origin);

		expect(result).toBe(origin);
		expect(rebuild).not.toHaveBeenCalled();
	});

	/**
	 * Order, stated as a test rather than only as a comment. The prompt is
	 * assembled from settings, capabilities and plugin roots, so rebuilding it
	 * before those are re-scoped would produce the destination's path wrapped
	 * around the previous project's configuration, which is harder to notice than
	 * a wholly stale prompt.
	 */
	it("rebuilds the prompt after the ssh tool, not before", async () => {
		const origin = makeDir("origin");
		const destination = makeDir("destination");
		const agentSession = await createSession(origin);
		const order: string[] = [];
		vi.spyOn(agentSession, "refreshSshTool").mockImplementation(async () => {
			order.push("ssh");
		});
		vi.spyOn(agentSession, "refreshBaseSystemPrompt").mockImplementation(async () => {
			order.push("prompt");
			return [];
		});

		await agentSession.setCwd(destination);

		expect(order).toEqual(["ssh", "prompt"]);
	});

	/**
	 * The transcript still records the move. The re-scope was inserted between the
	 * directory change and the note, so a regression that threw mid-re-scope would
	 * lose the note entirely; this pins that the note survives a normal move.
	 */
	it("still records the move in the transcript", async () => {
		const origin = makeDir("origin");
		const destination = makeDir("destination");
		const agentSession = await createSession(origin);
		vi.spyOn(agentSession, "refreshBaseSystemPrompt").mockResolvedValue([]);

		await agentSession.setCwd(destination);

		const entries = agentSession.sessionManager.getEntries();
		// A type predicate, because a plain boolean filter leaves the array as the
		// whole `SessionEntry` union and `content` belongs to one member of it. The
		// assertion below is on that exact field, so this has to narrow.
		const moved = entries.filter(
			(entry): entry is CustomMessageEntry => entry.type === "custom_message" && entry.customType === "cwd_changed",
		);
		expect(moved).toHaveLength(1);
		expect(moved[0]?.content).toBe(`Session working directory changed: ${origin} → ${destination}`);
	});

	/**
	 * The event still fires, and it fires AFTER the re-scope. The TUI's handler
	 * reacts by reading state the re-scope just wrote, so an event raised first
	 * would have it render the previous project's configuration.
	 */
	it("emits cwd_changed after the re-scope, not before", async () => {
		const origin = makeDir("origin");
		const destination = makeDir("destination");
		const agentSession = await createSession(origin);
		const order: string[] = [];
		vi.spyOn(agentSession, "refreshBaseSystemPrompt").mockImplementation(async () => {
			order.push("prompt");
			return [];
		});
		agentSession.subscribe(event => {
			if (event.type === "cwd_changed") order.push("event");
		});

		await agentSession.setCwd(destination);

		expect(order).toEqual(["prompt", "event"]);
	});
});
