/**
 * Moving the working directory must not rewrite the provider's cache prefix.
 *
 * WHY THIS SUITE EXISTS. The base system prompt is the provider's cache prefix,
 * and the working directory was stated inside it verbatim: "Today is <date>, and
 * the current working directory is '<path>'". A re-root rebuilds the prompt,
 * legitimately — the rules, skills and workspace tree really are cwd-derived —
 * but a move that changed nothing else still changed that one sentence, and one
 * changed byte discards the cached prefix for the whole conversation behind it.
 * Measured on this repository, moving from the root to `packages/utils` altered
 * exactly one line of a 92,921-character prompt. Across 19 local log files, 210
 * of 232 recorded invalidations were a `cwd-change`, about 85,000 characters
 * re-read each time.
 *
 * THE CLASS, not the incident. The defect is not "the cwd sentence"; it is a fact
 * that changes during a session living in the part of the request that is only
 * cheap while it does not change. So the fix is not a special case for that
 * sentence: the date and the working directory are delivered as a turn message,
 * the way recalled memories already are, and the sweep below asserts that NO
 * directory in a project produces different prompt bytes from any other. A future
 * placeholder that puts the path back — anywhere in the prefix, under any
 * condition — turns this red.
 *
 * WHAT IT DOES NOT CATCH. Two things legitimately differ per directory and stay
 * in the prefix: the workspace tree, which is a picture of the working directory
 * and is off by default (`includeWorkspaceTree`), and the active-repo-context
 * block, which names a repository root relative to a cwd outside git. A move
 * between two states of either is a real change of content, not a restatement of
 * the same fact, and it is expected to invalidate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { getProjectDir, setProjectDir, TempDir } from "@veyyon/utils";

/**
 * A directory has to be TWO levels below the temp root to be a project at all: a
 * direct child of the temp directory is classified as a scratch workspace, which
 * is a different prompt and would make the sweep compare two unlike things.
 */
const PROJECT_A = path.join("workspace", "project-a");
const PROJECT_B = path.join("workspace", "project-b");

/**
 * The sweep runs per MARKER STATE, because whether a directory is itself a
 * project root is a real difference in what the prompt says, not a restatement of
 * the same fact: an unmarked directory gets a paragraph telling the model to
 * re-root, and a move between the two states is expected to change the bytes. The
 * invariant under test is narrower and is the one that was broken — two
 * directories that agree on every prompt input EXCEPT their path build the same
 * bytes. So each group holds directories at different depths in one state.
 *
 * Each marked directory carries its own `package.json`, which is a project-root
 * marker; the unmarked ones carry nothing.
 */
const MARKED_DIRS = ["", "packages", path.join("packages", "core")];
const UNMARKED_DIRS = ["src", path.join("src", "deep"), "docs"];
const PROJECT_A_DIRS = [...MARKED_DIRS, ...UNMARKED_DIRS];

describe("the working directory is not part of the cached prompt prefix", () => {
	let tempDir: TempDir;
	let originalProjectDir: string;
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		// Re-scoping really chdirs the process, so the original has to come back or
		// the next suite restores its state inside a deleted directory.
		originalProjectDir = getProjectDir();
		tempDir = TempDir.createSync("@pi-cwd-prefix-");
		for (const relative of PROJECT_A_DIRS) {
			fs.mkdirSync(path.join(tempDir.path(), PROJECT_A, relative), { recursive: true });
		}
		for (const relative of MARKED_DIRS.slice(1)) {
			fs.writeFileSync(path.join(tempDir.path(), PROJECT_A, relative, "package.json"), '{"name":"marked"}\n');
		}
		fs.mkdirSync(path.join(tempDir.path(), PROJECT_B), { recursive: true });
		// `AGENTS.md` is a project-root marker, so each root is a project. Different
		// bytes in the two files are what the negative control below depends on.
		fs.writeFileSync(path.join(tempDir.path(), PROJECT_A, "AGENTS.md"), "# Project A\n\nUse two spaces.\n");
		fs.writeFileSync(path.join(tempDir.path(), PROJECT_B, "AGENTS.md"), "# Project B\n\nUse tabs, never spaces.\n");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		setProjectDir(originalProjectDir);
		tempDir.removeSync();
	});

	/** The real project directories on disk, resolved the way the session sees them. */
	function dirsOf(relatives: readonly string[]): string[] {
		return relatives.map(relative => fs.realpathSync(path.join(tempDir.path(), PROJECT_A, relative)));
	}

	function projectBDir(): string {
		return fs.realpathSync(path.join(tempDir.path(), PROJECT_B));
	}

	async function promptFor(cwd: string): Promise<string> {
		const result = await buildSystemPrompt({ toolNames: ["read", "bash"], cwd });
		return result.systemPrompt.join("\n\n");
	}

	/**
	 * The headline invariant, once per marker state. Enumerated from the fixture at
	 * run time rather than asserted for one pair, so a directory added to either
	 * group is swept and a new cwd-derived byte anywhere in the prefix fails here.
	 */
	for (const [state, relatives] of [
		["marked", MARKED_DIRS],
		["unmarked", UNMARKED_DIRS],
	] as const) {
		it(`builds byte-identical bytes for every ${state} directory of one project`, async () => {
			const dirs = dirsOf(relatives);
			const prompts = await Promise.all(dirs.map(promptFor));
			const differing = dirs.filter((_dir, index) => prompts[index] !== prompts[0]);

			expect(differing).toEqual([]);
		});

		/**
		 * The path itself is what must not be there. The project root is exempt and
		 * only there: its path is where the rules came from, it is inlined as the
		 * context file's own header, and it does not move when the cwd moves inside
		 * it. Every other directory has no reason to appear at all.
		 */
		it(`names no ${state} directory below the root anywhere in the prompt`, async () => {
			const dirs = dirsOf(relatives).filter(dir => dir !== dirsOf([""])[0]);
			const prompts = await Promise.all(dirs.map(promptFor));
			const leaking = dirs.filter((dir, index) => prompts[index].includes(dir));

			expect(leaking).toEqual([]);
		});
	}

	/**
	 * Green-by-luck control. If the builder simply ignored the working directory,
	 * the sweeps above would pass and prove nothing. A project with different rules
	 * must still produce a different prompt, which is what makes the rebuild on
	 * re-root worth its cost when it does fire.
	 */
	it("still builds different bytes for a project with different rules", async () => {
		const alpha = await promptFor(dirsOf([""])[0]);
		const beta = await promptFor(projectBDir());

		expect(alpha).not.toBe(beta);
		expect(alpha).toContain("Use two spaces.");
		expect(beta).toContain("Use tabs, never spaces.");
	});

	/**
	 * The two states really are different bytes, which is why they are swept apart.
	 * Asserted rather than assumed: if they were identical the split above would be
	 * hiding a directory the marked sweep should have caught.
	 */
	it("builds different bytes for the two marker states", async () => {
		const marked = await promptFor(dirsOf([MARKED_DIRS[1]])[0]);
		const unmarked = await promptFor(dirsOf([UNMARKED_DIRS[0]])[0]);

		expect(marked).not.toBe(unmarked);
	});

	/**
	 * The unmarked paragraph is the OTHER spelling of the leak: it named the path
	 * while explaining why the directory is not a project root. The paragraph is
	 * still there and still explains itself; the path is not.
	 */
	it("explains an unmarked directory without naming it", async () => {
		const unmarked = dirsOf([UNMARKED_DIRS[0]])[0];
		const text = await promptFor(unmarked);

		expect(text).toContain("the working directory is not a project root, because");
		expect(text).not.toContain(unmarked);
	});

	/**
	 * `persisted` gives the session a real session file. `fork` refuses without
	 * one, so the fork case below would otherwise never reach the code it means to
	 * test and would pass on a no-op.
	 */
	async function createSession(cwd: string, options?: { persisted?: boolean }): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled anthropic model to exist");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: undefined },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `auth-${authStorages.length}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = options?.persisted
			? SessionManager.create(cwd, path.join(tempDir.path(), `sessions-${authStorages.length}`))
			: SessionManager.inMemory();
		await sessionManager.setCwd(cwd);
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			// The real builder, reading the cwd live, which is the shape `sdk.ts`
			// installs. Without a rebuilder the session's invalidation record is
			// empty by construction and the two tests below would pass on nothing.
			rebuildSystemPrompt: async toolNames => buildSystemPrompt({ toolNames, cwd: sessionManager.getCwd() }),
		});
		sessions.push(session);
		return session;
	}

	/**
	 * The whole point, at the seam that pays for it. `refreshBaseSystemPrompt`
	 * records an invalidation only when the rebuilt bytes differ, so an empty
	 * record after a real re-root through the real builder is the proof that the
	 * prefix survived.
	 *
	 * The baseline rebuild is discounted: a bare `AgentSession` starts on the
	 * agent's placeholder prompt, so the first real build legitimately changes the
	 * bytes and would otherwise be counted as the move's own cost.
	 */
	it("records no invalidation for a move inside one project", async () => {
		const [root, , deep] = dirsOf(MARKED_DIRS);
		const session = await createSession(root);
		await session.refreshBaseSystemPrompt("test-baseline");
		const baseline = session.systemPromptInvalidations().length;

		await session.setCwd(deep);

		expect(session.systemPromptInvalidations().slice(baseline)).toEqual([]);
	});

	/**
	 * And it still fires when it should. A move to a project with different rules
	 * is a real change of content, so the cache has to go and the reason has to say
	 * which caller spent it. Pinned by exact equality: a second entry would mean
	 * one move paid for two rebuilds.
	 */
	it("records exactly one invalidation for a move to another project", async () => {
		const [root] = dirsOf(MARKED_DIRS);
		const session = await createSession(root);
		await session.refreshBaseSystemPrompt("test-baseline");
		const baseline = session.systemPromptInvalidations().length;

		await session.setCwd(projectBDir());

		expect(session.systemPromptInvalidations().slice(baseline)).toEqual(["cwd-change"]);
	});

	/**
	 * The messages a turn would hand the agent, with only the provider call stubbed.
	 *
	 * The stub still APPENDS them to the agent's message list, because that is the
	 * one side effect of the real call the code under test depends on: the
	 * delivered-once cache is re-derived from the conversation, so a stub that
	 * swallowed the messages would make every fork look like a fresh transcript and
	 * the two cases below indistinguishable.
	 */
	async function messagesForTurn(session: AgentSession, text: string): Promise<AgentMessage[]> {
		const captured: AgentMessage[] = [];
		const spy = vi.spyOn(session.agent, "prompt").mockImplementation(async input => {
			const incoming = Array.isArray(input) ? input : [input as AgentMessage];
			captured.push(...incoming);
			session.agent.state.messages.push(...incoming);
		});
		await session.prompt(text);
		spy.mockRestore();
		return captured;
	}

	function sessionStateBlocks(messages: AgentMessage[]): string[] {
		return messages.flatMap(message =>
			message.role === "custom" && message.customType === "session-state" && typeof message.content === "string"
				? [message.content]
				: [],
		);
	}

	/**
	 * The fact still reaches the model, which is the half a prefix fix can get
	 * wrong: a working directory removed from the prompt and delivered nowhere
	 * leaves the model guessing, and it cannot tell that it is guessing.
	 */
	it("states the working directory to the model as a turn message", async () => {
		const [root] = dirsOf(MARKED_DIRS);
		const session = await createSession(root);

		const blocks = sessionStateBlocks(await messagesForTurn(session, "first question"));

		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain(`The current working directory is '${root}'.`);
	});

	/**
	 * Delivered once. Re-sending an unchanged block every turn would trade a
	 * prefix invalidation for a context that grows forever, which is the same bill
	 * paid slower.
	 */
	it("does not restate an unchanged working directory on the next turn", async () => {
		const [root] = dirsOf(MARKED_DIRS);
		const session = await createSession(root);

		await messagesForTurn(session, "first question");
		const second = sessionStateBlocks(await messagesForTurn(session, "second question"));

		expect(second).toEqual([]);
	});

	/**
	 * And restated the moment it changes, naming the destination and not the
	 * origin. This is the assertion that a stale-cwd regression fails: a session
	 * that moved and never said so reads as a session that never moved.
	 */
	it("restates the working directory after a re-root", async () => {
		const [root, , deep] = dirsOf(MARKED_DIRS);
		const session = await createSession(root);
		await messagesForTurn(session, "first question");

		await session.setCwd(deep);
		const blocks = sessionStateBlocks(await messagesForTurn(session, "second question"));

		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain(`The current working directory is '${deep}'.`);
		expect(blocks[0]).not.toContain(`directory is '${root}'.`);
	});

	/**
	 * It is context, not conversation: hidden from the transcript and the TUI, and
	 * ahead of the question, because the directory is something the model should
	 * already know when it reads what was asked.
	 */
	it("delivers the block hidden and ahead of the user message", async () => {
		const [root] = dirsOf(MARKED_DIRS);
		const session = await createSession(root);

		const messages = await messagesForTurn(session, "first question");
		const stateIndex = messages.findIndex(m => m.role === "custom" && m.customType === "session-state");
		const userIndex = messages.findIndex(m => m.role === "user");

		expect(stateIndex).toBe(0);
		expect(userIndex).toBeGreaterThan(stateIndex);
		expect(messages[stateIndex]).toMatchObject({ display: false, attribution: "agent" });
	});

	/**
	 * A fresh transcript has to be told again. This is the variant the delivery
	 * tests above cannot see: `/new` empties the conversation, so the block the
	 * dedupe remembers is no longer anywhere the model can read, and a session that
	 * skipped it would run a whole conversation never having stated its directory.
	 * The dedupe is re-derived from the messages rather than reset to a flag, which
	 * is what makes a fork — where the block IS still in the transcript — keep
	 * staying quiet.
	 */
	it("restates the working directory on a fresh transcript", async () => {
		const [root] = dirsOf(MARKED_DIRS);
		const session = await createSession(root);
		await messagesForTurn(session, "first question");

		await session.newSession();
		const blocks = sessionStateBlocks(await messagesForTurn(session, "second question"));

		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain(`The current working directory is '${root}'.`);
	});

	/**
	 * A fork is the other half of the same question, and the half that says WHY the
	 * dedupe reads the messages instead of a flag: a fork keeps the conversation, so
	 * the block is still there for the model to read and restating it would put the
	 * same directory in twice. Without this case, reading any other block type
	 * satisfies the fresh-transcript test above just as well.
	 */
	it("stays quiet after a fork that kept the block", async () => {
		const [root] = dirsOf(MARKED_DIRS);
		const session = await createSession(root, { persisted: true });
		await messagesForTurn(session, "first question");

		// Both premises asserted, because either one failing makes the quiet below
		// mean nothing: a fork that was refused never reset anything, and a fork that
		// dropped the block SHOULD restate it.
		expect(await session.fork()).toBe(true);
		expect(sessionStateBlocks(session.agent.state.messages)).toHaveLength(1);

		const blocks = sessionStateBlocks(await messagesForTurn(session, "second question"));

		expect(blocks).toEqual([]);
	});
});
