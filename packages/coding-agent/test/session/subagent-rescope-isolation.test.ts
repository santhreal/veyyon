import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { getProjectDir, setProjectDir, TempDir } from "@veyyon/utils";

/**
 * A subagent moving its working directory does not move anyone else's.
 *
 * WHY THIS SUITE EXISTS. `setProjectDir` really calls `process.chdir`, on purpose:
 * `getProjectDir()` and `process.cwd()` are one thing wearing two hats, and drift
 * between them leaves half the program looking at a directory the user never chose.
 * That reasoning is sound for ONE session per process, and it is not what runs.
 * Subagents are built in-process through `sdk.ts`, several can be in flight at
 * once, and each carries its own `AgentSession` with its own session cwd. So one
 * subagent calling `set_cwd` used to chdir the whole process, reload the global
 * settings singleton for ITS project, and reset the shared capability and
 * plugin-root caches, moving the parent and every sibling to a directory nobody
 * asked them to be in.
 *
 * It hid well, which is why it needs pinning rather than a comment. Tool calls
 * mostly survived it, because `resolveToCwd(path, sessionCwd)` resolves against
 * the SESSION cwd rather than the process cwd, so the paths a reader sees stayed
 * right. What did not survive is everything that reads `process.cwd()` directly: a
 * spawned child process, a bare relative `fs` call, and any reader still consulting
 * `getProjectDir()`. Nothing reports it, and the failure surfaces as a command run
 * in the wrong repository.
 *
 * THE ASSERTIONS ARE ON `process.cwd()` AND `getProjectDir()` TOGETHER, never on
 * one alone. Checking only the global would pass for a change that assigned it
 * without chdir, which is precisely the drift `setProjectDir` exists to prevent,
 * and checking only `process.cwd()` would miss the reverse.
 */

describe("a subagent's re-root leaves the process where it is", () => {
	let tempDir: TempDir;
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];
	let originalProjectDir: string;

	beforeEach(() => {
		// The primary-session cases below really chdir, so the process has to be put
		// back before the temp directory it is sitting in is deleted. Without this the
		// NEXT suite fails with ENOENT on a directory it never created.
		originalProjectDir = getProjectDir();
		tempDir = TempDir.createSync("@pi-subagent-rescope-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
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

	/**
	 * Build a session at `cwd`. `isSubagent` is the one thing under test here, and it
	 * is passed exactly as `sdk.ts` passes it, from `isSubagentSession(options)`.
	 */
	async function createSession(cwd: string, isSubagent: boolean): Promise<AgentSession> {
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
		const session = new AgentSession({
			agent,
			isSubagent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		// Rebuilding the real prompt would reach settings and capabilities, which is a
		// different subject; these cases are about who owns the process.
		vi.spyOn(session, "refreshBaseSystemPrompt").mockResolvedValue([]);
		vi.spyOn(session, "refreshSshTool").mockResolvedValue();
		sessions.push(session);
		return session;
	}

	/**
	 * THE BUG, stated directly. A subagent re-roots and the process stays put.
	 */
	it("does not chdir the process when a subagent moves", async () => {
		const parentDir = makeDir("parent-project");
		const subagentDir = makeDir("subagent-project");
		setProjectDir(parentDir);
		const subagent = await createSession(parentDir, true);

		await subagent.setCwd(subagentDir);

		expect(fs.realpathSync(process.cwd())).toBe(parentDir);
		expect(getProjectDir()).toBe(parentDir);
	});

	/**
	 * The subagent still moved. Refusing the re-root would also keep the process
	 * still, and would be a different behaviour entirely, so this is what separates
	 * a fix from a removal.
	 */
	it("still moves the subagent's own session working directory", async () => {
		const parentDir = makeDir("parent-project");
		const subagentDir = makeDir("subagent-project");
		setProjectDir(parentDir);
		const subagent = await createSession(parentDir, true);

		await subagent.setCwd(subagentDir);

		expect(subagent.sessionManager.getCwd()).toBe(subagentDir);
	});

	/**
	 * The session-scoped half runs for a subagent too. The base system prompt states
	 * the working directory verbatim, so a subagent that skipped the rebuild would go
	 * on naming the directory it had just left, which is the one claim the model
	 * cannot check for itself.
	 */
	it("still rebuilds the subagent's own system prompt", async () => {
		const parentDir = makeDir("parent-project");
		const subagentDir = makeDir("subagent-project");
		setProjectDir(parentDir);
		const subagent = await createSession(parentDir, true);
		const rebuild = vi.spyOn(subagent, "refreshBaseSystemPrompt").mockResolvedValue([]);

		await subagent.setCwd(subagentDir);

		expect(rebuild).toHaveBeenCalledTimes(1);
	});

	/**
	 * The parent is the point of the whole thing. Its session cwd is what
	 * `resolveToCwd(path, sessionCwd)` resolves tool paths against, and it must be
	 * untouched by a sibling's move.
	 */
	it("leaves a parent session's working directory alone", async () => {
		const parentDir = makeDir("parent-project");
		const subagentDir = makeDir("subagent-project");
		setProjectDir(parentDir);
		const parent = await createSession(parentDir, false);
		const subagent = await createSession(parentDir, true);

		await subagent.setCwd(subagentDir);

		expect(parent.sessionManager.getCwd()).toBe(parentDir);
		expect(fs.realpathSync(process.cwd())).toBe(parentDir);
	});

	/**
	 * Two subagents in flight at once is the real shape, and neither may move the
	 * other. Asserted with two moves rather than one, because a fix that merely made
	 * the FIRST subagent's re-root a no-op would pass a single-move check.
	 */
	it("keeps two concurrent subagents out of each other's directories", async () => {
		const parentDir = makeDir("parent-project");
		const firstDir = makeDir("first-project");
		const secondDir = makeDir("second-project");
		setProjectDir(parentDir);
		const first = await createSession(parentDir, true);
		const second = await createSession(parentDir, true);

		await first.setCwd(firstDir);
		await second.setCwd(secondDir);

		expect(first.sessionManager.getCwd()).toBe(firstDir);
		expect(second.sessionManager.getCwd()).toBe(secondDir);
		expect(fs.realpathSync(process.cwd())).toBe(parentDir);
		expect(getProjectDir()).toBe(parentDir);
	});

	/**
	 * NON-VACUITY, and the reason this suite cannot pass by doing nothing at all: the
	 * primary session still moves the process. A change that simply deleted the
	 * `setProjectDir` call would satisfy every case above and break the behaviour the
	 * original doc on `setProjectDir` argues for.
	 */
	it("still chdirs the process when the primary session moves", async () => {
		const originDir = makeDir("origin-project");
		const destinationDir = makeDir("destination-project");
		setProjectDir(originDir);
		const primary = await createSession(originDir, false);

		await primary.setCwd(destinationDir);

		expect(fs.realpathSync(process.cwd())).toBe(destinationDir);
		expect(getProjectDir()).toBe(destinationDir);
	});

	/**
	 * A session built without the flag owns the process. An embedder constructing an
	 * `AgentSession` directly has nobody above it, so the default has to be the
	 * primary behaviour; defaulting the other way would silently stop honouring
	 * `set_cwd` for every SDK consumer.
	 */
	it("treats a session with no isSubagent flag as the primary", async () => {
		const originDir = makeDir("origin-project");
		const destinationDir = makeDir("destination-project");
		setProjectDir(originDir);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled anthropic model to exist");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: undefined },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth-default.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		await sessionManager.setCwd(originDir);
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models-default.yml")),
		});
		sessions.push(session);
		vi.spyOn(session, "refreshBaseSystemPrompt").mockResolvedValue([]);
		vi.spyOn(session, "refreshSshTool").mockResolvedValue();

		await session.setCwd(destinationDir);

		expect(getProjectDir()).toBe(destinationDir);
	});
});
