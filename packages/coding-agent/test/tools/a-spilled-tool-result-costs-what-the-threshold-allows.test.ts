/**
 * A tool result that passes `tools.artifactSpillThreshold` keeps an inline window no larger than
 * that threshold, and the bytes it drops stay recoverable through the artifact it wrote.
 *
 * WHY THIS SUITE EXISTS. The threshold decided WHEN a result spilled and nothing else. The window
 * kept inline was `tools.artifactHeadBytes + tools.artifactTailBytes`, 20KB + 20KB by default, so a
 * 404KB result delivered 39.8KB at a threshold of 8KB and the same 39.8KB at 200KB: lowering the
 * setting named as the tool-output budget wrote an artifact sooner and cost a request exactly the
 * same. A tool result is sent again on every later request of the session, so that is the setting a
 * user reaches for to cut cost, and it did not cut any.
 *
 * This is the choke point every tool result except `read` passes, so the invariant is asserted here
 * once rather than per tool. `read` is exempt by design (it is bounded by lines the caller asked
 * for, and has its own budget suite).
 *
 * WHAT IT DOES NOT CATCH. Whether a given tool reaches this wrapper at all: a tool that saves its
 * own artifact first (bash, eval, ssh through the output sink) is skipped here by design and priced
 * by `enforceInlineByteCap`. It also does not assert the artifact's contents, only that the id is
 * offered and that the notice names the elision.
 */
import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { wrapToolWithMetaNotice } from "@veyyon/coding-agent/tools/core/output-meta";

const LINE_WIDTH = 200;
const LINE_COUNT = 2_000;
const BODY = `${Array.from(
	{ length: LINE_COUNT },
	(_, index) => `${String(index).padStart(5, "0")} ${"L".repeat(LINE_WIDTH)}`,
).join("\n")}\n`;

function probeTool(text = BODY): AgentTool {
	return {
		name: "probe",
		description: "probe",
		parameters: undefined,
		execute: async (): Promise<AgentToolResult> => ({ content: [{ type: "text", text }], details: {} }),
	} as unknown as AgentTool;
}

interface Spilled {
	readonly text: string;
	readonly bytes: number;
	readonly artifacts: readonly string[];
}

async function spill(thresholdKb: number, overrides: Record<string, number> = {}, body = BODY): Promise<Spilled> {
	const artifacts: string[] = [];
	const settings = Settings.isolated({ "tools.artifactSpillThreshold": thresholdKb, ...overrides });
	const context = {
		settings,
		sessionManager: {
			saveArtifact: async (): Promise<string> => {
				const id = `artifact-${artifacts.length + 1}`;
				artifacts.push(id);
				return id;
			},
		},
	} as unknown as AgentToolContext;
	const result = await wrapToolWithMetaNotice(probeTool(body)).execute(
		"probe",
		{} as never,
		undefined,
		undefined,
		context,
	);
	const text = result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && "text" in block)
		.map(block => block.text)
		.join("\n");
	return { text, bytes: Buffer.byteLength(text, "utf-8"), artifacts };
}

describe("a spilled tool result costs what the threshold allows", () => {
	it("holds the inline window to the threshold at every setting of it", async () => {
		for (const thresholdKb of [4, 8, 20]) {
			const { bytes } = await spill(thresholdKb);
			// One line of slack: the elision marker and the notice are added after the window.
			expect(bytes).toBeLessThan(thresholdKb * 1024 + LINE_WIDTH * 3);
			expect(bytes).toBeGreaterThan(thresholdKb * 512);
		}
	});

	it("costs less when the threshold is lowered rather than only writing an artifact sooner", async () => {
		const low = await spill(4);
		const high = await spill(20);
		expect(high.bytes).toBeGreaterThan(low.bytes * 2);
	});

	it("never grows the window past the head and tail settings when the threshold is raised", async () => {
		const wide = await spill(400, { "tools.artifactHeadBytes": 4, "tools.artifactTailBytes": 4 });
		expect(wide.bytes).toBeLessThan(8 * 1024 + LINE_WIDTH * 3);
	});
	it("holds a tail-only window to the threshold when no head is configured", async () => {
		// `tools.artifactHeadBytes: 0` is the documented tail-only mode, a separate branch from
		// middle elision, and the branch a clamp applied to only one of the two would leave open.
		const { text, bytes } = await spill(4, { "tools.artifactHeadBytes": 0, "tools.artifactTailBytes": 40 });
		expect(bytes).toBeLessThan(4 * 1024 + LINE_WIDTH * 3);
		expect(text).toContain(`0${LINE_COUNT - 1} `);
		expect(text).not.toContain("00000 ");
	});

	it("keeps the dropped bytes recoverable and says they were dropped", async () => {
		const { text, artifacts } = await spill(8);
		expect(artifacts).toEqual(["artifact-1"]);
		expect(text).toContain(artifacts[0]);
		expect(text).toContain("00000 ");
		expect(text).toContain(`0${LINE_COUNT - 1} `);
	});

	it("leaves a result inside the threshold whole, unannotated, and writes no artifact", async () => {
		const { text, artifacts } = await spill(8, {}, "one\ntwo\nthree\n");
		expect(text).toBe("one\ntwo\nthree\n");
		expect(artifacts).toEqual([]);
	});

	it("keeps the head and tail in the ratio the settings name, inside the threshold", async () => {
		const { text } = await spill(8, { "tools.artifactHeadBytes": 30, "tools.artifactTailBytes": 10 });
		const [head, tail] = text.split(/^\[…\d+ln elided…\]$/m);
		expect(head).toBeDefined();
		expect(tail).toBeDefined();
		expect(Buffer.byteLength(head ?? "", "utf-8")).toBeGreaterThan(Buffer.byteLength(tail ?? "", "utf-8"));
	});
});
