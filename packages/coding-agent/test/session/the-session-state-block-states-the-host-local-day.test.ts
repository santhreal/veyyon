/**
 * The day the model is told is the host's local calendar day, not the UTC one.
 *
 * WHY THIS SUITE EXISTS. A session states the date once per change, and a model
 * that believes it is a different day dates files, changelog sections and release
 * notes wrong for the whole conversation. The date used to sit in the cached
 * system prompt and was covered there; it moved into the per-turn session-state
 * message when the working directory left the prefix, and the old coverage went on
 * asserting a system prompt that no longer carries a date, so it passed while
 * nothing checked the date at all.
 *
 * THE CLASS, not the incident. A UTC-versus-local mistake shows up only in the
 * window where the two disagree, and it disagrees in BOTH directions: west of UTC
 * the local day is the earlier one, east of it the later one. Both are swept, both
 * through the real turn, and each asserts the wrong day is absent as well as the
 * right one present — a renderer that emitted both dates would otherwise pass.
 *
 * WHAT IT DOES NOT CATCH. The timezone is the process's, read live from `TZ`, so
 * this says nothing about a host whose zone changes mid-session (a laptop crossing
 * a boundary): the next block after a change states the new day, and nothing
 * restates an unchanged one.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

/**
 * Each case is one instant and two zones' worth of disagreement about which day it
 * is. `expected` is the host-local day in `timeZone`, `rejected` the day the same
 * instant carries in UTC.
 */
const CASES = [
	{
		label: "west of UTC, where the local day is still the previous one",
		timeZone: "America/Los_Angeles",
		instant: "2026-07-01T03:15:00Z",
		expected: "2026-06-30",
		rejected: "2026-07-01",
	},
	{
		label: "east of UTC, where the local day is already the next one",
		timeZone: "Europe/Berlin",
		instant: "2026-06-30T23:30:00Z",
		expected: "2026-07-01",
		rejected: "2026-06-30",
	},
] as const;

describe("the session-state block states the host local day", () => {
	let tempDir: TempDir;
	let originalTimeZone: string | undefined;
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		originalTimeZone = process.env.TZ;
		tempDir = TempDir.createSync("@pi-session-date-");
	});

	afterEach(async () => {
		setSystemTime();
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		// The zone is process state, so it goes back exactly as it was: deleting a
		// variable the host never set is not the same as setting it to "undefined".
		if (originalTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = originalTimeZone;
		tempDir.removeSync();
	});

	async function createSession(): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled anthropic model to exist");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `auth-${authStorages.length}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		sessions.push(session);
		return session;
	}

	/**
	 * The turn a real prompt builds, with only the provider call stubbed. The stub
	 * still appends what it was handed, because the delivered-once cache is derived
	 * from the conversation and a swallowing stub would make every turn look like
	 * the first.
	 */
	async function sessionStateBlocksFor(session: AgentSession, text: string): Promise<string[]> {
		const captured: AgentMessage[] = [];
		const spy = vi.spyOn(session.agent, "prompt").mockImplementation(async input => {
			const incoming = Array.isArray(input) ? input : [input as AgentMessage];
			captured.push(...incoming);
			session.agent.state.messages.push(...incoming);
		});
		await session.prompt(text);
		spy.mockRestore();
		return captured.flatMap(message =>
			message.role === "custom" && message.customType === "session-state" && typeof message.content === "string"
				? [message.content]
				: [],
		);
	}

	for (const { label, timeZone, instant, expected, rejected } of CASES) {
		it(`states the local day ${label}`, async () => {
			process.env.TZ = timeZone;
			setSystemTime(new Date(instant));
			const session = await createSession();

			const blocks = await sessionStateBlocksFor(session, "which day is it");

			expect(blocks).toHaveLength(1);
			expect(blocks[0]).toContain(`Today is ${expected}`);
			expect(blocks[0]).not.toContain(rejected);
		});
	}

	/**
	 * The zone really is what decides. One instant, both zones, two different days:
	 * a renderer that read UTC would produce the same block twice and this is the
	 * assertion it cannot pass.
	 */
	it("states two different days for one instant in two zones", async () => {
		const instant = new Date("2026-07-01T03:15:00Z");
		const blocks: string[] = [];
		for (const timeZone of ["America/Los_Angeles", "Europe/Berlin"]) {
			process.env.TZ = timeZone;
			setSystemTime(instant);
			const session = await createSession();
			blocks.push(...(await sessionStateBlocksFor(session, "which day is it")));
		}

		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toContain("Today is 2026-06-30");
		expect(blocks[1]).toContain("Today is 2026-07-01");
	});
});
