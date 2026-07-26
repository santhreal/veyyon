import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { CreateAgentSessionOptions } from "@veyyon/coding-agent/sdk";
import { isInProcessChildSession, isSubagentSession } from "@veyyon/coding-agent/sdk";

const SDK = path.join(import.meta.dir, "../../src/sdk.ts");

/**
 * The slice of the options bag both predicates read. Fixtures are annotated with
 * it rather than left as bare literals: `parentTaskPrefix` is optional, so a
 * literal like `{ taskDepth: 1 }` has no property in common with the narrower
 * `Pick` that `isInProcessChildSession` takes, and TypeScript rejects it as a
 * weak-type mismatch. Annotating says what a real caller passes, which is the
 * whole bag, and keeps the narrow signature honest about what it reads.
 */
type SessionRoleOptions = Pick<CreateAgentSessionOptions, "taskDepth" | "parentTaskPrefix">;

/**
 * `sdk.ts` asks two different questions about a session's role, and they used to
 * look like the same question asked two ways: `isSubagentSession` in four places,
 * and a bare `!options.parentTaskPrefix` in four others that decided who owns the
 * process-global singletons. Reading the file, nothing said whether the second
 * group was a narrower question on purpose or an inline copy that had drifted.
 *
 * It is narrower on purpose. This suite pins the distinction, pins the exact input
 * where the two disagree, and pins the call sites, so neither can be "simplified"
 * into the other by someone who reads them as duplicates.
 */
describe("isSubagentSession", () => {
	/**
	 * The plain top-level session: no depth, no parent. Everything else here is a
	 * departure from this shape.
	 */
	it("is false for a session with neither signal", () => {
		expect(isSubagentSession({})).toBe(false);
		expect(isSubagentSession({ taskDepth: 0 })).toBe(false);
		expect(isSubagentSession({ taskDepth: 0, parentTaskPrefix: undefined })).toBe(false);
	});

	/**
	 * Either signal alone is enough. The task executor sets `taskDepth`, the IRC and
	 * registry path sets `parentTaskPrefix`, and a session can arrive carrying one
	 * and not the other, so requiring both would miss a real subagent.
	 */
	it.each<[string, SessionRoleOptions]>([
		["depth alone", { taskDepth: 1 }],
		["a deeper depth alone", { taskDepth: 4 }],
		["a prefix alone", { parentTaskPrefix: "agent-7" }],
		["both together, as the executor sends them", { taskDepth: 1, parentTaskPrefix: "agent-7" }],
	])("is true for %s", (_label, options) => {
		expect(isSubagentSession(options)).toBe(true);
	});

	/**
	 * An empty prefix is not a parent. `Boolean("")` is false, so this falls through
	 * to the depth check and reports top-level. Pinned because the prefix is a string
	 * that reaches here from a session file and a spawn path, and a null-ish check
	 * (`parentTaskPrefix !== undefined`) would read an empty one as a live parent and
	 * make a top-level session behave as a subagent.
	 */
	it("does not treat an empty prefix as a parent", () => {
		expect(isSubagentSession({ parentTaskPrefix: "" })).toBe(false);
	});
});

describe("isInProcessChildSession", () => {
	/**
	 * Only the prefix answers this one. The prefix names the spawning agent, so it
	 * is the only signal that says a live parent exists in this process with
	 * singletons already installed to inherit.
	 */
	it("is true only when a parent prefix is present", () => {
		expect(isInProcessChildSession({ parentTaskPrefix: "agent-7" })).toBe(true);
		expect(isInProcessChildSession({})).toBe(false);
		expect(isInProcessChildSession({ parentTaskPrefix: undefined })).toBe(false);
		expect(isInProcessChildSession({ parentTaskPrefix: "" })).toBe(false);
	});
});

describe("the two predicates are not interchangeable", () => {
	/**
	 * THE ONE INPUT THAT SEPARATES THEM, and the reason both exist. A session
	 * carrying task depth but no parent prefix is a subagent by every other measure
	 * in `sdk.ts` (it is displayed as "sub", it follows the subagent Argot policy, it
	 * may not re-root the process) and is still an OWNER of the process globals,
	 * because no parent in this process installed any.
	 *
	 * Collapsing the two here would stop that session installing the skills, rules
	 * and MCP singletons, and would hand it `AsyncJobManager.instance()` as its
	 * scoped manager, which is `undefined` when nothing installed one. It would then
	 * refuse async work with no parent to route it to.
	 */
	it("disagree exactly on depth without a parent prefix", () => {
		const depthOnly: SessionRoleOptions = { taskDepth: 1 };

		expect(isSubagentSession(depthOnly)).toBe(true);
		expect(isInProcessChildSession(depthOnly)).toBe(false);
	});

	/**
	 * And they agree everywhere else, which is what makes the case above easy to
	 * miss: on every shape an in-tree caller actually produces, the two return the
	 * same answer. The task executor and `persisted-revive` both set depth and
	 * prefix together, so the divergent shape only arrives from an outside caller of
	 * the public `createAgentSession`.
	 */
	it.each<[SessionRoleOptions]>([
		[{}],
		[{ taskDepth: 0 }],
		[{ parentTaskPrefix: "agent-7" }],
		[{ taskDepth: 1, parentTaskPrefix: "agent-7" }],
		[{ taskDepth: 3, parentTaskPrefix: "agent-9" }],
	])("agree on %o", options => {
		expect(isSubagentSession(options)).toBe(isInProcessChildSession(options));
	});
});

describe("the ownership sites ask through the predicate", () => {
	const source = fs.readFileSync(SDK, "utf8");

	/**
	 * The four decisions that turn on ownership: constructing the process-global
	 * `AsyncJobManager`, scoping to an inherited one, installing the active skills
	 * and rules, and installing the global `MCPManager`. Each was a bare
	 * `!options.parentTaskPrefix`, which is what let them drift from each other and
	 * from `isSubagentSession` without anything failing.
	 */
	it.each([
		["constructing the AsyncJobManager", "!isInProcessChildSession(options) && !AsyncJobManager.instance()"],
		["scoping to an inherited manager", "isInProcessChildSession(options) ? AsyncJobManager.instance() : undefined"],
		["installing the active skills and rules", "if (!isInProcessChildSession(options)) {"],
		[
			"installing the global MCPManager",
			"if (mcpManager && !isInProcessChildSession(options)) MCPManager.setInstance(mcpManager)",
		],
	])("routes %s through isInProcessChildSession", (_label, expression) => {
		expect(source).toContain(expression);
	});

	/**
	 * No bare copy is left. This is the case that actually holds the line: the four
	 * above would still pass if someone added a FIFTH ownership decision spelled
	 * inline, which is exactly how the original divergence appeared.
	 *
	 * Value reads are allowed and are not what this forbids. `parentTaskPrefix` is
	 * legitimately used as a string (the agent id fallback, the IRC parent prefix),
	 * so only its use as a truthiness TEST is banned.
	 *
	 * The two predicate bodies are the exception, and the only one: they are where
	 * the raw field is SUPPOSED to be tested, since something has to read it once.
	 * They are `return` statements, which is what the filter keys off.
	 */
	const BARE_TEST = /[!(]\s*options\.parentTaskPrefix\s*(?:\)|&&|\|\||\?)/;

	function bareTestsOutsideThePredicates(text: string): string[] {
		return text
			.split("\n")
			.filter(line => !/^\s*return\b/.test(line))
			.filter(line => BARE_TEST.test(line))
			.map(line => line.trim());
	}

	it("leaves no bare truthiness test on parentTaskPrefix", () => {
		expect(bareTestsOutsideThePredicates(source)).toEqual([]);
	});

	/**
	 * Anti-vacuity for the case above. Proves the filter still catches a bare test
	 * outside a predicate body, and that the `return` exemption is narrow enough to
	 * cover the two definitions without covering a reintroduced call site: an empty
	 * result from a filter that excluded everything would prove nothing.
	 */
	it("would catch a bare test if one came back, while still exempting the predicates", () => {
		expect(bareTestsOutsideThePredicates("\t\tif (!options.parentTaskPrefix) doSomething();")).toEqual([
			"if (!options.parentTaskPrefix) doSomething();",
		]);
		expect(bareTestsOutsideThePredicates("\treturn Boolean(options.parentTaskPrefix);")).toEqual([]);
	});
});
