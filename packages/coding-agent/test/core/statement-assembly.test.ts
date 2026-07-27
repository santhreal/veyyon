/**
 * A converted section assembled from statements is BYTE-IDENTICAL to the template's render.
 *
 * WHY THIS SUITE EXISTS. Moving the system prompt from one Handlebars document to statement rows
 * is a mechanical change to text every model reads, so any drift is a silent behaviour change:
 * the build stays green, the tests stay green, and every model quietly receives slightly
 * different instructions. There is no way to notice that from the outside, which is why the
 * migration is not allowed to proceed on review alone.
 *
 * This is the gate. For every converted section it expands the shipped template, takes that
 * section's bytes, and requires `assembleSection` to produce the same string. Not the same length
 * and not the same trimmed content: the same bytes, because a lost trailing newline is exactly the
 * kind of difference that reads as harmless and changes how a model parses a list.
 *
 * IT COMPARES PRE-NORMALIZATION TEXT, and that is a correction rather than a shortcut. `render`
 * ends with `format(rendered, { renderPhase: "post-render" })`, applied ONCE over the whole
 * expanded template, and that pass collapses blank lines. Measured: a heading, an `{{#if skills}}`
 * block, a blank line, an `{{#if rules}}` block, a blank line and a heading render as
 * `"# Skills & Rules\nSKILLS BLOCK\n# Internal URLs"` when only skills is present. The blank line
 * before the last heading is gone even though it is unconditional text. So the whitespace around a
 * conditional block belongs to NO statement, and comparing post-`format` bytes would be asking
 * statement concatenation to reproduce a global pass it does not run.
 *
 * Comparing `compile()` output instead separates the two concerns cleanly: this suite tests which
 * statements are included and in what order, and `format` keeps owning normalization, applied
 * exactly once at the end by the real builder. The earlier version of this suite compared
 * post-`format` text and passed only because `conventions` and `role` happen not to trigger
 * collapsing, which made it weaker than it looked.
 *
 * IT USES THE REORDERER'S SEPARATOR CONVENTION, which is the one already documented on
 * `splitPromptSections` rather than a third answer invented here. Pre-normalization, a raw region
 * runs to the start of the next banner, so it carries the blank line that separates them: measured,
 * every converted section came out exactly one byte longer than its statements, and that byte was
 * the separator. A separator inside a section is wrong for the same reason the reorderer says it is,
 * that moving the section would carry a stray newline with it, so a statement never holds one and
 * the join owns it. `splitPromptSections` drops exactly one trailing newline per region and keeps
 * the last region's terminal newline, which is precisely what statement files do: every one ends
 * with a single newline, so the last section needs no special case.
 *
 * IT RUNS OVER A MATRIX, not over defaults. A section whose conditionals are all in their default
 * state proves nothing about the conditionals, and the conditionals are the whole reason the
 * statements exist. `role` is checked with `renderMermaid` both true and false, so both arms of
 * its one conditional are compared.
 *
 * WHAT IT DOES NOT DO. It does not check unconverted sections, and it must not: those are still
 * rendered from `system-prompt.md`, which remains their source of truth. `STATEMENT_SECTIONS` is
 * derived from the rows, so the coverage here follows the migration automatically rather than
 * through a second list that could lag it.
 */
import { describe, expect, it } from "bun:test";
import { bannerTable, splitBanneredDocument } from "@veyyon/coding-agent/system-prompt-builder/banner-grammar";
import {
	assembleDefaultTemplate,
	statementSectionOverrides,
} from "@veyyon/coding-agent/system-prompt-builder/default-template";
import { splitPromptSections } from "@veyyon/coding-agent/system-prompt-builder/prompt-sections";
import {
	BANNERED_TEMPLATE_SECTIONS,
	TEMPLATE_SECTION_IDS,
} from "@veyyon/coding-agent/system-prompt-builder/section-registry";
import {
	conditionVariables,
	PROMPT_STATEMENTS,
	SECTION_FIDELITY,
	STATEMENT_SECTIONS,
	statementsOf,
} from "@veyyon/coding-agent/system-prompt-builder/statement-registry";
import { prompt } from "@veyyon/utils";
import { collapseBlankLines, MATRIX, repairGluedBullet } from "./statement-matrix";

/**
 * One template's sections, expanded but NOT normalized.
 *
 * `prompt.compile` rather than `prompt.render`, which is the point of this suite: `render` appends
 * the global `format` pass, and `format` is a whole-document concern the real builder applies exactly
 * once. Comparing before it separates "are the right statements present, in the right order, with the
 * right bytes" from "how is the finished document spaced", and the second question belongs to
 * `statement-wiring.test.ts` where the whole document is what gets compared.
 *
 * BOTH SIDES GO THROUGH THIS, which is what makes the comparison meaningful now that `assembleSection`
 * returns TEMPLATE text rather than rendered text. An earlier version compared the assembler's raw
 * output against the template's EXPANDED region, which happened to pass while the only converted
 * sections contained no interpolation and broke the moment `runtime` arrived carrying `{{#each
 * skills}}`. Expanding both, as whole documents, treats them identically.
 *
 * `splitPromptSections` rather than a splitter written here: it is the one the reorder and inspection
 * paths use, and it is the view whose separator convention statements follow. The template banner
 * table is passed explicitly because the default is the RUNTIME table, and a base template has only
 * template sections in it. Region names are the registry's kebab ids, the same vocabulary the rows
 * use, so nothing needs converting; the unnamed leading region is renamed exactly as
 * `splitDefaultTemplate` renames it.
 */
function sectionsOf(template: string, context: Record<string, unknown>): Map<string, string> {
	const expanded = prompt.compile(template)(context);
	const regions = splitPromptSections(expanded, bannerTable(BANNERED_TEMPLATE_SECTIONS) as never);
	return new Map(
		regions.map(region => [region.name === "preamble" ? TEMPLATE_SECTION_IDS[0] : String(region.name), region.text]),
	);
}

/**
 * The shipped template's sections: what every converted section has to reproduce.
 *
 * With the one declared template defect repaired, the same repair `statement-wiring.test.ts` applies
 * for the same reason: the template glues a bullet onto the end of a sentence, so `delegated.-` is one
 * token, and the statements deliberately do not. Repairing the template side keeps every other word in
 * the section held to equality instead of exempting the section.
 */
function templateSections(context: Record<string, unknown>): Map<string, string> {
	const sections = sectionsOf(assembleDefaultTemplate(), context);
	return new Map([...sections].map(([id, text]) => [id, repairGluedBullet(text)]));
}

/** The same sections with the converted ones coming from statements instead. */
function statementSections(context: Record<string, unknown>): Map<string, string> {
	return sectionsOf(assembleDefaultTemplate(statementSectionOverrides(context)), context);
}

describe("statements reproduce the template byte for byte", () => {
	for (const point of MATRIX) {
		describe(point.label, () => {
			it.each([...STATEMENT_SECTIONS])("assembles %s identically", section => {
				const fromTemplate = templateSections(point.context).get(section);

				// A converted section the assembled prompt does not contain would make the comparison
				// below vacuous, so the absence is a failure rather than a skip.
				expect(fromTemplate, `${section} is not in the rendered prompt`).toBeDefined();
				// For the compiler only. The assertion above is what fails when the section is absent.
				if (fromTemplate === undefined) return;

				const assembled = statementSections(point.context).get(section) ?? "";

				// The bar is byte identity, and `SECTION_FIDELITY` is where a section says it cannot
				// meet it. Only `runtime` does, because its template interleaves UNCONDITIONAL blank
				// lines between conditional blocks and a statement cannot own an unconditional byte;
				// its three reviewed spacing differences are enumerated in `statement-wiring.test.ts`
				// against the whole rendered document, which is where they are actually observable.
				// Reading the classification rather than special-casing a section name here means a
				// newly converted section gets the strict comparison unless it declares otherwise.
				if (SECTION_FIDELITY[section] === "spacing-normalized") {
					// Words byte-exact, and the difference confined to blank lines.
					expect(assembled.replace(/\s+/g, " ").trim()).toBe(fromTemplate.replace(/\s+/g, " ").trim());
					expect(collapseBlankLines(assembled)).toBe(collapseBlankLines(fromTemplate));
					return;
				}
				expect(assembled).toBe(fromTemplate);
			});
		});
	}

	it("compares against real text, not two empty strings", () => {
		// The failure mode this suite could rot into: both sides empty, passing forever.
		const rendered = templateSections(MATRIX[0].context);

		for (const section of STATEMENT_SECTIONS) {
			expect((rendered.get(section) ?? "").length, `${section} rendered empty`).toBeGreaterThan(100);
			expect((statementSections(MATRIX[0].context).get(section) ?? "").length).toBeGreaterThan(100);
		}
	});

	it("has converted at least one section, so the loop above is not empty", () => {
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

	it("covers every variable the converted statements depend on", () => {
		// Fails when a section is converted whose conditionals the matrix does not exercise, which
		// is how a byte-identity gate silently stops covering the arms it was written for.
		const exercised = new Set(MATRIX.flatMap(point => Object.keys(point.context)));
		// `conditionVariables` from the registry rather than a second switch here: a copy would
		// stop agreeing with the real one the first time a new condition form is added, and this
		// check would then quietly stop covering it.
		const needed = new Set(PROMPT_STATEMENTS.flatMap(statement => conditionVariables(statement.condition)));

		const uncovered = [...needed].filter(variable => !exercised.has(variable));

		expect(uncovered, `converted conditionals not in the matrix: ${uncovered.join(", ")}`).toEqual([]);
	});
});

describe("the separator between sections belongs to the join, not to a section", () => {
	it("measures the raw region as exactly one newline longer than the section's own bytes", () => {
		// The reason this suite uses the reorderer's view. Pre-normalization a raw region runs to the
		// start of the next banner, so it ends with the blank line separating them. That is a real byte
		// in the template and it belongs to no statement, which this asserts by measurement rather
		// than by trimming both sides until they agree: the difference is exactly "\n", so any OTHER
		// difference still fails the gate above.
		const context = { renderMermaid: true };
		const expanded = prompt.compile(assembleDefaultTemplate())(context);
		const raw = splitBanneredDocument(expanded, { banners: bannerTable(BANNERED_TEMPLATE_SECTIONS) });
		const view = templateSections(context);

		const lastSection = TEMPLATE_SECTION_IDS[TEMPLATE_SECTION_IDS.length - 1];
		for (const section of STATEMENT_SECTIONS) {
			// Only a byte-exact section can be measured to the byte; a spacing-normalized one is held
			// to its enumerated difference in the wiring gate instead.
			if (SECTION_FIDELITY[section] === "spacing-normalized") continue;
			// And the final section has nothing after it to be separated from, so there is no
			// separator byte to find. That is the same rule `statementSectionOverrides` applies.
			if (section === lastSection) continue;
			const rawRegion = raw.find(region =>
				region.name === "preamble" ? TEMPLATE_SECTION_IDS[0] === section : region.name === section,
			);
			expect(rawRegion, `${section} is not a template region`).toBeDefined();
			if (rawRegion === undefined) return;

			expect(rawRegion.text).toBe(`${view.get(section) ?? ""}\n`);
		}
	});

	it("never ends an assembled section with a blank line", () => {
		// The other direction: if the assembler emitted the separator itself, joining sections would
		// produce two blank lines between them, and `format` collapsing that back is exactly the
		// coincidence this suite was rewritten to stop relying on.
		for (const point of MATRIX) {
			for (const section of STATEMENT_SECTIONS) {
				const text = statementSections(point.context).get(section) ?? "";

				expect(text.endsWith("\n"), `${section} does not end with a newline`).toBe(true);
				// A spacing-normalized section's last statement may own a trailing blank line as its
				// separation from the block after it, which is exactly why `runtime` is classified
				// that way. What no section may do is end with TWO blank lines, since `format`
				// deletes a run of 2+ and the gap would silently vanish.
				if (SECTION_FIDELITY[section] !== "spacing-normalized") {
					expect(text.endsWith("\n\n"), `${section} ends with a separator it does not own`).toBe(false);
				}
				expect(text.endsWith("\n\n\n"), `${section} ends with two blank lines, which format deletes`).toBe(false);
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
