/**
 * WHY: `/guided-goal` interviewed an objective through the terminal's editor
 * and nothing else, so a window typing it had the text passed to the model as
 * prose and the desktop decision for the command read "no goal interview
 * surface". The interview turns are shared (`goals/guided-setup.ts`); what was
 * missing was a host that asks its questions where a window answers them,
 * which is the interaction ledger every other desktop decision arrives on.
 *
 * THE CLASS THIS CLOSES: an outcome of the interview that reaches no goal and
 * says nothing about why. `GuidedGoalOutcome` has three members and the review
 * card has three answers; every one is driven here through the socket, and the
 * preconditions are asserted to refuse before the first provider turn rather
 * than after an interview the session could never have entered a goal from.
 * The turn bound is `GUIDED_GOAL_TURN_LIMIT` read at run time, so raising it
 * changes what this suite drives rather than leaving a stale number behind,
 * and the stub counts its calls so an interview that never terminates fails
 * here as a wrong count instead of stalling the run.
 *
 * WHAT IT DOES NOT CATCH: a real provider request — `runGuidedGoalTurn` is
 * stubbed, and what it makes of a model's answer is `guided-setup`'s own; how
 * the window draws a question card, which the desktop's decision surfaces own;
 * and what the goal does once entered, which
 * `a-goal-set-from-the-window-drives-turns-and-states-itself.test.ts` drives.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest } from "../../src/config/settings";
import * as guidedSetup from "../../src/goals/guided-setup";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { GoalView, PendingDecisions } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

interface GoalSnapshotPayload {
	session: string;
	goal: GoalView | null;
}

/** The answers the review card offers, in the order the card lists them. */
const START = 0;
const CHANGE = 1;
const CANCEL = 2;

/** What the stubbed interview says next, consumed one per turn. */
type Scripted = guidedSetup.GuidedGoalTurnResult;

describe("a window interviews an objective before the goal is set", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	let session = "";
	let next = 2;
	let turns = 0;

	beforeEach(async () => {
		turns = 0;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-guided-goal-"));
		const authStorage = await isolatedAuthStorage(tempDir);
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
		resetSettingsForTest();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** Answers each interview turn from `script`, counting what it was asked. */
	function scripted(script: readonly Scripted[]): void {
		vi.spyOn(guidedSetup, "runGuidedGoalTurn").mockImplementation(async () => {
			const step = script[Math.min(turns, script.length - 1)];
			turns += 1;
			if (!step) throw new Error("the interview asked for a turn the script does not have");
			return step;
		});
	}

	/**
	 * Runs `/guided-goal <args>`, answering each question the host raises with
	 * the next answer in `answers`, and returns every frame of the request.
	 *
	 * An answer is either an option index for the review card or the text a
	 * free-text question is answered with, which is how one script drives both
	 * kinds of card the interview raises. Answers run out when the interview
	 * is meant to end, so a card raised after the last one fails the read
	 * rather than hanging the suite.
	 */
	async function interview(
		args: string,
		answers: readonly (number | string)[],
	): Promise<{ frames: RequestFrame[]; outcome: RequestFrame }> {
		const id = next++;
		const text = args ? `/guided-goal ${args}` : "/guided-goal";
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

	/** Every question the frames of one interview raised, in the order raised. */
	function asked(frames: RequestFrame[]): PendingDecisions["questions"] {
		const seen = new Map<string, PendingDecisions["questions"][number]>();
		for (const section of snapshotSections<{ pending: PendingDecisions }>(frames, "Interactions")) {
			for (const question of section.pending.questions) seen.set(question.id, question);
		}
		return [...seen.values()];
	}

	/** The goal the session holds now, read back through `/goal show`. */
	async function goalNow(): Promise<GoalView | null> {
		const shown = await client.request(next++, { RunCommand: { session, text: "/goal show" } });
		return snapshotSections<GoalSnapshotPayload>(shown.frames, "Goal").at(-1)?.goal ?? null;
	}

	test("a question is asked in the window, and the answer reaches the next turn", async () => {
		scripted([
			{ kind: "question", question: "Which parser?" },
			{ kind: "ready", objective: "Port the parser to the new grammar" },
		]);

		const { frames, outcome } = await interview("port the parser", ["the wire one", START]);

		expect(outcome).toEqual({ RequestSucceeded: { request: 2 } });
		const questions = asked(frames);
		expect(questions[0]?.prompt).toBe("Which parser?");
		// A free-text question carries no options; the review card does, and
		// its first answer is the one that starts the goal.
		expect(questions[0]?.options).toEqual([]);
		expect(questions[1]?.prompt).toContain("Port the parser to the new grammar");
		expect(questions[1]?.options.length).toBe(3);
		expect(turns).toBe(2);

		const goal = await goalNow();
		expect(goal?.objective).toBe("Port the parser to the new grammar");
	});

	test("the objective the review replaces is the one the goal is set from", async () => {
		scripted([{ kind: "ready", objective: "Drafted by the interview" }]);

		const { outcome } = await interview("port the parser", [CHANGE, "Typed by the operator instead"]);

		expect(outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect((await goalNow())?.objective).toBe("Typed by the operator instead");
	});

	test("a review that is cancelled enters no goal, and the command still completes", async () => {
		scripted([{ kind: "ready", objective: "Drafted by the interview" }]);

		const { outcome } = await interview("port the parser", [CANCEL]);

		expect(outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(await goalNow()).toBeNull();
	});

	test("a question left unanswered ends the interview and enters no goal", async () => {
		scripted([
			{ kind: "question", question: "Which parser?" },
			{ kind: "ready", objective: "Never reached" },
		]);

		const { outcome } = await interview("port the parser", [""]);

		expect(outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(turns).toBe(1);
		expect(await goalNow()).toBeNull();
	});

	test("an interview that never converges puts its latest draft up rather than a goal", async () => {
		const limit = guidedSetup.GUIDED_GOAL_TURN_LIMIT;
		scripted([{ kind: "question", question: "Narrow it down", objective: "The draft so far" }]);

		const answers = Array.from({ length: limit }, () => "still broad" as number | string);
		const { frames, outcome } = await interview("port the parser", [...answers, START]);

		expect(outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(turns).toBe(limit);
		expect(asked(frames).at(-1)?.prompt).toContain("The draft so far");
		expect((await goalNow())?.objective).toBe("The draft so far");
	});

	test("an interview out of turns with nothing drafted is refused, naming what to do", async () => {
		const limit = guidedSetup.GUIDED_GOAL_TURN_LIMIT;
		scripted([{ kind: "question", question: "Narrow it down" }]);

		const { outcome } = await interview(
			"port the parser",
			Array.from({ length: limit }, () => "still broad"),
		);

		expect(outcome.RequestFailed?.error.code).toBe("GOAL_UNRESOLVED");
		expect(outcome.RequestFailed?.error.message).toContain("/guided-goal");
		expect(turns).toBe(limit);
		expect(await goalNow()).toBeNull();
	});

	test("the bare command asks for the objective before it interviews anything", async () => {
		scripted([{ kind: "ready", objective: "Asked for and answered" }]);

		const { frames, outcome } = await interview("", ["port the parser", START]);

		expect(outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(asked(frames)[0]?.prompt).toBe("What is the goal?");
		expect((await goalNow())?.objective).toBe("Asked for and answered");
	});

	test("goal mode disabled refuses before a single interview turn runs", async () => {
		scripted([{ kind: "ready", objective: "Never interviewed" }]);
		const disabled = await client.request(next++, {
			SetSetting: { key: "goal.enabled", value: false },
		});
		expect(disabled.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		const { outcome } = await interview("port the parser", []);

		expect(outcome.RequestFailed?.error.code).toBe("MODE_DISABLED");
		expect(turns).toBe(0);
	});

	test("a goal already running refuses the interview rather than replacing it", async () => {
		const set = await client.request(next++, {
			SetGoal: { session, objective: "The goal already running", token_budget: null },
		});
		expect(set.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		scripted([{ kind: "ready", objective: "Never interviewed" }]);

		const { outcome } = await interview("port the parser", []);

		expect(outcome.RequestFailed?.error.code).toBe("MODE_CONFLICT");
		expect(turns).toBe(0);
		expect((await goalNow())?.objective).toBe("The goal already running");
	});
});
