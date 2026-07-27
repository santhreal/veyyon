/**
 * The status-event list's update contract, and where it is allowed to live.
 *
 * Why this suite exists: `upsertStatusEvent` decides whether a reported event REPLACES an earlier one or is
 * appended beside it, and the answer differs by op. Agent events supersede, because one subagent reports
 * pending, then running, then completed under a single `id` and the reader wants its current state; appending
 * each would make one subagent look like three, and the count is what the status line shows. Everything else is
 * a distinct thing that happened. Nothing tested that directly: the behaviour was only observable through the
 * rendered progress block, so a change to the replacement rule would have shown up as a wrong count in a
 * screenful of text rather than as a failing assertion.
 *
 * It also pins where the function lives. It used to sit in `tools/eval-render.ts`, so `tools/eval.ts` imported
 * the module that DRAWS status events in order to append to an array, and paid 105 modules for it: `Markdown`
 * and `Text` from `@veyyon/tui`, the theme engine, the markdown theme, the settings store and the framed-block
 * helpers, all instantiated by a tool that starts a Python kernel. That single edge put the eval tool at 801
 * modules and left eleven `tools/eval-*` test files sitting at 802 and 803, just over the 800-module line the
 * architecture gate draws.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { upsertStatusEvent } from "@veyyon/coding-agent/eval/status-events";
import type { EvalStatusEvent } from "@veyyon/coding-agent/eval/types";

const SRC = path.resolve(import.meta.dir, "../../src");

/** An agent event as the backend reports one: an op, an id, and whatever else that status carries. */
function agentEvent(id: string, status: string, extra: Record<string, unknown> = {}): EvalStatusEvent {
	return { op: "agent", id, status, ...extra };
}

describe("recording an eval status event", () => {
	/** The empty case: the first event is simply the list. */
	it("appends the first event", () => {
		const events: EvalStatusEvent[] = [];
		upsertStatusEvent(events, { op: "tool", name: "read" });
		expect(events).toEqual([{ op: "tool", name: "read" }]);
	});

	/**
	 * A non-agent op is a distinct occurrence, so two tool calls are two entries even when they are identical.
	 * Collapsing them would under-report work the model actually did.
	 */
	it("appends every non-agent event, including a repeat", () => {
		const events: EvalStatusEvent[] = [];
		upsertStatusEvent(events, { op: "tool", name: "read" });
		upsertStatusEvent(events, { op: "tool", name: "read" });
		upsertStatusEvent(events, { op: "fetch", url: "https://example.com" });
		expect(events).toEqual([
			{ op: "tool", name: "read" },
			{ op: "tool", name: "read" },
			{ op: "fetch", url: "https://example.com" },
		]);
	});

	/**
	 * THE CONTRACT. One subagent progressing through three states stays one entry, holding the LATEST state.
	 * Three entries would report three subagents.
	 */
	it("supersedes an agent event of the same id", () => {
		const events: EvalStatusEvent[] = [];
		upsertStatusEvent(events, agentEvent("a1", "pending"));
		upsertStatusEvent(events, agentEvent("a1", "running"));
		upsertStatusEvent(events, agentEvent("a1", "completed", { tokens: 1_204 }));
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({ op: "agent", id: "a1", status: "completed", tokens: 1_204 });
	});

	/**
	 * Replacement is WHOLESALE, not a merge. The event the backend sent is the current state of that subagent, so
	 * a field absent from the newer event is absent from the list. A merge would leave a stale token count beside
	 * a finished status and there would be no way to tell it was stale.
	 */
	it("replaces rather than merges the superseded event", () => {
		const events: EvalStatusEvent[] = [];
		upsertStatusEvent(events, agentEvent("a1", "running", { tokens: 40, tool: "read" }));
		upsertStatusEvent(events, agentEvent("a1", "completed"));
		expect(events[0]).toEqual({ op: "agent", id: "a1", status: "completed" });
		expect(events[0]).not.toHaveProperty("tokens");
		expect(events[0]).not.toHaveProperty("tool");
	});

	/** Different subagents are different entries, in the order they first appeared. */
	it("keeps one entry per agent id", () => {
		const events: EvalStatusEvent[] = [];
		for (const id of ["a1", "a2", "a3"]) upsertStatusEvent(events, agentEvent(id, "pending"));
		for (const id of ["a3", "a1"]) upsertStatusEvent(events, agentEvent(id, "completed"));
		expect(events.map(event => event.id)).toEqual(["a1", "a2", "a3"]);
		expect(events.map(event => event.status)).toEqual(["completed", "pending", "completed"]);
	});

	/**
	 * Superseding updates IN PLACE and does not move the entry to the end. The rendered progress block is read
	 * top to bottom, so a subagent that jumped down the list every time it reported would make the block
	 * reshuffle under the reader's eyes while nothing had actually started or finished.
	 */
	it("does not reorder the list when superseding", () => {
		const events: EvalStatusEvent[] = [];
		upsertStatusEvent(events, agentEvent("first", "pending"));
		upsertStatusEvent(events, { op: "tool", name: "read" });
		upsertStatusEvent(events, agentEvent("second", "pending"));
		upsertStatusEvent(events, agentEvent("first", "completed"));
		expect(events.map(event => `${event.op}:${event.id ?? event.name}`)).toEqual([
			"agent:first",
			"tool:read",
			"agent:second",
		]);
		expect(events[0]?.status).toBe("completed");
	});

	/**
	 * An agent event with NO id cannot be matched against, so it is appended. Two of them are two entries: an
	 * un-identified event is the one case where the function cannot tell whether it is the same subagent, and
	 * guessing that it is would collapse two real subagents into one.
	 */
	it("appends an agent event that carries no id", () => {
		const events: EvalStatusEvent[] = [];
		upsertStatusEvent(events, { op: "agent", status: "pending" });
		upsertStatusEvent(events, { op: "agent", status: "pending" });
		expect(events).toHaveLength(2);
	});

	/**
	 * A non-string id is treated the same way, since the match is by string equality. Worth pinning because the
	 * event type is `{ op: string; [key: string]: unknown }`, so a backend sending a numeric id type-checks.
	 */
	it("appends an agent event whose id is not a string", () => {
		const events: EvalStatusEvent[] = [];
		upsertStatusEvent(events, { op: "agent", id: 7, status: "pending" });
		upsertStatusEvent(events, { op: "agent", id: 7, status: "running" });
		expect(events).toHaveLength(2);
	});

	/**
	 * An id shared with a DIFFERENT op is not a match. Ops are separate namespaces, and a tool call that happened
	 * to carry the same id as a subagent must not be overwritten by it.
	 */
	it("does not supersede across ops", () => {
		const events: EvalStatusEvent[] = [];
		upsertStatusEvent(events, { op: "tool", id: "a1", name: "read" });
		upsertStatusEvent(events, agentEvent("a1", "running"));
		expect(events).toHaveLength(2);
		expect(events[0]).toEqual({ op: "tool", id: "a1", name: "read" });
	});

	/** The empty-string id is a string, so it matches itself: one entry, latest state. */
	it("treats an empty-string id as an id", () => {
		const events: EvalStatusEvent[] = [];
		upsertStatusEvent(events, agentEvent("", "pending"));
		upsertStatusEvent(events, agentEvent("", "running"));
		expect(events).toHaveLength(1);
		expect(events[0]?.status).toBe("running");
	});

	/** The list is mutated in place and nothing is returned, which is what every call site relies on. */
	it("mutates the caller's array in place", () => {
		const events: EvalStatusEvent[] = [];
		const same = events;
		expect(upsertStatusEvent(events, { op: "tool" })).toBeUndefined();
		expect(same).toHaveLength(1);
	});

	/** A long run stays proportional to the number of distinct subagents rather than to the number of reports. */
	it("holds one entry per subagent across many reports", () => {
		const events: EvalStatusEvent[] = [];
		for (let round = 0; round < 200; round++) {
			for (const id of ["a1", "a2", "a3"]) upsertStatusEvent(events, agentEvent(id, `round-${round}`));
		}
		expect(events).toHaveLength(3);
		expect(events.map(event => event.status)).toEqual(["round-199", "round-199", "round-199"]);
	});
});

describe("the status-event helper stays out of the renderer", () => {
	/**
	 * The whole point of the move. The producer imports it from the leaf, not from the module that draws events,
	 * and the leaf imports nothing but the event type.
	 */
	it("is imported by the eval tool from the leaf", async () => {
		const tool = await Bun.file(path.join(SRC, "tools/eval.ts")).text();
		expect(tool).toContain('import { upsertStatusEvent } from "../eval/status-events";');
		// And the tool has no edge to the renderer left at all. Moving the helper alone bought nothing, because
		// `eval.ts` also re-exported the renderer, and `export ... from` instantiates a module just like an
		// import does. Both edges had to go for the Python runner to stop carrying `Markdown` and the theme
		// engine: 801 modules to 638.
		expect(tool).not.toContain("eval-render");
	});

	/** The leaf's only import is the type it operates on, so appending to a list costs one module. */
	it("imports only the event type", async () => {
		const leaf = await Bun.file(path.join(SRC, "eval/status-events.ts")).text();
		const imports = [...leaf.matchAll(/^import .*?from "(.+?)";$/gm)].map(match => match[1]);
		expect(imports).toEqual(["./types"]);
		expect(leaf).toContain("import type");
	});

	/**
	 * And the renderer no longer declares it, so there is one definition rather than a copy left behind on each
	 * side of the split. Keyed on the declaration, so the doc above may still explain the history.
	 */
	it("is declared in exactly one module", async () => {
		const offenders: string[] = [];
		for (const file of new Bun.Glob("**/*.ts").scanSync(SRC)) {
			if (file === "eval/status-events.ts") continue;
			const text = await Bun.file(path.join(SRC, file)).text();
			if (/^\s*(?:export )?function upsertStatusEvent\b/m.test(text)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});
});
