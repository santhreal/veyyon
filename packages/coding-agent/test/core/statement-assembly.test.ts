/**
 * Behavioral coverage for modular statement assembly.
 *
 * The zero-prose outer template is not an instruction fixture. These tests
 * therefore exercise the registry output directly across every gate-matrix
 * point, prove every registered static section is present and substantive, and
 * verify that statement conditions change only their intended text.
 */
import { describe, expect, it } from "bun:test";
import { bannerTable, splitBanneredDocument } from "@veyyon/coding-agent/system-prompt-builder/banner-grammar";
import {
	assembleDefaultTemplate,
	assembleStatementSections,
} from "@veyyon/coding-agent/system-prompt-builder/default-template";
import { splitPromptSections } from "@veyyon/coding-agent/system-prompt-builder/prompt-sections";
import {
	BANNERED_TEMPLATE_SECTIONS,
	TEMPLATE_SECTION_IDS,
} from "@veyyon/coding-agent/system-prompt-builder/section-registry";
import {
	conditionVariables,
	PROMPT_STATEMENTS,
	STATEMENT_SECTIONS,
	statementsOf,
} from "@veyyon/coding-agent/system-prompt-builder/statement-registry";
import { prompt } from "@veyyon/utils";
import { MATRIX } from "./statement-matrix";

/** Expand and split one fully modular static prompt document. */
function sectionsOf(template: string, context: Record<string, unknown>): Map<string, string> {
	const expanded = prompt.compile(template)(context);
	const regions = splitPromptSections(expanded, bannerTable(BANNERED_TEMPLATE_SECTIONS) as never);
	return new Map(
		regions.map(region => [region.name === "preamble" ? TEMPLATE_SECTION_IDS[0] : String(region.name), region.text]),
	);
}

/** Assemble every static section through the production registry path. */
function statementSections(context: Record<string, unknown>): Map<string, string> {
	const sections = assembleStatementSections(context);
	return sectionsOf(assembleDefaultTemplate(sections), context);
}

describe("the statement registry supplies every static prompt section", () => {
	for (const point of MATRIX) {
		describe(point.label, () => {
			/**
			 * Every registry section must survive real assembly. Missing or tiny
			 * output indicates a dropped module, condition, banner, or slot.
			 */
			it.each([...STATEMENT_SECTIONS])("assembles substantive %s content", section => {
				const assembled = statementSections(point.context).get(section);

				expect(assembled, `${section} is not in the assembled prompt`).toBeDefined();
				expect((assembled ?? "").length, `${section} rendered empty`).toBeGreaterThan(100);
			});
		});
	}

	/**
	 * The parameterized suite must never pass vacuously after an accidental
	 * registry deletion.
	 */
	it("contains registered statement sections", () => {
		expect(STATEMENT_SECTIONS.length).toBeGreaterThan(0);
	});
});

describe("the conditional arms are actually exercised", () => {
	it("produces different bytes for the two matrix points, or the matrix is decoration", () => {
		// If every point of the matrix rendered the same thing, the matrix would prove nothing and
		// the suite would be checking one arm twice.
		const on = statementSections({ renderMermaid: true }).get("role") ?? "";
		const off = statementSections({ renderMermaid: false }).get("role") ?? "";

		expect(on).not.toBe(off);
		expect(on.length).toBeGreaterThan(off.length);
	});

	it("includes the mermaid statement only when the terminal renders diagrams", () => {
		expect(statementSections({ renderMermaid: true }).get("role")).toContain("```mermaid");
		expect(statementSections({ renderMermaid: false }).get("role")).not.toContain("```mermaid");
	});

	it("keeps the unconditional part in both arms", () => {
		// The other half of the previous check: the conditional must remove ONLY its own statement.
		for (const renderMermaid of [true, false]) {
			const text = statementSections({ renderMermaid }).get("role") ?? "";

			expect(text).toContain("Engineering Principles");
			expect(text).toContain("Optimize for correctness first");
		}
	});

	it("covers every variable the statements depend on", () => {
		// A condition missing from the matrix would leave an untested arm in the
		// one modular prompt source.
		const exercised = new Set(MATRIX.flatMap(point => Object.keys(point.context)));
		const needed = new Set(PROMPT_STATEMENTS.flatMap(statement => conditionVariables(statement.condition)));

		const uncovered = [...needed].filter(variable => !exercised.has(variable));

		expect(uncovered, `converted conditionals not in the matrix: ${uncovered.join(", ")}`).toEqual([]);
	});
});

describe("section separators belong to document assembly", () => {
	/**
	 * Each non-final raw region must differ from its addressable section view by
	 * exactly the one newline inserted by the outer join.
	 */
	it("adds exactly one join newline between adjacent sections", () => {
		const context = { renderMermaid: true };
		const assembled = assembleStatementSections(context);
		const expanded = prompt.compile(assembleDefaultTemplate(assembled))(context);
		const raw = splitBanneredDocument(expanded, { banners: bannerTable(BANNERED_TEMPLATE_SECTIONS) });
		const view = statementSections(context);
		const lastSection = TEMPLATE_SECTION_IDS[TEMPLATE_SECTION_IDS.length - 1];

		for (const section of STATEMENT_SECTIONS) {
			if (section === lastSection) continue;
			const rawRegion = raw.find(region =>
				region.name === "preamble" ? TEMPLATE_SECTION_IDS[0] === section : region.name === section,
			);
			expect(rawRegion, `${section} is not an assembled region`).toBeDefined();
			if (rawRegion === undefined) return;

			expect(rawRegion.text).toBe(`${view.get(section) ?? ""}\n`);
		}
	});

	/**
	 * Statement modules may end their own final line, but they must never carry
	 * multiple trailing blank separators that document assembly will normalize.
	 */
	it("never ends an assembled section with two blank lines", () => {
		for (const point of MATRIX) {
			for (const section of STATEMENT_SECTIONS) {
				const text = statementSections(point.context).get(section) ?? "";

				expect(text.endsWith("\n"), `${section} does not end with a newline`).toBe(true);
				expect(text.endsWith("\n\n\n"), `${section} owns two blank separators`).toBe(false);
			}
		}
	});
});

describe("each statement carries its own bytes", () => {
	it("ends every statement with a newline, which is what makes concatenation exact", () => {
		// Statements are joined with NO separator, because Handlebars removes the line a standalone
		// block helper sits on: the bytes that survive are the block's contents and nothing else. A
		// statement missing its trailing newline would run into the next one, and a separator added
		// by the assembler would be a byte the template never emitted.
		for (const statement of PROMPT_STATEMENTS) {
			expect(statement.text.endsWith("\n"), `${statement.id} does not end with a newline`).toBe(true);
		}
	});

	it("holds text in every statement", () => {
		for (const statement of PROMPT_STATEMENTS) {
			// The floor is below the shortest real statement, which is `# 1. Scope` at 10 characters,
			// and above anything blank. The point is to catch an empty or whitespace-only file, which
			// is what an md file that failed to load looks like, not to police statement length.
			expect(statement.text.trim().length, `${statement.id} is empty`).toBeGreaterThan(5);
		}
	});

	it("orders a section's statements so concatenation reproduces it", () => {
		// Order is a fact about the prompt, not a convenience. `role` opens with the principles and
		// the Mermaid bullet joins that list, so reversing them would put a bullet before its header.
		const role = statementsOf("role").map(statement => statement.id);

		expect(role).toEqual(["role/principles", "role/mermaid-diagrams"]);
	});
});
