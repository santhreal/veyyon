import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { createTools, type Tool } from "@veyyon/coding-agent/tools";
import { useTempHome } from "../helpers/temp-home";
import { makeToolSession } from "../helpers/tool-session";

/**
 * A tool's `description` is the only API documentation the model ever reads: it is
 * serialized into every request beside the JSON schema, and the model has no other
 * source for the rules it must not violate. Trimming a description for wire bytes is
 * therefore an API change, and these cases are the acceptance criteria for that trim.
 *
 * Each entry names the rules and failure modes that survived a byte cut. Deleting one
 * from the prompt turns its case red. This is not a source grep: the text asserted is
 * the RENDERED description the provider receives, taken from a real tool instance built
 * by `createTools`, not the `.md` template on disk.
 */
const RETAINED: Readonly<Record<string, readonly string[]>> = {
	bash: [
		// The specialized-tool routing that survived the cut of its system-prompt duplicate.
		// The system prompt names neither `find` nor the single-listing exception, so both
		// clauses had to stay here.
		"`ls` → `read`",
		"`find` → `glob`",
		"even for one quick listing",
		// The launch routing rule, previously stated three times in this one description
		// and now stated once. Every clause of the surviving copy is load-bearing.
		"MUST use `launch`",
		"needing later stdin",
		"`nohup`",
		"process supervisor",
		// Failure modes that were never candidates for cutting.
		"stderr already merged",
		"artifact://<id>",
	],
	read: [
		// The context-padding contract, compressed from three restatements to one. Each
		// fragment below is a distinct fact the model needs to read its own output.
		"1 line before",
		"3 after",
		"`:1-5` returns lines 1-8",
		"states what was padded",
		"`:raw:1-5`",
		// Routing rule kept while the duplicate "parallelize independent reads" went.
		"browser only when `read` can't deliver",
		"NEVER guess",
	],
	set_cwd: [
		// The tool-result rule the `<working-directory>` system block does NOT state.
		"started and stopped applying",
		// Parameter rules and failure modes, untouched by the cut.
		"must exist and be a directory",
		"never writes the profile `session.workdir` setting",
		"Subagents already running keep the cwd they were spawned with",
		"needs the same permission as reading or writing outside it",
		"Prefer an absolute path",
	],
	task: [
		// The routing rule, restated by `fd5edbd34` from "each agent is a distinct
		// type with its own use case" to a cost ladder. The old sentence invited
		// routing on subject matter, which is the thing that sent cheap work to
		// expensive lanes; these two clauses are what replaced it and they carry
		// the part that must never be cut, that a disabled lane is not a reason to
		// pick a wider one.
		"cost lanes, not job titles",
		"Route on how much is unknown",
		"A lane that is not listed is disabled",
		"NEVER substitute a wider lane for a disabled one",
		// The rules the collapse must not have taken with it.
		"One-liners or missing acceptance criteria are PROHIBITED",
		"skip formatters, linters, and project-wide test suites",
		"Subagents start blank",
	],
	launch: [
		// The enumeration moved out of `<instruction>` and into `<critical>`; losing any
		// term makes the rule unactionable, which is why it moved rather than vanished.
		"service, watcher, debugger, REPL",
		"needing later stdin MUST use `launch`",
		"Readiness MUST be observed",
		"NEVER kill an unverified PID",
	],
	eval: [
		// The one surviving statement of the re-run-setup rule.
		"Re-run setup only after `reset`, a crash, or a `NameError`/`ReferenceError`",
		"NEVER re-import, re-require, or re-declare a helper",
	],
	todo: [
		// The example array went 8 -> 2 because the ops table already documents every
		// op. What the examples never carried, and prose must: that a task is named
		// by its content string, that a finished task is marked immediately, and that
		// a plan handed over by the operator is enumerated in full rather than
		// summarized, which is the failure this tool exists to prevent.
		"NEVER an auto-generated ID",
		"Mark tasks done immediately after finishing",
		"MUST `init` the list with EVERY item",
		"NEVER summarize into fewer tasks",
	],
	irc: [
		// The prose cut collapsed two statements of the narration rule into one and
		// removed a duplicated "never send a progress report" list. What no cut may
		// take: what a message COSTS, and the two prohibitions that stop a loop.
		"NEVER invent names",
		"WAKES an `idle` or `parked` peer",
		"Silence IS the acknowledgement",
		"traded 16 in a row",
		"NEVER send JSON status objects",
		"DM them before editing, not after",
	],
	ast_grep: [
		// The example array went 5 -> 2, so the metavariable grammar is now stated
		// once. A pattern written with the two-dollar form silently matches nothing.
		"`$$$NAME`, NOT `$$NAME`",
		"MUST be the whole AST node",
		"Parse issues = query failure, not absence",
	],
	ast_edit: [
		// Same grammar, same single statement, plus the one op an example no longer
		// demonstrates: deleting a match is an empty `out`, not a missing field.
		"`$$$NAME`, NOT `$$NAME`",
		"empty `out`",
	],
	debug: [
		// The repl example went; the rule it stood next to did not.
		"Only one active debug session at a time",
		"`program` is a target path, not a shell command",
	],
	glob: [
		// Two of four examples went, including the gitignored-file pair, so the
		// defaults they demonstrated have to be readable in the prose.
		"`gitignore` (default `true`)",
		"becomes `**/*.json`",
	],
	browser: [
		// Ref lifetime is the failure mode a trimmed sentence could have dropped.
		"Refs renumber from e1 each call",
		"aria-ref=e5",
		"MUST `open` before `run`",
		"Navigation invalidates element ids",
	],
};

describe("tool descriptions keep their model-visible rules", () => {
	const home = useTempHome();
	let byName = new Map<string, Tool>();

	beforeAll(async () => {
		const session = makeToolSession({
			cwd: home(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			// `irc` refuses to build without both of these, so without them its rules
			// were not "kept through the cut", they were unverified.
			agentRegistry: new AgentRegistry(),
			getAgentId: () => "Main",
			// In-memory settings: this suite never touches a repo, so the isolated
			// constructor (which also skips on-disk discovery) is the right fixture.
			// `browser` ships off by default and `RETAINED` names its rules, so the
			// fixture enables the opt-in tools rather than letting the default drop
			// them from `createTools` and leave their contract unverified.
			settings: Settings.isolated({ "browser.enabled": true, "lsp.enabled": true }),
		});
		byName = new Map((await createTools(session)).map(tool => [tool.name, tool]));
	});

	for (const [name, rules] of Object.entries(RETAINED)) {
		it(`${name} still advertises every rule kept through the byte cut`, () => {
			const tool = byName.get(name);
			if (!tool) throw new Error(`tool ${name} was not built; the contract below is unverified`);
			const description = tool.description ?? "";
			const missing = rules.filter(rule => !description.includes(rule));
			expect(missing).toEqual([]);
		});
	}
});
