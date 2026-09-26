/**
 * `--resume <id>` opens a session from another project in place: the same
 * transcript, still rooted at its recorded directory, with no prompt and no
 * fork into the launch directory, interactive or not. The launch then moves the
 * process into that directory, unless an explicit `--cwd` names another one, in
 * which case the session is re-rooted there and the move is recorded.
 *
 * Also covers the moved/renamed-worktree path: when the matched session's
 * recorded directory no longer exists, `--resume <id>` offers to *move*
 * (re-root) the session into the launch directory, and declining it exits
 * cleanly (#1668).
 *
 * Not covered here: the profile the resumed session runs under, which
 * `a-resumed-session-continues-in-its-own-profile.test.ts` covers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { type Args, parseArgs } from "@veyyon/coding-agent/cli/args";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createSessionManager, runRootCommand } from "@veyyon/coding-agent/main";
import type { CustomMessageEntry, SessionHeader } from "@veyyon/kernel/session/session-entries";
import type { SessionInfo } from "@veyyon/kernel/session/session-listing";
import * as sessionListingModule from "@veyyon/kernel/session/session-listing";
import { loadEntriesFromFile } from "@veyyon/kernel/session/session-loader";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { getProjectDir, normalizePathForComparison, setProjectDir } from "@veyyon/utils";
import { makeAssistantMessage } from "./session-manager/helpers";

function buildArgs(resume: string, sessionDir?: string): Args {
	return {
		resume,
		sessionDir,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	};
}

function buildGlobalMatch(cwd: string): { session: SessionInfo; scope: "global" } {
	return {
		scope: "global",
		session: {
			path: `${cwd}/019e84ed-b4cc-7000-9c87-5afe6df992c1.jsonl`,
			id: "019e84ed-b4cc-7000-9c87-5afe6df992c1",
			cwd,
			title: "in-other-project",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			size: 0,
			firstMessage: "",
			allMessagesText: "",
		},
	};
}

const stubSettings = { get: () => undefined } as unknown as Settings;

/** A session recorded in `cwd` and answered, so it reaches disk. */
async function persistSession(cwd: string, sessionDir: string): Promise<SessionInfo> {
	const source = SessionManager.create(cwd, sessionDir);
	source.appendMessage({ role: "user", content: "work in the other project", timestamp: 1 });
	source.appendMessage(makeAssistantMessage());
	await source.flush();
	const file = source.getSessionFile();
	if (!file) throw new Error("Expected persisted session file");
	const info: SessionInfo = { ...buildGlobalMatch(cwd).session, path: file, id: source.getSessionId() };
	await source.close();
	return info;
}

describe("createSessionManager — --resume <id> from another project", () => {
	let root: string;
	let otherProject: string;
	let currentProject: string;
	let sessionDir: string;

	beforeEach(async () => {
		root = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-xproj-"));
		otherProject = path.join(root, "other-project");
		currentProject = path.join(root, "current-project");
		sessionDir = path.join(root, "sessions");
		await fsp.mkdir(otherProject, { recursive: true });
		await fsp.mkdir(currentProject, { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(root, { recursive: true, force: true });
	});

	async function persistOtherProjectSession(): Promise<SessionInfo> {
		return await persistSession(otherProject, sessionDir);
	}

	for (const interactive of [true, false]) {
		it(`opens the same transcript at its recorded directory without prompting (stdin TTY: ${interactive})`, async () => {
			const info = await persistOtherProjectSession();
			vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue({
				scope: "global",
				session: info,
			});
			const movePrompt = vi.fn(async () => "accepted" as const);
			const originalIsTTY = process.stdin.isTTY;
			Object.defineProperty(process.stdin, "isTTY", { value: interactive, configurable: true });
			let result: SessionManager | undefined;
			try {
				result = await createSessionManager(
					buildArgs(info.id.slice(0, 8)),
					currentProject,
					stubSettings,
					movePrompt,
				);
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
			}

			if (!result) throw new Error("Expected the resumed session manager");
			try {
				// A fork would hand back a new transcript with a new id, rooted at the launch directory.
				expect(result.getSessionFile()).toBe(info.path);
				expect(result.getSessionId()).toBe(info.id);
				expect(result.getCwd()).toBe(path.resolve(otherProject));
			} finally {
				await result.close();
			}
			expect(movePrompt).not.toHaveBeenCalled();
		});
	}
});

describe("createSessionManager — cross-project --resume relocation (moved worktree)", () => {
	let missingRoot: string;
	let missingProject: string;

	beforeEach(async () => {
		missingRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-moved-xproj-"));
		missingProject = path.join(missingRoot, "worktree-gone");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(missingRoot, { recursive: true, force: true });
	});

	it("offers move and returns undefined when the user declines", async () => {
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(missingProject));
		expect(fs.existsSync(missingProject)).toBe(false);

		const movePrompt = vi.fn(async () => "declined" as const);
		const result = await createSessionManager(buildArgs("019e84ed"), "/current/project", stubSettings, movePrompt);

		expect(result).toBeUndefined();
		expect(movePrompt).toHaveBeenCalledTimes(1);
	});

	it("throws the move-specific error when unavailable in non-interactive mode", async () => {
		const originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		try {
			vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(missingProject));

			await expect(createSessionManager(buildArgs("019e84ed"), "/current/project", stubSettings)).rejects.toThrow(
				`Session "019e84ed" belongs to a directory that no longer exists (${missingProject}); run interactively to move it into the current project.`,
			);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		}
	});

	it("moves a local explicit-session-dir match whose recorded cwd is gone", async () => {
		const currentProject = path.join(missingRoot, "current-project");
		const explicitSessionDir = path.join(missingRoot, "sessions");
		await fsp.mkdir(currentProject, { recursive: true });

		const moved = SessionManager.create(missingProject, explicitSessionDir);
		moved.appendMessage({ role: "user", content: "before local move", timestamp: 1 });
		await moved.flush();
		const oldFile = moved.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted session file");
		const resumePrefix = moved.getSessionId().slice(0, 8);
		const sessionInfo: SessionInfo = {
			path: oldFile,
			id: moved.getSessionId(),
			cwd: missingProject,
			title: "moved-local",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 1,
			size: 0,
			firstMessage: "before local move",
			allMessagesText: "before local move",
		};
		await moved.close();
		expect(fs.existsSync(missingProject)).toBe(false);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue({
			scope: "local",
			session: sessionInfo,
		});

		const movePrompt = vi.fn(async () => "accepted" as const);
		const result = await createSessionManager(
			buildArgs(resumePrefix, explicitSessionDir),
			currentProject,
			stubSettings,
			movePrompt,
		);

		if (!result) throw new Error("Expected moved session manager");
		try {
			expect(result.getSessionFile()).toBe(oldFile);
			expect(result.getCwd()).toBe(path.resolve(currentProject));
			const entries = await loadEntriesFromFile(oldFile);
			const header = entries.find(
				(entry): entry is SessionHeader =>
					typeof entry === "object" &&
					entry !== null &&
					"type" in entry &&
					(entry as { type: unknown }).type === "session",
			);
			expect(header?.cwd).toBe(path.resolve(currentProject));
		} finally {
			await result.close();
		}
		expect(movePrompt).toHaveBeenCalledTimes(1);
	});
});

class StopAfterSessionOptions extends Error {}

class ProcessExitSignal extends Error {}

function realDir(dir: string): string {
	return fs.realpathSync(dir);
}

describe("runRootCommand — a resumed session continues in its recorded directory", () => {
	let root: string;
	let otherProject: string;
	let launchDir: string;
	let sessionDir: string;
	let originalProjectDir: string;

	beforeEach(async () => {
		originalProjectDir = getProjectDir();
		root = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-resume-cwd-"));
		otherProject = path.join(root, "other-project");
		launchDir = path.join(root, "launch-dir");
		sessionDir = path.join(root, "sessions");
		await fsp.mkdir(otherProject, { recursive: true });
		await fsp.mkdir(launchDir, { recursive: true });
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ProcessExitSignal(`process.exit(${code ?? 0})`);
		}) as typeof process.exit);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		await fsp.rm(root, { recursive: true, force: true });
	});

	/** Run the launch up to session construction and return the session manager it would build on. */
	async function launchUntilSession(argv: string[]): Promise<SessionManager> {
		const parsed = parseArgs(argv);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = sessionDir;
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		let opened: SessionManager | undefined;
		try {
			await runRootCommand(parsed, argv, {
				discoverAuthStorage: async () => authStorage,
				// An inherited stdin pipe nobody writes to never reaches EOF.
				readPipedInput: async () => undefined,
				settings: Settings.isolated({}),
				createAgentSession: async options => {
					opened = options?.sessionManager;
					throw new StopAfterSessionOptions();
				},
			});
		} catch (error) {
			if (!(error instanceof StopAfterSessionOptions)) throw error;
		} finally {
			authStorage.close();
		}
		if (!opened) throw new Error("The launch built no session manager");
		return opened;
	}

	it("moves the process into the session's recorded directory", async () => {
		const info = await persistSession(otherProject, sessionDir);
		setProjectDir(launchDir);

		const opened = await launchUntilSession(["--resume", info.id, "--print", "hello"]);
		try {
			expect(opened.getSessionFile()).toBe(info.path);
			expect(realDir(opened.getCwd())).toBe(realDir(otherProject));
			expect(realDir(getProjectDir())).toBe(realDir(otherProject));
		} finally {
			await opened.close();
		}
	}, 15_000);

	it("re-roots the session at an explicit --cwd and records the move", async () => {
		const info = await persistSession(otherProject, sessionDir);
		setProjectDir(root);

		const opened = await launchUntilSession(["--cwd", launchDir, "--resume", info.id, "--print", "hello"]);
		try {
			expect(opened.getSessionFile()).toBe(info.path);
			expect(realDir(opened.getCwd())).toBe(realDir(launchDir));
			expect(realDir(getProjectDir())).toBe(realDir(launchDir));
		} finally {
			await opened.close();
		}

		const entries = await loadEntriesFromFile(info.path);
		const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
		expect(normalizePathForComparison(header?.cwd ?? "")).toBe(normalizePathForComparison(opened.getCwd()));
		const moves = entries.filter(
			(entry): entry is CustomMessageEntry<{ previous: string; cwd: string }> =>
				entry.type === "custom_message" && entry.customType === "cwd_changed",
		);
		expect(moves.map(entry => entry.details)).toEqual([
			{ previous: path.resolve(otherProject), cwd: opened.getCwd() },
		]);
	}, 15_000);
});
