import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { InstrumentationLevel } from "@veyyon/ai/instrumentation";
import { computeSessionStats } from "@veyyon/coding-agent/cli/session-stats";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

function readJsonl(file: string): Array<Record<string, unknown>> {
	return fs
		.readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>)
		.filter(entry => entry.type !== "title");
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("session lifecycle telemetry persistence", () => {
	it.each(["off", "basic", "rich", "ultra"] as const)(
		"gates lifecycle records and sequence at %s granularity",
		async (instrumentation: InstrumentationLevel) => {
			const cwd = makeTempDir(`@pi-lifecycle-${instrumentation}-`);
			const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, { instrumentation });
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session path");

			manager.appendMessage({ role: "user", content: "persist", timestamp: Date.now() });
			await manager.ensureOnDisk();
			const checkpoint = manager.createCheckpoint();
			await manager.close();

			const entries = readJsonl(sessionFile).filter(entry => entry.type !== "session");
			const allowed = instrumentation !== "off";
			expect(entries.some(entry => entry.type === "session_lifecycle")).toBe(allowed);
			expect(entries.some(entry => entry.sequence !== undefined)).toBe(allowed);
			expect(checkpoint === null).toBe(!allowed);
			if (allowed) {
				const lifecycle = entries.filter(entry => entry.type === "session_lifecycle");
				expect(lifecycle.map(entry => entry.state)).toEqual(["running", "ended"]);
				expect(lifecycle.at(-1)?.reason).toBe("closed");
			} else {
				expect(entries.every(entry => entry.sequence === undefined)).toBe(true);
			}
		},
	);

	/**
	 * Runtime policy changes delimit measured intervals. Entries written while
	 * off remain ordinary resumable history without sequence metadata.
	 */
	it("applies live off and on transitions without leaking sequence metadata", async () => {
		const cwd = makeTempDir("@pi-lifecycle-live-policy-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, {
			instrumentation: "off",
		});
		manager.setInstrumentationLevel("rich");
		manager.appendMessage({ role: "user", content: "measured", timestamp: 1 });
		manager.setInstrumentationLevel("off");
		manager.appendMessage({ role: "user", content: "ordinary", timestamp: 2 });
		manager.setInstrumentationLevel("ultra");

		const entries = manager.getEntries();
		expect(
			entries.filter(entry => entry.type === "session_lifecycle").map(entry => [entry.state, entry.reason]),
		).toEqual([
			["running", "created"],
			["ended", "instrumentation_disabled"],
			["running", "resumed"],
		]);
		const ordinary = entries.find(
			entry => entry.type === "message" && entry.message.role === "user" && entry.message.content === "ordinary",
		);
		expect(ordinary?.sequence).toBeUndefined();
		const sequences = entries.flatMap(entry => (entry.sequence === undefined ? [] : [entry.sequence]));
		expect(new Set(sequences).size).toBe(sequences.length);
		await manager.close();
	});

	/**
	 * Enabled-level changes need their own lifecycle intervals so a lifecycle-only
	 * report preserves the highest configured granularity.
	 */
	it("records enabled instrumentation level changes as measured intervals", async () => {
		const cwd = makeTempDir("@pi-lifecycle-level-change-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, {
			instrumentation: "basic",
		});
		manager.setInstrumentationLevel("ultra");
		manager.setInstrumentationLevel("basic");
		await manager.close();

		expect(
			manager
				.getEntries()
				.filter(entry => entry.type === "session_lifecycle")
				.map(entry => [entry.state, entry.reason, entry.instrumentationLevel]),
		).toEqual([
			["running", "created", "basic"],
			["ended", "instrumentation_changed", undefined],
			["running", "resumed", "ultra"],
			["ended", "instrumentation_changed", undefined],
			["running", "resumed", "basic"],
			["ended", "closed", undefined],
		]);
		const header = manager.getHeader();
		if (!header) throw new Error("Expected session header");
		expect(computeSessionStats([header, ...manager.getEntries()]).instrumentationLevel).toBe("ultra");
	});

	/**
	 * A target read failure must leave the current lifecycle open and its
	 * sequence allocator untouched so the caller can continue after rollback.
	 */
	it("does not terminate the current session when a switch target fails to load", async () => {
		const cwd = makeTempDir("@pi-lifecycle-switch-failure-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, {
			instrumentation: "basic",
		});
		manager.appendMessage({ role: "user", content: "before failure", timestamp: 1 });
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected current session file");

		await expect(manager.setSessionFile(cwd)).rejects.toThrow();
		manager.appendMessage({ role: "user", content: "after failure", timestamp: 2 });
		await manager.close();

		const entries = readJsonl(sessionFile).filter(entry => entry.type !== "session");
		expect(
			entries.filter(entry => entry.type === "session_lifecycle").map(entry => [entry.state, entry.reason]),
		).toEqual([
			["running", "created"],
			["ended", "closed"],
		]);
		const sequences = entries.flatMap(entry => (typeof entry.sequence === "number" ? [entry.sequence] : []));
		expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
		expect(new Set(sequences).size).toBe(sequences.length);
	});

	it("reports ultra for a lifecycle-only ultra session", () => {
		const cwd = makeTempDir("@pi-lifecycle-ultra-stats-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, {
			instrumentation: "ultra",
		});
		const header = manager.getHeader();
		if (!header) throw new Error("Expected session header");

		const running = manager.getEntries().find(entry => entry.type === "session_lifecycle");
		expect(running).toMatchObject({ state: "running", instrumentationLevel: "ultra" });
		expect(computeSessionStats([header, ...manager.getEntries()]).instrumentationLevel).toBe("ultra");
	});

	it("distinguishes running from ended and freezes a checkpoint prefix across later appends", async () => {
		const cwd = makeTempDir("@pi-lifecycle-checkpoint-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, {
			instrumentation: "basic",
		});
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session path");

		manager.appendMessage({ role: "user", content: "before", timestamp: Date.now() });
		await manager.ensureOnDisk();
		expect(manager.getLifecycleState()).toBe("running");

		const frozenIds = manager.getEntries().map(entry => entry.id);
		const checkpoint = manager.createCheckpoint();
		if (!checkpoint) throw new Error("Expected lifecycle checkpoint");
		expect(manager.getEntriesThroughCheckpoint(checkpoint).map(entry => entry.id)).toEqual(frozenIds);

		manager.appendMessage({ role: "user", content: "after", timestamp: Date.now() });
		expect(manager.getEntriesThroughCheckpoint(checkpoint).map(entry => entry.id)).toEqual(frozenIds);

		const runningEntries = readJsonl(sessionFile);
		const checkpointIndex = runningEntries.findIndex(entry => entry.id === checkpoint.id);
		const laterIndex = runningEntries.findIndex(
			entry => entry.type === "message" && (entry.message as { content?: unknown } | undefined)?.content === "after",
		);
		expect(checkpointIndex).toBeGreaterThan(0);
		expect(laterIndex).toBeGreaterThan(checkpointIndex);
		expect(runningEntries[checkpointIndex]?.prefixSequence).toBe(checkpoint.prefixSequence);

		await manager.close();
		expect(manager.getLifecycleState()).toBe("ended");
		const endedEntries = readJsonl(sessionFile);
		expect(endedEntries.at(-1)).toMatchObject({ type: "session_lifecycle", state: "ended", reason: "closed" });
		const sequences = endedEntries.filter(entry => entry.type !== "session").map(entry => entry.sequence as number);
		expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
		expect(new Set(sequences).size).toBe(sequences.length);
	});

	it("loads an old entry without lifecycle or sequence fields and resumes additively", async () => {
		const cwd = makeTempDir("@pi-lifecycle-old-");
		const sessionFile = path.join(cwd, "old.jsonl");
		const timestamp = "2025-01-01T00:00:00.000Z";
		fs.writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "old-session", timestamp, cwd }),
				JSON.stringify({
					type: "message",
					id: "old-message",
					parentId: null,
					timestamp,
					message: { role: "user", content: "old payload", timestamp: Date.parse(timestamp) },
				}),
				"",
			].join("\n"),
		);

		const manager = await SessionManager.open(sessionFile, cwd, undefined, { instrumentation: "basic" });
		const oldEntry = manager.getEntry("old-message");
		expect(oldEntry).toMatchObject({ type: "message", id: "old-message" });
		expect(oldEntry?.sequence).toBeUndefined();
		expect(manager.getLifecycleState()).toBe("running");
		const resumed = manager.getEntries().at(-1);
		expect(resumed).toMatchObject({
			type: "session_lifecycle",
			state: "running",
			reason: "resumed",
			sequence: 2,
			instrumentationLevel: "basic",
		});
		await manager.close();
	});

	/**
	 * Off disables only study metadata; it must never suppress the message history
	 * needed to reopen and continue a session.
	 */
	it("keeps off sessions resumable without telemetry entries", async () => {
		const cwd = makeTempDir("@pi-lifecycle-off-resume-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, {
			instrumentation: "off",
		});
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session path");

		manager.appendMessage({ role: "user", content: "before restart", timestamp: 1 });
		await manager.ensureOnDisk();
		await manager.close();

		const firstPersisted = readJsonl(sessionFile);
		expect(firstPersisted.map(entry => entry.type)).toEqual(["session", "message"]);
		expect(firstPersisted.every(entry => entry.sequence === undefined)).toBe(true);

		const resumed = await SessionManager.open(sessionFile, cwd, undefined, { instrumentation: "off" });
		expect(resumed.getLifecycleState()).toBe("unknown");
		expect(resumed.getEntries().at(-1)).toMatchObject({
			type: "message",
			message: { role: "user", content: "before restart", timestamp: 1 },
		});
		resumed.appendMessage({ role: "user", content: "after restart", timestamp: 2 });
		await resumed.close();

		const reopened = await SessionManager.open(sessionFile, cwd, undefined, { instrumentation: "off" });
		const messages = reopened
			.getEntries()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message);
		expect(messages).toEqual([
			{ role: "user", content: "before restart", timestamp: 1 },
			{ role: "user", content: "after restart", timestamp: 2 },
		]);
		await reopened.close();
	});

	/**
	 * Large historical traces must resume without spreading every stored sequence
	 * into one function call, which overflows the JavaScript argument limit.
	 */
	it("resumes a large unsequenced session without argument overflow", async () => {
		const cwd = makeTempDir("@pi-lifecycle-large-resume-");
		const sessionFile = path.join(cwd, "large.jsonl");
		const timestamp = "2025-01-01T00:00:00.000Z";
		const entryCount = 130_000;
		const lines = [JSON.stringify({ type: "session", version: 3, id: "large-session", timestamp, cwd })];
		for (let index = 1; index <= entryCount; index++) {
			lines.push(
				JSON.stringify({
					type: "custom",
					id: `entry-${index}`,
					parentId: index === 1 ? null : `entry-${index - 1}`,
					timestamp,
					customType: "scale-fixture",
					data: {},
				}),
			);
		}
		fs.writeFileSync(sessionFile, `${lines.join("\n")}\n`);

		const manager = await SessionManager.open(sessionFile, cwd, undefined, { instrumentation: "basic" });
		expect(manager.getEntries().at(-1)).toMatchObject({
			type: "session_lifecycle",
			state: "running",
			reason: "resumed",
			sequence: entryCount + 1,
		});
		await manager.close();
	});

	/**
	 * Corrupt numeric metadata must fail before resume can emit duplicate, null,
	 * or non-monotonic sequence values into an otherwise valid journal.
	 */
	it("rejects loaded sequences without a safe successor", async () => {
		for (const [name, rawSequence] of [
			["maximum", String(Number.MAX_SAFE_INTEGER)],
			["negative", "-1"],
			["fractional", "1.5"],
			["infinite", "1e400"],
		] as const) {
			const cwd = makeTempDir(`@pi-lifecycle-invalid-${name}-`);
			const sessionFile = path.join(cwd, `${name}.jsonl`);
			const timestamp = "2025-01-01T00:00:00.000Z";
			const header = JSON.stringify({ type: "session", version: 3, id: `${name}-session`, timestamp, cwd });
			const lifecycle =
				`{"type":"session_lifecycle","id":"life","parentId":null,"timestamp":"${timestamp}",` +
				`"state":"running","reason":"created","sequence":${rawSequence}}`;
			fs.writeFileSync(sessionFile, `${header}\n${lifecycle}\n`);

			await expect(SessionManager.open(sessionFile, cwd, undefined, { instrumentation: "basic" })).rejects.toThrow(
				"non-negative safe integer",
			);
		}
	});

	/**
	 * Forking changes the live session identity. The parent must close cleanly
	 * and the child must record its own running interval before either can resume.
	 */
	it("closes the parent lifecycle and starts a child lifecycle on fork", async () => {
		const cwd = makeTempDir("@pi-lifecycle-fork-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, {
			instrumentation: "basic",
		});
		manager.appendMessage({ role: "user", content: "fork point", timestamp: 1 });
		await manager.ensureOnDisk();

		const forked = await manager.fork();
		if (!forked) throw new Error("Expected persisted fork");
		expect(
			readJsonl(forked.oldSessionFile)
				.filter(entry => entry.type === "session_lifecycle")
				.map(entry => [entry.state, entry.reason]),
		).toEqual([
			["running", "created"],
			["ended", "session_switched"],
		]);
		expect(manager.getEntries().at(-1)).toMatchObject({
			type: "session_lifecycle",
			state: "running",
			reason: "created",
		});
		await manager.close();
		expect(
			readJsonl(forked.newSessionFile)
				.filter(entry => entry.type === "session_lifecycle")
				.map(entry => [entry.state, entry.reason]),
		).toEqual([
			["running", "created"],
			["ended", "closed"],
		]);

		const resumedParent = await SessionManager.open(forked.oldSessionFile, cwd, undefined, {
			instrumentation: "basic",
		});
		expect(resumedParent.getEntries().at(-1)).toMatchObject({
			type: "session_lifecycle",
			state: "running",
			reason: "resumed",
		});
		await resumedParent.close();
	});

	/**
	 * Creating a selected-history branch is also a session identity switch.
	 * Its synchronous API must close the source file without writing child
	 * lifecycle bytes through the source file's existing append handle.
	 */
	it("closes the source lifecycle and starts a child lifecycle on branch", async () => {
		const cwd = makeTempDir("@pi-lifecycle-branch-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, {
			instrumentation: "basic",
		});
		const leafId = manager.appendMessage({ role: "user", content: "branch point", timestamp: 1 });
		await manager.ensureOnDisk();
		const sourceFile = manager.getSessionFile();
		if (!sourceFile) throw new Error("Expected source session file");

		const branchFile = manager.createBranchedSession(leafId);
		if (!branchFile) throw new Error("Expected branched session file");
		expect(
			readJsonl(sourceFile)
				.filter(entry => entry.type === "session_lifecycle")
				.map(entry => [entry.state, entry.reason]),
		).toEqual([
			["running", "created"],
			["ended", "session_switched"],
		]);
		expect(manager.getEntries().at(-1)).toMatchObject({
			type: "session_lifecycle",
			state: "running",
			reason: "created",
		});
		await manager.close();

		expect(
			readJsonl(branchFile)
				.filter(entry => entry.type === "session_lifecycle")
				.map(entry => [entry.state, entry.reason]),
		).toEqual([
			["running", "created"],
			["ended", "closed"],
		]);
	});

	it("applies the SDK setting to a caller-supplied manager", async () => {
		const cwd = makeTempDir("@pi-lifecycle-sdk-");
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
			expect(manager.getLifecycleState()).toBe("unknown");

			const { session } = await createAgentSession({
				cwd,
				agentDir: cwd,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
				sessionManager: manager,
				settings: Settings.isolated({ "session.instrumentation": "basic" }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			expect(manager.getLifecycleState()).toBe("running");
			expect(manager.getEntries().filter(entry => entry.type === "session_lifecycle")).toHaveLength(1);
			await session.dispose();
			expect(manager.getLifecycleState()).toBe("ended");
		} finally {
			authStorage.close();
		}
	});
});
