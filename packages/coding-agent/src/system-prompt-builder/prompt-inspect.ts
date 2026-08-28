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

export interface InspectedSection {
	readonly id: string;
	readonly source: "template" | "runtime" | "preamble" | "unregistered";
	readonly blockIndex: number;
	readonly bytes: number;
	readonly tokens: number;
	readonly text: string;
}

export interface MissingSection {
	readonly id: string;
	readonly optional: boolean;
	readonly purpose: string;
}

export interface InspectedStatement {
	readonly id: string;
	readonly section: string;
	readonly purpose: string;
	readonly condition: string;
	readonly present: boolean;
	readonly bytes: number;
	readonly tokens: number;
	readonly text: string;
}

export interface PromptInspection {
	readonly blocks: readonly string[];
	readonly sections: readonly InspectedSection[];
	readonly missing: readonly MissingSection[];
	readonly statements: readonly InspectedStatement[];
	readonly fromStatements: boolean;
	readonly totalBytes: number;
	readonly totalTokens: number;
}

const SECTION_SOURCE: ReadonlyMap<string, "template" | "runtime"> = new Map(
	SYSTEM_PROMPT_SECTIONS.map(section => [section.id as string, section.source]),
);

export async function inspectSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<PromptInspection> {
	const { systemPrompt, statementContext, statementOverrides, replacedStatementSections } =
		await buildSystemPrompt(options);
	const sections: InspectedSection[] = [];

	for (const [blockIndex, block] of systemPrompt.entries()) {
		for (const rendered of splitPromptSections(block)) {
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

function priceStatements(
	context: StatementContext,
	overrides: StatementOverrides,
	replacedSections: ReadonlySet<string>,
): InspectedStatement[] {
	const priced: InspectedStatement[] = [];

	for (const section of STATEMENT_SECTIONS) {
		let template = sectionBanner(section);
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

function measure(template: string, context: StatementContext): { bytes: number; tokens: number; text: string } {
	const rendered = prompt.render(template, context);
	return {
		bytes: Buffer.byteLength(rendered, "utf8"),
		tokens: estimateTokensFromText(rendered),
		text: rendered,
	};
}

function commonPrefixLength(before: string, after: string): number {
	const limit = Math.min(before.length, after.length);
	let index = 0;
	while (index < limit && before[index] === after[index]) index++;
	return index;
}

function resolveSectionId(name: string, blockIndex: number): string {
	return name === "preamble" && blockIndex === 0 ? "conventions" : name;
}

function sourceOf(name: string): InspectedSection["source"] {
	if (name === "preamble") return "preamble";
	return SECTION_SOURCE.get(name) ?? "unregistered";
}

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

	if (inspection.missing.length > 0) {
		lines.push("", "not in this prompt:");
		for (const section of inspection.missing) {
			const marker = section.optional ? "optional" : "REQUIRED";
			lines.push(`  ${section.id.padEnd(idWidth)}  ${marker}  ${section.purpose}`);
		}
		const required = inspection.missing.filter(section => !section.optional);
		if (required.length > 0) {
			lines.push(
				"",
				`${required.length} REQUIRED section${required.length === 1 ? "" : "s"} did not render ` +
					`(${required.map(section => section.id).join(", ")}). This prompt is incomplete, not minimal.`,
			);
		}
	}
	return lines.join("\n");
}

export function formatStatementTable(inspection: PromptInspection): string {
	if (!inspection.fromStatements) {
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
