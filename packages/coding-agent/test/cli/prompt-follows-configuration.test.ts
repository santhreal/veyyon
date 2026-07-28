/**
 * `veyyon prompt` renders YOUR configuration, not the schema defaults.
 *
 * WHY THIS SUITE EXISTS. The command exists to answer one question: what does this configuration
 * send to the model. It answered it against `Settings.isolated({})` -- the testing constructor,
 * which is in-memory, reads no `config.yml` and no project settings, and therefore hands every
 * gate a schema default. Nothing failed. A prompt was printed, it was well-formed, and it was the
 * prompt of a configuration nobody has. With `subagent.delegation=required` and
 * `personality=none` it printed the PREFERRED delegation wording and a full personality block,
 * which is the opposite of both settings (`BACKLOG.md`,
 * `FINDING-VEYYON-PROMPT-IGNORES-EVERY-SETTINGS-FED-GATE`).
 *
 * That is the worst shape a bug can take on an inspection tool: the surface built to show you a
 * settings change was the one surface that could not show you a settings change, so an operator
 * verifying a gated edit was reading a fixed answer and believing it.
 *
 * `Settings.loadReadOnly` is the loader written for exactly this case -- it reads `config.yml`
 * and the project providers, opens no database and writes nothing -- and until this fix it had
 * zero callers in `src/`. These cases pin both halves: the configured values reach the rendered
 * text, and inspecting a prompt still leaves no trace on disk.
 *
 * Project settings rather than a global config file, deliberately: project settings merge OVER
 * the global ones (`Settings.#rebuildMerged`), so these assertions hold whatever the developer
 * running them has in `~/.veyyon/config.yml`.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runPromptCommand } from "../../src/cli/prompt-cli";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

/** The project config directory the discovery layer reads `settings.json` from. */
const PROJECT_CONFIG_DIR = ".veyyon";

const makeWorkspace = useTrackedTempDirs("veyyon-prompt-config-");

/**
 * A temp cwd, optionally carrying project settings, deleted when the file finishes.
 *
 * The comment here used to say the directory was "torn down with the test process",
 * which was wrong: nothing deleted it, and this file makes one per case, so a full
 * `test/cli` run left nineteen behind. `useTrackedTempDirs` attaches the deletion to
 * the act of making the directory, so there is no teardown for a new case to forget.
 */
function workspace(settings?: Record<string, unknown>): string {
	const dir = makeWorkspace();
	if (settings) {
		fs.mkdirSync(path.join(dir, PROJECT_CONFIG_DIR), { recursive: true });
		fs.writeFileSync(path.join(dir, PROJECT_CONFIG_DIR, "settings.json"), JSON.stringify(settings));
	}
	return dir;
}

/** Every file under `dir`, relative, sorted -- the before/after for the no-writes case. */
function tree(dir: string): string[] {
	const found: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
		const named = entry as unknown as { parentPath?: string; path?: string };
		const parent = named.parentPath ?? named.path ?? dir;
		found.push(path.relative(dir, path.join(parent, entry.name)));
	}
	return found.sort();
}

describe("veyyon prompt reads the real configuration", () => {
	/**
	 * `subagent.delegation=required` is the gate the finding was reproduced with. The section
	 * carries two different paragraphs for `preferred` and `required`, so asserting the MUST
	 * wording proves the setting was READ, not merely that some prompt rendered.
	 */
	it("renders the required-delegation wording when the project asks for it", async () => {
		const result = await runPromptCommand({
			cwd: workspace({ subagent: { delegation: "required" } }),
			section: "tool-policy",
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Delegation is the default here, not the exception.");
		expect(result.output).toContain("you MUST fan the work out to `task` subagents");
		// The paragraph the default configuration renders instead. Its absence is the half of the
		// assertion that fails if the gate silently rendered both.
		expect(result.output).not.toContain("Delegation is preferred");
	});

	/**
	 * The default it was masking. Without this case the one above passes against a build that
	 * hardcodes the `required` text, which is the same class of bug in the other direction.
	 */
	it("renders the preferred-delegation wording when the project says nothing", async () => {
		const result = await runPromptCommand({ cwd: workspace(), section: "tool-policy" });

		expect(result.output).toContain("Delegation is preferred");
		expect(result.output).not.toContain("Delegation is the default here, not the exception.");
	});

	/**
	 * `personality=none` removes the block entirely rather than substituting a quieter one. This
	 * is the second gate from the reproduction, and it fails in the OPPOSITE direction from the
	 * delegation one -- the old code rendered content the configuration had turned off, where
	 * delegation rendered the weaker of two alternatives. One case cannot cover both shapes.
	 */
	it("omits the personality block when the project sets personality to none", async () => {
		const result = await runPromptCommand({ cwd: workspace({ personality: "none" }), section: "delivery-contract" });

		expect(result.output).not.toContain("<personality>");
		expect(result.output).not.toContain("terse, evidence-first engineer");
	});

	/** The non-vacuity twin: the block really is there by default, so its absence above means something. */
	it("includes the personality block by default", async () => {
		const result = await runPromptCommand({ cwd: workspace(), section: "delivery-contract" });

		expect(result.output).toContain("<personality>");
		expect(result.output).toContain("terse, evidence-first engineer");
	});

	/**
	 * Both gates at once, through the default full-prompt output rather than a single section, so
	 * this covers the path an operator actually runs (`veyyon prompt` with no flags).
	 */
	it("applies every configured gate to the full rendered prompt", async () => {
		const cwd = workspace({ personality: "none", subagent: { delegation: "required", batch: false } });

		const result = await runPromptCommand({ cwd });

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("you MUST fan the work out to `task` subagents");
		expect(result.output).not.toContain("<personality>");
		// `subagent.batch: false` drops the batching instruction that `required` otherwise carries.
		expect(result.output).not.toContain("Batch independent slices into one parallel `task` call");
	});

	/**
	 * The JSON output is the machine-diffable form, and it is the one an operator uses to compare
	 * two configurations. It must follow the settings for the same reason the text does; rendering
	 * defaults there would make every diff between two configurations empty.
	 */
	it("follows the configuration through --json as well", async () => {
		const configured = await runPromptCommand({
			cwd: workspace({ subagent: { delegation: "required" } }),
			json: true,
		});
		const plain = await runPromptCommand({ cwd: workspace(), json: true });

		const policyOf = (raw: string): { bytes: number; text: string } => {
			const sections = (JSON.parse(raw) as { sections: { id: string; bytes: number; text: string }[] }).sections;
			const found = sections.find(section => section.id === "tool-policy");
			expect(found, "tool-policy section missing from the JSON inspection").toBeDefined();
			return found as { bytes: number; text: string };
		};

		expect(policyOf(configured.output).text).toContain("you MUST fan the work out to `task` subagents");
		expect(policyOf(plain.output).text).toContain("Delegation is preferred");
		// The required paragraph is the longer of the two, so the configured run is strictly bigger.
		expect(policyOf(configured.output).bytes).toBeGreaterThan(policyOf(plain.output).bytes);
	});

	/**
	 * INSPECTION DOES NOT MUTATE. The fix swapped a constructor for a loader, and the wrong loader
	 * (`Settings.loadIsolated`, or a plain `init` without `inMemory`) opens the profile database
	 * and runs the legacy-settings migration. Printing a prompt must never change what the next
	 * session sends, so the workspace is byte-identical afterwards.
	 */
	it("writes nothing into the workspace it inspects", async () => {
		const cwd = workspace({ personality: "none" });
		const before = tree(cwd);

		await runPromptCommand({ cwd });

		expect(tree(cwd)).toEqual(before);
	});

	/**
	 * SOURCE LOCK. Every case above is a behaviour assertion, and all of them would keep passing
	 * if someone reintroduced `Settings.isolated` for a NEW read alongside the loaded instance --
	 * the tool would follow configuration for these two gates and not for that one. The
	 * constructor is a testing seam; the command must not reach for it at all.
	 */
	it("does not build settings from the testing constructor", () => {
		const source = fs.readFileSync(path.join(import.meta.dir, "..", "..", "src/cli/prompt-cli.ts"), "utf-8");

		// The comment in that file names `Settings.isolated({})` when explaining what was replaced,
		// so the lock looks for a call rather than the identifier: `.isolated(` preceded by nothing
		// that makes it prose. Backticked prose is excluded by requiring no backtick before it.
		const calls = source.split("\n").filter(line => /(?<!`)\bSettings\.isolated\s*\(/.test(line));

		expect(calls, "prompt-cli must resolve settings through Settings.loadReadOnly").toEqual([]);
	});

	/** And the positive half of the lock: the loader that actually reads the configuration is used. */
	it("resolves settings through the read-only loader", () => {
		const source = fs.readFileSync(path.join(import.meta.dir, "..", "..", "src/cli/prompt-cli.ts"), "utf-8");

		expect(source).toContain("await Settings.loadReadOnly({ cwd })");
	});
});

/**
 * `veyyon prompt --statements` PRICES EACH RULE, and it has to follow the configuration for the same
 * reason the text does.
 *
 * WHY THIS IS A SEPARATE SURFACE WORTH ITS OWN CASES. The section breakdown answers "what is taking up
 * the prompt" down to a section, and TOOL POLICY is one row of it and 9KB of prompt, so for the section
 * that matters most the answer is "tool policy is large". A rule has a name, so this is the level at
 * which an operator can decide a rule is not earning its tokens, and the level an eval ablates at.
 *
 * The cost is MARGINAL: what the prompt would be shorter by without the rule, not the length of the
 * rule's text. The two differ because rendering ends in a whitespace-normalizing pass that runs across
 * statement boundaries, so text lengths would produce a breakdown whose parts exceed the whole.
 */
describe("veyyon prompt --statements prices each rule against the real configuration", () => {
	it("charges for the delegation rules a configured session actually receives", async () => {
		// `required` selects a different, longer delegation paragraph than the default `preferred`, so
		// the two runs must charge DIFFERENT rows, not merely produce different totals.
		const configured = await runPromptCommand({
			cwd: workspace({ subagent: { delegation: "required" } }),
			statements: true,
		});
		const plain = await runPromptCommand({ cwd: workspace(), statements: true });

		expect(configured.output).toContain("tool-policy/delegation-required");
		expect(configured.output).toContain("needs tools has task and not useCodexTaskPrompt");
		expect(plain.output).toContain("tool-policy/delegation-preferred");
	});

	it("reports a rule this configuration leaves out, with the condition that would include it", async () => {
		// `personality: none` removes the personality block. Reporting it as absent WITH its condition
		// is the difference between "this rule costs nothing" and "this rule is not here", which is the
		// distinction an operator needs and a zero row cannot make.
		const result = await runPromptCommand({ cwd: workspace({ personality: "none" }), statements: true });

		expect(result.output).toContain("not in this prompt");
		expect(result.output).toMatch(/delivery-contract\/personality\s+needs personality/);
	});

	it("prices the personality block by what it costs, not by the length of its template", async () => {
		// The marginal measurement, end to end through the CLI. The statement's template is four short
		// lines; what it costs is the rendered personality, which is far larger. A row reporting the
		// template's length would be roughly an order of magnitude too small.
		const result = await runPromptCommand({ cwd: workspace(), statements: true });
		const row = result.output.split("\n").find(line => line.startsWith("delivery-contract/personality"));

		expect(row, "the personality row is missing").toBeDefined();
		const bytes = Number(row?.match(/\s(\d+)\s+\d+\s+\d+\.\d%/)?.[1]);
		expect(bytes).toBeGreaterThan(200);
	});

	it("carries the same numbers into --json, which is the diffable form", async () => {
		// An operator comparing two configurations reads the JSON. It must carry the per-rule rows and
		// the flag that says whether the prompt came from the statements at all, since an empty list
		// otherwise reads as "the rules cost nothing".
		const result = await runPromptCommand({ cwd: workspace(), json: true });
		const parsed = JSON.parse(result.output) as {
			fromStatements: boolean;
			statements: { id: string; present: boolean; bytes: number; condition: string }[];
		};

		expect(parsed.fromStatements).toBe(true);
		expect(parsed.statements.length).toBeGreaterThan(60);
		const personality = parsed.statements.find(statement => statement.id === "delivery-contract/personality");
		expect(personality?.present).toBe(true);
		expect(personality?.condition).toBe("personality");
		expect(personality?.bytes).toBeGreaterThan(200);
		for (const statement of parsed.statements.filter(entry => !entry.present)) {
			expect(statement.bytes, `${statement.id} is absent but charged`).toBe(0);
		}
	});
});

/**
 * `veyyon prompt --statement <id>` READS ONE RULE, which is the next thing anyone wants after seeing a
 * row in the cost table they do not recognise.
 *
 * The counterpart to `--section` at the granularity a rule actually has. Three outcomes, and the middle
 * one is the reason this needs its own cases: a present rule prints its rendered text; an ABSENT rule
 * exits 0 and reports the condition that would include it, because "off because the task tool is not
 * built" is the answer to the question being asked; an unknown id exits non-zero with the ids of the
 * section it named, because an empty stdout reads as an empty rule rather than as a typo.
 */
describe("veyyon prompt --statement reads one rule", () => {
	it("prints the rendered text of a rule that is in this prompt", async () => {
		// Rendered, not the template: the personality block interpolates the resolved personality, and
		// printing `{{personality}}` would show a rule nobody is sent.
		const result = await runPromptCommand({ cwd: workspace(), statement: "delivery-contract/personality" });

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("<personality>");
		expect(result.output).not.toContain("{{personality}}");
	});

	it("says why a rule is absent, and exits 0, because an off rule is not a failure", async () => {
		// A temp workspace has no Obsidian vault, so the `vault://` URL bullet is off. Chosen because it
		// depends on the WORKSPACE rather than on the tool set: this command resolves tools for real, so
		// the delegation family is present here and would not have made the point.
		//
		// Reporting the condition is what makes the absence actionable; a non-zero exit would report a
		// working configuration as broken.
		const result = await runPromptCommand({ cwd: workspace(), statement: "runtime/obsidian-vault-url" });

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("is not in this prompt");
		expect(result.output).toContain("It needs: hasObsidian");
		expect(result.output).toContain("Why it exists:");
	});

	it("refuses an unknown id with the ids of the section it named", async () => {
		// 68 ids is too many to print, and a typo is almost always inside the section the operator
		// meant, so the message narrows to that section rather than listing everything.
		const result = await runPromptCommand({ cwd: workspace(), statement: "delivery-contract/yeilding" });

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("Unknown statement");
		expect(result.output).toContain("delivery-contract/yielding");
	});

	it("names the sections when the id does not even have one", async () => {
		const result = await runPromptCommand({ cwd: workspace(), statement: "yielding" });

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("sections: ");
		expect(result.output).toContain("delivery-contract");
	});

	it("prints text whose length is exactly the cost the table reports", async () => {
		// The two surfaces have to agree, or one of them is lying about what the rule costs. The text is
		// the MARGINAL contribution, so byte length and reported bytes are the same number by
		// construction, and this is the end-to-end check of that.
		const one = await runPromptCommand({ cwd: workspace(), statement: "delivery-contract/personality" });
		const all = await runPromptCommand({ cwd: workspace(), json: true });
		const priced = (JSON.parse(all.output) as { statements: { id: string; bytes: number }[] }).statements.find(
			statement => statement.id === "delivery-contract/personality",
		);

		// Asserted defined first: without it a renamed or missing statement makes `priced?.bytes`
		// undefined and the comparison reports a type error rather than the real failure.
		expect(priced, "delivery-contract/personality missing from the JSON inspection").toBeDefined();
		expect(Buffer.byteLength(one.output, "utf8")).toBe((priced as { bytes: number }).bytes);
	});
});
