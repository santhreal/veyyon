/**
 * Read back the system prompt a given configuration would actually send.
 *
 * WHY THIS EXISTS. The system prompt is not a document, it is a program. It is
 * assembled from named statements, each with a condition, so whole regions
 * appear or vanish with the live tool set, with settings, with the workspace and
 * with the model's harness profile, which can reorder the sections outright. And
 * within a statement Handlebars still decides what it says. Reading the rules
 * tells you what COULD ship. It does not tell you what did.
 *
 * TWO GRANULARITIES, because they answer different questions. `sections` says
 * what is taking up the prompt, which is where to look. `statements` says what
 * each individual RULE costs and which rules this configuration leaves out,
 * which is what an operator or an eval can act on: TOOL POLICY is one section
 * row and 9KB of prompt, so at section granularity the answer is "tool policy is
 * large".
 *
 * Before this, the only way to see a real prompt was to start a session and
 * export it out of a session dump — slow enough that in practice nobody did,
 * so prompt changes were reviewed as diffs of template fragments rather than as
 * the artifact the model receives. Reviewing a program's source in place of its
 * output is guesswork, and it is exactly how a silently-dropped section
 * survives review.
 *
 * WHAT IT GUARANTEES. The text comes from the same `buildSystemPrompt` the
 * agent calls, on options resolved the same way. It is not a reimplementation
 * of assembly, because a second assembler would drift from the first and then
 * confidently report a prompt nobody ever sent.
 *
 * THE BLOCK BOUNDARY IS PRESERVED because it is a caching contract, not a
 * formatting detail: `buildSystemPrompt` returns template sections in one array
 * entry and volatile runtime sections in their own so the static prefix stays
 * byte-stable for the provider's cache. An inspection that concatenated
 * everything into one string would hide the single most expensive thing a
 * prompt change can get wrong.
 */
import { estimateTokensFromText, prompt } from "@veyyon/utils";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "../system-prompt";
import { splitPromptSections } from "./prompt-sections";
import { SYSTEM_PROMPT_SECTIONS } from "./section-registry";
import {
	conditionHolds,
	describeCondition,
	STATEMENT_SECTIONS,
	type StatementContext,
	type StatementOverrides,
	sectionBanner,
	statementsOf,
} from "./statement-registry";

/** One section of an assembled prompt, with what it cost. */
export interface InspectedSection {
	/** Registry id, or `preamble` for the text before the first banner. */
	readonly id: string;
	/**
	 * Where the text came from, per the registry.
	 *
	 * `unregistered` is not a formality: it means the assembled prompt carries a
	 * banner the registry does not know, which is what a custom template or an
	 * appended block looks like. Those cannot be reordered or overridden, so
	 * naming them is the point rather than an edge case.
	 */
	readonly source: "template" | "runtime" | "preamble" | "unregistered";
	/** Which `systemPrompt[]` entry it landed in — the provider caching boundary. */
	readonly blockIndex: number;
	readonly bytes: number;
	readonly tokens: number;
	readonly text: string;
}

/**
 * A registered section that the assembled prompt does not contain.
 *
 * The half an inspection could not report. `sections` answers "what is in this
 * prompt", which cannot distinguish a feature being off from assembly having
 * broken — and the system prompt is the one where that matters most, since half
 * its rules are conditional. The subagent prompt has had
 * this distinction since its registry was written (`veyyon prompt --prompt
 * subagent` marks each section optional or always); the system prompt, the larger
 * and far more conditional of the two, did not.
 */
export interface MissingSection {
	readonly id: string;
	/** From the registry: `false` means the prompt is broken, not merely minimal. */
	readonly optional: boolean;
	readonly purpose: string;
}

/**
 * One statement, with what it costs the prompt it is in.
 *
 * WHY PER-STATEMENT COST EXISTS. A section breakdown answers "what is taking up the prompt" down
 * to the section, and TOOL POLICY is 9KB of it, so the answer for the section that matters most is
 * "tool policy is large", which nobody can act on. A statement is a single rule, so this is the
 * granularity at which someone decides a rule is not worth its tokens, and it is the number an
 * ablation needs before it can be designed rather than guessed at.
 */
export interface InspectedStatement {
	readonly id: string;
	readonly section: string;
	/** Why the row exists, from the registry, so the cost sits next to the reason to pay it. */
	readonly purpose: string;
	/** The condition in English, which is why this statement is or is not in this prompt. */
	readonly condition: string;
	readonly present: boolean;
	/**
	 * MARGINAL bytes: what the prompt would be shorter by without this statement, not the length of
	 * its text.
	 *
	 * The distinction is not pedantry. `render` ends in a `format` pass that collapses whitespace
	 * across statement boundaries, so the lengths of 34 statement texts do not add up to the length
	 * of the section they form, and reporting text length would produce a breakdown whose parts
	 * exceed the whole. Measured instead by assembling the section one statement at a time and taking
	 * the growth each one causes.
	 *
	 * WHAT THAT RECONCILES TO, exactly, because a cost breakdown whose parts do not add up to the
	 * whole is a breakdown nobody can trust:
	 *
	 *     section bytes = banner + sum of statement bytes + separator
	 *
	 * The banner belongs to the section assembler rather than to any statement,
	 * and `assembleDefaultTemplate` owns the one newline between adjacent static
	 * sections. `prompt-inspect.test.ts` pins the residual so a change in either
	 * convention cannot silently make the reported parts stop reconciling.
	 *
	 * Zero for an absent statement: it costs nothing, and that is the fact worth reporting.
	 */
	readonly bytes: number;
	readonly tokens: number;
	/**
	 * The rendered bytes this statement contributed, or `""` when it is absent.
	 *
	 * Defined as the marginal text for the same reason the cost is marginal: it is the growth this
	 * statement caused in its section, taken after the common prefix with the section built without
	 * it. So `Buffer.byteLength(text) === bytes` always, which `prompt-inspect.test.ts` asserts across
	 * the matrix; a statement whose addition also perturbed earlier bytes would break that equality
	 * rather than quietly report a length that disagrees with its own cost.
	 */
	readonly text: string;
}

export interface PromptInspection {
	/** The blocks exactly as `buildSystemPrompt` returns them. */
	readonly blocks: readonly string[];
	readonly sections: readonly InspectedSection[];
	/** Registered sections absent from this assembly, in registry order. */
	readonly missing: readonly MissingSection[];
	/**
	 * Every registered statement, present or not, in registry order.
	 *
	 * Empty when this prompt did not come from the statement registry, which is a custom system
	 * prompt or `NULL_PROMPT`. `fromStatements` is what distinguishes that from a registry with no
	 * rows, because the two look identical here and mean opposite things.
	 */
	readonly statements: readonly InspectedStatement[];
	/** Whether the blocks above were assembled from statements at all. */
	readonly fromStatements: boolean;
	readonly totalBytes: number;
	readonly totalTokens: number;
}

const SECTION_SOURCE: ReadonlyMap<string, "template" | "runtime"> = new Map(
	SYSTEM_PROMPT_SECTIONS.map(section => [section.id as string, section.source]),
);

/**
 * Assemble the prompt for `options` and break it down by section.
 *
 * Byte-faithful: concatenating `sections` within a block reproduces that block,
 * and `blocks` is what the provider receives. Nothing is trimmed or normalized
 * on the way out, because an inspection that tidied its output would disagree
 * with the bytes it claims to report.
 */
export async function inspectSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<PromptInspection> {
	const { systemPrompt, statementContext, statementOverrides, replacedStatementSections } =
		await buildSystemPrompt(options);
	const sections: InspectedSection[] = [];

	for (const [blockIndex, block] of systemPrompt.entries()) {
		for (const rendered of splitPromptSections(block)) {
			// A split can yield an empty leading preamble when a block opens
			// directly on a banner; reporting it would invent a section that is not
			// in the prompt.
			if (rendered.name === "preamble" && rendered.text === "") continue;
			const id = resolveSectionId(rendered.name, blockIndex);
			sections.push({
				id,
				source: sourceOf(id),
				blockIndex,
				bytes: Buffer.byteLength(rendered.text, "utf8"),
				tokens: estimateTokensFromText(rendered.text),
				text: rendered.text,
			});
		}
	}

	const present = new Set(sections.map(section => section.id));
	const missing = SYSTEM_PROMPT_SECTIONS.filter(section => !present.has(section.id)).map(section => ({
		id: section.id,
		optional: section.optional,
		purpose: section.purpose,
	}));

	return {
		blocks: systemPrompt,
		sections,
		missing,
		statements:
			statementContext === null || statementOverrides === null
				? []
				: priceStatements(statementContext, statementOverrides, new Set(replacedStatementSections)),
		fromStatements: statementContext !== null,
		totalBytes: sections.reduce((sum, section) => sum + section.bytes, 0),
		totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
	};
}

/**
 * What each statement adds to the section it is in, measured rather than estimated.
 *
 * HOW, and why not more simply. Rendering a statement on its own and measuring the result is the
 * obvious approach and it is wrong twice: `format` normalizes whitespace across statement
 * boundaries, so 34 independently rendered statements do not reconstruct the section they form, and
 * a statement whose text is `{{toolInventory}}` would be priced against a context-free render. So
 * this assembles the section incrementally, in row order, through the SAME `prompt.render` the
 * builder uses, and takes each statement's cost as the growth it causes. See
 * {@link InspectedStatement.bytes} for what those costs reconcile to and where that is pinned.
 *
 * Absent statements are reported at zero rather than omitted, because "this rule is off and costs
 * you nothing" is the answer to a question somebody is asking, and a list of only present rows
 * cannot distinguish an off rule from a rule that no longer exists.
 */
function priceStatements(
	context: StatementContext,
	overrides: StatementOverrides,
	replacedSections: ReadonlySet<string>,
): InspectedStatement[] {
	const priced: InspectedStatement[] = [];

	for (const section of STATEMENT_SECTIONS) {
		let template = sectionBanner(section);
		// One render per step, both measures taken from it. Rendering twice to price bytes and
		// tokens separately would double the work for two numbers about the same string.
		let running = measure(template, context);

		if (replacedSections.has(section)) {
			for (const statement of statementsOf(section)) {
				priced.push({
					id: statement.id,
					section,
					purpose: statement.purpose,
					condition: describeCondition(statement.condition),
					present: false,
					bytes: 0,
					tokens: 0,
					text: "",
				});
			}
			continue;
		}

		for (const statement of statementsOf(section)) {
			const shared = {
				id: statement.id,
				section,
				purpose: statement.purpose,
				condition: describeCondition(statement.condition),
			};
			if (!conditionHolds(statement.condition, context)) {
				priced.push({ ...shared, present: false, bytes: 0, tokens: 0, text: "" });
				continue;
			}
			const replacement = Object.hasOwn(overrides, statement.id) ? overrides[statement.id] : statement.text;
			if (replacement === null) {
				priced.push({ ...shared, present: false, bytes: 0, tokens: 0, text: "" });
				continue;
			}
			template += replacement;
			const grown = measure(template, context);
			priced.push({
				...shared,
				present: true,
				bytes: grown.bytes - running.bytes,
				tokens: grown.tokens - running.tokens,
				text: grown.text.slice(commonPrefixLength(running.text, grown.text)),
			});
			running = grown;
		}
	}

	return priced;
}

/** Render a section prefix once and report the result with both costs of it. */
function measure(template: string, context: StatementContext): { bytes: number; tokens: number; text: string } {
	const rendered = prompt.render(template, context);
	return {
		bytes: Buffer.byteLength(rendered, "utf8"),
		tokens: estimateTokensFromText(rendered),
		text: rendered,
	};
}

/** How much of two renders is identical from the start, which is where the new statement begins. */
function commonPrefixLength(before: string, after: string): number {
	const limit = Math.min(before.length, after.length);
	let index = 0;
	while (index < limit && before[index] === after[index]) index++;
	return index;
}

/**
 * Name the leading region by its registry id rather than by the splitter's.
 *
 * `splitPromptSections` calls everything before the first banner "preamble",
 * because that is what it is structurally. The registry calls that same text
 * `conventions` — it is a declared section that simply has no banner of its own,
 * being DEFINED as whatever precedes the first one. Reporting the splitter's
 * name would give the section two identities and make `--section conventions`
 * fail on a section that is plainly present.
 *
 * Only in the first block: later blocks open directly on a banner, so a
 * preamble there is genuinely unregistered leading text, not the conventions.
 */
function resolveSectionId(name: string, blockIndex: number): string {
	return name === "preamble" && blockIndex === 0 ? "conventions" : name;
}

function sourceOf(name: string): InspectedSection["source"] {
	if (name === "preamble") return "preamble";
	return SECTION_SOURCE.get(name) ?? "unregistered";
}

/**
 * The breakdown as a table, largest section first.
 *
 * Sorted by cost rather than by position because the question this answers is
 * "what is taking up the prompt", and prompt order is already visible in the
 * full text. `share` is of the total, so a section that quietly doubles is
 * obvious without comparing two runs by hand.
 */
export function formatInspectionTable(inspection: PromptInspection): string {
	const rows = [...inspection.sections].sort((a, b) => b.tokens - a.tokens);
	const width = (values: string[]) => Math.max(...values.map(v => v.length));
	const idWidth = width([...rows.map(r => r.id), "section"]);
	const sourceWidth = width([...rows.map(r => r.source), "source"]);

	const lines = [
		`${"section".padEnd(idWidth)}  ${"source".padEnd(sourceWidth)}  ${"block".padStart(5)}  ${"bytes".padStart(7)}  ${"tokens".padStart(7)}  share`,
	];
	for (const row of rows) {
		const share = inspection.totalTokens === 0 ? 0 : (row.tokens / inspection.totalTokens) * 100;
		lines.push(
			`${row.id.padEnd(idWidth)}  ${row.source.padEnd(sourceWidth)}  ${String(row.blockIndex).padStart(5)}  ` +
				`${String(row.bytes).padStart(7)}  ${String(row.tokens).padStart(7)}  ${share.toFixed(1).padStart(5)}%`,
		);
	}
	lines.push(
		`${"TOTAL".padEnd(idWidth)}  ${"".padEnd(sourceWidth)}  ${String(inspection.blocks.length).padStart(5)}  ` +
			`${String(inspection.totalBytes).padStart(7)}  ${String(inspection.totalTokens).padStart(7)}`,
	);

	// Absent sections are reported UNDER the table rather than as zero-cost rows in
	// it. A row of zeroes reads as "this section is here and empty", which is a
	// different fact from "this section is not here", and the table is sorted by
	// cost so every absent section would collect at the bottom anyway.
	if (inspection.missing.length > 0) {
		lines.push("", "not in this prompt:");
		for (const section of inspection.missing) {
			const marker = section.optional ? "optional" : "REQUIRED";
			lines.push(`  ${section.id.padEnd(idWidth)}  ${marker}  ${section.purpose}`);
		}
		const required = inspection.missing.filter(section => !section.optional);
		if (required.length > 0) {
			// Named rather than counted, and stated as a defect: a required section
			// that did not render means assembly broke, and the reader needs to know
			// that this output is not simply a minimal configuration.
			lines.push(
				"",
				`${required.length} REQUIRED section${required.length === 1 ? "" : "s"} did not render ` +
					`(${required.map(section => section.id).join(", ")}). This prompt is incomplete, not minimal.`,
			);
		}
	}
	return lines.join("\n");
}

/**
 * The per-statement breakdown as a table, most expensive first, absent rules listed under it.
 *
 * Sorted by cost for the same reason the section table is: the question is which rules are worth
 * their tokens. Absent statements are listed separately rather than as zero rows, because a rule
 * that is off is a different fact from a rule that costs nothing, and the condition is printed
 * beside it so the reader can see WHY it is off without going to the registry.
 */
export function formatStatementTable(inspection: PromptInspection): string {
	if (!inspection.fromStatements) {
		// Not an empty table. An empty table says the statements cost nothing, which is false here:
		// this prompt was not built from them at all.
		return "this prompt was not assembled from statements (a custom system prompt replaced it), so there is nothing to price";
	}

	const present = inspection.statements.filter(statement => statement.present).sort((a, b) => b.tokens - a.tokens);
	const absent = inspection.statements.filter(statement => !statement.present);
	const width = (values: string[]) => Math.max(...values.map(value => value.length));
	const idWidth = width([...inspection.statements.map(statement => statement.id), "statement"]);
	const total = present.reduce((sum, statement) => sum + statement.tokens, 0);

	const lines = [`${"statement".padEnd(idWidth)}  ${"bytes".padStart(7)}  ${"tokens".padStart(7)}  share  condition`];
	for (const statement of present) {
		const share = total === 0 ? 0 : (statement.tokens / total) * 100;
		lines.push(
			`${statement.id.padEnd(idWidth)}  ${String(statement.bytes).padStart(7)}  ${String(statement.tokens).padStart(7)}  ` +
				`${share.toFixed(1).padStart(5)}%  ${statement.condition}`,
		);
	}
	lines.push(`${"TOTAL".padEnd(idWidth)}  ${"".padStart(7)}  ${String(total).padStart(7)}`);

	if (absent.length > 0) {
		lines.push("", `not in this prompt (${absent.length} of ${inspection.statements.length}):`);
		for (const statement of absent) {
			lines.push(`  ${statement.id.padEnd(idWidth)}  needs ${statement.condition}`);
		}
	}
	return lines.join("\n");
}
