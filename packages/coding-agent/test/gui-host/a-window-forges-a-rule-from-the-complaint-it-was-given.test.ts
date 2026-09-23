/**
 * WHY: `/omfg` forged a TTSR rule into a terminal panel and nowhere else, so a
 * window that typed it had the complaint passed to the model as prose and the
 * desktop decision for the command read "no rule-forging surface". The forge
 * itself is shared (`rules/forge.ts`); what was missing was a host that puts
 * the draft up for review where a window answers it, which is the interaction
 * ledger every other desktop decision arrives on.
 *
 * THE CLASS THIS CLOSES: an answer on a forge card that reaches no outcome.
 * Every answer of both cards the forge raises — the review's save, amend and
 * discard, and the save-anyway a rule nobody could confirm raises first — is
 * driven through the socket, as is the overwrite of a rule already on disk and
 * a complaint the model never answers with a valid rule. What is asserted is
 * the rule file on disk and the request's own outcome, so a handler that
 * replies without writing, or writes without replying, fails here.
 *
 * The attempt bound is `MAX_FORGE_ATTEMPTS` read at run time and the stub
 * counts what it was asked, so a forge that never gives up fails as a wrong
 * count rather than stalling the run.
 *
 * WHAT IT DOES NOT CATCH: a real provider request, since the side stream is
 * stubbed and what the model puts in the JSON is `omfg-rule`'s to parse; how a
 * window draws a decision card, which the desktop surfaces own; and what the
 * rule does once live, which the TTSR manager owns — the rule reaching the
 * running session is asserted as the file rule discovery reads, not as an
 * interrupt fired.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { resetSettingsForTest } from "../../src/config/settings";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { PendingDecisions } from "../../src/gui-host/wire";
import { MAX_FORGE_ATTEMPTS } from "../../src/rules/forge";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

/** The answers a forge card offers, by the index a window sends back. */
const FIRST = 0;
const SECOND = 1;
const THIRD = 2;

const RULE_NAME = "no-any-in-edits";
/** What the rule matches on, and what the seeded reply says so it matches. */
const CONDITION = "const value: any";

/** A rule the model returns, as the JSON object the forge parses out. */
function ruleJson(body: string, scope = "text"): string {
	return JSON.stringify({ name: RULE_NAME, description: "Generated rule", condition: CONDITION, scope, body });
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-chat",
		provider: "openai",
		model: "gpt-4o-mini",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

/** A stream that delivers `text` as one delta and finishes, as a reply does. */
function completedStream(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(text);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: { ...message, content: [{ type: "text", text: "" }] },
		});
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

describe("a window forges a rule from the complaint it was given", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	let session = "";
	let next = 2;
	/** The messages of each request the stub answered, in order. */
	let asked: string[] = [];
	/** What the stub replies with, read per request so a test can change it. */
	let reply: (sent: string) => string = () => ruleJson("Use the safer behavior.");

	beforeEach(async () => {
		asked = [];
		reply = () => ruleJson("Use the safer behavior.");
		// Installed before the session exists: the side transport is captured
		// once at construction, so a spy set after it holds the real stream.
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			const sent = JSON.stringify(context.messages ?? []);
			asked.push(sent);
			return completedStream(reply(sent));
		});
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-omfg-"));
		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
		const created = await client.request(1, { CreateSession: {} });
		const active = snapshotSections<{ value: { id: string } }>(created.frames, "ActiveSession").at(-1);
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		session = active.value.id;
		next = 2;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		// The settings a session initialises are process-wide, so the next
		// test's rule would be written to this test's directory without this.
		resetSettingsForTest();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** The file the forge writes a rule of this name to, present or not. */
	function rulePath(): string {
		return path.join(tempDir, "rules", `${RULE_NAME}.md`);
	}

	async function ruleOnDisk(): Promise<string | null> {
		return await fs.readFile(rulePath(), "utf8").catch(() => null);
	}

	/**
	 * Runs one turn whose reply carries the text the rule condition matches,
	 * so the forge has a conversation to confirm the rule against.
	 *
	 * The request is acknowledged before the turn runs, so the reply is read
	 * off the socket rather than assumed: what the forge confirms against is
	 * the conversation, not the request that started it.
	 */
	async function seedMatchingHistory(): Promise<void> {
		reply = () => `Here is the edit: ${CONDITION} = input;`;
		await client.request(next++, { SubmitPrompt: { session, text: "write it", attachments: [] } });
		for (;;) {
			const frame = (await client.nextFrame()) as RequestFrame;
			const entries = (frame.TranscriptAppended?.entries ?? []) as { role: string; content: unknown[] }[];
			const landed = entries.some(
				entry => entry.role === "Assistant" && JSON.stringify(entry.content).includes(CONDITION),
			);
			if (landed) break;
		}
		reply = () => ruleJson("Use the safer behavior.");
		asked = [];
	}

	/**
	 * Runs `/omfg <complaint>`, answering each card the host raises with the
	 * next answer, and returns every frame of the request.
	 *
	 * An answer is an option index for a card or the text a free-text question
	 * takes, so one script drives both kinds. Answers run out where the
	 * command is meant to end, so a card raised past the last one fails the
	 * read rather than hanging the suite.
	 */
	async function forge(
		complaint: string,
		answers: readonly (number | string)[],
	): Promise<{ frames: RequestFrame[]; outcome: RequestFrame }> {
		const id = next++;
		const text = complaint ? `/omfg ${complaint}` : "/omfg";
		client.send({ id, action: { RunCommand: { session, text } } });
		const frames: RequestFrame[] = [];
		const answered = new Set<string>();
		for (;;) {
			const frame = (await client.nextFrame()) as RequestFrame;
			frames.push(frame);
			if (frame.RequestSucceeded?.request === id || frame.RequestFailed?.request === id) {
				return { frames, outcome: frame };
			}
			const pending = snapshotSections<{ pending: PendingDecisions }>([frame], "Interactions");
			for (const question of pending.at(-1)?.pending.questions ?? []) {
				if (answered.has(question.id)) continue;
				const answer = answers[answered.size];
				answered.add(question.id);
				if (answer === undefined) throw new Error(`no answer scripted for "${question.prompt}"`);
				client.send({
					id: next++,
					action: {
						RespondToInteraction: {
							session,
							interaction_id: question.id,
							response: typeof answer === "number" ? { option: answer } : { text: answer },
						},
					},
				});
			}
		}
	}

	/** Every card those frames raised, in the order raised. */
	function cards(frames: RequestFrame[]): PendingDecisions["questions"] {
		const seen = new Map<string, PendingDecisions["questions"][number]>();
		for (const section of snapshotSections<{ pending: PendingDecisions }>(frames, "Interactions")) {
			for (const question of section.pending.questions) seen.set(question.id, question);
		}
		return [...seen.values()];
	}

	/** What the command printed into the window, in the order it printed. */
	function stated(frames: RequestFrame[]): string[] {
		const said: string[] = [];
		for (const frame of frames) {
			for (const entry of frame.TranscriptAppended?.entries ?? []) {
				const written = entry as { raw_discriminator?: string; raw?: { command?: string; text?: string } };
				if (written.raw_discriminator === "command_output" && written.raw?.command === "omfg") {
					said.push(written.raw.text ?? "");
				}
			}
		}
		return said;
	}

	test("a rule the conversation confirms is reviewed once and saved where rule discovery reads it", async () => {
		await seedMatchingHistory();

		const { frames, outcome } = await forge("stop writing any", [FIRST]);

		expect(outcome.RequestFailed).toBeUndefined();
		const raised = cards(frames);
		// Confirmed against the turn above, so the only card is the review
		// itself, and it carries the rule a window is being asked about.
		expect(raised.length).toBe(1);
		expect(raised[0]?.prompt).toContain("Use the safer behavior.");
		expect(raised[0]?.options.length).toBe(3);
		// One attempt: a confirmed rule is not asked for again.
		expect(asked.length).toBe(1);
		const written = await ruleOnDisk();
		expect(written).toContain(`name: ${RULE_NAME}`);
		expect(written).toContain("Use the safer behavior.");
	});

	test("a rule nothing in the conversation confirms is saved only after the card that says so", async () => {
		const { frames, outcome } = await forge("stop writing any", [FIRST, FIRST]);

		expect(outcome.RequestFailed).toBeUndefined();
		const raised = cards(frames);
		expect(raised[0]?.prompt).toContain("Couldn't confirm");
		expect(raised[1]?.prompt).toContain("Use the safer behavior.");
		// Every attempt was spent trying to confirm it before the card.
		expect(asked.length).toBe(MAX_FORGE_ATTEMPTS);
		expect(stated(frames).join("\n")).toContain("Saved");
		expect(await ruleOnDisk()).toContain("Use the safer behavior.");
	});

	test("a rule nobody could confirm is not written when that card declines it", async () => {
		const { frames, outcome } = await forge("stop writing any", [SECOND]);

		expect(outcome.RequestFailed).toBeUndefined();
		expect(cards(frames).length).toBe(1);
		expect(await ruleOnDisk()).toBeNull();
	});

	test("an amendment re-forges the rule with the feedback that asked for it", async () => {
		await seedMatchingHistory();
		reply = sent => ruleJson(sent.includes("make it Ruby only") ? "Amended attempt." : "First attempt.");

		const { outcome } = await forge("stop writing any", [SECOND, "make it Ruby only", FIRST]);

		expect(outcome.RequestFailed).toBeUndefined();
		// The second ask carries the amendment and the rule it is about, which
		// is what makes it a revision rather than a second first attempt.
		expect(asked.at(-1)).toContain("make it Ruby only");
		expect(asked.at(-1)).toContain("First attempt.");
		expect(await ruleOnDisk()).toContain("Amended attempt.");
	});

	test("an amendment nobody described leaves the rule unsaved", async () => {
		await seedMatchingHistory();

		const { outcome } = await forge("stop writing any", [SECOND, "   "]);

		expect(outcome.RequestFailed).toBeUndefined();
		expect(await ruleOnDisk()).toBeNull();
	});

	test("a review that is discarded writes no rule, and the command still completes", async () => {
		await seedMatchingHistory();

		const { outcome } = await forge("stop writing any", [THIRD]);

		expect(outcome.RequestFailed).toBeUndefined();
		expect(await ruleOnDisk()).toBeNull();
	});

	test("a rule already on disk is overwritten only when the card says to", async () => {
		await seedMatchingHistory();
		await fs.mkdir(path.dirname(rulePath()), { recursive: true });
		await fs.writeFile(rulePath(), "the rule that was already there", "utf8");

		const kept = await forge("stop writing any", [FIRST, SECOND]);
		expect(kept.outcome.RequestFailed).toBeUndefined();
		expect(await ruleOnDisk()).toBe("the rule that was already there");

		const replaced = await forge("stop writing any", [FIRST, FIRST]);
		expect(replaced.outcome.RequestFailed).toBeUndefined();
		expect(await ruleOnDisk()).toContain("Use the safer behavior.");
	});

	test("a model that never returns a valid rule is refused after the attempts it is given", async () => {
		reply = () => "nothing resembling a rule";

		const { outcome } = await forge("stop writing any", []);

		expect(outcome.RequestFailed?.error.code).toBe("RULE_NOT_FORGED");
		expect(asked.length).toBe(MAX_FORGE_ATTEMPTS);
		expect(await ruleOnDisk()).toBeNull();
	});

	test("a complaint with nothing in it is refused, and nothing is asked of the model", async () => {
		const { outcome } = await forge("   ", []);

		expect(outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
		expect(outcome.RequestFailed?.error.message).toBe("Usage: /omfg <complaint>");
		expect(asked).toEqual([]);
	});
});
