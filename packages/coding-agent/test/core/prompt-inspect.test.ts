/**
 * SYSPROMPT-3: the assembled system prompt must be readable without running a session.
 *
 * The system prompt is a program, not a document: it is assembled from named
 * statements, many conditional, so whole regions appear or
 * vanish with the live tool set, the settings, the workspace and the model's
 * harness profile. Reading the rules tells you what could ship. Before this
 * inspection existed the only way to see what DID ship was to start a session
 * and export it, which is slow enough that in practice nobody did — so prompt
 * changes were reviewed as diffs of template fragments rather than as the
 * artifact the model receives.
 *
 * The contract these tests defend is FAITHFULNESS. An inspection that is merely
 * plausible is worse than none: it invites review of a prompt nobody was ever
 * sent. So the assertions are about identity with the real assembly rather than
 * about the output looking reasonable — the sections must reconstruct the real
 * blocks byte for byte, the block boundary must survive because it is the
 * provider caching contract, and section ids must match the registry's so the
 * thing you can see is the thing you can override.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	formatInspectionTable,
	formatStatementTable,
	inspectSystemPrompt,
	type PromptInspection,
} from "@veyyon/coding-agent/system-prompt-builder/prompt-inspect";
import { SYSTEM_PROMPT_SECTIONS } from "@veyyon/coding-agent/system-prompt-builder/section-registry";
import {
	PROMPT_STATEMENTS,
	STATEMENT_SECTIONS,
	sectionBanner,
	statementsOf,
} from "@veyyon/coding-agent/system-prompt-builder/statement-registry";
import { prompt } from "@veyyon/utils";

await Settings.init({ inMemory: true });

/** One assembly, shared: building it runs real workspace discovery. */
const inspection: PromptInspection = await inspectSystemPrompt({ toolNames: ["read", "edit", "bash", "grep"] });

describe("the inspection reproduces the prompt rather than approximating it", () => {
	it("reconstructs every block byte for byte from its sections", () => {
		// THE core guarantee. If the pieces do not reassemble into the real thing,
		// every size, share and diff computed from them describes a document that
		// was never sent, and a reviewer would be reading fiction.
		for (const [index, block] of inspection.blocks.entries()) {
			const rebuilt = inspection.sections
				.filter(section => section.blockIndex === index)
				.map(section => section.text)
				.join("\n");

			expect(rebuilt).toBe(block);
		}
	});

	it("reports byte counts that match the text it carries", () => {
		// A size table is the first thing an operator trusts and the easiest thing
		// to compute from the wrong string.
		for (const section of inspection.sections) {
			expect(section.bytes).toBe(Buffer.byteLength(section.text, "utf8"));
		}
	});

	it("totals the sections rather than measuring something else", () => {
		expect(inspection.totalBytes).toBe(inspection.sections.reduce((sum, s) => sum + s.bytes, 0));
		expect(inspection.totalTokens).toBe(inspection.sections.reduce((sum, s) => sum + s.tokens, 0));
	});
});

describe("the provider caching boundary survives inspection", () => {
	it("keeps template and runtime text in separate blocks", () => {
		// `buildSystemPrompt` splits the array so the static prefix stays
		// byte-stable for the provider's cache while volatile runtime text cannot
		// invalidate it. An inspection that flattened the array would hide the
		// single most expensive thing a prompt change can get wrong, so the split
		// is asserted as a property of the report itself.
		const blocksBySource = new Map<string, Set<number>>();
		for (const section of inspection.sections) {
			if (section.source === "preamble") continue;
			const blocks = blocksBySource.get(section.source) ?? new Set();
			blocks.add(section.blockIndex);
			blocksBySource.set(section.source, blocks);
		}

		const templateBlocks = blocksBySource.get("template") ?? new Set();
		const runtimeBlocks = blocksBySource.get("runtime") ?? new Set();
		for (const block of templateBlocks) expect(runtimeBlocks.has(block)).toBe(false);
	});

	it("assigns every section to a block that exists", () => {
		for (const section of inspection.sections) {
			expect(section.blockIndex).toBeGreaterThanOrEqual(0);
			expect(section.blockIndex).toBeLessThan(inspection.blocks.length);
		}
	});
});

describe("section identity agrees with the registry", () => {
	it("names the leading region by its registry id, not the splitter's", () => {
		// The splitter calls everything before the first banner "preamble" because
		// that is what it structurally is; the registry calls that same text
		// `conventions`, a declared section that simply has no banner. Reporting
		// two names for one section would make `--section conventions` fail on a
		// section that is plainly present.
		const ids = inspection.sections.map(section => section.id);

		expect(ids).toContain("conventions");
		expect(ids).not.toContain("preamble");
	});

	it("labels each section with the source the registry declares", () => {
		// The label is what tells an operator whether a section comes from the .md
		// file or from runtime state, which decides how it can be changed at all.
		const declared = new Map(SYSTEM_PROMPT_SECTIONS.map(section => [section.id as string, section.source]));
		for (const section of inspection.sections) {
			const expected = declared.get(section.id);
			if (expected === undefined) continue;
			expect(section.source).toBe(expected);
		}
	});

	it("reports no unregistered section for a default build", () => {
		// `unregistered` means the prompt carries a banner the registry does not
		// know, which cannot be reordered or overridden. On the default path that
		// is a defect, so it is pinned rather than tolerated.
		expect(inspection.sections.filter(section => section.source === "unregistered")).toEqual([]);
	});

	it("includes the sections the shipped template actually defines", () => {
		// Guards against a silently truncated assembly. A regression that dropped
		// half the prompt would still satisfy every structural assertion above.
		const ids = new Set(inspection.sections.map(section => section.id));

		for (const id of ["conventions", "role", "runtime", "tool-policy", "execution-workflow", "delivery-contract"]) {
			expect(ids).toContain(id);
		}
	});
});

describe("the tool set really does change the prompt", () => {
	it("drops tool-gated text when the tools are absent", () => {
		// Roughly half the template's conditionals are `{{#has tools "..."}}`, so
		// this is the proof that the inspection reflects its inputs instead of
		// printing the template with the conditionals rendered once and cached.
		expect(inspection.blocks.join("\n")).toContain("`grep`");
	});

	it("produces a smaller prompt with no tools at all", async () => {
		const bare = await inspectSystemPrompt({ toolNames: [] });

		expect(bare.totalBytes).toBeLessThan(inspection.totalBytes);
	});
});

describe("the breakdown table", () => {
	const table = formatInspectionTable(inspection);

	/**
	 * The cost table proper: header, one row per present section, TOTAL. Anything
	 * after that is the absent-section footer, which is a different report about a
	 * different set and must not be measured as though it were part of the table.
	 */
	const costTable = (): string[] => {
		const lines = table.split("\n");
		const footer = lines.indexOf("not in this prompt:");
		return footer === -1 ? lines : lines.slice(0, footer - 1);
	};

	it("lists sections largest first", () => {
		// The table answers "what is taking up the prompt", so cost order is the
		// useful one; prompt order is already visible in the full text.
		const rows = costTable().slice(1, -1);
		const tokens = rows.map(row => Number(row.trim().split(/\s+/).at(-2)));

		expect(tokens).toEqual([...tokens].sort((a, b) => b - a));
	});

	it("carries a row for every section plus a header and a total", () => {
		expect(costTable()).toHaveLength(inspection.sections.length + 2);
	});

	/**
	 * The footer is the half a cost table cannot show. Sections that did not render
	 * have no bytes to report, so they appear nowhere in the rows above, and their
	 * absence used to be indistinguishable from them not existing.
	 */
	it("names the sections that are not in this prompt", () => {
		expect(inspection.missing.length).toBeGreaterThan(0);
		expect(table).toContain("not in this prompt:");
		for (const section of inspection.missing) {
			expect(table).toContain(section.id);
		}
	});

	it("shows shares that add up to the whole", () => {
		// A share column that did not sum to 100 would quietly misattribute cost,
		// which is the one number an operator acts on.
		const shares = [...table.matchAll(/(\d+\.\d)%/g)].map(match => Number(match[1]));

		expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(100, 0);
	});
});

/**
 * PER-STATEMENT COST: what each individual rule in the prompt costs.
 *
 * WHY THIS EXISTS. The section breakdown above answers "what is taking up the prompt" down to the
 * section, and TOOL POLICY is a single row of it worth 9KB, so for the section that matters most the
 * answer is "tool policy is large" and nobody can act on it. A statement is one rule, which is the
 * granularity at which somebody decides a rule is not earning its tokens, and the granularity an
 * ablation has to operate on to be designed rather than guessed at.
 *
 * The contract these tests defend is that the numbers ADD UP. A cost breakdown whose parts do not
 * reconcile with the whole is worse than no breakdown: it looks authoritative and misattributes the
 * cost an operator would act on. Because `render` ends in a `format` pass that normalizes whitespace
 * ACROSS statement boundaries, the obvious implementation (measure each statement's rendered text)
 * produces parts that exceed their whole, so the measurement is marginal and the reconciliation
 * below is what proves the marginal costs are real.
 */
describe("what each rule costs", () => {
	it("prices every registered statement, present or absent", () => {
		// Absent rules are reported at zero rather than omitted, because "this rule is off and costs
		// nothing" is an answer somebody wants, and a list of only present rows cannot tell an
		// off rule from a rule that has been deleted.
		expect(inspection.fromStatements).toBe(true);
		expect(inspection.statements).toHaveLength(PROMPT_STATEMENTS.length);
		expect(inspection.statements.map(statement => statement.id)).toEqual(PROMPT_STATEMENTS.map(row => row.id));
	});

	/**
	 * The reconciliation the `InspectedStatement.bytes` doc comment claims, measured.
	 *
	 * `section bytes = banner + sum of statement bytes + boundary`. The banner belongs to the
	 * assembler rather than to any statement. Sections normally own the separator newline that
	 * follows them; runtime owns none when native schemas suppress its terminal inventory statement.
	 */
	it("adds up to the section, once the banner and the separator are accounted for", () => {
		const last = STATEMENT_SECTIONS[STATEMENT_SECTIONS.length - 1];

		for (const section of STATEMENT_SECTIONS) {
			const priced = inspection.statements.filter(statement => statement.section === section);
			const sum = priced.reduce((total, statement) => total + statement.bytes, 0);
			const banner = Buffer.byteLength(prompt.render(sectionBanner(section), {}), "utf8");
			const separator = section === last || section === "runtime" ? 0 : 1;
			const actual = inspection.sections.find(entry => entry.id === section);
			if (actual === undefined) throw new Error(`${section} is not in this prompt at all`);

			expect(sum + banner + separator, `${section} does not reconcile`).toBe(actual.bytes);
		}
	});

	/**
	 * The text a statement contributed weighs exactly what the statement is charged.
	 *
	 * `--statement <id>` prints this text and `--statements` prints that number, so the two operator
	 * surfaces would disagree about the same rule if the equality did not hold. It also proves the
	 * marginal definition is sound: the text is taken as the growth after the common prefix with the
	 * section built without the statement, so a statement whose addition ALSO perturbed earlier bytes
	 * would break this rather than quietly report a length that disagrees with its own cost.
	 */
	it("reports text weighing exactly what the statement is charged", () => {
		for (const statement of inspection.statements) {
			expect(Buffer.byteLength(statement.text, "utf8"), `${statement.id}: text and cost disagree`).toBe(
				statement.bytes,
			);
		}
	});

	it("gives an absent statement no text at all, not the text it would have had", () => {
		// The alternative would be reporting the text a rule WOULD contribute, which reads as though the
		// rule were in the prompt. Absent means absent on every field.
		for (const statement of inspection.statements.filter(entry => !entry.present)) {
			expect(statement.text, `${statement.id} is absent but carries text`).toBe("");
		}
	});

	it("prices a statement at what removing it would save, not at the length of its text", () => {
		// The distinction the whole measurement rests on. `delivery-contract/personality` is an XML
		// block whose text is 4 lines of template; what it COSTS is the rendered personality, which
		// is far larger. A test asserting text length would pass on an implementation that reported
		// template bytes and misattribute every interpolation in the prompt.
		const personality = inspection.statements.find(statement => statement.id === "delivery-contract/personality");
		const row = PROMPT_STATEMENTS.find(statement => statement.id === "delivery-contract/personality");

		expect(personality?.present).toBe(true);
		expect(row).toBeDefined();
		expect(personality?.bytes ?? 0, "the rendered cost is not the template's length").toBeGreaterThan(
			Buffer.byteLength(row?.text ?? "", "utf8") * 2,
		);
	});

	it("charges nothing for a rule this configuration leaves out", () => {
		// This assembly has no `task` tool, so the whole delegation family is off. Charging for it
		// would be the specific error that makes a cost report useless: paying attention to rules
		// that are not in the prompt.
		const absent = inspection.statements.filter(statement => !statement.present);

		expect(absent.length).toBeGreaterThan(10);
		for (const statement of absent) {
			expect(statement.bytes, `${statement.id} is absent but charged`).toBe(0);
			expect(statement.tokens, `${statement.id} is absent but charged tokens`).toBe(0);
		}
		expect(absent.map(statement => statement.id)).toContain("tool-policy/delegation-gates");
	});

	it("says why each rule is in or out, in the condition's own terms", () => {
		// The cost is only actionable next to the reason it is being paid. A reader seeing
		// `tool-policy/lsp` at 300 tokens needs "tools has lsp" to know what turns it off.
		const lsp = inspection.statements.find(statement => statement.id === "tool-policy/lsp");
		const always = inspection.statements.find(statement => statement.id === "role/principles");
		const codex = inspection.statements.find(statement => statement.id === "tool-policy/delegation-preferred");

		expect(lsp?.condition).toBe("tools has lsp");
		expect(always?.condition).toBe("always");
		expect(codex?.condition).toBe(
			"tools has task and not useCodexTaskPrompt and eagerTasks and not eagerTasksAlways",
		);
	});

	it("carries the purpose from the registry, so the cost sits next to the reason to pay it", () => {
		for (const statement of inspection.statements) {
			const row = PROMPT_STATEMENTS.find(entry => entry.id === statement.id);
			if (row === undefined) throw new Error(`${statement.id} is priced but not registered`);
			expect(statement.purpose, `${statement.id} lost its purpose`).toBe(row.purpose);
		}
	});
});

describe("inspection follows effective overrides", () => {
	/**
	 * An ablated statement is absent from both the provider blocks and the cost
	 * rows. Pricing the shipped text would describe a prompt nobody received.
	 */
	it("prices the effective statement arm rather than registered source text", async () => {
		const previous = process.env.VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS;
		process.env.VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS = JSON.stringify({ "role/principles": null });
		try {
			const armed = await inspectSystemPrompt({ toolNames: ["read"] });
			const principle = armed.statements.find(statement => statement.id === "role/principles");

			expect(armed.blocks.join("\n")).not.toContain("Optimize for correctness first");
			expect(principle).toMatchObject({ present: false, bytes: 0, tokens: 0, text: "" });
		} finally {
			if (previous === undefined) delete process.env.VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS;
			else process.env.VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS = previous;
		}
	});

	/**
	 * Once a complete section body is replaced, none of its shipped statement
	 * rows can honestly claim to be present in that body.
	 */
	it("marks shipped statements absent for a whole-section replacement", async () => {
		const previous = process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS;
		process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS = JSON.stringify({ role: "REPLACED ROLE BODY" });
		try {
			const armed = await inspectSystemPrompt({ toolNames: ["read"] });
			const role = armed.statements.filter(statement => statement.section === "role");

			expect(armed.blocks.join("\n")).toContain("REPLACED ROLE BODY");
			expect(role.length).toBeGreaterThan(0);
			expect(role.every(statement => !statement.present && statement.bytes === 0)).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS;
			else process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS = previous;
		}
	});
});

describe("the per-statement table", () => {
	const table = formatStatementTable(inspection);

	it("lists present rules largest first and totals them", () => {
		// Parsed by shape rather than by field position: the condition is the last column and it
		// contains spaces, so counting words back from the end reads the condition, not the cost.
		const rows = table.split("\n").slice(1);
		const priced = rows.slice(
			0,
			rows.findIndex(row => row.startsWith("TOTAL")),
		);
		const tokens = priced.map(row => {
			const match = row.match(/\s(\d+)\s+(\d+)\s+(\d+\.\d)%\s+\S/);
			expect(match, `unparseable row: ${row}`).not.toBeNull();
			return Number(match?.[2]);
		});

		expect(tokens.length).toBe(inspection.statements.filter(statement => statement.present).length);
		expect(tokens).toEqual([...tokens].sort((a, b) => b - a));
		const total = Number((rows.find(row => row.startsWith("TOTAL")) ?? "").trim().split(/\s+/).at(-1));
		expect(total).toBe(tokens.reduce((sum, count) => sum + count, 0));
	});

	it("names every rule this configuration leaves out, with the condition that would turn it on", () => {
		// The footer is the half a cost table cannot show, and the condition is what makes it
		// actionable: a reader can see that a rule needs `tools has lsp` rather than going to the
		// registry to find out.
		const absent = inspection.statements.filter(statement => !statement.present);

		expect(table).toContain(`not in this prompt (${absent.length} of ${inspection.statements.length}):`);
		for (const statement of absent) {
			expect(table).toContain(`${statement.id.padEnd(0)}`);
			expect(table).toContain(`needs ${statement.condition}`);
		}
	});

	it("refuses to price a prompt that was not assembled from statements", async () => {
		// Not an empty table, which would read as "the rules cost nothing". A custom system prompt
		// replaces the assembly, so there is no statement in it to charge for, and saying so is the
		// only honest output. `fromStatements` is what carries that distinction.
		const custom = await inspectSystemPrompt({ resolvedCustomPrompt: "just this" });

		expect(custom.fromStatements).toBe(false);
		expect(custom.statements).toEqual([]);
		expect(formatStatementTable(custom)).toContain("was not assembled from statements");
	});

	it("keeps one section's statements in row order in the registry, whatever the table sorts by", () => {
		// The table sorts by cost; the inspection must not. A consumer diffing two configurations
		// reads `statements` positionally, so registry order is the contract there.
		const delivery = inspection.statements.filter(statement => statement.section === "delivery-contract");

		expect(delivery.map(statement => statement.id)).toEqual(statementsOf("delivery-contract").map(row => row.id));
	});
});
