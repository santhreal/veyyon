/**
 * Simulations for tools that misbehave while the provider waits on them.
 *
 * Unit tests in this tree simulate tools that RETURN. The interesting failures
 * are the ones that do not: a tool that never settles, a tool that throws, and
 * a tool that is cut off mid-execution. Each of those decides whether the turn
 * ends or the session sits at "Working…" forever, so each is asserted by
 * awaiting the turn to completion.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createSimulation, lastAssistantText, type Simulation, scriptTurns, simTool, toolResultTexts } from "./harness";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/**
 * A tool that blocks until its abort signal fires, and never on its own.
 *
 * `entered` resolves once the loop is genuinely inside `execute`, which is the
 * causal hook a cancel scenario needs: it removes any need to guess when the
 * tool started.
 */
function wedgedTool(name: string, entered: PromiseWithResolvers<void>) {
	return simTool(name, async (_id, _args, signal) => {
		entered.resolve();
		const held = Promise.withResolvers<never>();
		signal?.addEventListener("abort", () => held.reject(new Error("tool aborted")), { once: true });
		await held.promise;
		return { content: [{ type: "text", text: "never reached" }] };
	});
}

// NOTE: the sibling case, a tool that IGNORES its abort signal, is NOT covered
// here because the product currently has no answer for it: `AgentSession.abort`
// awaits `agent.waitForIdle()` with no bound, so the turn never ends and the
// session stays streaming for good. That is reported as a defect rather than
// pinned as a contract; pinning it would make the wedge look intended.
describe("a tool that never returns", () => {
	it("lets the user cancel out and leaves the session usable for the next turn", async () => {
		// The #4593 wedge as an operator meets it: the model called a local tool,
		// the tool never came back, and the escape is a cancel. Two things are
		// under test. First, the cancel must land while a tool is mid-execution.
		// Second, and this is the part real sessions got wrong, the session must
		// not stay LATCHED afterwards: the very next prompt has to run a fresh
		// turn against a clean loop.
		const toolEntered = Promise.withResolvers<void>();
		let secondTurnRan = false;

		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [wedgedTool("wedge", toolEntered)],
			script: scriptTurns(
				turn => {
					turn.toolCall("wedge", {});
					turn.finish();
				},
				turn => {
					secondTurnRan = true;
					turn.text("picked up where we left off");
					turn.finish();
				},
			),
		});

		const first = sim.session.prompt("run the wedge tool");
		await toolEntered.promise;
		await sim.session.abort({ reason: "user interrupt" });
		await first;

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.session.isAborting).toBe(false);

		// "Cancel and say continue fixes it" must be true, not folklore.
		await sim.session.prompt("continue");

		expect(secondTurnRan).toBe(true);
		expect(sim.session.isStreaming).toBe(false);
		expect(lastAssistantText(sim.session)).toContain("picked up where we left off");
	});

	it("reports the cancelled tool as cancelled rather than as a completed result", async () => {
		// A wedged tool that is cut off must not be recorded as work that
		// happened. The model reading this transcript decides whether to retry,
		// so a success-shaped or empty result is how a half-applied edit gets
		// double-applied on the follow-up turn.
		const toolEntered = Promise.withResolvers<void>();

		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [wedgedTool("wedge", toolEntered)],
			script: turn => {
				turn.toolCall("wedge", {});
				turn.finish();
			},
		});

		const first = sim.session.prompt("run the wedge tool");
		await toolEntered.promise;
		await sim.session.abort({ reason: "user interrupt" });
		await first;

		const results = toolResultTexts(sim.session);
		expect(results).toHaveLength(1);
		expect(results[0]).not.toContain("never reached");
		expect(results[0]).toMatch(/abort|cancel|interrupt/i);
	});
});

describe("a tool that errors", () => {
	it("carries the failure into the next turn and finishes the conversation", async () => {
		// A throwing tool is the routine case, and the contract is that the turn
		// CONTINUES: the error becomes a tool result, the model sees it, and the
		// turn reaches a terminal answer. A session that stops dead on a tool
		// error is indistinguishable to the operator from one that hung.
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [
				simTool("brittle", async () => {
					throw new Error("ENOENT: no such file or directory, open '/nope'");
				}),
			],
			script: scriptTurns(
				turn => {
					turn.toolCall("brittle", { path: "/nope" });
					turn.finish();
				},
				turn => {
					turn.text("that path does not exist, stopping");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("read /nope");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.providerCalls()).toBe(2);
		expect(lastAssistantText(sim.session)).toContain("that path does not exist");

		// The model's second turn must have been able to READ the real failure.
		const results = toolResultTexts(sim.session);
		expect(results.some(text => text.includes("no such file or directory"))).toBe(true);
	});

	it("keeps the sibling calls of a batch alive when one of them throws", async () => {
		// One bad call in a batch must not take the whole turn down, or a single
		// brittle tool wedges every multi-call step the model takes.
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [
				simTool("brittle", async () => {
					throw new Error("simulated tool explosion");
				}),
				simTool("sturdy", async () => ({ content: [{ type: "text", text: "sturdy ok" }] })),
			],
			script: scriptTurns(
				turn => {
					turn.toolCall("brittle", {});
					turn.toolCall("sturdy", {});
					turn.finish();
				},
				turn => {
					turn.text("done");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("run both");

		const results = toolResultTexts(sim.session);
		expect(results.some(text => text.includes("simulated tool explosion"))).toBe(true);
		expect(results.some(text => text.includes("sturdy ok"))).toBe(true);
		expect(lastAssistantText(sim.session)).toContain("done");
	});
});
