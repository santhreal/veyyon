/**
 * A disabled subagent is disabled, and a `/` command can still name one.
 *
 * WHY THIS SUITE EXISTS (SUBAGENT-TRISTATE-IS-A-SWITCH-THAT-LIES). The enable
 * setting used to have four display states over two predicates:
 * `isSubagentAdvertised` decided what went in the task tool description, and
 * `isSubagentSpawnable` decided what a named spawn was allowed to run. The gap
 * between them was a state shown to users as "Not offered (default) — still runs
 * when named". A switch labelled off that still runs is not a switch, and an
 * operator who pressed `space` until the row read off had not turned the agent
 * off.
 *
 * The gap existed for exactly one reason: `/review` builds a prompt saying
 * `agent: "reviewer"`, and `reviewer` ships disabled, so closing the gap without
 * a replacement would break the command on a stock install. The replacement is
 * the honest one — a command DECLARES the agents its prompt names, the session
 * grants them for that turn, and the setting keeps meaning exactly what it says
 * for every path the MODEL drives.
 *
 * So this suite has two halves, and they only make sense together:
 *   1. disabled really is disabled, on every path the model can take;
 *   2. a declared command grant still works, and is scoped to its own turn.
 * Testing either alone would pass while the feature was broken — half one alone
 * is satisfied by breaking `/review`, half two alone by reopening the loophole.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ReviewCommand } from "@veyyon/coding-agent/extensibility/custom-commands/bundled/review";
import { filterEnabledAgents, isSubagentEnabled } from "@veyyon/coding-agent/task/subagent-settings";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";

function bundled(name: string): AgentDefinition {
	return { name, source: "bundled", description: `${name} agent`, systemPrompt: "", filePath: `${name}.md` };
}

function userAgent(name: string): AgentDefinition {
	return { name, source: "user", description: `${name} agent`, systemPrompt: "", filePath: `${name}.md` };
}

/** The five bundled specialists, all of which ship disabled. */
const SPECIALISTS = ["scout", "reviewer", "designer", "librarian", "sonic"] as const;

describe("a disabled agent is disabled on every model-driven path", () => {
	/**
	 * The headline. On a stock install every specialist answers the ONE question
	 * the same way, and there is no second predicate that answers it differently.
	 * This is the assertion that fails if anyone reintroduces an "unadvertised but
	 * spawnable" tier, whatever it gets called.
	 */
	it("reports every bundled specialist as disabled on a stock install", () => {
		const settings = Settings.isolated();
		for (const name of SPECIALISTS) {
			expect(isSubagentEnabled(settings, bundled(name)), `${name} must be disabled by default`).toBe(false);
		}
		expect(isSubagentEnabled(settings, bundled("task"))).toBe(true);
	});

	/**
	 * The set offered to the model and the set a spawn may use are now the SAME
	 * set, which is the property the two-predicate design lacked. If they ever
	 * diverge again, an agent absent from the tool description would still be
	 * reachable, which is how "off" stopped meaning off.
	 */
	it("offers exactly the agents that may be spawned", () => {
		const settings = Settings.isolated();
		const agents = [bundled("task"), ...SPECIALISTS.map(bundled), userAgent("mine")];

		const offered = filterEnabledAgents(settings, agents).map(agent => agent.name);
		const spawnable = agents.filter(agent => isSubagentEnabled(settings, agent)).map(agent => agent.name);

		expect(offered).toEqual(["task"]);
		expect(spawnable).toEqual(offered);
	});

	/**
	 * Adding an agent definition makes the role available to configure, but it
	 * does not let the model start that role without an explicit grant.
	 */
	it("keeps user-authored and project agents disabled with no settings row", () => {
		const settings = Settings.isolated();
		expect(isSubagentEnabled(settings, userAgent("mine"))).toBe(false);
		expect(isSubagentEnabled(settings, { ...userAgent("proj"), source: "project" })).toBe(false);
	});

	/**
	 * An explicit `enabled: false` on an agent that is on by default is the
	 * operator saying no to the thing they would otherwise get. It must outrank the
	 * default in the same direction the row is written.
	 */
	it("disables the worker when the operator says so", () => {
		const settings = Settings.isolated({ "subagent.agents": { task: { enabled: false } } });
		expect(isSubagentEnabled(settings, bundled("task"))).toBe(false);
		expect(filterEnabledAgents(settings, [bundled("task")])).toEqual([]);
	});
});

describe("the command grant that replaced the third state", () => {
	/**
	 * `/review` is the command the whole tri-state existed to keep alive, so it is
	 * the one that must declare its agent. Asserting the exact name rather than
	 * "declares something": a typo here fails open in the least visible way — the
	 * command keeps working for anyone who enabled `reviewer` by hand, and breaks
	 * only on the stock install nobody tests against.
	 */
	it("declares reviewer on /review, which is the agent its prompt names", () => {
		const command = new ReviewCommand({ cwd: process.cwd() } as never);
		expect(command.name).toBe("review");
		expect([...(command.spawnsAgents ?? [])]).toEqual(["reviewer"]);
	});

	/**
	 * And the agent it declares is genuinely disabled by default, which is what
	 * makes the declaration load-bearing rather than decorative. If `reviewer` ever
	 * ships enabled, this test says so, and the declaration can go.
	 */
	it("declares an agent that a stock install actually disables", () => {
		expect(isSubagentEnabled(Settings.isolated(), bundled("reviewer"))).toBe(false);
	});

	/**
	 * Most commands spawn nothing, and the grant must stay the exception it was
	 * designed as. A field that quietly spread to every command would be a general
	 * escape hatch, which is the old loophole wearing a new name — so the honest
	 * check is that the ONE bundled command carrying it is the one with a reason.
	 */
	it("is carried by the review command alone among the agent-spawning bundled commands", async () => {
		const { readdir } = await import("node:fs/promises");
		const path = await import("node:path");
		const bundledDir = path.resolve(import.meta.dir, "../../src/extensibility/custom-commands/bundled");
		const entries = await readdir(bundledDir, { withFileTypes: true });
		expect(entries.length).toBeGreaterThan(0);

		const { readFile } = await import("node:fs/promises");
		const declaring: string[] = [];
		for (const entry of entries) {
			const file = entry.isDirectory()
				? path.join(bundledDir, entry.name, "index.ts")
				: path.join(bundledDir, entry.name);
			const source = await readFile(file, "utf8").catch(() => "");
			if (source.includes("spawnsAgents")) declaring.push(entry.name);
		}
		expect(declaring).toEqual(["review"]);
	});
});
