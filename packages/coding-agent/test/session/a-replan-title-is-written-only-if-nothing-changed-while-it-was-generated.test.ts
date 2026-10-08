/**
 * WHY THIS SUITE EXISTS. `ReplanTitleRefresh` generates a new session title when the model re-plans,
 * and generating one is a model request that takes seconds. While it runs the user can name the
 * session, the session can switch to another one, and the setting can be turned off. A refresh that
 * wrote its title regardless would overwrite the user's name, rename the session the user switched to,
 * or rename after the user said not to.
 *
 * THE CLASS. Every condition `schedule()` checks before it starts is checked again before the title
 * is written, and one refresh runs at a time. The session-level suite
 * (`agent-session-eager-todo.test.ts`) covers the conditions as they stand when the refresh starts;
 * this suite changes each one while the title is being generated.
 *
 * WHAT IT DOES NOT CATCH. The title text itself and the request that produces it; the generator is
 * replaced here and has its own suite.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { SessionNameTrigger } from "@veyyon/coding-agent/session/agent-session-types";
import {
	ReplanTitleRefresh,
	type ReplanTitleRefreshHost,
	type ReplanTitleStore,
} from "@veyyon/coding-agent/session/runtime/replan-title-refresh";
import * as titleGenerator from "@veyyon/coding-agent/utils/title-generator";
import type { SessionTitleSource } from "@veyyon/kernel/session/session-entries";

interface Rename {
	readonly name: string;
	readonly source: SessionTitleSource;
	readonly trigger: SessionNameTrigger;
}

/** A session log whose title source and id the test changes mid-refresh, recording every rename. */
class FakeStore implements ReplanTitleStore {
	titleSource: SessionTitleSource | undefined = "auto";
	sessionId = "session-a";
	readonly renames: Rename[] = [];

	getSessionId(): string {
		return this.sessionId;
	}

	async setSessionName(name: string, source: SessionTitleSource, trigger: SessionNameTrigger): Promise<boolean> {
		this.renames.push({ name, source, trigger });
		return true;
	}
}

const CONVERSATION: AgentMessage[] = [{ role: "user", content: "rework the parser diagnostics", timestamp: 1 }];

/** The pending title of each generation, in the order they were requested. */
function stubGenerator(): Array<PromiseWithResolvers<string | null>> {
	const pending: Array<PromiseWithResolvers<string | null>> = [];
	vi.spyOn(titleGenerator, "generateSessionTitle").mockImplementation(() => {
		const title = Promise.withResolvers<string | null>();
		pending.push(title);
		return title.promise;
	});
	return pending;
}

function refreshFor(store: FakeStore, settings: Settings): ReplanTitleRefresh {
	const host: ReplanTitleRefreshHost = {
		agent: { state: { messages: CONVERSATION }, metadataForProvider: () => undefined },
		sessionStore: store,
		settings,
		// Read only by the generator, which this suite replaces.
		modelRegistry: {} as ModelRegistry,
		sideComplete: () => {
			throw new Error("the generator is replaced; no side request is made");
		},
		model: () => undefined,
		obfuscateProviderText: text => text,
	};
	return new ReplanTitleRefresh(host, undefined);
}

/**
 * Settings with the refresh on in the layer `/settings` writes. An override layer would outrank the
 * user's toggle, and the mid-generation switch-off below would never be seen.
 */
function refreshingSettings(): Settings {
	const settings = Settings.isolated();
	settings.set("title.refreshOnReplan", true);
	return settings;
}

/** Let a resolved generation run to the end of its refresh. */
async function settle(): Promise<void> {
	for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a replan title is written only if nothing changed while it was generated", () => {
	it("writes the generated title as an automatic replan title", async () => {
		const pending = stubGenerator();
		const store = new FakeStore();
		const refresh = refreshFor(store, refreshingSettings());

		refresh.schedule();
		pending[0]?.resolve("Parser diagnostics");
		await settle();

		expect(store.renames).toEqual([{ name: "Parser diagnostics", source: "auto", trigger: "replan" }]);
	});

	it("runs one refresh at a time, and the next once the first has finished", async () => {
		const pending = stubGenerator();
		const store = new FakeStore();
		const refresh = refreshFor(store, refreshingSettings());

		refresh.schedule();
		refresh.schedule();
		expect(pending).toHaveLength(1);

		pending[0]?.resolve(null);
		await settle();
		refresh.schedule();
		expect(pending).toHaveLength(2);
	});

	it("keeps a name the user set while the title was generated", async () => {
		const pending = stubGenerator();
		const store = new FakeStore();
		const refresh = refreshFor(store, refreshingSettings());

		refresh.schedule();
		store.titleSource = "user";
		pending[0]?.resolve("Parser diagnostics");
		await settle();

		expect(store.renames).toEqual([]);
		// The refresh finished rather than stalling: the next one starts once the title is automatic again.
		store.titleSource = "auto";
		refresh.schedule();
		expect(pending).toHaveLength(2);
	});

	it("does not rename a session the user switched to while the title was generated", async () => {
		const pending = stubGenerator();
		const store = new FakeStore();
		const refresh = refreshFor(store, refreshingSettings());

		refresh.schedule();
		store.sessionId = "session-b";
		pending[0]?.resolve("Parser diagnostics");
		await settle();

		expect(store.renames).toEqual([]);
		refresh.schedule();
		expect(pending).toHaveLength(2);
	});

	it("writes nothing once the setting was turned off while the title was generated", async () => {
		const pending = stubGenerator();
		const store = new FakeStore();
		const settings = refreshingSettings();
		const refresh = refreshFor(store, settings);

		refresh.schedule();
		settings.set("title.refreshOnReplan", false);
		pending[0]?.resolve("Parser diagnostics");
		await settle();

		expect(store.renames).toEqual([]);
		settings.set("title.refreshOnReplan", true);
		refresh.schedule();
		expect(pending).toHaveLength(2);
	});

	it("lets the next refresh run after a generation that failed", async () => {
		const pending = stubGenerator();
		const store = new FakeStore();
		const refresh = refreshFor(store, refreshingSettings());

		refresh.schedule();
		pending[0]?.reject(new Error("title model unavailable"));
		await settle();

		expect(store.renames).toEqual([]);
		refresh.schedule();
		expect(pending).toHaveLength(2);
	});
});
