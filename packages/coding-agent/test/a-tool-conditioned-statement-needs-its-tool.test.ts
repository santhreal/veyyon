/**
 * WHY: a statement gated on a tool must not reach a session that has no such tool.
 *
 * THE DEFECT CLASS. `execution-workflow/verify` told every session to "drive it in
 * browser" while `browser` shipped on. When the tool went off by default the
 * sentence stayed, so the prompt named a tool the model could not call: the model
 * either invents a call and gets a hard error, or reads the whole verification
 * bullet as inapplicable and skips verification. The fix split the browser
 * mechanics into `execution-workflow/verify-browser` behind
 * `contains("tools", "browser")`, and nothing asserted the gate. Twenty-five
 * statements carry a tool condition today and every one of them can rot the same
 * way, in either direction: a gate that fails open names a missing tool, a gate
 * that fails closed silently drops a rule the session needed.
 *
 * THE INVARIANT, at the choke point every statement crosses (the assembler):
 *
 *   For a statement conditioned on tool T, its text is in the composed prompt when
 *   T is granted and absent when it is not.
 *
 * ENUMERATION. The rows come out of `PROMPT_STATEMENTS` at run time, filtered to
 * the ones whose whole condition is `contains("tools", …)`, so a statement added
 * with a tool condition is swept without anyone editing this file, and a statement
 * that loses its gate turns the absent half red.
 *
 * WHAT IT DOES NOT CATCH. A statement gated on a tool through a compound condition
 * (`and`/`or` with another variable) is not swept, because withholding one variable
 * would not isolate the tool; the count of those is asserted so the exemption
 * cannot grow silently. Nor does it check WHICH array entry the text lands in:
 * `system-prompt-cached-prefix-stability.test.ts` owns the block-0 boundary.
 */
import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import { PROMPT_STATEMENTS } from "@veyyon/coding-agent/system-prompt-builder/statement-registry";

const EMPTY_TREE = {
	rootPath: "/tmp",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

type BuildOptions = Parameters<typeof buildSystemPrompt>[0];

/** Same pinned fixture as the prefix suite, with the tool list left to the caller. */
const options = (toolNames: string[]): BuildOptions =>
	({
		toolNames,
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: EMPTY_TREE,
		activeRepoContext: null,
	}) as BuildOptions;

const composed = async (toolNames: string[]): Promise<string> => {
	const { systemPrompt } = await buildSystemPrompt(options(toolNames));
	return (systemPrompt as string[]).join("\n");
};

/**
 * A fragment of the statement that survives rendering verbatim.
 *
 * Statements are Handlebars templates and most of these name their tool through
 * `{{toolRefs.read}}`, so a whole source line is not what reaches the model. The
 * literal text BETWEEN the expressions is, and the longest such run identifies the
 * statement without asserting on a rendered tool name (which is the one part a
 * profile may rebind). A statement carrying a block helper is skipped: text inside
 * `{{#if}}` renders conditionally, so its presence would prove nothing.
 */
function searchableFragment(text: string): string | undefined {
	if (text.includes("{{#")) return undefined;
	const fragments = text
		.split("\n")
		.flatMap(line => line.split(/\{\{[^}]*\}\}/))
		.map(fragment => fragment.trim())
		.filter(fragment => fragment.length >= 12)
		.sort((left, right) => right.length - left.length);
	return fragments[0];
}

/** Statements whose whole condition is "the session has tool X". */
const TOOL_GATED = PROMPT_STATEMENTS.filter(
	statement => statement.condition.kind === "whenContains" && statement.condition.collection === "tools",
).map(statement => ({
	id: statement.id,
	// Narrowed by the filter above; the union member is the only one carrying `member`.
	tool: (statement.condition as { kind: "whenContains"; collection: string; member: string }).member,
	fragment: searchableFragment(statement.text),
}));

/** The swept rows: a fragment to search for, and the tool that must produce it. */
const SWEPT = TOOL_GATED.flatMap(row => (row.fragment === undefined ? [] : [{ ...row, fragment: row.fragment }]));

describe("a statement conditioned on a tool needs that tool", () => {
	it("sweeps the tool-gated statements the registry actually declares", () => {
		// Anti-vacuity: the filter must find the rows, and nearly all of them must
		// offer a fragment to search for, or a green sweep would mean nothing.
		expect(TOOL_GATED.length).toBeGreaterThanOrEqual(20);
		expect(SWEPT.length).toBeGreaterThanOrEqual(20);
		expect(new Set(SWEPT.map(row => row.tool)).size).toBeGreaterThanOrEqual(10);
		// The fragments identify their statement rather than each other, so a
		// containment hit cannot come from a neighbour's prose.
		expect(new Set(SWEPT.map(row => row.fragment)).size).toBe(SWEPT.length);
	});

	it("names the statements it does not sweep by tool, and covers them anyway", async () => {
		// The exemption, pinned rather than described: a statement whose condition
		// mentions a tool alongside another variable is not swept per tool, because
		// withholding one variable would not isolate the tool. Sorted, so reordering
		// the registry is not a failure.
		const compound = PROMPT_STATEMENTS.filter(
			statement =>
				statement.condition.kind !== "whenContains" &&
				JSON.stringify(statement.condition).includes('"collection":"tools"'),
		);
		// Written in sorted order rather than sorted here, so the literals keep their
		// narrow ids: a statement renamed in the registry fails the TYPE check on this
		// list, before anyone runs the suite.
		expect(compound.map(statement => statement.id).sort()).toEqual([
			"execution-workflow/implement-no-destructive",
			"tool-policy/ast",
			"tool-policy/ast-plain-text",
			"tool-policy/delegation",
			"tool-policy/delegation-allowed",
			"tool-policy/delegation-codex-eager",
			"tool-policy/delegation-codex-off",
			"tool-policy/delegation-concurrency-cap",
			"tool-policy/delegation-gates",
			"tool-policy/delegation-no-shrinking",
			"tool-policy/delegation-preferred",
			"tool-policy/delegation-required",
			"tool-policy/delegation-subagent-value",
			"tool-policy/inspect-image",
		]);

		// The half of them that IS isolable: a condition requiring a tool (and no
		// `not`, which inverts the requirement) cannot hold when the session has no
		// tools at all, so none of these may reach a toolless prompt either.
		const bare = await composed([]);
		const requiresTool = compound.filter(statement => !JSON.stringify(statement.condition).includes('"kind":"not"'));
		expect(requiresTool.length).toBeGreaterThanOrEqual(5);
		for (const statement of requiresTool) {
			const fragment = searchableFragment(statement.text);
			if (fragment === undefined) continue;
			expect(bare.includes(fragment), `${statement.id} rendered with no tools at all`).toBe(false);
		}

		// Every tool-gated row offers a searchable fragment, or the sweep above would
		// be quietly narrower than it claims.
		expect(TOOL_GATED.filter(row => row.fragment === undefined).map(row => row.id)).toEqual([]);
	});

	it("withholds every tool-gated statement from a session with no tools", async () => {
		const bare = await composed([]);
		for (const row of SWEPT) {
			expect(bare.includes(row.fragment), `${row.id} rendered without ${row.tool}`).toBe(false);
		}
	});

	it("renders each tool-gated statement for a session that carries its tool", async () => {
		// One build per distinct tool rather than per statement: granting the tool is
		// what the condition reads, and several statements share a tool.
		const tools = [...new Set(SWEPT.map(row => row.tool))];
		for (const tool of tools) {
			const prompt = await composed([tool]);
			for (const row of SWEPT.filter(candidate => candidate.tool === tool)) {
				expect(prompt.includes(row.fragment), `${row.id} missing with ${tool} granted`).toBe(true);
			}
		}
	});

	/**
	 * The other direction, and the one that catches a gate being REMOVED rather than
	 * a statement being added: a statement that names a tool must require it.
	 *
	 * The sweeps above read the registry's conditions, so deleting a condition also
	 * deletes the row from the sweep and the sweep stays green while the prompt
	 * starts naming a tool the session may not have. This case reads the TEXT
	 * instead, so the sweep cannot be narrowed by removing what it looks at.
	 */
	it("requires the tool that a statement's own text names", () => {
		const offenders: string[] = [];
		for (const statement of PROMPT_STATEMENTS) {
			const named = [...statement.text.matchAll(/\{\{toolRefs\.([a-z_]+)\}\}/g)].map(match => match[1] as string);
			if (named.length === 0) continue;
			const condition = JSON.stringify(statement.condition);
			for (const tool of new Set(named)) {
				if (!condition.includes(`"member":"${tool}"`)) offenders.push(`${statement.id} names ${tool}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The specific regression, kept as a named case beside the sweep: the generic
	 * verification bullet must not name a tool, because it renders for every
	 * session, and the browser mechanics must arrive only with the browser tool.
	 */
	it("keeps the browser out of the verification bullet every session reads", async () => {
		const bare = await composed(["read", "write", "bash"]);
		expect(bare).toContain("**UI change** → drive the real interface and look at the result");
		expect(bare).not.toContain("`browser` tool");

		const withBrowser = await composed(["read", "write", "bash", "browser"]);
		expect(withBrowser).toContain("**UI change** → drive the real interface and look at the result");
		expect(withBrowser).toContain("A web UI is driven with the `browser` tool");
	});
});
