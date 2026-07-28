/**
 * An agent's role comes from the tools it grants, and the bundled roster must classify correctly.
 *
 * WHY THIS SUITE EXISTS. The delegation prose told the model to delegate audit work no matter which
 * agents were enabled: `delegation-subagent-value.md` shipped "Use `task` to map unknown code instead
 * of reading file after file yourself", the bulk-reading rationale, and "multi-subsystem
 * investigation" with no gate. On a stock install the only enabled bundled agent is `task`, described
 * as "General-purpose subagent with full capabilities for delegated multi-step tasks", so the prompt
 * routed exploration and review into a WORKER. A task is real work: running code, reads and writes,
 * changes. An audit is a different kind of work, and with nothing typed for it the honest instruction
 * is to do it inline.
 *
 * The fix needed a role, and the role is DERIVED rather than listed, which is what these tests pin:
 *
 *   1. The bundled roster classifies correctly, asserted agent by agent against the REAL definitions
 *      rather than against fixtures. A fixture would let the bundled `tools:` lines change under the
 *      classifier without any test noticing, and those lines are the whole input.
 *   2. `tools: undefined` is EXECUTING, because it grants everything. Reading it as "grants nothing"
 *      would classify `task`, `sonic` and `designer` as investigative and switch audit delegation on
 *      for exactly the roster that must not have it.
 *   3. A user-authored read-only agent is investigative with no `role:` field to write, which is the
 *      point of deriving: a name-based roster is a door such an agent could never walk through.
 *   4. `bash` does NOT make an agent executing. It is the entry that decides whether the predicate
 *      matches reality: `reviewer` and `librarian` both grant `bash` to RUN things while reading, and
 *      a "can it possibly mutate" reading would classify both as executors, which is the opposite of
 *      what they are.
 */
import { describe, expect, it } from "bun:test";
import { agentRole, investigativeAgentNames, isInvestigativeAgent } from "@veyyon/coding-agent/task/agent-role";
import { loadBundledAgents } from "@veyyon/coding-agent/task/agents";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";

/** A definition with only the fields the role question reads, so a test states its input exactly. */
function agent(name: string, tools?: string[]): AgentDefinition {
	return { name, description: `${name} agent`, systemPrompt: "", tools, source: "bundled" };
}

/** The bundled agent by name, so the assertions read against what actually ships. */
function bundled(name: string): AgentDefinition {
	const found = loadBundledAgents().find(a => a.name === name);
	if (!found) throw new Error(`No bundled agent named ${name}. The roster changed; update this suite.`);
	return found;
}

describe("the bundled roster", () => {
	/**
	 * `scout` is investigative: `read, grep, glob, web_search` and nothing that writes.
	 *
	 * Asserted against the shipped definition rather than a fixture, so adding `edit` to scout's
	 * frontmatter fails here instead of silently switching audit delegation on for a session that has
	 * only scout enabled.
	 */
	it("classifies scout as investigative", () => {
		expect(agentRole(bundled("scout"))).toBe("investigative");
	});

	/**
	 * `reviewer` is investigative DESPITE granting `bash`.
	 *
	 * The case that decides whether the predicate is useful. `reviewer` grants
	 * `read, grep, glob, bash, lsp, web_search, ast_grep`: `bash` is there to run an lsp query or a
	 * test while reading, not to edit. Classifying it as an executor because `bash` can technically
	 * write would make the code-review specialist the one agent audits could not be delegated to.
	 */
	it("classifies reviewer as investigative even though it grants bash", () => {
		const reviewer = bundled("reviewer");

		expect(reviewer.tools).toContain("bash");
		expect(agentRole(reviewer)).toBe("investigative");
	});

	/** `librarian` is investigative for the same reason: the same tool set, reading external source. */
	it("classifies librarian as investigative", () => {
		expect(agentRole(bundled("librarian"))).toBe("investigative");
	});

	/**
	 * `task` is executing, which is the whole reason this axis exists.
	 *
	 * It restricts nothing, so it holds `edit` and `write`. This is the agent the prompt used to point
	 * audits at, and the assertion that would have caught it.
	 */
	it("classifies task as executing", () => {
		const task = bundled("task");

		expect(task.tools).toBeUndefined();
		expect(agentRole(task)).toBe("executing");
	});

	/**
	 * `sonic` is executing too, and this is the pair that had to stop being conflated.
	 *
	 * `hasSubagentSpecialists` was `some(name => name !== "task")`, so enabling `sonic` made the prompt
	 * claim a kind-of-work specialist existed. `sonic` is "Low-reasoning agent for strictly mechanical
	 * updates or data collection only": another executor, and no reason to hand off an audit.
	 */
	it("classifies sonic as executing", () => {
		expect(agentRole(bundled("sonic"))).toBe("executing");
	});

	/** `designer` is executing: it restricts nothing and its own prompt says it edits files. */
	it("classifies designer as executing", () => {
		expect(agentRole(bundled("designer"))).toBe("executing");
	});

	/**
	 * The whole roster, as one list, so a NEW bundled agent cannot slip in unclassified.
	 *
	 * The per-agent tests above would all still pass if a seventh agent were added, and if it granted
	 * no editing tool it would switch audit delegation on for every session that enables it. This
	 * fails on any roster change, which is the intent: the change is fine, going unnoticed is not.
	 */
	it("splits the roster exactly two ways", () => {
		const all = loadBundledAgents();

		expect(investigativeAgentNames(all).sort()).toEqual(["librarian", "reviewer", "scout"]);
		expect(
			all
				.filter(a => !isInvestigativeAgent(a))
				.map(a => a.name)
				.sort(),
		).toEqual(["designer", "sonic", "task"]);
	});
});

describe("the derivation itself", () => {
	/**
	 * NO `tools:` MEANS EVERYTHING, so it is executing.
	 *
	 * The inversion that would break the fix while looking like it worked: reading an absent grant as
	 * "grants nothing" makes `task` investigative, and audit delegation switches on for the stock
	 * install this was written to fix.
	 */
	it("treats an unrestricted agent as executing", () => {
		expect(agentRole(agent("unrestricted", undefined))).toBe("executing");
	});

	/** An explicitly EMPTY grant is investigative: it holds no tool, so it cannot write. */
	it("treats an empty tool list as investigative", () => {
		expect(agentRole(agent("toothless", []))).toBe("investigative");
	});

	/**
	 * A user-authored read-only agent is investigative with nothing to declare.
	 *
	 * The reason the role is derived instead of listed. A roster of bundled names is a door this agent
	 * could never walk through, however plainly its `tools:` line says what it is, and the operator who
	 * wrote it would have to keep doing audits inline forever.
	 */
	it("classifies a user-authored read-only agent as investigative", () => {
		const auditor: AgentDefinition = {
			name: "auditor",
			description: "reads and reports",
			systemPrompt: "",
			tools: ["read", "grep", "glob"],
			source: "project",
		};

		expect(agentRole(auditor)).toBe("investigative");
	});

	/** One editing tool is enough, asserted per tool so the list cannot lose an entry unnoticed. */
	it.each([["edit"], ["write"], ["ast_edit"], ["memory_edit"], ["manage_skill"]])(
		"treats a grant of %s as executing",
		tool => {
			expect(agentRole(agent("writer", ["read", tool]))).toBe("executing");
		},
	);

	/**
	 * `bash` alone is NOT enough, which is the deliberate hole in the predicate.
	 *
	 * Stated as its own test because it looks like an omission until you know why: this answers what an
	 * agent is SET UP for, as declared by its file-editing grant, and it is not a security boundary. An
	 * investigative agent with `bash` can obviously write a file if it decides to; the sandbox is what
	 * stops it, not this.
	 */
	it("does not treat bash, lsp or ast_grep as editing tools", () => {
		expect(agentRole(agent("runner", ["read", "bash", "lsp", "ast_grep"]))).toBe("investigative");
	});

	/**
	 * A legacy tool alias still classifies, because the grant is normalized first.
	 *
	 * `tools:` is author-written text and the aliases are real (`search` for `grep`), so a grant naming
	 * an alias of an editing tool must not read as investigative through a spelling.
	 */
	it("classifies through a legacy tool alias", () => {
		expect(agentRole(agent("aliased", ["search", "glob"]))).toBe("investigative");
	});

	/**
	 * AN MCP TOOL MAKES THE AGENT EXECUTING, BECAUSE NOTHING HERE CAN TELL WHAT IT DOES.
	 *
	 * `mcp__github__create_pull_request` and `mcp__github__list_issues` are the same shape from this
	 * side: the capability lives in another process, and MCP servers routinely expose file writes,
	 * commits and deploys. The predicate used to ask only "does the grant contain one of the five known
	 * editing tools", so any grant of unrecognised names answered "investigative" and the prompt then
	 * told the model to hand exploration and review to it. "Investigative" is a positive claim the
	 * prompt spends, so it needs evidence for EVERY granted tool.
	 */
	it("refuses to call an agent investigative when it grants an unrecognised tool", () => {
		expect(agentRole(agent("mcp-reader", ["read", "grep", "mcp__github__list_issues"]))).toBe("executing");
		expect(agentRole(agent("mcp-writer", ["mcp__github__create_pull_request"]))).toBe("executing");
	});

	/**
	 * And a plugin-provided tool is the same case under a different naming convention.
	 *
	 * Asserted separately from the `mcp__` case so a fix keyed on that PREFIX rather than on membership
	 * of the shipped tool set fails here. Nothing guarantees a third-party tool announces itself with a
	 * recognisable prefix, so the rule has to be "is this a tool this build ships" and not "does the
	 * name look foreign".
	 */
	it("refuses on a plugin tool that carries no recognisable prefix", () => {
		expect(agentRole(agent("plugin-reader", ["read", "acme_lookup"]))).toBe("executing");
	});

	/**
	 * A hidden tool is still a tool this build ships, so it does not trip the unknown-name rule.
	 *
	 * `yield`, `report_finding` and `resolve` are not offered by default but are ours, and a reviewer
	 * agent granting `report_finding` is the ordinary case rather than an exotic one. A `KNOWN` set
	 * built from the builtin list alone would misclassify it, which is why the set is the union.
	 */
	it("accepts a hidden tool as known", () => {
		expect(agentRole(agent("finder", ["read", "grep", "report_finding", "yield"]))).toBe("investigative");
	});

	/**
	 * An empty grant is investigative: it is a restriction, not an absent one.
	 *
	 * `tools: []` grants nothing, so there is nothing to prove and no editing tool present. Pinned
	 * because the unknown-name loop must not confuse "no tools" with "tools I could not check", and
	 * because it is the boundary between this rule and the `tools: undefined` case above it.
	 */
	it("treats an empty grant as investigative", () => {
		expect(agentRole(agent("nothing", []))).toBe("investigative");
	});

	/** Order is preserved, because the prompt names these and the tool lists them in discovery order. */
	it("keeps discovery order when listing investigative agents", () => {
		const agents = [agent("z-reader", ["read"]), agent("worker", undefined), agent("a-reader", ["glob"])];

		expect(investigativeAgentNames(agents)).toEqual(["z-reader", "a-reader"]);
	});
});
