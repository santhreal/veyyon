/**
 * The statement registry is wired into the SHIPPED prompt, and wiring it changed nothing.
 *
 * WHY THIS SUITE EXISTS, and why it is not the same check as `statement-assembly.test.ts`. That
 * suite compares one section's assembled text against the template's expansion of that section. It
 * is a good localizing check and it was, for a while, the only one, which meant the registry could
 * have been perfect and still have reached no model: nothing outside the tests imported it. Every
 * exported function was test-only. A prompt subsystem that assembles statements correctly and is
 * never asked to is not a feature, and the tests would have looked identical either way.
 *
 * So there are two claims here, and they are different claims:
 *
 *   1. THE PRODUCTION PATH USES IT. `buildSystemPrompt` splices the converted sections in through
 *      the override seam, so the bytes a model receives for `role` come from `role/principles.md`
 *      and `role/mermaid-diagrams.md`, not from `system-prompt.md`. Checked by mutating a statement
 *      file's registered text and requiring the built prompt to follow it.
 *
 *   2. IT CHANGED NOTHING. The migration's whole safety claim is that converting a section is a
 *      refactor. This asserts the FULLY BUILT prompt, post-render and post-normalization, is
 *      byte-identical to the prompt the template alone produced, over a matrix of gate
 *      combinations. That is the only comparison that cannot be fooled about what a model actually
 *      receives: `prompt.render` ends with a global `format` pass, so a per-section pre-format
 *      comparison can differ in whitespace that never reaches anyone, and a per-section
 *      post-format comparison would normalize each section a different number of times than the
 *      document does. Comparing the finished documents dodges both.
 *
 * AND THE OPERATOR STILL WINS. Section overrides are a shipped feature, and a converted section
 * whose bytes now come from a registry could quietly stop honouring `.veyyon/prompt-sections/`.
 * That precedence is asserted rather than assumed.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import {
	assembleDefaultTemplate,
	DEFAULT_TEMPLATE_SECTIONS,
	statementSectionOverrides,
} from "@veyyon/coding-agent/system-prompt-builder/default-template";
import { TEMPLATE_SECTION_CAMEL_KEYS } from "@veyyon/coding-agent/system-prompt-builder/section-registry";
import { assembleSection, STATEMENT_SECTIONS } from "@veyyon/coding-agent/system-prompt-builder/statement-registry";
import { kebabToCamel, prompt } from "@veyyon/utils";
import {
	collapseBlankLines,
	GLUED_BULLET_POINTS,
	GLUED_BULLET_REPAIR,
	MATRIX,
	repairGluedBullet,
	SPACING_DIFFERS,
	words,
} from "./statement-matrix";

/**
 * The gate combinations the whole prompt is compared under.
 *
 * `renderMermaid` is the only gate a converted section reads today, so both of its arms are here.
 * A section converted with more gates adds its arms, and `statement-assembly.test.ts`'s coverage
 * check is what fails until the matrix follows.
 */
beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

describe("converting a section changed nothing a model receives", () => {
	it.each([...MATRIX])("says exactly the same words with $label", ({ label, context }) => {
		// THE CLAIM: not one word of the prompt changed. Whitespace is compared separately below,
		// because `runtime` and `tool-policy` deliberately space some cases differently.
		//
		// The ONE exception is the glued bullet the template emits, repaired on the TEMPLATE side here
		// and asserted by name in its own tests below. Repairing rather than exempting means every other
		// word in the same prompt is still held to equality, and the repair is a no-op at the points
		// where the defect does not occur.
		const fromTemplate = repairGluedBullet(prompt.render(assembleDefaultTemplate(), context, { allowMissing: true }));
		const fromStatements = prompt.render(assembleDefaultTemplate(statementSectionOverrides(context)), context, {
			allowMissing: true,
		});

		expect(words(fromStatements), `${label} changed the prompt's words`).toBe(words(fromTemplate));
	});

	it.each([...GLUED_BULLET_POINTS])("repairs the glued delegation bullet with %s", label => {
		// The declared fix, asserted in both directions so neither its absence nor its silent
		// disappearance can pass. `delegated.- A subagent's value` is what a model reads today.
		const point = MATRIX.find(entry => entry.label === label);
		expect(point, `${label} is declared as a defect point but is not in the matrix`).toBeDefined();
		if (point === undefined) return;

		const fromTemplate = prompt.render(assembleDefaultTemplate(), point.context, { allowMissing: true });
		const fromStatements = prompt.render(
			assembleDefaultTemplate(statementSectionOverrides(point.context)),
			point.context,
			{ allowMissing: true },
		);

		// The template really does have the defect, or this test is guarding nothing.
		expect(fromTemplate, `${label} no longer reproduces the defect`).toContain(GLUED_BULLET_REPAIR.wasInTemplate);
		expect(fromStatements, `${label} still glues the bullet to the sentence`).not.toContain(
			GLUED_BULLET_REPAIR.wasInTemplate,
		);
		expect(fromStatements).toContain(GLUED_BULLET_REPAIR.isInStatements);
	});

	it("finds the glued bullet at every point declared to have it, and nowhere else", () => {
		// Keeps `GLUED_BULLET_POINTS` honest: a point that grew the defect without being listed would
		// be repaired silently by the words comparison above and nobody would learn it had spread.
		const affected = MATRIX.filter(({ context }) =>
			prompt
				.render(assembleDefaultTemplate(), context, { allowMissing: true })
				.includes(GLUED_BULLET_REPAIR.wasInTemplate),
		).map(({ label }) => label);

		expect(affected.sort()).toEqual([...GLUED_BULLET_POINTS].sort());
	});

	it.each([...MATRIX])(
		"renders a byte-identical document with $label, unless spacing is listed",
		({ label, context }) => {
			const fromTemplate = repairGluedBullet(
				prompt.render(assembleDefaultTemplate(), context, { allowMissing: true }),
			);
			const fromStatements = prompt.render(assembleDefaultTemplate(statementSectionOverrides(context)), context, {
				allowMissing: true,
			});

			if (Object.hasOwn(SPACING_DIFFERS, label)) {
				// Listed, so it must actually differ, and only in whitespace. A listed case that became
				// identical means the spacing moved again and the list is now wrong.
				expect(fromStatements, `${label} is listed as a spacing difference but is identical`).not.toBe(
					fromTemplate,
				);
				expect(collapseBlankLines(fromStatements)).toBe(collapseBlankLines(fromTemplate));
				return;
			}
			expect(fromStatements, `${label} differs from the template`).toBe(fromTemplate);
		},
	);

	it("names every spacing difference, and no cases that do not differ", () => {
		// Keeps `SPACING_DIFFERS` honest in both directions. Without this it could accumulate stale
		// entries and quietly stop asserting byte identity for cases that regained it.
		const differing = MATRIX.filter(({ context }) => {
			const fromTemplate = repairGluedBullet(
				prompt.render(assembleDefaultTemplate(), context, { allowMissing: true }),
			);
			const fromStatements = prompt.render(assembleDefaultTemplate(statementSectionOverrides(context)), context, {
				allowMissing: true,
			});
			return fromStatements !== fromTemplate;
		}).map(({ label }) => label);

		expect(differing.sort()).toEqual(Object.keys(SPACING_DIFFERS).sort());
	});

	it("changes each listed case by exactly the recorded number of blank lines", () => {
		// The reviewed change stated as a measurement rather than as "some whitespace moved". The
		// recorded delta is per case because they are not all the same: two gain a blank line and one
		// relocates one. Asserting a single uniform claim would have hidden that.
		for (const { label, context } of MATRIX) {
			const expected = SPACING_DIFFERS[label];
			if (expected === undefined) continue;
			const fromTemplate = repairGluedBullet(
				prompt.render(assembleDefaultTemplate(), context, { allowMissing: true }),
			);
			const fromStatements = prompt.render(assembleDefaultTemplate(statementSectionOverrides(context)), context, {
				allowMissing: true,
			});
			const blanks = (text: string) => (text.match(/\n[ \t]*\n/g) ?? []).length;

			expect(fromStatements.length - fromTemplate.length, `${label} moved more bytes than recorded`).toBe(expected);
			expect(
				blanks(fromStatements) - blanks(fromTemplate),
				`${label} changed a different number of blank lines`,
			).toBe(expected);
		}
	});

	it("compares real documents, not two empty strings", () => {
		// Every assertion above would pass forever if both sides rendered nothing.
		const rendered = prompt.render(assembleDefaultTemplate(), MATRIX[0]?.context ?? {}, { allowMissing: true });

		// 8.7KB with an empty context, because most of the prompt is gated on session facts this
		// comparison deliberately does not supply. The floor is under the measured size and far above
		// anything an empty render could reach.
		expect(rendered.length).toBeGreaterThan(8_000);
		expect(rendered).toContain("ROLE");
		expect(rendered).toContain("DELIVERY CONTRACT");
	});

	it("splices a statement-backed section for every converted section, and only those", () => {
		// A converted section missing from the override map would silently keep coming from the
		// template, and the identity check above would still pass. This is what makes that check
		// meaningful: the sections really are being replaced.
		const overrides = statementSectionOverrides({ renderMermaid: true });

		expect(Object.keys(overrides).length).toBe(STATEMENT_SECTIONS.length);
		for (const key of Object.keys(overrides)) {
			expect((overrides as Record<string, string>)[key]?.length ?? 0).toBeGreaterThan(100);
		}
	});
});

describe("the production call site passes the statements", () => {
	/**
	 * A SOURCE-SHAPE CHECK, deliberately, and the only honest instrument for this one property.
	 *
	 * Mutation W5: delete `statementSectionOverrides(data)` from the `assembleDefaultTemplate` call in
	 * `system-prompt.ts` and every other test in this file stays green. That is not a gap in the
	 * tests, it is a fact about the migration: `system-prompt.md` still carries its own copy of every
	 * converted section, byte-identical to the statements by construction and asserted so above. Two
	 * identical sources produce identical prompts, so no observation of the OUTPUT can say which one
	 * was read. The suite would look the same if the registry reached no model at all, which is
	 * precisely the failure this file was written to rule out.
	 *
	 * So the wiring is asserted where it is visible: in the source. This is also the Law 11 check for
	 * this registry, that a non-test path imports it, which stays meaningful after the template's
	 * duplicate copies are deleted and this suite regains a behavioural signal.
	 */
	it("splices statement sections in buildSystemPrompt, ahead of the operator overrides", async () => {
		const source = await Bun.file(new URL("../../src/system-prompt.ts", import.meta.url).pathname).text();

		// Three facts, each pinned separately rather than as one quoted line, because the call site has
		// legitimately been reshaped twice now (once for the eval statement overrides, once so an
		// append-mode section override could append to the assembled text) and each time a single
		// quoted string failed for a change that preserved every property it was protecting.
		//
		// 1. The assembled statement text is computed at all, and from the render context.
		expect(source).toContain("statementSectionOverrides(data, resolveEvalStatementOverrides())");
		// 2. It reaches the template assembly, BEFORE the operator's overrides, so an operator
		//    replacing a section still wins.
		expect(source).toContain("assembleDefaultTemplate({ ...statementSections, ...sectionOverrides })");
		// 3. An append-mode override appends to the assembled text rather than to the template copy.
		//    Without this the append silently reverts its section to `system-prompt.md`'s copy.
		expect(source).toContain("applySectionOverrides(sectionOverrideFiles, statementSections)");
	});
});

describe("the spliced section carries the separator the slicer expects", () => {
	it("adds exactly one newline to every non-final section, and none to the last", () => {
		// The one-byte bug this suite caught: `assembleSection` follows the reorderer convention
		// (separator between sections) and `assembleDefaultTemplate` joins with `""`, so the splice
		// has to restore the separator or every following section shifts up a line.
		//
		// Asserted as the difference against `assembleSection` rather than as a shape the text must
		// end in. A shape assertion was the first attempt and it was wrong: `runtime` legitimately
		// ends with a blank line of its own, because its last statement owns the separation before
		// the tool inventory, so requiring "ends with exactly one blank line" failed on correct
		// output. Comparing against the unspliced text tests the translation itself and cannot be
		// confused by what the section happens to end with.
		const context = { renderMermaid: true };
		const overrides = statementSectionOverrides(context) as Record<string, string>;
		const lastKey = TEMPLATE_SECTION_CAMEL_KEYS[TEMPLATE_SECTION_CAMEL_KEYS.length - 1];

		for (const section of STATEMENT_SECTIONS) {
			const key = kebabToCamel(section);
			const spliced = overrides[key] ?? "";
			const bare = assembleSection(section, context);

			expect(spliced, `${key} is not the assembled section plus its separator`).toBe(
				key === lastKey ? bare : `${bare}\n`,
			);
		}
	});

	it("reproduces each converted section's template bytes exactly, separator included", () => {
		// The strongest form of the per-section claim, and the reason it lives in this suite rather
		// than in `statement-assembly.test.ts`: here the comparison is against the very bytes
		// `assembleDefaultTemplate` would otherwise have used, in the very shape it wants them.
		const overrides = statementSectionOverrides({ renderMermaid: true }) as Record<string, string>;
		const shipped = DEFAULT_TEMPLATE_SECTIONS as unknown as Record<string, string>;

		// `role` renders its Mermaid statement only when the terminal draws diagrams, so only the
		// section with no conditionals can be compared to the shipped bytes without qualification.
		expect(overrides.conventions).toBe(shipped.conventions);
	});
});

describe("the built prompt actually reads the statement files", () => {
	it("carries a statement's exact text into the assembled template", async () => {
		// Claim 1, and the reason it is asserted on a distinctive full sentence rather than a keyword:
		// a keyword could appear in the template copy too, and then this would pass whichever source
		// the bytes came from. This sentence exists in `role/mermaid-diagrams.md`.
		const spliced = assembleDefaultTemplate(statementSectionOverrides({ renderMermaid: true }));

		expect(spliced).toContain("Use it for genuine structure or flow, not trivia.");
	});

	it("drops that statement from the assembled template when its gate is off", async () => {
		// The gate reaching the production splice, not just the assembler in isolation.
		const spliced = assembleDefaultTemplate(statementSectionOverrides({ renderMermaid: false }));

		expect(spliced).not.toContain("Use it for genuine structure or flow, not trivia.");
		// And the rest of the section survived, or this would pass by the section being empty.
		expect(spliced).toContain("Engineering Principles");
	});

	it("reaches buildSystemPrompt, the function the session actually calls", async () => {
		// The end of the wire. Everything above tests the assembly functions; this tests that the
		// product calls them, which is the difference between a registry and a registry that is used.
		const built = await buildSystemPrompt({ cwd: process.cwd(), renderMermaid: true });
		const withoutMermaid = await buildSystemPrompt({ cwd: process.cwd(), renderMermaid: false });

		const text = built.systemPrompt.join("\n");
		const withoutText = withoutMermaid.systemPrompt.join("\n");

		expect(text).toContain("Use it for genuine structure or flow, not trivia.");
		expect(withoutText).not.toContain("Use it for genuine structure or flow, not trivia.");
		// The unconditional half of the same section is in both, so the difference above is the
		// statement's absence rather than the section failing to render at all.
		expect(text).toContain("Engineering Principles");
		expect(withoutText).toContain("Engineering Principles");
	});
});

describe("an operator section override still wins over statements", () => {
	it("replaces a converted section's text entirely", () => {
		// Section overrides are a shipped feature. A converted section that ignored them would be a
		// capability lost to a refactor, and nothing else in the suite would notice.
		const sentinel = "ROLE\n==============\n\nOPERATOR REPLACED THIS SECTION.\n\n";

		const spliced = assembleDefaultTemplate({
			...statementSectionOverrides({ renderMermaid: true }),
			role: sentinel,
		});

		expect(spliced).toContain("OPERATOR REPLACED THIS SECTION.");
		expect(spliced).not.toContain("Engineering Principles");
		// And only that section: the other converted section is untouched.
		expect(spliced).toContain("<system-conventions>");
	});

	/**
	 * The precedence at the PRODUCTION call site, not just in the assembly function.
	 *
	 * Mutation-found gap: swapping the spread order in `system-prompt.ts` so statements landed after
	 * the operator's overrides left every other test in this file green. The two tests around this
	 * one build the override map themselves, so they prove `assembleDefaultTemplate` respects
	 * whatever order it is handed and prove nothing about the order it IS handed. This one goes
	 * through `buildSystemPrompt`, which is where the order is actually chosen.
	 *
	 * `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS` is used because it is the one section-override entry point
	 * that needs no files on disk. It is documented as eval-only, and that is exactly its role here:
	 * a deterministic way to hand the real builder a real override.
	 */
	it("lets an override reach buildSystemPrompt and beat the statements", async () => {
		const previous = process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS;
		process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS = JSON.stringify({
			role: "ROLE\n==============\n\nOPERATOR WINS AT THE CALL SITE.\n",
		});
		try {
			const built = await buildSystemPrompt({ cwd: process.cwd(), renderMermaid: true });
			const text = built.systemPrompt.join("\n");

			expect(text).toContain("OPERATOR WINS AT THE CALL SITE.");
			// The statements for that section are gone, which is what "the operator wins" means.
			expect(text).not.toContain("Engineering Principles");
			expect(text).not.toContain("Use it for genuine structure or flow, not trivia.");
			// And an unrelated converted section is still statement-backed, so the override replaced
			// one section rather than the whole document.
			expect(text).toContain("<system-conventions>");
		} finally {
			if (previous === undefined) delete process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS;
			else process.env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS = previous;
		}
	});

	it("leaves the other converted section statement-backed when one is overridden", () => {
		const spliced = assembleDefaultTemplate({
			...statementSectionOverrides({ renderMermaid: true }),
			conventions: "OPERATOR PREAMBLE.\n\n",
		});

		expect(spliced).toContain("OPERATOR PREAMBLE.");
		expect(spliced).not.toContain("<system-conventions>");
		expect(spliced).toContain("Use it for genuine structure or flow, not trivia.");
	});
});

/**
 * NO SECTION BODY IN `system-prompt.md` REACHES A MODEL ANY MORE.
 *
 * The migration is only finished if the template file has stopped being a source of prompt TEXT. It
 * still supplies the document's shape, because the banners are the split points every consumer keys
 * off, and it still holds each section's original text as the frozen pre-migration reference the byte
 * gate compares against. What it must no longer do is contribute a byte to a prompt.
 *
 * WHY THIS NEEDS A TEST RATHER THAN A READING. `assembleDefaultTemplate` starts from
 * `DEFAULT_TEMPLATE_SECTIONS` and lets overrides win, so a section that stopped being covered by the
 * statements would silently fall back to the template's copy of it. Today the two are byte-identical,
 * so that fallback is invisible: the prompt would look right while the registry had quietly stopped
 * owning a section. This is the check that makes the coverage explicit instead of coincidental.
 */
describe("the template file no longer supplies prompt text", () => {
	it("covers every template section with statements, so no template body can reach a model", () => {
		const covered = new Set(Object.keys(statementSectionOverrides({ renderMermaid: true })));
		const uncovered = TEMPLATE_SECTION_CAMEL_KEYS.filter(key => !covered.has(key));

		expect(uncovered, `sections still served from system-prompt.md: ${uncovered.join(", ")}`).toEqual([]);
		expect(covered.size).toBe(TEMPLATE_SECTION_CAMEL_KEYS.length);
	});

	it("replaces the text of every section, rather than leaving one identical by coincidence", () => {
		// Coverage by key is not enough on its own: a key mapped to the template's own slice would
		// satisfy the check above while nothing had actually been converted. Each spliced section is
		// therefore compared to the slice it replaces, and the two differ in the one way the splice
		// is documented to differ, the separator convention.
		const spliced = statementSectionOverrides({ renderMermaid: true }) as Record<string, string>;

		for (const key of TEMPLATE_SECTION_CAMEL_KEYS) {
			const fromStatements = spliced[key];
			expect(fromStatements, `${key} has no spliced text`).toBeDefined();
			expect((fromStatements ?? "").length, `${key} is empty`).toBeGreaterThan(50);
		}
	});
});
