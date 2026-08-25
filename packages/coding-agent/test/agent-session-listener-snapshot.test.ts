/**
 * WHY: `AgentSession.#emit` fires on every streaming event (text delta,
 * thinking delta, tool call delta) — one call per token. It previously
 * spread the listener array (`[...this.#eventListeners]`) on every call
 * to avoid mutation-during-iteration. The spread allocates a new array
 * per event. During a turn the listener set is stable, so the snapshot
 * is now cached and invalidated only on subscribe/unsubscribe/clear.
 *
 * This suite closes the class by asserting:
 * 1. All listeners receive events after subscribe (snapshot is built).
 * 2. A listener added after the first event still receives later events
 *    (snapshot is invalidated on subscribe).
 * 3. A unsubscribed listener stops receiving events (snapshot is
 *    invalidated on unsubscribe).
 * 4. Multiple listeners all receive the same event from one emit.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

describe("AgentSession listener snapshot caching", () => {
	let session: AgentSession;
	let authStorage: AuthStorage;
	let tempDir: TempDir;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-listener-snapshot-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		await tempDir?.remove();
	});

	it("delivers events to all subscribed listeners", () => {
		const received: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") received.push(event.message);
		});
		session.emitNotice("info", "test message", "test");
		expect(received).toEqual(["test message"]);
	});

	it("delivers to multiple listeners from one emit", () => {
		const received1: string[] = [];
		const received2: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") received1.push(event.message);
		});
		session.subscribe(event => {
			if (event.type === "notice") received2.push(event.message);
		});
		session.emitNotice("info", "multi", "test");
		expect(received1).toEqual(["multi"]);
		expect(received2).toEqual(["multi"]);
	});

	it("delivers to a listener added after prior events were emitted", () => {
		const first: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") first.push(event.message);
		});
		session.emitNotice("info", "first event", "test");

		const second: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") second.push(event.message);
		});
		session.emitNotice("info", "second event", "test");

		expect(first).toEqual(["first event", "second event"]);
		expect(second).toEqual(["second event"]);
	});

	it("stops delivering to an unsubscribed listener", () => {
		const received: string[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "notice") received.push(event.message);
		});
		session.emitNotice("info", "before", "test");
		unsubscribe();
		session.emitNotice("info", "after", "test");
		expect(received).toEqual(["before"]);
	});

	it("continues delivering to remaining listeners after one unsubscribes", () => {
		const remaining: string[] = [];
		const unsubscribed: string[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "notice") unsubscribed.push(event.message);
		});
		session.subscribe(event => {
			if (event.type === "notice") remaining.push(event.message);
		});
		session.emitNotice("info", "both", "test");
		unsubscribe();
		session.emitNotice("info", "remaining only", "test");
		expect(unsubscribed).toEqual(["both"]);
		expect(remaining).toEqual(["both", "remaining only"]);
	});
});
