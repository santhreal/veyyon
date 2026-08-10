/**
 * A model that keeps making the same tool call is steered once per run, and the
 * rules for "the same call" are not the obvious ones.
 *
 * WHY THIS FILE EXISTS. The guard (`ai/utils/tool-call-loop-guard.ts`) hashes the
 * one tool call of a turn and counts consecutive matches, and the session turns a
 * threshold hit into a hidden redirect turn the next request carries. Every part
 * of that has a quiet edge:
 *
 *   - the intent field is excluded from the hash, so a model that only rewrites
 *     its own explanation is still repeating itself;
 *   - a turn with TWO calls is not a repetition of anything and resets the run,
 *     which means a looping model that pairs its call with a second one is
 *     invisible to the guard by construction;
 *   - the redirect fires when the count EQUALS the threshold, so it is one
 *     redirect per uninterrupted run rather than one per turn after the
 *     threshold, and a different call in between starts a new run that can fire
 *     again;
 *   - the threshold and the exempt list are operator settings, so a build that
 *     hardcoded either would still look right at its default.
 *
 * Each of those is asserted here against the real session: the redirect is
 * counted in the stored history and read again in the outbound context of the
 * next request, because a redirect the model never receives steers nothing.
 *
 * WHAT THIS DOES NOT CATCH, measured rather than assumed.
 *   - Nothing here bounds a model that ignores the redirect. Past the threshold
 *     the count never equals it again, so the guard stays quiet for the rest of
 *     that run by design; what stops a runaway is the loop's own step budget,
 *     which is a different owner and a different file.
 *   - The redirect's wording is the prompt's business. The rows assert that it
 *     names the looping tool and reaches the model, not how it reads.
 *   - The guard only sees turns that COMPLETED. A cancel mid-batch is the cancel
 *     matrix's axis, and a turn the provider failed never reaches the guard at
 *     all.
 *
 * RED PROOFS, observed rather than predicted. Six mutations across the guard and
 * the session that owns its settings:
 *   - firing on every count at or past the threshold (`<` for `!==`): both
 *     threshold rows red on a second and third redirect.
 *   - the intent field left in the hash: only the intent row reds.
 *   - a multi-call turn counted as a repetition: only the two-calls row reds.
 *   - the exempt list ignored: only the exempt row reds.
 *   - the enabled setting ignored: only the off row reds.
 *   - the threshold hardcoded to its default of five: the threshold-3 row reds
 *     while the threshold-5 row stays green, and the intent and second-run rows
 *     red with it because they are scripted against a threshold of three. That
 *     asymmetry is the point of running both arms.
 */
import { afterEach, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { createSimulation, type Simulation, simTool } from "./harness";

const REDIRECT_TYPE = "tool-call-loop-redirect";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

function redirects(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.filter(
		message => message.role === "custom" && (message as { customType?: string }).customType === REDIRECT_TYPE,
	);
}

/** All text of the non-assistant messages of a list: what the model was told. */
function injectedText(messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			parts.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const candidate = block as { type: string; text?: string };
			if (candidate.type === "text" && candidate.text) parts.push(candidate.text);
		}
	}
	return parts.join("\n");
}

function loopTool(name = "work"): ReturnType<typeof simTool> {
	return simTool(name, async () => ({ content: [{ type: "text", text: "same output every time" }] }));
}

/**
 * The threshold is an operator setting, so both arms run the same script and
 * differ only in where the redirect is expected. A build that hardcoded a count
 * would satisfy one arm and fail the other.
 */
for (const threshold of [3, 5]) {
	it(`redirects once, on the turn that reaches a threshold of ${threshold}`, async () => {
		const wire: AgentMessage[][] = [];
		// Two turns past the threshold: enough to prove the redirect does not
		// repeat, and the script still terminates.
		const repeats = threshold + 2;
		sim = await createSimulation({
			settings: { "model.toolCallLoopGuard.threshold": threshold },
			tools: [loopTool()],
			script: turn => {
				wire.push([...turn.context.messages]);
				if (turn.call <= repeats) {
					turn.toolCall("work", { path: "same.ts" }, `call-${turn.call}`);
					turn.finish();
					return;
				}
				turn.text("giving up on that tool");
				turn.finish();
			},
		});

		await sim.session.prompt("go");

		expect(redirects(sim.session.messages).length).toBe(1);
		const redirect = redirects(sim.session.messages)[0]!;
		expect((redirect as { details?: { toolName?: string; count?: number } }).details).toMatchObject({
			toolName: "work",
			count: threshold,
		});
		// Hidden from the transcript, but not from the model.
		expect((redirect as { display?: boolean }).display).toBe(false);

		// The request AFTER the threshold turn is the first one that carries it, so
		// the count of the turn that fired is what indexes the wire. Comparing the
		// redirect's own bytes is what makes this about delivery: a redirect stored
		// but never sent would satisfy every assertion above it.
		const redirectText = typeof redirect.content === "string" ? redirect.content : "";
		expect(redirectText).toContain("work");
		const sentAfter = wire[threshold];
		expect(sentAfter).toBeDefined();
		expect(injectedText(sentAfter!)).toContain(redirectText);
		expect(injectedText(wire[threshold - 1]!)).not.toContain(redirectText);
	});
}

it("counts a call whose only difference is its intent as a repetition", async () => {
	sim = await createSimulation({
		settings: { "model.toolCallLoopGuard.threshold": 3 },
		tools: [loopTool()],
		script: turn => {
			if (turn.call <= 3) {
				// `i` is the intent field, excluded from the hash. A model rewriting
				// its own explanation each turn is still doing the same thing.
				turn.toolCall("work", { path: "same.ts", i: `Attempt number ${turn.call}` }, `call-${turn.call}`);
				turn.finish();
				return;
			}
			turn.text("done");
			turn.finish();
		},
	});

	await sim.session.prompt("go");

	expect(redirects(sim.session.messages).length).toBe(1);
});

it("starts a new run after a different call, so a second loop is steered again", async () => {
	sim = await createSimulation({
		settings: { "model.toolCallLoopGuard.threshold": 3 },
		tools: [loopTool()],
		script: turn => {
			// Three identical, one different, three identical: two full runs.
			const step = turn.call;
			if (step <= 3) {
				turn.toolCall("work", { path: "first.ts" }, `call-${step}`);
				turn.finish();
				return;
			}
			if (step === 4) {
				turn.toolCall("work", { path: "elsewhere.ts" }, `call-${step}`);
				turn.finish();
				return;
			}
			if (step <= 7) {
				turn.toolCall("work", { path: "second.ts" }, `call-${step}`);
				turn.finish();
				return;
			}
			turn.text("done");
			turn.finish();
		},
	});

	await sim.session.prompt("go");

	// Not a one-shot latch: the guard is per run, and the interruption is what
	// ends a run.
	expect(redirects(sim.session.messages).length).toBe(2);
});

it("never counts a turn that made two calls", async () => {
	sim = await createSimulation({
		settings: { "model.toolCallLoopGuard.threshold": 3 },
		tools: [loopTool(), loopTool("other")],
		script: turn => {
			if (turn.call <= 6) {
				// Byte-identical pairs, six turns running. The guard only hashes a
				// turn that made exactly one call, so this run never counts.
				turn.toolCall("work", { path: "same.ts" }, `call-${turn.call}-a`);
				turn.toolCall("other", { path: "same.ts" }, `call-${turn.call}-b`);
				turn.finish();
				return;
			}
			turn.text("done");
			turn.finish();
		},
	});

	await sim.session.prompt("go");

	expect(redirects(sim.session.messages)).toEqual([]);
});

it("never counts an exempt tool", async () => {
	sim = await createSimulation({
		settings: { "model.toolCallLoopGuard.threshold": 3, "model.toolCallLoopGuard.exemptTools": ["work"] },
		tools: [loopTool()],
		script: turn => {
			if (turn.call <= 5) {
				turn.toolCall("work", { path: "same.ts" }, `call-${turn.call}`);
				turn.finish();
				return;
			}
			turn.text("done");
			turn.finish();
		},
	});

	await sim.session.prompt("go");

	expect(redirects(sim.session.messages)).toEqual([]);
});

it("stays quiet while the guard is off", async () => {
	sim = await createSimulation({
		settings: { "model.toolCallLoopGuard.enabled": false, "model.toolCallLoopGuard.threshold": 3 },
		tools: [loopTool()],
		script: turn => {
			if (turn.call <= 5) {
				turn.toolCall("work", { path: "same.ts" }, `call-${turn.call}`);
				turn.finish();
				return;
			}
			turn.text("done");
			turn.finish();
		},
	});

	await sim.session.prompt("go");

	// The off state is asserted with the same script that fires twice when the
	// guard is on, so a toggle wired to nothing fails here rather than passing on
	// a default.
	expect(redirects(sim.session.messages)).toEqual([]);
});
