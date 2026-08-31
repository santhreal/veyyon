/**
 * WHY. Reported from a real run: a session printed
 *
 *   "Compaction freed too little context to make progress — pausing automatic
 *    maintenance to avoid a compaction loop. The most recent turn alone is too
 *    large to reduce further"
 *
 * and then could do nothing at all. Goal mode stood down after its turns
 * failed, and the next request was refused before it left the process. Rewinding
 * the session tree did not help, because the oversized message is on every
 * branch point that still carries it.
 *
 * THE DEFECT. `#rescueCompactionDeadEnd` had two tiers and both were driven by
 * the SHAPE of the oversized content: `shake("elide")` recognizes a whole tool
 * result or a fenced/XML block, `dropImages` recognizes an image. A tail whose
 * bulk is one message of unfenced prose matches neither, so both tiers reported
 * nothing eligible, the pass warned, and automatic maintenance stopped. Nothing
 * in the chain could reduce a message it did not recognize, so there was no
 * floor under a session at all — the operator's only move was to start over.
 *
 * THE CLASS THIS CLOSES. Not "unfenced prose". The class is a session that
 * cannot reduce itself because no reducer recognizes what is too large. The fix
 * is a third tier whose eligibility asks one question, how big is this text, so
 * that the last resort cannot be defeated by shape. This suite drives the real
 * `AgentSession` through the reported dead end and requires that maintenance
 * recovers and continues rather than parking.
 *
 * WHAT IT DOES NOT CATCH. It does not prove the tier reaches every role's text —
 * `packages/agent/test/every-oversized-text-can-be-truncated.test.ts` sweeps the
 * role union for that. It uses the extension short-circuit for the summarizer,
 * so it exercises the post-pass progress tail rather than a real LLM summary.
 * And it says nothing about whether a truncated message is still useful to the
 * model, only that the session is no longer wedged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, countTokens } from "@veyyon/agent-core";
import * as AIError from "@veyyon/ai/error";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { loadExtensions } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { MAX_JSON_TRANSFORM_STRING_BYTES, SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { AgentSession, obfuscateProviderPayload } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { getProjectAgentDir, TempDir } from "@veyyon/utils";

const CONTEXT_WINDOW = 200_000;
const NO_PROGRESS_FRAGMENT = "Compaction freed too little context to make progress";
const RECOVERY_FRAGMENT = "Compaction dead-end recovery";

/**
 * Unfenced prose: no code fence, no XML tag, so `collectShakeRegions` finds
 * nothing in it, which is the state the report was made from.
 */
function prose(approxTokens: number): string {
	const sample = "sentence 1000 describes an unremarkable observation about record 7000.";
	const count = Math.max(1, Math.ceil(approxTokens / countTokens(sample)));
	const sentences: string[] = [];
	for (let i = 0; i < count; i++) {
		sentences.push(`sentence ${i} describes an unremarkable observation about record ${i * 7}.`);
	}
	return sentences.join(" ");
}

describe("a turn too large to summarize is truncated, not parked", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-compaction-truncation-");

		// Short-circuit the summarizer so no LLM call is made; the production tail
		// (events, progress guard, rescue tiers, continuation scheduling) then runs
		// exactly as in a real pass.
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				"\t\treturn {",
				"\t\t\tcompaction: {",
				'\t\t\t\tsummary: "compacted",',
				"\t\t\t\tshortSummary: undefined,",
				"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\t\tdetails: {},",
				"\t\t\t},",
				"\t\t};",
				"\t});",
				"}",
			].join("\n"),
		);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const extensionsResult = await loadExtensions([extensionPath], tempDir.path(), undefined, undefined, {
			configuredPaths: [extensionPath],
		});
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: CONTEXT_WINDOW, maxTokens: 64_000 };

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.autoContinue": true }),
			modelRegistry,
			extensionRunner,
		});
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			vi.restoreAllMocks();
		}
	});

	/**
	 * Report context usage from what the branch actually holds, so a tier that
	 * removes bytes is the only thing that can move the number. A fixed mock
	 * would let a tier "succeed" while freeing nothing.
	 */
	function trackLiveContext(baseTokens: number) {
		vi.spyOn(session, "getContextUsage").mockImplementation(() => {
			let live = 0;
			for (const entry of sessionManager.getBranch()) {
				if (entry.type !== "message") continue;
				const content = "content" in entry.message ? entry.message.content : undefined;
				if (typeof content === "string") live += countTokens(content);
				else if (Array.isArray(content)) {
					for (const block of content) {
						if (
							block !== null &&
							typeof block === "object" &&
							"text" in block &&
							typeof block.text === "string"
						) {
							live += countTokens(block.text);
						}
					}
				}
			}
			const tokens = baseTokens + live;
			return { tokens, contextWindow: CONTEXT_WINDOW, percent: (tokens / CONTEXT_WINDOW) * 100 };
		});
	}

	function collectNotices() {
		const notices: { level: string; message: string }[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "compaction") {
				notices.push({ level: event.level, message: event.message });
			}
		});
		return notices;
	}

	/** A threshold-tripping assistant turn, as in the auto-compaction guard suite. */
	function highUsageAssistant() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	async function runMaintenance() {
		const { promise, resolve } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") resolve();
		});
		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
		await promise;
		await session.waitForIdle();
	}

	it("recovers a session wedged by one oversized unfenced message", async () => {
		const bulk = prose(60_000);
		sessionManager.appendMessage({ role: "user", content: bulk, timestamp: Date.now() });
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		// 120k of other context plus the 60k message sits above the recovery band;
		// removing the message's middle brings it under.
		trackLiveContext(120_000);

		const notices = collectNotices();
		await runMaintenance();

		expect(notices.filter(n => n.message.includes(NO_PROGRESS_FRAGMENT))).toEqual([]);
		const recovery = notices.filter(n => n.message.includes(RECOVERY_FRAGMENT));
		expect(recovery).toHaveLength(1);
		expect(recovery[0].level).toBe("info");
		expect(recovery[0].message).toContain("truncated the middle of");

		// The bytes left the branch, the edges did not, and the marker points at
		// where the removed middle can be read back.
		const live = sessionManager
			.getBranch()
			.flatMap(entry =>
				entry.type === "message" && "content" in entry.message && typeof entry.message.content === "string"
					? [entry.message.content]
					: [],
			);
		const survivor = live.find(text => text.startsWith(bulk.slice(0, 40)));
		if (survivor === undefined) throw new Error("the oversized message is gone entirely; it should be truncated");
		expect(survivor.endsWith(bulk.slice(-40))).toBe(true);
		expect(survivor).toContain("truncated ~");
		expect(countTokens(survivor)).toBeLessThan(countTokens(bulk) / 2);

		// Maintenance made progress, so the turn continues instead of standing down.
		expect(promptSpy).toHaveBeenCalled();
	});

	it("still parks, once, when nothing on the branch is large enough to cut", async () => {
		// Many small messages: over the band in aggregate, with no single text the
		// truncation tier can take a middle out of. This is the honest dead end,
		// and it must stay a single warning rather than a loop.
		for (let i = 0; i < 40; i++) {
			sessionManager.appendMessage({ role: "user", content: `note ${i}: ${prose(40)}`, timestamp: Date.now() });
		}
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		trackLiveContext(190_000);

		const notices = collectNotices();
		let starts = 0;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") starts++;
		});
		await runMaintenance();

		expect(starts).toBe(1);
		const parked = notices.filter(n => n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(parked).toHaveLength(1);
		expect(parked[0].level).toBe("warning");
		// The warning names what was already tried, so the remedy it offers is the
		// one the operator has left.
		expect(parked[0].message).toContain("truncating the largest messages");
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("cuts only what the bar is exceeded by, leaving the rest of the tail intact", async () => {
		const first = prose(40_000);
		const second = prose(40_000);
		sessionManager.appendMessage({ role: "user", content: first, timestamp: Date.now() });
		sessionManager.appendMessage({ role: "user", content: second, timestamp: Date.now() });
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		// One message's middle is enough to clear the band, so the other must be
		// left whole: a last-resort reducer still removes the minimum.
		trackLiveContext(90_000);

		await runMaintenance();

		const live = sessionManager
			.getBranch()
			.flatMap(entry =>
				entry.type === "message" && "content" in entry.message && typeof entry.message.content === "string"
					? [entry.message.content]
					: [],
			);
		expect(live.filter(text => text.includes("truncated ~"))).toHaveLength(1);
		expect(live).toContain(second);
	});

	/**
	 * BACKTEST. The report carried both notices from one session:
	 *
	 *   "Compaction freed too little context to make progress — pausing automatic
	 *    maintenance to avoid a compaction loop."
	 *   "AgentSession provider payload: the provider request exceeds the
	 *    confidentiality scan byte limit; confidentiality transform failed."
	 *
	 * They are one dead end with two locks. The scan runs before the send, so it
	 * refuses the turn locally and no provider ever answers; that refusal used to
	 * classify as nothing, so the retry ladder had no recovery for it and the
	 * rescue was never reached. The rescue could not have helped anyway, because
	 * no tier recognized unfenced prose.
	 *
	 * The input is the reported SHAPE reduced to what reproduces it: one turn
	 * whose single unfenced text exceeds the scan's cumulative byte limit, with a
	 * secret configured, which is what puts the scan on the path at all. No
	 * recorded content, path or identifier from the session is used.
	 */
	it("backtest: the reported turn is refused by the scan, then cleared by maintenance", async () => {
		const bulk = prose(60_000) + "x".repeat(MAX_JSON_TRANSFORM_STRING_BYTES);
		sessionManager.appendMessage({ role: "user", content: bulk, timestamp: Date.now() });
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		trackLiveContext(120_000);

		const payloadOf = () => ({
			messages: sessionManager
				.getBranch()
				.flatMap(entry =>
					entry.type === "message" && "content" in entry.message && typeof entry.message.content === "string"
						? [{ text: entry.message.content }]
						: [],
				),
		});
		const secrets = new SecretObfuscator([{ type: "plain", origin: "config", content: "A_CONFIGURED_SECRET" }]);

		// Wall two, as reported: the scan refuses this turn before it can be sent.
		// It must now say the payload is too big, so the overflow recovery is
		// entered instead of the failure surfacing as an unactionable error.
		let refusal: unknown;
		try {
			obfuscateProviderPayload(payloadOf(), secrets);
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeDefined();
		expect(AIError.is(AIError.classify(refusal), AIError.Flag.ContextOverflow)).toBe(true);

		// Wall one: maintenance recovers rather than parking.
		const notices = collectNotices();
		await runMaintenance();
		expect(notices.filter(n => n.message.includes(NO_PROGRESS_FRAGMENT))).toEqual([]);
		expect(notices.filter(n => n.message.includes(RECOVERY_FRAGMENT))).toHaveLength(1);

		// The two locks open together: the same scan now accepts the branch, so the
		// next request leaves the process instead of repeating the refusal.
		expect(() => obfuscateProviderPayload(payloadOf(), secrets)).not.toThrow();
	}, 60_000);
});
