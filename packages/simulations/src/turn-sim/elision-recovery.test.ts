/**
 * What "recoverable" has to mean when the session elides its own history.
 *
 * WHY THIS FILE EXISTS. Several maintenance paths shrink a context by taking the
 * bytes OUT of a tool result and leaving a marker that names an `artifact://` id:
 * the redundant-result dedup, the shake elide tier, and the compaction tail
 * bound. Every one of them describes itself as recall-preserving because the
 * originals are recoverable through that pointer, and that promise is the whole
 * reason the pass is allowed to touch a result the operator already read. The
 * pointer is written by the session, the bytes are written by the artifact
 * manager onto real disk beside the transcript, and nothing before this suite
 * checked that the two ever meet. A marker naming an id that was never written,
 * or written without the content, is silent data loss wearing a receipt.
 *
 * ASSERTED. The dedup pass drops exactly the older copy of a byte-identical
 * result and keeps the newest one live; the marker it leaves carries an
 * `artifact://<id>` pointer; the file that pointer resolves to exists and holds
 * the elided bytes; the rewrite reaches both the store and the next request; and
 * the pointer still resolves after the session is reopened from its transcript,
 * which is when a recovery is actually attempted.
 *
 * NOT asserted. The `read` tool's own resolution of an `artifact://` URI (that is
 * the tool's contract, exercised where the tool is) and the shake elide tier's
 * size-driven region selection, whose savings floor needs a context far larger
 * than a simulation builds. This suite takes the one elision path a session
 * reaches with no size pressure at all, because it is the path an operator hits
 * without asking for anything.
 *
 * The end-of-turn supersede pass is turned OFF here on purpose: it would blank
 * the older read first, on its own rule, and then there would be no identical
 * pair left for dedup to find. `history-maintenance.test.ts` owns that pass.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { AgentTool } from "@veyyon/agent-core";
import type { Context } from "@veyyon/ai";
import { createSimulation, type Simulation, scriptTurns, simTool } from "./harness";
import { describeViolations, pairingViolations } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** Big enough that eliding it is worth a pointer, small enough to read in a diff. */
function bodyFor(path: string): string {
	return `contents of ${path}\n${"export const value = compute(1234);\n".repeat(30)}`;
}

function readTool(): AgentTool[] {
	return [
		simTool("read", async (_id, args) => ({
			content: [{ type: "text", text: bodyFor(String(args.path)) }],
		})),
	];
}

function textOfResult(sim: Simulation, toolCallId: string): string {
	for (const message of sim.session.messages) {
		if (message.role !== "toolResult" || message.toolCallId !== toolCallId) continue;
		return message.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("");
	}
	return "(no result recorded)";
}

function resultTexts(messages: readonly { role: string }[]): string[] {
	const texts: string[] = [];
	for (const message of messages as readonly Context["messages"][number][]) {
		if (message.role !== "toolResult") continue;
		texts.push(
			message.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join(""),
		);
	}
	return texts;
}

/**
 * Two prompts that each read `paths[n]`, then a third with nothing to do. The
 * third exists so the rewrite the dedup performed has to survive onto a request.
 */
async function runTwoReads(paths: readonly [string, string]): Promise<{ contexts: Context[] }> {
	const contexts: Context[] = [];
	sim = await createSimulation({
		persist: true,
		settings: {
			"retry.enabled": false,
			// Isolate the dedup path: see the header.
			"compaction.supersedeReads": false,
			"compaction.dropUseless": false,
		},
		tools: readTool(),
		script: scriptTurns(
			turn => {
				contexts.push(turn.context);
				turn.toolCall("read", { path: paths[0] }, "read-1");
				turn.finish("toolUse");
			},
			turn => {
				contexts.push(turn.context);
				turn.text("first read done");
				turn.finish();
			},
			turn => {
				contexts.push(turn.context);
				turn.toolCall("read", { path: paths[1] }, "read-2");
				turn.finish("toolUse");
			},
			turn => {
				contexts.push(turn.context);
				turn.text("second read done");
				turn.finish();
			},
			turn => {
				contexts.push(turn.context);
				turn.text("nothing left to do");
				turn.finish();
			},
		),
	});
	await sim.session.prompt("read it");
	await sim.session.prompt("read it again");
	return { contexts };
}

describe("an elided tool result is recoverable through the artifact it points at", () => {
	it("elides the older identical read and writes its bytes where the marker says", async () => {
		const { contexts } = await runTwoReads(["src/a.ts", "src/a.ts"]);
		const simulation = sim;
		expect(simulation).toBeDefined();
		if (!simulation) return;

		const dedup = await simulation.session.dedupeRedundantToolResults();

		expect(dedup.toolResultsDropped).toBe(1);
		expect(dedup.tokensFreed).toBeGreaterThan(0);
		expect(dedup.artifactId).toBeDefined();
		const artifactId = dedup.artifactId ?? "";

		// The older copy is a pointer; the newest copy is still the answer.
		const marker = textOfResult(simulation, "read-1");
		expect(marker).toContain(`recover: artifact://${artifactId}`);
		expect(marker).not.toContain("export const value");
		expect(textOfResult(simulation, "read-2")).toBe(bodyFor("src/a.ts"));

		// The pointer resolves to a real file, and that file holds what was taken.
		const artifactPath = await simulation.sessionManager.getArtifactPath(artifactId);
		expect(artifactPath).toBeTruthy();
		const stored = await fs.readFile(artifactPath ?? "", "utf8");
		expect(stored).toContain(bodyFor("src/a.ts"));

		// The rewrite reaches the next request, and the pair still lines up there.
		await simulation.session.prompt("now answer");
		const outbound = contexts.at(-1);
		expect(outbound).toBeDefined();
		expect(describeViolations("dedup", pairingViolations(outbound?.messages ?? []))).toEqual([]);
		const wire = resultTexts(outbound?.messages ?? []);
		expect(wire.filter(text => text.includes("export const value"))).toHaveLength(1);
		expect(wire.some(text => text.includes(`recover: artifact://${artifactId}`))).toBe(true);

		// A recovery is attempted from a NEW process, so the reopened session is
		// where the pointer has to still resolve.
		const reopened = await simulation.reopen();
		try {
			const reopenedPath = await reopened.sessionManager.getArtifactPath(artifactId);
			expect(reopenedPath).toBeTruthy();
			expect(await fs.readFile(reopenedPath ?? "", "utf8")).toBe(stored);
			expect(resultTexts(reopened.session.messages)).toEqual(resultTexts(simulation.session.messages));
		} finally {
			await reopened.dispose();
		}
	});

	it("elides nothing and writes no artifact when the two reads differ", async () => {
		await runTwoReads(["src/a.ts", "src/b.ts"]);
		const simulation = sim;
		expect(simulation).toBeDefined();
		if (!simulation) return;

		const dedup = await simulation.session.dedupeRedundantToolResults();

		expect(dedup.toolResultsDropped).toBe(0);
		expect(dedup.tokensFreed).toBe(0);
		expect(dedup.artifactId).toBeUndefined();
		expect(textOfResult(simulation, "read-1")).toBe(bodyFor("src/a.ts"));
		expect(textOfResult(simulation, "read-2")).toBe(bodyFor("src/b.ts"));
	});
});
