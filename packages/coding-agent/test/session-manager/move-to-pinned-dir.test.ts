import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";

/**
 * `moveTo` must not move a session out of the directory its caller pinned.
 *
 * `SessionManager.create(cwd, sessionDir)` takes an EXPLICIT storage path, and
 * `moveTo` used to discard it. The rule it applied was a guess: a directory
 * counted as "managed" only when its basename was the encoded form of the
 * current cwd, and anything else fell through to
 * `computeDefaultSessionDir(newCwd, storage)` with the GLOBAL sessions root. So
 * a caller that deliberately pinned session storage to one location had its
 * data land somewhere else entirely after a cwd move, with nothing logged.
 *
 * That is a silent fallback in the Law 10 sense: the move succeeds, the session
 * keeps working, and the only symptom is files appearing under `~/.veyyon` that
 * the caller explicitly asked to be kept elsewhere. It is how `sdk-move-cwd`
 * ended up writing into the operator's real profile directory.
 *
 * What the basename could not distinguish is the whole problem, because the two
 * cases it conflates want OPPOSITE things. A caller that pinned a directory
 * wants storage to stay there. A session opened from a file that happens to sit
 * somewhere arbitrary wants to re-root into the new project, which is exactly
 * what makes `--resume` able to adopt a session whose directory was moved or
 * renamed. A filename cannot answer which one it is looking at, so the intent is
 * now recorded at construction instead of inferred.
 *
 * Both halves are pinned below. A fix that only kept pinned directories in place
 * would break the re-root flow, and one that only re-rooted would reintroduce
 * the original bug.
 */
describe("moveTo and an explicitly pinned session directory", () => {
	const tempDirs: TempDir[] = [];
	let dirOverrides: DirOverridesSnapshot | undefined;

	function makeTempDir(prefix: string): string {
		const dir = TempDir.createSync(prefix);
		tempDirs.push(dir);
		return dir.path();
	}

	beforeEach(() => {
		// The default session root resolves under the agent dir. Without moving it,
		// this suite writes into the developer's real data directory.
		//
		// The whole snapshot, not just `VEYYON_CODING_AGENT_DIR`: `setAgentDir` also deletes
		// `VEYYON_PROFILE` and overwrites the pre-profile baseline, so restoring the one
		// variable by hand left this file handing an unset profile to every suite scheduled
		// after it, which then resolved under `profiles/default/` on a machine that runs with
		// a named profile. `restoreDirOverrides` is the single owner of putting all of it back.
		dirOverrides = captureDirOverrides();
		setAgentDir(makeTempDir("@pi-movepin-agent-"));
	});

	afterEach(async () => {
		if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
	});

	/** A persisted session pinned to `sessionDir`, with one message on disk. */
	async function pinnedSession(cwd: string, sessionDir: string): Promise<SessionManager> {
		const manager = SessionManager.create(cwd, sessionDir);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		await manager.rewriteEntries();
		return manager;
	}

	/**
	 * The core case. The caller pinned one directory; after moving to a different
	 * cwd, the session's files are still in it.
	 */
	it("keeps the session in the pinned directory after a cwd move", async () => {
		const pinned = makeTempDir("@pi-movepin-store-");
		const from = makeTempDir("@pi-movepin-from-");
		const to = makeTempDir("@pi-movepin-to-");
		const manager = await pinnedSession(from, pinned);

		await manager.moveTo(to);

		expect(path.resolve(manager.getSessionDir())).toBe(path.resolve(pinned));
		expect(path.dirname(manager.getSessionFile() ?? "")).toBe(path.resolve(pinned));
	});

	/**
	 * The file has to actually be there, not just the recorded path. A move that
	 * updated the bookkeeping without the rename would satisfy the assertion
	 * above and lose the session.
	 */
	it("leaves the session file readable in the pinned directory", async () => {
		const pinned = makeTempDir("@pi-movepin-store-");
		const manager = await pinnedSession(makeTempDir("@pi-movepin-from-"), pinned);
		const to = makeTempDir("@pi-movepin-to-");

		await manager.moveTo(to);

		const file = manager.getSessionFile();
		expect(file).toBeDefined();
		expect(fs.existsSync(file as string)).toBe(true);
		expect(fs.readFileSync(file as string, "utf8")).toContain("hello");
	});

	/**
	 * The specific regression, stated as its own assertion: nothing may appear
	 * under the global sessions root. This is the one that fails loudly against
	 * the old behaviour, and it is what stops the fix from being reverted by a
	 * later change that "restores the default".
	 */
	it("writes nothing into the global sessions root", async () => {
		const agentRoot = makeTempDir("@pi-movepin-agent2-");
		setAgentDir(agentRoot);
		const pinned = makeTempDir("@pi-movepin-store-");
		const manager = await pinnedSession(makeTempDir("@pi-movepin-from-"), pinned);

		await manager.moveTo(makeTempDir("@pi-movepin-to-"));

		const globalSessions = path.join(agentRoot, "sessions");
		const stray = fs.existsSync(globalSessions)
			? fs.readdirSync(globalSessions, { recursive: true }).map(String).filter(Boolean)
			: [];
		expect(stray, `session data escaped into ${globalSessions}`).toEqual([]);
	});

	/**
	 * The cwd itself still moves. The fix is about storage only, and a version
	 * that pinned the directory by refusing the move would pass every assertion
	 * above while breaking the feature.
	 */
	it("still moves the session's cwd", async () => {
		const manager = await pinnedSession(makeTempDir("@pi-movepin-from-"), makeTempDir("@pi-movepin-store-"));
		const to = makeTempDir("@pi-movepin-to-");

		await manager.moveTo(to);

		expect(path.resolve(manager.getCwd())).toBe(path.resolve(to));
	});

	/**
	 * An explicit `targetSessionDir` still wins over the pin. Honouring the
	 * original pin THERE would be the opposite bug: a caller asking for the files
	 * to move would be ignored.
	 */
	it("moves to an explicitly requested directory when one is given", async () => {
		const pinned = makeTempDir("@pi-movepin-store-");
		const manager = await pinnedSession(makeTempDir("@pi-movepin-from-"), pinned);
		const requested = makeTempDir("@pi-movepin-requested-");

		await manager.moveTo(makeTempDir("@pi-movepin-to-"), requested);

		expect(path.resolve(manager.getSessionDir())).toBe(path.resolve(requested));
		expect(fs.existsSync(manager.getSessionFile() as string)).toBe(true);
	});

	/**
	 * The behaviour the fix must NOT change, and the one the `--resume` re-root
	 * flow is built on: a session whose directory sits inside a sessions root
	 * (its basename is the encoded cwd) is re-derived under that same root for
	 * the new cwd, so it lands beside its siblings rather than staying under the
	 * old cwd's name.
	 */
	it("still re-derives a managed session directory under the same root", async () => {
		const agentRoot = makeTempDir("@pi-movepin-agent3-");
		setAgentDir(agentRoot);
		const from = makeTempDir("@pi-movepin-managed-from-");
		// No explicit dir: this session is managed, under the agent's sessions root.
		const manager = SessionManager.create(from);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		await manager.rewriteEntries();
		const before = manager.getSessionDir();
		const to = makeTempDir("@pi-movepin-managed-to-");

		await manager.moveTo(to);

		const after = manager.getSessionDir();
		// Same root, different cwd-encoded leaf.
		expect(path.dirname(after)).toBe(path.dirname(before));
		expect(path.basename(after)).not.toBe(path.basename(before));
		expect(fs.existsSync(manager.getSessionFile() as string)).toBe(true);
	});
	/**
	 * The other half of the contract, and the reason the pin has to be recorded
	 * rather than guessed at: a session opened from an arbitrary file path was
	 * never pinned, so it re-roots into the new cwd's directory. `--resume`
	 * depends on this when a project directory is moved or renamed, and a fix that
	 * honoured every non-derived directory would silently disable it.
	 */
	it("re-roots a session opened from an arbitrary file path", async () => {
		const from = makeTempDir("@pi-movepin-openfrom-");
		const to = makeTempDir("@pi-movepin-opento-");
		const filePath = path.join(from, "loose-session.jsonl");
		const manager = await SessionManager.open(filePath);
		expect(fs.existsSync(filePath)).toBe(true);

		await manager.moveTo(to);

		// The session left the arbitrary directory entirely.
		expect(fs.existsSync(filePath)).toBe(false);
		expect(path.resolve(manager.getSessionDir())).not.toBe(path.resolve(from));
		expect(fs.existsSync(manager.getSessionFile() as string)).toBe(true);
	});

	/**
	 * The same call WITH an explicit directory is pinned, so it does not re-root.
	 * This is the pair that proves the behaviour follows the caller's declared
	 * intent and not the shape of the path.
	 */
	it("keeps a session opened with an explicit directory where it was put", async () => {
		const agentRoot = makeTempDir("@pi-movepin-agent4-");
		setAgentDir(agentRoot);
		const pinned = makeTempDir("@pi-movepin-openpinned-");
		const manager = await SessionManager.open(path.join(pinned, "pinned-session.jsonl"), pinned);

		await manager.moveTo(makeTempDir("@pi-movepin-opento2-"));

		expect(path.resolve(manager.getSessionDir())).toBe(path.resolve(pinned));
		expect(fs.existsSync(manager.getSessionFile() as string)).toBe(true);
		const globalSessions = path.join(agentRoot, "sessions");
		expect(fs.existsSync(globalSessions) ? fs.readdirSync(globalSessions).map(String) : []).toEqual([]);
	});
});
