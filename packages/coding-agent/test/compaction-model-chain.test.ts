/**
 * Contract: `compaction.model` is an ORDERED CHAIN, and landing anywhere other
 * than its first entry is announced.
 *
 * The chain itself has always been representable (the value goes through
 * `normalizeModelPatternList`, which splits commas and flattens arrays), but two
 * things were wrong. The tail after the configured entries was hardcoded and
 * unconfigurable, so a session could summarize on a model the user never named;
 * and taking a fallback only ever reached a `debug` log, so the summary that
 * shapes the rest of the session was written by a surprise model with no trace
 * a user would ever see. `compaction.modelFallbackStrategy` makes the tail a
 * choice, and the notice makes the swap visible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { assistantMsg, userMsg } from "./helpers/e2e-session";

describe("compaction model chain", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let notices: Array<Extract<AgentSessionEvent, { type: "notice" }>>;

	const mainModel = getBundledModel("openai-codex", "gpt-5.4-mini");
	const firstChoice = getBundledModel("anthropic", "claude-opus-4-1");
	const secondChoice = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!mainModel || !firstChoice || !secondChoice) throw new Error("Expected bundled test models to exist");

	const selector = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-compaction-chain-");
		notices = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir.removeSync();
	});

	/**
	 * A session whose compaction chain is `overrides["compaction.model"]`.
	 *
	 * Every provider gets a stored credential so all three models are in the
	 * registry's available list (an unavailable model resolves to no candidate at
	 * all, which is a different failure from the one under test). `usable` then
	 * decides which of them actually hands back a key at compaction time.
	 */
	async function createSession(overrides: Record<string, unknown>, usable: (model: { id: string }) => boolean) {
		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			...overrides,
		} as Parameters<typeof Settings.isolated>[0]);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		for (const provider of new Set([mainModel.provider, firstChoice.provider, secondChoice.provider])) {
			authStorage.setRuntimeApiKey(provider, `${provider}-token`);
		}
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model =>
			usable(model) ? `${model.provider}-token` : undefined,
		);

		session = new AgentSession({
			agent: new Agent({ initialState: { model: mainModel, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event);
		});

		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}
	}

	/** Records which models compaction was actually attempted on, in order. */
	function spyOnCompact() {
		return vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: `summary from ${selector(model)}`,
			shortSummary: "short",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
			details: { provider: model.provider },
		}));
	}

	/**
	 * The whole point of a chain: entry two runs when entry one cannot. An
	 * unauthenticated first entry must not fail compaction and must not be
	 * silently reordered away.
	 */
	it("runs the second configured model when the first is not authenticated", async () => {
		await createSession(
			{ "compaction.model": `${selector(firstChoice)},${selector(secondChoice)}` },
			model => model.id === secondChoice.id,
		);
		const compactSpy = spyOnCompact();

		const result = await session.compact();

		expect(result.summary).toBe(`summary from ${selector(secondChoice)}`);
		expect(compactSpy.mock.calls.map(([, model]) => selector(model))).toEqual([selector(secondChoice)]);
	});

	/**
	 * A chain written as a comma-separated string is the same chain as an array.
	 * Both encodings have always been accepted by `normalizeModelPatternList`, so
	 * a config written by hand and one written by the settings picker must resolve
	 * identically. Round-trip guard.
	 */
	it("treats a comma-separated chain exactly like an array", async () => {
		await createSession(
			{ "compaction.model": [selector(firstChoice), selector(secondChoice)] },
			model => model.id === secondChoice.id,
		);
		const compactSpy = spyOnCompact();

		const result = await session.compact();

		expect(result.summary).toBe(`summary from ${selector(secondChoice)}`);
		expect(compactSpy.mock.calls.map(([, model]) => selector(model))).toEqual([selector(secondChoice)]);
	});

	/**
	 * Landing on a fallback is a warning, not a debug line. It names the model
	 * that ran, the model that was meant to, and why the first one did not, so
	 * the user can tell whether the summary was written at the quality they chose.
	 */
	it("announces which model compacted and why the first choice was skipped", async () => {
		await createSession(
			{ "compaction.model": `${selector(firstChoice)},${selector(secondChoice)}` },
			model => model.id === secondChoice.id,
		);
		spyOnCompact();

		await session.compact();

		expect(notices).toHaveLength(1);
		expect(notices[0]?.level).toBe("warning");
		expect(notices[0]?.source).toBe("compaction");
		expect(notices[0]?.message).toBe(
			`Compacted with ${selector(secondChoice)}. ${selector(firstChoice)} was skipped: it is not authenticated.`,
		);
	});

	/**
	 * The negative twin of the announcement. A notice on every compaction that
	 * did exactly what was configured is noise, and noise is how a real warning
	 * gets ignored.
	 */
	it("says nothing when the first configured model is the one that compacted", async () => {
		await createSession({ "compaction.model": `${selector(firstChoice)},${selector(secondChoice)}` }, () => true);
		spyOnCompact();

		await session.compact();

		expect(notices).toEqual([]);
	});

	/**
	 * A session that fails over on every compaction should say so once. Repeating
	 * the identical warning on every compaction trains the user to skip it.
	 */
	it("announces the same fallback only once per session", async () => {
		await createSession(
			{ "compaction.model": `${selector(firstChoice)},${selector(secondChoice)}` },
			model => model.id === secondChoice.id,
		);
		spyOnCompact();

		await session.compact();
		// New history, or the second compact() refuses with "Already compacted"
		// before it ever reaches a candidate.
		for (const [userText, assistantText] of [["third question", "third answer"]] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}
		await session.compact();

		expect(notices).toHaveLength(1);
	});

	/**
	 * `auto` is the historical tail and stays the default: with the configured
	 * chain unusable it reaches the main model rather than failing. This is the
	 * differential twin of the `configured-only` test below, so the two
	 * strategies are pinned against the same setup.
	 */
	it("auto falls past the configured chain to the main model", async () => {
		await createSession({ "compaction.model": selector(firstChoice) }, model => model.id === mainModel.id);
		const compactSpy = spyOnCompact();

		const result = await session.compact();

		expect(result.summary).toBe(`summary from ${selector(mainModel)}`);
		expect(compactSpy.mock.calls.map(([, model]) => selector(model))).toEqual([selector(mainModel)]);
	});

	/**
	 * `configured-only` is the reason this setting exists: it refuses to summarize
	 * on a model the user never named. With the configured chain unusable it must
	 * FAIL, not quietly reach the main model or the largest window available.
	 */
	it("configured-only fails instead of reaching a model that was never configured", async () => {
		await createSession(
			{ "compaction.model": selector(firstChoice), "compaction.modelFallbackStrategy": "configured-only" },
			model => model.id === mainModel.id,
		);
		const compactSpy = spyOnCompact();

		const error = await session.compact().catch(err => err);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("Compaction requires usable credentials");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	/**
	 * With no chain configured, `compaction.model` means "inherit", so
	 * `configured-only` narrows to exactly one model: the interactive one. It must
	 * not become "no candidates at all", which would break compaction for anybody
	 * who turns the strategy on without also listing models.
	 */
	it("configured-only with no chain configured still compacts on the main model", async () => {
		await createSession(
			{ "compaction.modelFallbackStrategy": "configured-only" },
			model => model.id === mainModel.id,
		);
		const compactSpy = spyOnCompact();

		const result = await session.compact();

		expect(result.summary).toBe(`summary from ${selector(mainModel)}`);
		expect(compactSpy.mock.calls.map(([, model]) => selector(model))).toEqual([selector(mainModel)]);
	});
});
