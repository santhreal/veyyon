/**
 * What the reader sees when a tool call fails.
 *
 * Measured over 778 local session transcripts: 41 tool results whose text
 * LEADS with `<system-reminder reason="rule_violation" ...>`. Top offenders
 * cwd-reroot (16), commit-drift (13), ts-no-tiny-functions (5),
 * bash-tool-nudge (3). A rule reminder is model-directed markup; when it rides
 * in front of a tool result it displaces the one thing the reader needs, which
 * is what the tool actually did or failed to do.
 *
 * The case that matters most is the FAILING call, and it is the one no
 * existing test covers: a successful call's text is still recognisable with a
 * preamble in front of it, but an error's first line is the whole diagnosis.
 *
 * These assert behaviour, not the mechanism. Whether the reminder rides a
 * hidden message, a separate channel, or nothing at all is not this file's
 * business; that the tool's own error is what the tool result says, is.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { Rule } from "@veyyon/coding-agent/capability/rule";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";
import { type } from "arktype";
import { createSimulation, type Simulation, scriptTurns, simTool, toolResultTexts } from "./harness";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** A rule that matches the streamed arguments of the calls below. */
const NO_UNWRAP: Rule = {
	name: "no-unwrap",
	path: "/tmp/no-unwrap.md",
	content: "Do not use .unwrap()",
	condition: ["\\.unwrap\\("],
	_source: { provider: "test", providerName: "test", path: "/tmp/no-unwrap.md", level: "project" },
};

/** Non-interrupting rules are the ones that produced all 41 observed leaks. */
function nonInterruptingRules(): TtsrManager {
	const manager = new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "never",
		repeatMode: "once",
		repeatGap: 10,
	});
	manager.addRule(NO_UNWRAP);
	return manager;
}

const SNIPPET_SCHEMA = type({ "snippet?": "string" });

describe("a failing tool call reports the tool's error", () => {
	it("leads with the real failure when a rule matched the same call", async () => {
		const failure = "ENOENT: no such file or directory, open '/tmp/missing.rs'";
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			ttsrManager: nonInterruptingRules(),
			tools: [
				simTool(
					"edit",
					async () => {
						throw new Error(failure);
					},
					{ parameters: SNIPPET_SCHEMA },
				),
			],
			script: scriptTurns(
				turn => {
					// The streamed argument delta is what the rule matches on.
					turn.toolCall("edit", { snippet: "let value = result.unwrap()" });
					turn.finish();
				},
				turn => {
					turn.text("the file is missing, stopping");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("edit the file");

		const results = toolResultTexts(sim.session);
		expect(results).toHaveLength(1);
		const text = results[0] ?? "";
		// The first thing the reader sees is the diagnosis, not a rule notice.
		expect(text.startsWith("<system-reminder")).toBe(false);
		expect(text).toContain(failure);
		expect(text).not.toContain('reason="rule_violation"');
		expect(sim.session.isStreaming).toBe(false);
	});

	it("leaves a succeeding call's output alone too", async () => {
		// The negative control on the same rule and the same call shape: if the
		// success path still carried the reminder, the fix would only have moved
		// the leak rather than removed it.
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			ttsrManager: nonInterruptingRules(),
			tools: [
				simTool("edit", async () => ({ content: [{ type: "text", text: "edit applied" }] }), {
					parameters: SNIPPET_SCHEMA,
				}),
			],
			script: scriptTurns(
				turn => {
					turn.toolCall("edit", { snippet: "let value = result.unwrap()" });
					turn.finish();
				},
				turn => {
					turn.text("done");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("edit the file");

		expect(toolResultTexts(sim.session)).toEqual(["edit applied"]);
	});

	it("does not lose the rule: the model is still told, off the reader's surface", async () => {
		// Keeping the reminder off the tool result must not mean dropping it.
		// This is the half that makes the previous two safe to enforce.
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			ttsrManager: nonInterruptingRules(),
			tools: [
				simTool(
					"edit",
					async () => {
						throw new Error("boom");
					},
					{ parameters: SNIPPET_SCHEMA },
				),
			],
			script: scriptTurns(
				turn => {
					turn.toolCall("edit", { snippet: "let value = result.unwrap()" });
					turn.finish();
				},
				turn => {
					turn.text("noted");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("edit the file");

		const hidden = sim.session.messages.filter(message => message.role === "custom" && message.display === false);
		const carriesRule = hidden.some(message => {
			const content = message.role === "custom" ? message.content : undefined;
			const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
			return text.includes("no-unwrap");
		});
		expect(carriesRule).toBe(true);
	});
});
