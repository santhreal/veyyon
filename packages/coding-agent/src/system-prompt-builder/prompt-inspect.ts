/**
 * Read back the system prompt a given configuration would actually send.
 *
 * WHY THIS EXISTS. `prompts/session/system-prompt.md` is not a document, it is a
 * program: 86 of its 272 lines carry template syntax and 54 of those open a
 * conditional. Whole regions appear or vanish with the live tool set
 * (`{{#has tools "lsp"}}`), with settings (`{{#if secretsEnabled}}`), with the
 * workspace (`{{#if skills.length}}`) and with the model's harness profile,
 * which can reorder the sections outright. Reading the file tells you what
 * COULD ship. It does not tell you what did.
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
import { estimateTokensFromText } from "@veyyon/utils";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "../system-prompt";
import { splitPromptSections } from "./prompt-sections";
import { SYSTEM_PROMPT_SECTIONS } from "./section-registry";

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
 * broken — and the system prompt is the one where that matters most, since 86 of
 * its 272 template lines carry conditional syntax. The subagent prompt has had
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

export interface PromptInspection {
	/** The blocks exactly as `buildSystemPrompt` returns them. */
	readonly blocks: readonly string[];
	readonly sections: readonly InspectedSection[];
	/** Registered sections absent from this assembly, in registry order. */
	readonly missing: readonly MissingSection[];
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
	const { systemPrompt } = await buildSystemPrompt(options);
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
		totalBytes: sections.reduce((sum, section) => sum + section.bytes, 0),
		totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
	};
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
