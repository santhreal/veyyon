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
 * ASSERTED, at BOTH owners of that pointer, because one owner covered is one
 * owner covered: the redundant-result dedup (`#offloadAndApplyShakeRegions`,
 * shared with `/shake elide`) and the compaction tail bound
 * (`#persistCompactionTailElisions`). Per owner: the pass takes the bytes out
 * and leaves a marker carrying an `artifact://<id>` pointer, the file that
 * pointer resolves to exists and holds those bytes, and the bulk is gone from
 * the request that follows. The dedup arm additionally pins that exactly the
 * older copy of an identical pair goes and the newest stays live, and that the
 * pointer still resolves after the session is reopened from its transcript,
 * which is when a recovery is actually attempted.
 *
 * NOT asserted. The `read` tool's own resolution of an `artifact://` URI (that
 * is the tool's contract, exercised where the tool is) and the shake elide
 * tier's size-driven region SELECTION, whose savings floor needs a context far
 * larger than a simulation builds; the tail arm reaches the same offload code
 * through a trigger a simulation can build.
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

/**
 * The tail bound's own pointer, at the other owner.
 *
 * A compaction keeps `compaction.keepRecentTokens` of recent history verbatim,
 * and a single heavy tool result inside that tail blows the bound on its own, so
 * the preparation elides it in place and the session offloads the bytes. Same
 * promise, different writer: `renderTailElisionMarker` names the id and
 * `#persistCompactionTailElisions` writes the file.
 */
const HEAVY_WINDOW = 64_000;
/** A stated trigger, so the window ceiling never enters the measurement. */
const HEAVY_THRESHOLD = "12000";
/** One round's tool output on its own is many times the retained-tail budget. */
const HEAVY_OUTPUT = `HEAVY-OUTPUT ${"payload word ".repeat(600)}`;

describe("the compaction tail bound points at the bytes it removed", () => {
	it("elides the heavy result inside the kept tail and stores it under the pointer", async () => {
		let compactions = 0;
		sim = await createSimulation({
			persist: true,
			model: { contextWindow: HEAVY_WINDOW },
			settings: {
				"compaction.enabled": true,
				"compaction.threshold": HEAVY_THRESHOLD,
				"compaction.keepRecentTokens": 1_000,
				"compaction.remote": false,
			},
			tools: [simTool("work", async () => ({ content: [{ type: "text", text: HEAVY_OUTPUT }] }))],
			script: turn => {
				if ((turn.context.tools?.length ?? 0) === 0) {
					compactions += 1;
					turn.text("SUMMARY OF THE EARLIER ROUNDS");
					turn.finish();
					return;
				}
				if (turn.call % 2 === 1) {
					turn.usage({ input: 400, output: 40 });
					turn.toolCall("work", { round: turn.call }, `work-${turn.call}`);
					turn.finish("toolUse");
					return;
				}
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});

		for (let round = 1; round <= 12; round += 1) {
			await sim.session.prompt(`round ${round}`);
			if (compactions > 0) break;
		}
		if (compactions === 0) throw new Error("no compaction after 12 rounds: the fixture never reached it");

		const elided = sim.session.messages
			.filter(message => message.role === "toolResult")
			.flatMap(message => message.content.filter(block => block.type === "text").map(block => block.text))
			.filter(text => text.startsWith("[output elided by compaction:"));
		if (elided.length === 0) throw new Error("compaction elided nothing inside the kept tail");

		const pointer = /recover the full output at artifact:\/\/(\S+?)\]/.exec(elided[0]);
		expect(pointer).not.toBeNull();
		const artifactId = pointer?.[1] ?? "";
		const artifactPath = await sim.sessionManager.getArtifactPath(artifactId);
		expect(artifactPath).toBeTruthy();
		expect(await fs.readFile(artifactPath ?? "", "utf8")).toContain(HEAVY_OUTPUT);

		// The bound is the point: the bulk it removed is not on the wire either.
		const contexts: string[] = [];
		for (const message of sim.session.messages) {
			if (message.role !== "toolResult") continue;
			for (const block of message.content) {
				if (block.type === "text") contexts.push(block.text);
			}
		}
		expect(contexts.filter(text => text.includes(HEAVY_OUTPUT)).length).toBeLessThan(
			contexts.filter(text => text.startsWith("[output elided by compaction:")).length + 1,
		);
	});
});
