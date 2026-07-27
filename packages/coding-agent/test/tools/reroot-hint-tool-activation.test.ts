/**
 * A hint that tells the model to call a tool must leave that tool callable.
 *
 * WHY THIS SUITE EXISTS. `set_cwd` is declared `loadMode: "discoverable"`, so under
 * `tools.discoveryMode: all` the SDK deliberately drops it from the initial toolset
 * (`filterInitialToolsForDiscoveryAll`) and the model is expected to find it through
 * `search_tool_bm25`. Meanwhile two separate places told the model, flatly, to "call
 * set_cwd": the `<working-directory>` block of the project prompt, and the re-root
 * hint appended to tool results. Neither checked whether the tool was there.
 *
 * The result was the failure that reads as "re-rooting just does not work, and not
 * as a false positive either -- it does nothing". The advice was correct, the
 * threshold logic was correct, the model followed the instruction, and the call
 * referenced a tool absent from the request. It appeared to work only in the
 * sessions where something else had already activated the tool, which is exactly the
 * pattern of a feature that works sometimes for no reason the operator can see.
 *
 * So the hint now ACTIVATES the tool on the call that earned it, and when it cannot,
 * it says so instead of naming an uncallable tool. This suite pins both halves and
 * the three ways activation can be unavailable, because the quiet version of this
 * bug -- printing the confident sentence anyway -- is the one that cost the time.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentTool } from "@veyyon/agent-core";
import {
	ensureSetCwdCallable,
	formatRerootHint,
	RerootDetector,
	SET_CWD_TOOL_NAME,
	wrapToolWithRerootHint,
} from "@veyyon/coding-agent/tools/reroot-hint";

const CWD = path.join(path.sep, "home", "dev", "launch");
const OTHER = path.join(path.sep, "srv", "work", "project");

/** A minimal filesystem-backed tool: declares its target, always succeeds. */
function fakeTool(): AgentTool<never, unknown> {
	return {
		name: "fake_read",
		label: "Fake",
		description: "",
		parameters: undefined as never,
		filesystemTargets: (args: unknown) => [(args as { path: string }).path],
		execute: async () => ({ content: [{ type: "text" as const, text: "file body" }] }),
	} as unknown as AgentTool<never, unknown>;
}

/**
 * A session that tracks an active toolset and can grow it, the way `AgentSession`
 * does. `activated` records what was asked for, so a test can prove activation
 * happened rather than only that the wording came out right.
 */
function discoverySession(options: { active?: string[]; activatable?: boolean } = {}) {
	const active = new Set(options.active ?? ["fake_read"]);
	const activated: string[][] = [];
	return {
		cwd: CWD,
		activated,
		active,
		isToolActive: (name: string) => active.has(name),
		activateDiscoveredTools: async (names: string[]) => {
			activated.push(names);
			if (options.activatable === false) return [];
			for (const name of names) active.add(name);
			return names;
		},
	};
}

/** The hint text out of a wrapped tool result, or undefined when none was appended. */
function hintFrom(result: { content: unknown[] }): string | undefined {
	const texts = result.content.map(block => (block as { text?: string }).text ?? "");
	return texts.length > 1 ? texts[texts.length - 1] : undefined;
}

/** Touch three distinct files under `OTHER`, which is the documented trigger. */
async function crossThreshold(tool: AgentTool<never, unknown>) {
	await tool.execute("1", { path: path.join(OTHER, "a.ts") } as never);
	await tool.execute("2", { path: path.join(OTHER, "b.ts") } as never);
	return await tool.execute("3", { path: path.join(OTHER, "c.ts") } as never);
}

describe("making set_cwd callable before recommending it", () => {
	/**
	 * THE REGRESSION. The tool is absent (discovery-all), the threshold fires, and by
	 * the time the model reads the hint the tool is in its toolset. Without this the
	 * hint was an instruction to call something that did not exist.
	 */
	it("activates set_cwd when the session does not have it yet", async () => {
		const session = discoverySession({ active: ["fake_read"] });
		const tool = wrapToolWithRerootHint(fakeTool(), new RerootDetector(), session);

		const third = await crossThreshold(tool);

		expect(session.activated).toEqual([[SET_CWD_TOOL_NAME]]);
		expect(session.active.has(SET_CWD_TOOL_NAME)).toBe(true);
		expect(hintFrom(third)).toContain(`call ${SET_CWD_TOOL_NAME} with ${OTHER}`);
	});

	/**
	 * Activation is not free -- it rebuilds the toolset and the system prompt -- so it
	 * must not happen on the ordinary out-of-cwd read that does not reach the
	 * threshold. A session that glances at one file next door ends with the same
	 * toolset it started with.
	 */
	it("does not activate anything before the threshold is reached", async () => {
		const session = discoverySession();
		const tool = wrapToolWithRerootHint(fakeTool(), new RerootDetector(), session);

		await tool.execute("1", { path: path.join(OTHER, "a.ts") } as never);
		await tool.execute("2", { path: path.join(OTHER, "b.ts") } as never);

		expect(session.activated).toEqual([]);
		expect(session.active.has(SET_CWD_TOOL_NAME)).toBe(false);
	});

	/** A session that already has the tool must not pay to activate it again. */
	it("leaves an already-active toolset alone", async () => {
		const session = discoverySession({ active: ["fake_read", SET_CWD_TOOL_NAME] });
		const tool = wrapToolWithRerootHint(fakeTool(), new RerootDetector(), session);

		const third = await crossThreshold(tool);

		expect(session.activated).toEqual([]);
		expect(hintFrom(third)).toContain(`call ${SET_CWD_TOOL_NAME}`);
	});
});

describe("when set_cwd cannot be made callable", () => {
	/**
	 * The honest failure. Activation was attempted and the session refused, so the
	 * hint must NOT say "call set_cwd": it says the tool is missing and names the way
	 * to get it. Silently printing the confident sentence is the original bug wearing
	 * a working mechanism.
	 */
	it("says the tool is missing instead of telling the model to call it", async () => {
		const session = discoverySession({ activatable: false });
		const tool = wrapToolWithRerootHint(fakeTool(), new RerootDetector(), session);

		const text = hintFrom(await crossThreshold(tool));

		expect(session.activated).toEqual([[SET_CWD_TOOL_NAME]]);
		expect(text).toContain(`The ${SET_CWD_TOOL_NAME} tool is NOT in your active toolset`);
		expect(text).toContain("search_tool_bm25");
		expect(text).not.toContain(`call ${SET_CWD_TOOL_NAME} with`);
	});

	/** The observation and the payoff survive: the model still learns where the work is. */
	it("still names the directory and what re-rooting buys", async () => {
		const session = discoverySession({ activatable: false });
		const tool = wrapToolWithRerootHint(fakeTool(), new RerootDetector(), session);

		const text = hintFrom(await crossThreshold(tool));

		expect(text).toContain(OTHER);
		expect(text).toContain(CWD);
		expect(text).toContain("AGENTS.md");
		expect(text).toContain("If you are only passing through, ignore this.");
	});

	/**
	 * A session that tracks activation but cannot perform it (no
	 * `activateDiscoveredTools`) is the SDK's pre-session window. It reports the
	 * missing tool rather than assuming either answer.
	 */
	it("reports the tool as missing when the session cannot activate at all", async () => {
		const callable = await ensureSetCwdCallable({ cwd: CWD, isToolActive: () => false });

		expect(callable).toBe(false);
	});

	/**
	 * A throwing activation must not fail a tool call that already succeeded, and must
	 * not be swallowed either: the reason lands in the hint, next to the corrected
	 * wording.
	 */
	it("reports a failed activation in the hint and keeps the tool result intact", async () => {
		const session = {
			cwd: CWD,
			isToolActive: () => false,
			activateDiscoveredTools: async () => {
				throw new Error("toolset rebuild refused");
			},
		};
		const tool = wrapToolWithRerootHint(fakeTool(), new RerootDetector(), session);

		const third = await crossThreshold(tool);

		expect((third.content[0] as { text: string }).text).toBe("file body");
		const text = hintFrom(third);
		expect(text).toContain("toolset rebuild refused");
		expect(text).toContain(`The ${SET_CWD_TOOL_NAME} tool is NOT in your active toolset`);
	});
});

describe("sessions with no activation tracking", () => {
	/**
	 * A plain tool session has neither member, which means its toolset is fixed and
	 * nothing here can or should change it. Treating that as "missing" would make
	 * every hint in every such session carry a false warning.
	 */
	it("assumes the tool is callable", async () => {
		expect(await ensureSetCwdCallable({ cwd: CWD })).toBe(true);
	});

	it("emits the ordinary hint wording", async () => {
		const tool = wrapToolWithRerootHint(fakeTool(), new RerootDetector(), { cwd: CWD });

		const text = hintFrom(await crossThreshold(tool));

		expect(text).toContain(`call ${SET_CWD_TOOL_NAME} with ${OTHER}`);
		expect(text).not.toContain("NOT in your active toolset");
	});
});

describe("the hint sentence", () => {
	/**
	 * One formatter owns both spellings, so the observation, the payoff and the
	 * permission to ignore cannot drift apart between them. Only the middle clause
	 * differs.
	 */
	it("differs from the callable form in exactly the instruction it gives", () => {
		const callable = formatRerootHint(OTHER, 4, CWD);
		const missing = formatRerootHint(OTHER, 4, CWD, { callable: false });

		const opening = `You keep working under ${OTHER} (4 files or commands now), which is outside the session working directory (${CWD}). `;
		expect(callable.startsWith(opening)).toBe(true);
		expect(missing.startsWith(opening)).toBe(true);
		expect(callable.endsWith("If you are only passing through, ignore this.")).toBe(true);
		expect(missing.endsWith("If you are only passing through, ignore this.")).toBe(true);
		expect(callable).not.toBe(missing);
	});

	/** `callable: true` and the default are the same sentence, so callers may omit it. */
	it("treats an omitted callable flag as callable", () => {
		expect(formatRerootHint(OTHER, 3, CWD, { callable: true })).toBe(formatRerootHint(OTHER, 3, CWD));
	});

	/**
	 * The name the hint prints and the name the harness activates are one constant.
	 * Two literals here is how a rename ships a hint pointing at a tool that no
	 * longer answers.
	 */
	it("prints the same tool name the activation path uses", () => {
		expect(SET_CWD_TOOL_NAME).toBe("set_cwd");
		expect(formatRerootHint(OTHER, 3, CWD)).toContain(SET_CWD_TOOL_NAME);
		expect(formatRerootHint(OTHER, 3, CWD, { callable: false })).toContain(SET_CWD_TOOL_NAME);
	});
});
