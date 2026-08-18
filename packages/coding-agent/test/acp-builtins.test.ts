import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome, ResetCreditTarget } from "@veyyon/ai";
// One owner for how `/fast` names the state it changes, so this suite cannot drift
// from the command the way it did when the wording became "priority tier".
import { PRIORITY_TIER_COMMAND_LABEL } from "@veyyon/coding-agent/config/service-tier";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as mcpConfigWriter from "@veyyon/coding-agent/mcp/config-writer";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import * as sshConfigWriter from "@veyyon/coding-agent/ssh/config-writer";
import { removeWithRetries } from "@veyyon/utils";

interface FakeAcpBuiltinSession {
	fastMode: boolean;
	forcedToolChoice: string | undefined;
	isStreaming: boolean;
	sessionFile: string | undefined;
	sessionId: string;
	sessionName: string;
	_todoPhases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
	_switchedTo: string | undefined;
	_movedFromEmptySessionFile: string | undefined;
	toggleFastMode(): boolean;
	setFastMode(enabled: boolean): boolean;
	isFastModeEnabled(): boolean;
	setForcedToolChoice(toolName: string): void;
	fetchUsageReports?: () => Promise<unknown>;
	getAsyncJobSnapshot: (opts?: { recentLimit?: number }) => { running: unknown[]; recent: unknown[] } | null;
	formatSessionAsText: () => string;
	dumpLlmRequestToTmpDir: () => Promise<string | undefined>;
	getLastAssistantText: () => string | undefined;
	messages: unknown[];
	settings: Settings;
	model: { provider: string; id: string } | undefined;
	newSession(opts?: { drop?: boolean; parentSession?: string }): Promise<boolean>;
	switchSession(sessionPath: string): Promise<boolean>;
	markMovedFromEmptySessionFile(sessionFile: string): void;
	fork(): Promise<boolean>;
	handoff(instr?: string): Promise<{ document: string; savedPath?: string } | undefined>;
	exportToHtml(outputPath?: string): Promise<string>;
	getTodoPhases(): Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
	setTodoPhases(phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>): void;
	refreshBaseSystemPrompt(): Promise<void>;
	refreshSshTool(options?: { activateIfAvailable?: boolean }): Promise<void>;
	moveToCwd(cwd: string): Promise<string>;
	getToolByName(name: string): unknown;
	compact(args?: string): Promise<void>;
	getContextUsage(): { tokens?: number; contextWindow: number } | undefined;
	getAvailableModels(): Array<{ provider: string; id: string; contextWindow?: number }>;
	setModel(model: unknown): Promise<void>;
	listResetCredits: () => Promise<ResetCreditAccountStatus[]>;
	redeemResetCredit: (target: ResetCreditTarget) => Promise<ResetCreditRedeemOutcome>;
}

interface FakeAcpBuiltinSessionManager {
	_sessionFile: string | undefined;
	_cwd: string;
	_entries: { type: string }[];
	_customEntries: Array<{ customType: string; data: unknown }>;
	_movedTo: string | undefined;
	_flushed: boolean;
	_droppedSessions: string[];
	_sessionName: string | undefined;
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getEntries(): { type: string }[];
	getBranch(): { type: string }[];
	appendCustomEntry(customType: string, data?: unknown): string;
	flush(): Promise<void>;
	moveTo(newCwd: string): Promise<void>;
	setSessionFile(sessionFile: string): Promise<void>;
	dropSession(sessionPath: string): Promise<void>;
	getCwd(): string;
	setSessionName(name: string, source: string): Promise<boolean>;
}

function createRuntime() {
	const settings = Settings.isolated();
	const output: string[] = [];
	let fakeSessionManager: FakeAcpBuiltinSessionManager | undefined;
	const session: FakeAcpBuiltinSession = {
		fastMode: false,
		forcedToolChoice: undefined as string | undefined,
		isStreaming: false,
		sessionFile: undefined,
		sessionId: "fake-session-id",
		sessionName: "Fake Session",
		_todoPhases: [],
		_switchedTo: undefined,
		_movedFromEmptySessionFile: undefined,
		toggleFastMode() {
			this.fastMode = !this.fastMode;
			return this.fastMode;
		},
		setFastMode(enabled: boolean) {
			this.fastMode = enabled;
			return true;
		},
		isFastModeEnabled() {
			return this.fastMode;
		},
		setForcedToolChoice(toolName: string) {
			this.forcedToolChoice = toolName;
		},
		async listResetCredits() {
			return [];
		},
		async redeemResetCredit(_target) {
			return { ok: false, code: "no_credit" };
		},
		async newSession(_opts?: { drop?: boolean; parentSession?: string }) {
			return true;
		},
		async switchSession(sessionPath: string) {
			this._switchedTo = path.resolve(sessionPath);
			this.sessionFile = this._switchedTo;
			if (!fakeSessionManager) throw new Error("fake session manager not initialized");
			await fakeSessionManager.flush();
			await fakeSessionManager.setSessionFile(this._switchedTo);
			return true;
		},
		markMovedFromEmptySessionFile(sessionFile: string) {
			this._movedFromEmptySessionFile = path.resolve(sessionFile);
		},
		async fork() {
			return true;
		},
		async handoff(_instr?: string) {
			return undefined;
		},
		async exportToHtml(outputPath?: string) {
			return outputPath ?? "/tmp/exported-session.html";
		},
		getTodoPhases() {
			return this._todoPhases;
		},
		setTodoPhases(phases) {
			this._todoPhases = phases;
		},
		async refreshBaseSystemPrompt() {},
		async moveToCwd(cwd: string) {
			await fakeSessionManager!.moveTo(cwd);
			return fakeSessionManager!.getCwd();
		},
		getAsyncJobSnapshot: () => null,
		formatSessionAsText: () => "",
		dumpLlmRequestToTmpDir: async () => undefined,
		getLastAssistantText: () => undefined,
		messages: [],
		model: undefined,
		settings,
		getToolByName: (_name: string) => undefined,
		async compact(_args?: string) {},
		getContextUsage: () => undefined,
		getAvailableModels: () => [] as Array<{ provider: string; id: string; contextWindow?: number }>,
		async setModel(_model: unknown) {},
		async refreshSshTool(_options?: { activateIfAvailable?: boolean }) {},
	};
	const typedSession = session as unknown as AgentSession & FakeAcpBuiltinSession;
	fakeSessionManager = {
		_sessionFile: undefined as string | undefined,
		_cwd: "/tmp/project",
		_entries: [] as { type: string }[],
		_customEntries: [] as Array<{ customType: string; data: unknown }>,
		_movedTo: undefined as string | undefined,
		_flushed: false,
		_droppedSessions: [] as string[],
		_sessionName: undefined as string | undefined,
		getSessionId(): string {
			return "fake-session-id";
		},
		getSessionFile(): string | undefined {
			return this._sessionFile;
		},
		getEntries(): { type: string }[] {
			return this._entries;
		},
		getBranch(): { type: string }[] {
			return this._entries;
		},
		appendCustomEntry(customType: string, data?: unknown): string {
			this._customEntries.push({ customType, data });
			return "fake-entry-id";
		},
		async flush() {
			this._flushed = true;
		},
		async moveTo(newCwd: string) {
			this._cwd = newCwd;
			this._movedTo = newCwd;
		},
		async setSessionFile(sessionFile: string) {
			this._sessionFile = path.resolve(sessionFile);
			const headerLine = (await Bun.file(this._sessionFile).text()).split("\n", 1)[0] ?? "{}";
			const header = JSON.parse(headerLine) as { cwd?: string };
			if (header.cwd) {
				this._cwd = path.resolve(header.cwd);
				this._movedTo = this._cwd;
			}
		},
		async dropSession(sessionPath: string) {
			this._droppedSessions.push(path.resolve(sessionPath));
			await fs.rm(sessionPath, { force: true });
		},
		getCwd(): string {
			return this._cwd;
		},
		async setSessionName(name: string, _source: string): Promise<boolean> {
			this._sessionName = name;
			return true;
		},
	};
	return {
		output,
		session,
		fakeSessionManager,
		runtime: {
			session: typedSession,
			sessionManager: fakeSessionManager as unknown as SessionManager,
			settings,
			cwd: "/tmp/project",
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
			notifyTitleChanged: undefined as (() => Promise<void> | void) | undefined,
			notifyConfigChanged: undefined as (() => Promise<void> | void) | undefined,
		},
	};
}

describe("ACP builtin slash commands", () => {
	it("consumes fast status without returning prompt text", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/fast status", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output).toEqual([`${PRIORITY_TIER_COMMAND_LABEL} is off.`]);
	});

	it("forces a tool and returns remaining prompt text", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/force read inspect package.json", runtime);

		expect(result).toEqual({ prompt: "inspect package.json" });
		expect(runtime.session.forcedToolChoice).toBe("read");
		expect(output).toEqual(["Next turn forced to use read."]);
	});

	it("renders provider usage reports when the session can fetch them", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.fetchUsageReports = async () => [
			{
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [
					{
						id: "codex-5h",
						label: "5 hours",
						scope: { provider: "openai-codex", tier: "prolite", accountId: "account-1" },
						window: { id: "5h", label: "5 hours", resetsAt: Date.now() + 60 * 60 * 1000 },
						amount: { used: 0.24, usedFraction: 0.24, unit: "unknown" },
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		const result = await executeAcpBuiltinSlashCommand("/usage show", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("OpenAI Codex");
		expect(output[0]).toContain("5 hours (prolite)");
		expect(output[0]).toContain("user@example.com: 0.24 unknown used (76.0% left)");
		expect(output[0]).toContain("resets in");
	});
	/**
	 * Bare `/usage` used to be `/usage show`, so `reset` existed and nothing said so. It now lists
	 * the subcommands instead, and must not reach the provider: fetching a usage report is work the
	 * operator did not ask for, and printing it is the hidden default this replaced.
	 */
	it("bare /usage lists its subcommands instead of rendering the report", async () => {
		const plain = createRuntime();
		let fetched = 0;
		plain.runtime.session.fetchUsageReports = async () => {
			fetched += 1;
			return [];
		};

		const result = await executeAcpBuiltinSlashCommand("/usage", plain.runtime);

		expect(result).toEqual({ consumed: true });
		expect(fetched).toBe(0);
		expect(plain.output[0]).toContain("/usage show");
		expect(plain.output[0]).toContain("/usage reset");
	});

	it("routes saved reset redemption through /usage reset", async () => {
		const { output, runtime } = createRuntime();
		let redeemedTarget: ResetCreditTarget | undefined;
		runtime.session.listResetCredits = async () => [
			{
				credentialId: 42,
				accountId: "account-1",
				email: "user@example.com",
				availableCount: 1,
				credits: [],
				active: true,
			},
		];
		runtime.session.redeemResetCredit = async target => {
			redeemedTarget = target;
			return { ok: true, code: "reset", email: target.email };
		};

		const result = await executeAcpBuiltinSlashCommand("/usage reset active", runtime);

		expect(result).toEqual({ consumed: true });
		expect(redeemedTarget).toEqual({ credentialId: 42, accountId: "account-1", email: "user@example.com" });
		expect(output).toEqual(["Reset applied for user@example.com — your rate-limit window has been refreshed."]);
	});

	it("does not dispatch the legacy /reset-usage command", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/reset-usage active", runtime);

		expect(result).toBe(false);
		expect(output).toEqual([]);
	});

	it("returns false for unknown commands", async () => {
		const { runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/not-a-real-command-xyz", runtime);

		expect(result).toBe(false);
	});

	// /jobs
	it("jobs: shows informative message when snapshot is null", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/jobs", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("background jobs");
	});

	it("jobs: lists running and recent jobs from snapshot", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.getAsyncJobSnapshot = () => ({
			running: [{ id: "j1", type: "bash", status: "running", label: "npm install", startTime: Date.now() - 5000 }],
			recent: [{ id: "j2", type: "task", status: "completed", label: "build done", startTime: Date.now() - 60_000 }],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		});

		const result = await executeAcpBuiltinSlashCommand("/jobs", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("npm install");
		expect(output[0]).toContain("build done");
		expect(output[0]).toContain("Running Jobs");
		expect(output[0]).toContain("Recent Jobs");
	});

	// /dump
	it("dump: outputs transcript with LLM request JSON path when sidecar succeeds", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.formatSessionAsText = () => "Session content here";
		runtime.session.dumpLlmRequestToTmpDir = async () => "/tmp/veyyon-llm-request-test.json";

		const result = await executeAcpBuiltinSlashCommand("/dump", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Session content here");
		expect(output[0]).toContain("LLM request JSON: /tmp/veyyon-llm-request-test.json");
		expect(output[0]).toContain("persists on disk");
	});

	/**
	 * The sidecar is the machine-readable half of what `/dump` promises. It used
	 * to be dropped in silence, so the operator got a transcript that looked
	 * complete and then went looking for a file that was never written. The
	 * transcript must still be emitted (the failure is not fatal), and the reason
	 * the sidecar is missing must be stated.
	 */
	it("dump: reports the reason when dumpLlmRequestToTmpDir throws, and still outputs the transcript", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.formatSessionAsText = () => "Session content here";
		runtime.session.dumpLlmRequestToTmpDir = async () => {
			throw new Error("convert failed");
		};

		const result = await executeAcpBuiltinSlashCommand("/dump", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Session content here");
		expect(output[0]).toContain("LLM request JSON could not be written: convert failed");
	});

	it("dump: outputs empty-state message when no messages", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/dump", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("No messages");
	});

	// /model
	it("model: returns current model when set", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.model = { provider: "anthropic", id: "claude-opus-4-5" } as never;

		const result = await executeAcpBuiltinSlashCommand("/model", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("anthropic/claude-opus-4-5");
	});

	it("model: returns no-selection message when undefined", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/model", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("No model");
	});

	it("model: returns ACP usage message when args provided", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/model claude-3-5-sonnet", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]?.toLowerCase()).toContain("acp");
	});

	/**
	 * Dispatch honors each declaration's argument contract: a tail cannot turn a
	 * no-argument reset into a handled command, while `/model <id>` remains a
	 * real invocation rather than falling through as prompt text.
	 */
	it("rejects argument tails for /fresh but accepts them for /model", async () => {
		const { output, runtime } = createRuntime();

		expect(await executeAcpBuiltinSlashCommand("/fresh tail", runtime)).toBe(false);
		expect(await executeAcpBuiltinSlashCommand("/model some-model-id", runtime)).toEqual({ consumed: true });
		expect(output[0]).toContain("Unknown model");
	});

	it("model: applies known id and emits both title + config change notifications", async () => {
		const { output, runtime, session } = createRuntime();
		const available = [{ provider: "anthropic", id: "claude-3-5-sonnet", contextWindow: 200_000 }];
		session.getAvailableModels = () => available;
		let titleNotified = 0;
		let configNotified = 0;
		runtime.notifyTitleChanged = () => {
			titleNotified++;
		};
		runtime.notifyConfigChanged = () => {
			configNotified++;
		};
		const setModelSpy = spyOn(session, "setModel").mockResolvedValue(undefined);

		const result = await executeAcpBuiltinSlashCommand("/model claude-3-5-sonnet", runtime);

		expect(result).toEqual({ consumed: true });
		expect(setModelSpy).toHaveBeenCalledWith(available[0]);
		expect(output[0]).toContain("Model set to anthropic/claude-3-5-sonnet");
		expect(titleNotified).toBe(1);
		expect(configNotified).toBe(1);
	});

	it("model: does not emit config change when id is unknown", async () => {
		const { runtime } = createRuntime();
		let configNotified = 0;
		runtime.notifyConfigChanged = () => {
			configNotified++;
		};

		await executeAcpBuiltinSlashCommand("/model nonexistent", runtime);

		expect(configNotified).toBe(0);
	});

	// Removed TUI-only and dropped commands fall through as false
	it("removed commands return false (fall through to model)", async () => {
		const removedCommands = [
			"/login",
			"/logout",
			"/resume",
			"/tree",
			"/branch",
			"/plan",
			"/loop",
			"/hotkeys",
			"/extensions",
			"/agents",
			"/copy",
			"/btw hi",
			"/new",
			"/drop",
			// `/handoff` is NOT here: it carries textMode, so an ACP client can dispatch it.
			// test/acp-agent.test.ts asserts the positive half.
			"/fork",
		];
		for (const cmd of removedCommands) {
			const { runtime } = createRuntime();
			const result = await executeAcpBuiltinSlashCommand(cmd, runtime);
			expect(result, `${cmd} reached a handler an ACP client cannot drive`).toBe(false);
		}
	});
});

describe("session lifecycle commands", () => {
	it("/session delete: returns in-memory usage when no sessionFile", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/session delete", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("in-memory");
	});

	it("/session delete: refuses while streaming", async () => {
		const { output, session, fakeSessionManager, runtime } = createRuntime();
		session.isStreaming = true;
		fakeSessionManager._sessionFile = "/tmp/session.jsonl";
		const result = await executeAcpBuiltinSlashCommand("/session delete", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("streaming");
	});

	it("/rename: renames and calls notifyTitleChanged on success", async () => {
		const { output, fakeSessionManager, runtime } = createRuntime();
		let notified = false;
		runtime.notifyTitleChanged = async () => {
			notified = true;
		};
		const result = await executeAcpBuiltinSlashCommand("/rename Project Apex", runtime);
		expect(result).toEqual({ consumed: true });
		expect(fakeSessionManager._sessionName).toBe("Project Apex");
		expect(output[0]).toBe("Session renamed to Project Apex.");
		expect(notified).toBe(true);
	});

	it("/rename: outputs precedence message when setSessionName returns false", async () => {
		const { output, fakeSessionManager, runtime } = createRuntime();
		let notified = false;
		runtime.notifyTitleChanged = async () => {
			notified = true;
		};
		fakeSessionManager.setSessionName = async () => false;
		const result = await executeAcpBuiltinSlashCommand("/rename Bar", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("takes precedence");
		expect(notified).toBe(false);
	});

	it("/move: refuses while streaming", async () => {
		const { output, session, runtime } = createRuntime();
		session.isStreaming = true;
		const result = await executeAcpBuiltinSlashCommand("/move /tmp", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("streaming");
	});
});

describe("wave 3 commands", () => {
	// /export
	it("/export: calls exportToHtml with the given arg and outputs the path", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/export /tmp/out.html", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toBe("Session exported to: /tmp/out.html");
	});

	it("/export: uses default path when no arg given", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/export", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Session exported to:");
	});

	it("/export: returns usage on exportToHtml failure", async () => {
		const { output, session, runtime } = createRuntime();
		session.exportToHtml = async () => {
			throw new Error("disk full");
		};
		const result = await executeAcpBuiltinSlashCommand("/export", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Failed to export session: disk full");
	});

	// /todo
	it("/todo no-args: outputs empty state message when no todos", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/todo", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toBe("No todos. Use /todo append <task> to start one.");
	});

	it("/todo append: stores phases and records custom entry", async () => {
		const { session, fakeSessionManager, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand('/todo append "Build" "Wire setup"', runtime);
		expect(result).toEqual({ consumed: true });
		expect(session._todoPhases).toHaveLength(1);
		expect(session._todoPhases[0]?.name).toBe("Build");
		expect(session._todoPhases[0]?.tasks[0]?.content).toBe("Wire setup");
		expect(fakeSessionManager._customEntries).toHaveLength(1);
		expect(fakeSessionManager._customEntries[0]?.customType).toBe("user_todo_edit");
	});

	it("/todo export: writes the default file under the active session cwd", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-todo-export-"));
		try {
			const { output, session, fakeSessionManager, runtime } = createRuntime();
			fakeSessionManager._cwd = tempRoot;
			session._todoPhases = [{ name: "Work", tasks: [{ content: "Ship it", status: "pending" }] }];

			const result = await executeAcpBuiltinSlashCommand("/todo export", runtime);

			const target = path.join(tempRoot, "TODO.md");
			expect(result).toEqual({ consumed: true });
			expect(output[0]).toBe(`Wrote todos to ${target}`);
			expect(await fs.readFile(target, "utf8")).toBe("# Work\n- [ ] Ship it\n");
		} finally {
			await removeWithRetries(tempRoot);
		}
	});

	it("/todo export: writes a quoted path with spaces", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-todo-export-quoted-"));
		try {
			const { output, session, runtime } = createRuntime();
			const target = path.join(tempRoot, "todo file.md");
			session._todoPhases = [{ name: "Work", tasks: [{ content: "Ship it", status: "pending" }] }];

			const result = await executeAcpBuiltinSlashCommand(`/todo export "${target}"`, runtime);

			expect(result).toEqual({ consumed: true });
			expect(output[0]).toBe(`Wrote todos to ${target}`);
			expect(await fs.readFile(target, "utf8")).toBe("# Work\n- [ ] Ship it\n");
		} finally {
			await removeWithRetries(tempRoot);
		}
	});

	it("/todo import: reads a quoted absolute path", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-todo-import-"));
		try {
			const target = path.join(tempRoot, "todo file.md");
			await fs.writeFile(target, "# Imported\n- [/] Active task\n", "utf8");
			const { output, session, runtime } = createRuntime();

			const result = await executeAcpBuiltinSlashCommand(`/todo import "${target}"`, runtime);

			expect(result).toEqual({ consumed: true });
			expect(output[0]).toBe(`Imported 1 phase(s), 1 task(s) from ${target}.`);
			expect(session._todoPhases).toEqual([
				{ name: "Imported", tasks: [{ content: "Active task", status: "in_progress" }] },
			]);
		} finally {
			await removeWithRetries(tempRoot);
		}
	});

	it("/todo import: reads the default file under the active session cwd", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-todo-import-default-"));
		try {
			const target = path.join(tempRoot, "TODO.md");
			await fs.writeFile(target, "# Default\n- [ ] From cwd\n", "utf8");
			const { output, session, fakeSessionManager, runtime } = createRuntime();
			fakeSessionManager._cwd = tempRoot;

			const result = await executeAcpBuiltinSlashCommand("/todo import", runtime);

			expect(result).toEqual({ consumed: true });
			expect(output[0]).toBe(`Imported 1 phase(s), 1 task(s) from ${target}.`);
			expect(session._todoPhases).toEqual([
				{ name: "Default", tasks: [{ content: "From cwd", status: "in_progress" }] },
			]);
		} finally {
			await removeWithRetries(tempRoot);
		}
	});

	it("/todo import: reports parse errors without committing", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-todo-import-invalid-"));
		try {
			const target = path.join(tempRoot, "TODO.md");
			await fs.writeFile(target, "# Imported\nnot a todo\n", "utf8");
			const { output, session, fakeSessionManager, runtime } = createRuntime();
			fakeSessionManager._cwd = tempRoot;

			const result = await executeAcpBuiltinSlashCommand("/todo import", runtime);

			expect(result).toEqual({ consumed: true });
			expect(output[0]).toContain(`Could not parse ${target}:`);
			expect(session._todoPhases).toEqual([]);
		} finally {
			await removeWithRetries(tempRoot);
		}
	});

	it("/todo export: reports invalid internal-scheme paths", async () => {
		const { output, session, runtime } = createRuntime();
		session._todoPhases = [{ name: "Work", tasks: [{ content: "Ship it", status: "pending" }] }];

		const result = await executeAcpBuiltinSlashCommand("/todo export artifact://1", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Failed to write todos:");
		expect(output[0]).toContain("internal scheme");
	});

	it("/todo import: reports invalid internal-scheme paths", async () => {
		const { output, session, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/todo import artifact://1", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Failed to read todos:");
		expect(output[0]).toContain("internal scheme");
		expect(session._todoPhases).toEqual([]);
	});

	it("/todo edit: returns TUI-only usage message", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/todo edit", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("TUI editor");
	});

	it("/todo unknown: returns usage message", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/todo foobar", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Unknown /todo subcommand");
	});

	/**
	 * Locks out the disagreement where the "Unknown /todo subcommand" message listed
	 * append/start/done/drop/rm/copy/export/import but omitted `edit` and `help`,
	 * both of which the dispatcher accepts. Omitting `help` was self-defeating: the
	 * one verb that prints the full usage was absent from the message telling the
	 * user what is valid. Asserts the exact bytes, then proves every verb the
	 * message names is really accepted.
	 */
	it("/todo unknown: names every accepted verb, and every named verb is accepted", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/todo halp", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toBe(
			"Unknown /todo subcommand.\nUse append, start, done, drop, rm, copy, export, import, edit, or help.",
		);

		const named = ["append", "start", "done", "drop", "rm", "copy", "export", "import", "edit", "help"];
		for (const verb of named) {
			const probe = createRuntime();
			await executeAcpBuiltinSlashCommand(`/todo ${verb}`, probe.runtime);
			expect(probe.output[0] ?? "").not.toContain("Unknown /todo subcommand");
		}
	});

	// /move
	it("/move: returns usage when no arg", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/move", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Usage: /move");
	});

	it("/move: returns usage when path does not exist", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/move /no/such/path/xyz", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("does not exist");
	});

	it("/move: relocates storage and cwd-scoped runtime through one transaction owner", async () => {
		const { output, runtime, session, fakeSessionManager } = createRuntime();
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-move-target-"));
		const moveToCwd = spyOn(session, "moveToCwd");
		let configNotified = 0;
		runtime.notifyConfigChanged = () => {
			configNotified++;
		};

		try {
			const result = await executeAcpBuiltinSlashCommand(`/move ${targetDir}`, runtime);

			expect(result).toEqual({ consumed: true });
			expect(fakeSessionManager._movedTo).toBe(targetDir);
			expect(fakeSessionManager.getCwd()).toBe(targetDir);
			expect(session._switchedTo).toBeUndefined();
			expect(session._movedFromEmptySessionFile).toBeUndefined();
			expect(moveToCwd).toHaveBeenCalledTimes(1);
			expect(moveToCwd).toHaveBeenCalledWith(targetDir);
			expect(configNotified).toBe(1);
			expect(output[0]).toContain(`Moved to ${targetDir}.`);
		} finally {
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("/move: reports a failed transaction and keeps the original cwd", async () => {
		const { output, runtime, session, fakeSessionManager } = createRuntime();
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-move-rescope-failure-"));
		spyOn(session, "moveToCwd").mockRejectedValue(new Error("secret refresh failed"));

		try {
			const result = await executeAcpBuiltinSlashCommand(`/move ${targetDir}`, runtime);

			expect(result).toEqual({ consumed: true });
			expect(fakeSessionManager.getCwd()).toBe("/tmp/project");
			expect(output).toEqual(["Move failed: secret refresh failed"]);
		} finally {
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	// /memory
	it("/memory unknown: returns usage message", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/memory unknownverb", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Usage: /memory");
	});

	// /todo start fuzzy match
	it("/todo start: finds pending task by substring and starts it", async () => {
		const { output, session, runtime } = createRuntime();
		session._todoPhases = [{ name: "Setup", tasks: [{ content: "Wire up router", status: "pending" }] }];
		const result = await executeAcpBuiltinSlashCommand('/todo start "wire"', runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Wire up router");
		expect(session._todoPhases[0]?.tasks[0]?.status).toBe("in_progress");
	});

	// /browser
	it("/browser visible: sets headless=false; second call is idempotent", async () => {
		const { runtime } = createRuntime();
		runtime.settings.set("browser.enabled", true);
		runtime.settings.set("browser.headless", true);
		const r1 = await executeAcpBuiltinSlashCommand("/browser visible", runtime);
		expect(r1).toEqual({ consumed: true });
		expect(runtime.settings.get("browser.headless")).toBe(false);
		const r2 = await executeAcpBuiltinSlashCommand("/browser visible", runtime);
		expect(r2).toEqual({ consumed: true });
		expect(runtime.settings.get("browser.headless")).toBe(false);
	});

	it("/browser no-arg after /browser visible toggles to headless", async () => {
		const { output, runtime } = createRuntime();
		runtime.settings.set("browser.enabled", true);
		runtime.settings.set("browser.headless", true);
		await executeAcpBuiltinSlashCommand("/browser visible", runtime);
		const r = await executeAcpBuiltinSlashCommand("/browser", runtime);
		expect(r).toEqual({ consumed: true });
		expect(output[output.length - 1]).toContain("headless");
		expect(runtime.settings.get("browser.headless")).toBe(true);
	});

	// /compact
	it("/compact: reports Compaction complete. after session.compact resolves", async () => {
		const { output, session, runtime } = createRuntime();
		let compactCalled = false;
		session.compact = async (_args?: string) => {
			compactCalled = true;
		};
		const result = await executeAcpBuiltinSlashCommand("/compact", runtime);
		expect(result).toEqual({ consumed: true });
		expect(compactCalled).toBe(true);
		expect(output[0]).toContain("Compaction complete.");
	});

	/**
	 * `handoff` is not a compaction mode: `/compact` condenses history in place
	 * and keeps the session, while a handoff replaces it. Reading the token as
	 * focus text would summarize when a transfer was requested, and routing it
	 * into compact would keep the old session either way, so the token is refused
	 * by name and the refusal states the command that performs the transfer.
	 * Nothing may compact on the way out.
	 */
	it("/compact handoff: refuses the token and names the command that transfers", async () => {
		const { output, session, runtime } = createRuntime();
		let compactCalled = false;
		session.compact = async () => {
			compactCalled = true;
		};

		const result = await executeAcpBuiltinSlashCommand("/compact handoff preserve failing gates", runtime);

		expect(result).toEqual({ consumed: true });
		expect(compactCalled).toBe(false);
		expect(output[0]).toBe(
			"`handoff` is not a compaction mode. Use `/handoff [focus instructions]` to transfer context to a new session.",
		);
	});
});

describe("wave 4 commands", () => {
	// /mcp
	it("/mcp (no args): outputs help text containing list, enable, disable, remove, reload", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/mcp", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("list");
		expect(output[0]).toContain("enable");
		expect(output[0]).toContain("disable");
		expect(output[0]).toContain("remove");
		expect(output[0]).toContain("reload");
	});

	it("/mcp help: outputs help text containing list, enable, disable, remove, reload", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/mcp help", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("list");
		expect(output[0]).toContain("enable");
		expect(output[0]).toContain("disable");
		expect(output[0]).toContain("remove");
		expect(output[0]).toContain("reload");
	});

	it("/mcp add (no args): returns usage string", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/mcp add", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Usage");
	});

	it("/mcp reload: calls refreshCommands and outputs confirmation", async () => {
		let refreshCalled = false;
		const { output, runtime } = createRuntime();
		runtime.refreshCommands = () => {
			refreshCalled = true;
		};
		const result = await executeAcpBuiltinSlashCommand("/mcp reload", runtime);
		expect(result).toEqual({ consumed: true });
		expect(refreshCalled).toBe(true);
		expect(output[0]).toContain("reload");
	});

	it("/mcp resources: outputs server list or no-server message", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/mcp resources", runtime);
		expect(result).toEqual({ consumed: true });
		// No servers configured in tmp project dir — should report that
		expect(output[0]).toMatch(/No MCP servers configured|No resources/);
	});

	it("/mcp unknown-verb: returns usage pointing to help", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/mcp frobnicate", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Unknown");
	});

	// /ssh
	it("/ssh (no args): outputs help text containing list and remove", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/ssh", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("list");
		expect(output[0]).toContain("remove");
	});

	it("/ssh help: outputs help text containing list and remove", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/ssh help", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("list");
		expect(output[0]).toContain("remove");
	});

	it("/ssh add (no args): returns usage", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/ssh add", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Usage");
	});

	it("/ssh unknown-verb: returns unknown subcommand message", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/ssh frobnicate", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Unknown");
	});

	// /marketplace was removed as a slash command (plugin management lives in
	// the `plugin` CLI subcommand and the TUI dashboards); ACP must not consume
	// it — the input falls through as a regular prompt.
	it("/marketplace is not a builtin: falls through as a prompt", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/marketplace help", runtime);
		expect(result).toBe(false);
		expect(output).toEqual([]);
	});

	// /plugins

	// /todo start with in_progress status in fuzzy list
	it("/todo start: resolves ambiguous matches by preferring active tasks", async () => {
		const { output, session, runtime } = createRuntime();
		session._todoPhases = [
			{
				name: "Phase 1",
				tasks: [
					{ content: "Wire auth middleware", status: "pending" },
					{ content: "Wire session store", status: "completed" },
				],
			},
		];
		const result = await executeAcpBuiltinSlashCommand('/todo start "wire"', runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Wire auth middleware");
	});
});

describe("wave 5 — adapters and polish", () => {
	// /mcp help lists new subcommands
	it("/mcp help: lists resources, prompts, test, add, smithery-search", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/mcp help", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("resources");
		expect(output[0]).toContain("prompts");
		expect(output[0]).toContain("test");
		expect(output[0]).toContain("add");
		expect(output[0]).toContain("smithery-search");
	});

	// /mcp add — verify parsing and output message
	it("/mcp add foo url … token X: writes the profile config and names no scope", async () => {
		const spy = spyOn(mcpConfigWriter, "addMCPServer").mockResolvedValue(undefined);
		try {
			const { output, runtime } = createRuntime();
			const result = await executeAcpBuiltinSlashCommand("/mcp add foo url https://example.com token X", runtime);
			expect(result).toEqual({ consumed: true });
			expect(output[0]).toBe('Added MCP server "foo".');
			expect(spy).toHaveBeenCalledTimes(1);
			// Lock in the parsed call shape so future regressions in the `url` / `token`
			// keyword fail this test instead of silently writing a different config.
			const [configPath, serverName, serverConfig] = spy.mock.calls[0]!;
			expect(serverName).toBe("foo");
			expect(serverConfig).toMatchObject({
				type: "http",
				url: "https://example.com",
				headers: { Authorization: "Bearer X" },
			});
			// The destination is never anything under the working tree: a project-scoped
			// write went to `<cwd>/.veyyon/mcp.json`, which `loadAllMCPConfigs` never reads.
			expect(configPath).not.toContain(`${path.sep}.veyyon${path.sep}mcp.json`);
			expect(path.basename(configPath)).toBe("mcp.json");
		} finally {
			spy.mockRestore();
		}
	});

	/**
	 * The scope words are refused rather than read, on this surface too. It kept a
	 * `project` scope after the terminal dropped it, DEFAULTED to it, and wrote a
	 * file `loadAllMCPConfigs` never reads while reporting success.
	 */
	it.each(["/mcp add foo url https://example.com project", "/mcp remove foo project"])(
		"%p is refused and writes no config",
		async command => {
			const addSpy = spyOn(mcpConfigWriter, "addMCPServer").mockResolvedValue(undefined);
			const removeSpy = spyOn(mcpConfigWriter, "removeMCPServer").mockResolvedValue(undefined);
			try {
				const { output, runtime } = createRuntime();
				await executeAcpBuiltinSlashCommand(command, runtime);
				expect(output[0]).toContain("project is gone");
				expect(output[0]).toContain("never per repository");
				expect(addSpy).not.toHaveBeenCalled();
				expect(removeSpy).not.toHaveBeenCalled();
			} finally {
				addSpy.mockRestore();
				removeSpy.mockRestore();
			}
		},
	);

	/**
	 * The option spellings `/mcp add` no longer has must be REFUSED, and the refusal
	 * must reach the operator instead of a config write. Accepting the old spelling
	 * would keep a grammar nobody can see; dropping it would register a server
	 * missing the URL or the credential that was asked for, which then fails to
	 * connect for a reason the operator cannot see either.
	 */
	it.each([
		"/mcp add foo --url https://example.com",
		"/mcp add foo --token X",
		"/mcp add foo --scope project",
		"/mcp add foo -- echo hi",
	])("%p is refused and writes no config", async command => {
		const spy = spyOn(mcpConfigWriter, "addMCPServer").mockResolvedValue(undefined);
		try {
			const { output, runtime } = createRuntime();
			const result = await executeAcpBuiltinSlashCommand(command, runtime);
			expect(result).toEqual({ consumed: true });
			expect(spy).not.toHaveBeenCalled();
			expect(output[0]).toContain("is gone");
			expect(output[0]).toContain("/mcp add");
		} finally {
			spy.mockRestore();
		}
	});

	// /mcp test — spy on connectToServer
	it("/mcp test bogus: returns error when server not found in config", async () => {
		const { output, runtime } = createRuntime();
		// No servers in /tmp/project config — server not found
		const result = await executeAcpBuiltinSlashCommand("/mcp test bogus", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("not found");
	});

	// /ssh add — spy on addSSHHost. There is no scope: an SSH host is written to the
	// operator's own config, and the option that used to pick a repository-local file
	// is gone. The host is POSITION 2, so a host literally spelled `user` still works.
	it("/ssh add foo x user y: calls addSSHHost", async () => {
		const spy = spyOn(sshConfigWriter, "addSSHHost").mockResolvedValue(undefined);
		try {
			const { output, runtime } = createRuntime();
			const result = await executeAcpBuiltinSlashCommand("/ssh add foo x user y", runtime);
			expect(result).toEqual({ consumed: true });
			expect(output[0]).toContain('Added SSH host "foo".');
			// Without this assertion, the command could succeed via a side-effect-free
			// path that prints the success message without writing the host config.
			expect(spy).toHaveBeenCalledTimes(1);
			const [configPath, name, hostConfig] = spy.mock.calls[0]!;
			expect(typeof configPath).toBe("string");
			expect(name).toBe("foo");
			expect(hostConfig).toMatchObject({ host: "x", username: "y" });
		} finally {
			spy.mockRestore();
		}
	});

	it("/ssh add reads a bare integer as the port and a host named like a keyword", async () => {
		const spy = spyOn(sshConfigWriter, "addSSHHost").mockResolvedValue(undefined);
		try {
			const { runtime } = createRuntime();
			await executeAcpBuiltinSlashCommand("/ssh add foo user 2222 key /k/id_ed25519", runtime);
			expect(spy).toHaveBeenCalledTimes(1);
			const [, name, hostConfig] = spy.mock.calls[0]!;
			expect(name).toBe("foo");
			expect(hostConfig).toMatchObject({ host: "user", port: 2222, keyPath: "/k/id_ed25519" });
		} finally {
			spy.mockRestore();
		}
	});

	it.each(["/ssh add foo --host x", "/ssh add foo x --user y", "/ssh add foo x --port 2222"])(
		"%p is refused and writes no SSH host",
		async command => {
			const spy = spyOn(sshConfigWriter, "addSSHHost").mockResolvedValue(undefined);
			try {
				const { output, runtime } = createRuntime();
				const result = await executeAcpBuiltinSlashCommand(command, runtime);
				expect(result).toEqual({ consumed: true });
				expect(spy).not.toHaveBeenCalled();
				expect(output[0]).toContain("is gone");
				expect(output[0]).toContain("/ssh add");
			} finally {
				spy.mockRestore();
			}
		},
	);

	// /model with unknown id
	it("/model gpt-fake-9000: returns unknown-model message", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/model gpt-fake-9000", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Unknown model");
	});

	// /model with known id (fake registry)
	it("/model known-id: reports model set and triggers notifyTitleChanged", async () => {
		const { output, session, runtime } = createRuntime();
		session.getAvailableModels = () => [{ provider: "anthropic", id: "claude-sonnet-test" }];
		let titleChanged = false;
		runtime.notifyTitleChanged = () => {
			titleChanged = true;
		};
		const result = await executeAcpBuiltinSlashCommand("/model claude-sonnet-test", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Model set to anthropic/claude-sonnet-test.");
		expect(titleChanged).toBe(true);
	});

	// /usage bar character
	it("/usage show: includes bar character when usedFraction is 0.5", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.fetchUsageReports = async () => [
			{
				provider: "test-provider",
				fetchedAt: Date.now(),
				limits: [
					{
						id: "test-limit",
						label: "Monthly",
						scope: { provider: "test-provider", tier: "pro", accountId: "acct-1" },
						window: { id: "monthly", label: "monthly", resetsAt: Date.now() + 30 * 86400_000 },
						amount: { used: 50, usedFraction: 0.5, unit: "requests" },
					},
				],
				metadata: {},
			},
		];
		const result = await executeAcpBuiltinSlashCommand("/usage show", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("█");
	});

	// /context breakdown
	it("/context: lists more than one breakdown line for session with messages", async () => {
		const { output, session, runtime } = createRuntime();
		// computeContextBreakdown needs model.contextWindow; fake session falls back gracefully
		(session as unknown as Record<string, unknown>).model = {
			provider: "anthropic",
			id: "claude-test",
			contextWindow: 200_000,
		};
		(session as unknown as Record<string, unknown>).skills = [];
		(session as unknown as Record<string, unknown>).agent = { state: { tools: [] } };
		(session as unknown as Record<string, unknown>).systemPrompt = ["You are a helpful assistant."];
		session.messages = [
			{ role: "user", content: "Hello, how are you?" },
			{ role: "assistant", content: "I am doing well." },
		];
		const result = await executeAcpBuiltinSlashCommand("/context", runtime);
		expect(result).toEqual({ consumed: true });
		// Should show the breakdown with multiple lines (Messages category visible)
		const text = output[0] ?? "";
		expect(text).toContain("tokens");
		expect(text.split("\n").length).toBeGreaterThan(1);
	});

	// /jobs empty state
	it("/jobs: empty-state output mentions background jobs definition", async () => {
		const { output, runtime } = createRuntime();
		// Return empty snapshot (running=[], recent=[])
		runtime.session.getAsyncJobSnapshot = () => ({
			running: [],
			recent: [],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		});
		const result = await executeAcpBuiltinSlashCommand("/jobs", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("background jobs");
	});
});
