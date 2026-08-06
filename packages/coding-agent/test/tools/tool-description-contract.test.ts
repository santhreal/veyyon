import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createTools, type Tool, type ToolSession } from "@veyyon/coding-agent/tools";
import { useTempHome } from "../helpers/temp-home";

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
		// The type-matching rule survives once, next to the agent list.
		"Each agent below is a distinct type with its own use case",
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
		const session = {
			cwd: home(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			// In-memory settings: this suite never touches a repo, so the isolated
			// constructor (which also skips on-disk discovery) is the right fixture.
			// `browser` ships off by default and `RETAINED` names its rules, so the
			// fixture enables the opt-in tools rather than letting the default drop
			// them from `createTools` and leave their contract unverified.
			settings: Settings.isolated({ "browser.enabled": true, "lsp.enabled": true }),
		} as unknown as ToolSession;
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
