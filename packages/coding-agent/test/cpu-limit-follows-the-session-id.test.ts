/**
 * A session's CPU budget follows the session, not the id it happened to have
 * when the process started.
 *
 * WHY THIS SUITE EXISTS. The limiter is registered once, in the AgentSession
 * constructor, under `sessionManager.getSessionId()`. Every spawn site resolves
 * it back by the session's CURRENT id. Those two facts agree only while the id
 * never changes, and it changes constantly: `/new`, `/resume`, a fork and a
 * branch all mint a fresh id on the same live process.
 *
 * After any of them the registry still held the limiter under the id the
 * operator just left. Nothing looked that id up any more, so the conversation
 * they were now in spawned with no budget at all: `session.cpuLimitCores` was
 * still set, the settings screen still showed it, and the cap silently applied
 * to nothing. `session.cpuLimitKill` went with it. The one visible symptom was
 * the absence of throttling, which is indistinguishable from a machine that is
 * simply fast enough.
 *
 * Three things have to hold for the budget to survive an id change, and each is
 * pinned below: the manager has to say the id moved, the registry has to move
 * with it, and the session has to be listening. The last is the one that was
 * broken; the first two are what it needs in order to work.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import {
	initSessionCpuLimit,
	primarySessionCpuLimit,
	rekeySessionCpuLimit,
	resetSessionCpuLimitsForTests,
	sessionCpuLimit,
} from "@veyyon/coding-agent/session/cpu-limit";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

/** Registering at 0 cores creates no group and touches no cgroup tree, which is all these cases need. */
const INERT = { cores: 0, kill: false, onNotice: () => {} };

let tempDir = "";
let authStorage: AuthStorage | undefined;
let session: AgentSession | undefined;

beforeEach(() => {
	resetSessionCpuLimitsForTests();
	tempDir = path.join(os.tmpdir(), `pi-cpu-rekey-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	resetSessionCpuLimitsForTests();
	if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
});

describe("the session manager reports an id change", () => {
	it("notifies on every mint, and reports the id it has actually adopted", async () => {
		const manager = SessionManager.create(tempDir, tempDir);
		const seen: string[] = [];
		manager.onSessionIdChanged(id => seen.push(id));
		const first = manager.getSessionId();

		await manager.newSession();
		const second = manager.getSessionId();

		expect(second).not.toBe(first);
		// The listener runs with the value already installed, so a subscriber can
		// re-register against the manager rather than against its own argument.
		expect(seen).toEqual([second]);
	});

	it("stops notifying once unsubscribed", async () => {
		const manager = SessionManager.create(tempDir, tempDir);
		const seen: string[] = [];
		const unsubscribe = manager.onSessionIdChanged(id => seen.push(id));

		await manager.newSession();
		unsubscribe();
		await manager.newSession();

		expect(seen.length).toBe(1);
	});
});

describe("the registry follows a session that was renamed", () => {
	it("keeps the same limiter, so pids already adopted into it stay accounted", async () => {
		const limiter = await initSessionCpuLimit({ sessionId: "old", ...INERT });

		expect(rekeySessionCpuLimit("old", "new")).toBe(limiter);
		expect(sessionCpuLimit("new")).toBe(limiter);
		expect(sessionCpuLimit("old")).toBeUndefined();
	});

	it("keeps the root session primary, so shared workers still charge to it", async () => {
		const root = await initSessionCpuLimit({ sessionId: "root", ...INERT });
		await initSessionCpuLimit({ sessionId: "second", ...INERT });

		rekeySessionCpuLimit("root", "root-renamed");

		// Registration ORDER decides which limiter the tiny model, embeddings and
		// speech workers join. A rekey that appended instead of replacing in place
		// would hand every shared worker to the wrong session.
		expect(primarySessionCpuLimit()).toBe(root);
	});

	/**
	 * A collision used to leave the source limiter in the map under its old id,
	 * where nothing could resolve it and nothing could lift it. It kept a
	 * cgroup, a transient unit and a once-a-second watcher alive for the life of
	 * the process, and, being earlier in registration order, it went on
	 * collecting every shared spawn into a budget no live session could see.
	 * Superseding a limiter has to retire it.
	 */
	it("retires the limiter it supersedes instead of orphaning it", async () => {
		const from = await initSessionCpuLimit({ sessionId: "from", ...INERT });
		const to = await initSessionCpuLimit({ sessionId: "to", ...INERT });

		expect(rekeySessionCpuLimit("from", "to")).toBe(to);

		// The occupant keeps the id. The rekey moves a key, and the session that
		// already owns the target is live.
		expect(sessionCpuLimit("to")).toBe(to);
		expect(to.disposed).toBe(false);
		// The source is unreachable AND retired. Unregistering alone would still
		// leave the watcher and the group running.
		// `dispose()` sets the flag before its first await, so the rekey's
		// fire-and-forget call has already retired it by the time it returns.
		// Nothing here waits on a clock.
		expect(sessionCpuLimit("from")).toBeUndefined();
		expect(from.disposed).toBe(true);
		// Registration order lost its first entry with it, so the surviving
		// session is the one shared workers now charge to.
		expect(primarySessionCpuLimit()).toBe(to);
	});
});

describe("a live session keeps its budget across a new conversation", () => {
	async function createSession(): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("bundled model missing");
		const agent = new Agent({
			getApiKey: () => "not-used: nothing in this suite reaches a provider",
			initialState: { model, systemPrompt: ["test"], tools: [] },
		});
		const sessionManager = SessionManager.create(tempDir, tempDir);
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const built = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "session.cpuLimitCores": 0 }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
		});
		built.subscribe(() => {});
		// Registration is fire-and-forget in the constructor, so let it settle.
		await Promise.resolve();
		return built;
	}

	it("re-registers under the id `/new` minted, instead of leaving it behind", async () => {
		session = await createSession();
		const before = session.sessionManager.getSessionId();
		expect(sessionCpuLimit(before)).toBeDefined();

		await session.sessionManager.newSession();
		const after = session.sessionManager.getSessionId();

		expect(after).not.toBe(before);
		// The same limiter, not a second one: a background command started before
		// `/new` is still running in this process, and two groups of N cores each
		// would let one operator budget be exceeded by starting a conversation.
		expect(sessionCpuLimit(after)).toBeDefined();
		expect(sessionCpuLimit(before)).toBeUndefined();
	});
});
