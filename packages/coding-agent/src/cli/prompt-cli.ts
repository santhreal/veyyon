/**
 * `veyyon prompt` — print the system prompt this configuration would send.
 *
 * See `system-prompt-builder/prompt-inspect.ts` for why an inspection surface
 * is needed at all. This module is the operator-facing half: it resolves the
 * same inputs a real session resolves, hands them to the one assembler, and
 * renders the result.
 *
 * THE TOOL SET IS RESOLVED FOR REAL, not stubbed, because it is the single
 * biggest source of variance in the output. Roughly half the shipped template's
 * conditionals are `{{#has tools "..."}}`, so a prompt inspected against an
 * imagined tool list is a prompt nobody will ever be sent. `createTools` is the
 * same call the session makes, on a session shape built from the same settings.
 */
import { Settings } from "../config/settings";
import { PROMPT_IDS, PROMPTS, type PromptEntry, requirePrompt } from "../prompts/registry";
import {
	formatInspectionTable,
	type InspectedSection,
	inspectSystemPrompt,
	type PromptInspection,
} from "../system-prompt-builder/prompt-inspect";
import { createTools, type Tool, type ToolSession } from "../tools";

export interface PromptCommandFlags {
	/** Emit the inspection as JSON, for diffing two configurations mechanically. */
	json?: boolean;
	/** Print only the per-section cost table, not the prompt text. */
	sections?: boolean;
	/** Print only this section's text. */
	section?: string;
	/** Working directory to resolve context files, skills and the tree from. */
	cwd?: string;
	/**
	 * Assemble with no tools at all.
	 *
	 * The baseline for "what does the prompt cost before tools", and the way to
	 * see which regions are tool-gated: diff it against the default run and every
	 * line that disappears was behind a `{{#has tools ...}}`.
	 */
	noTools?: boolean;
	/**
	 * Which prompt to inspect. Defaults to the main system prompt.
	 *
	 * The other registered prompts are not assembled from live session state the
	 * way the system prompt is, so they are inspected as the TEMPLATE they ship:
	 * their sections, their variable contract, and their sizes. That is the
	 * question worth answering about them, because until now the subagent prompt
	 * in particular could not be examined at all without reading the file and
	 * simulating its conditionals by eye.
	 */
	prompt?: string;
	/** List every registered prompt instead of inspecting one. */
	prompts?: boolean;
}

export interface PromptCommandResult {
	readonly output: string;
	readonly exitCode: number;
}

/**
 * Build the inspection for `flags` and render it.
 *
 * Returns the text rather than printing it so tests can assert the bytes, and
 * so an unknown `--section` can be reported as a non-zero exit with the valid
 * list rather than an empty stdout that reads like an empty section.
 */
export async function runPromptCommand(flags: PromptCommandFlags = {}): Promise<PromptCommandResult> {
	if (flags.prompts) return listRegisteredPrompts();
	if (flags.prompt !== undefined && flags.prompt !== "system") return describeRegisteredPrompt(flags.prompt);

	const cwd = flags.cwd ?? process.cwd();
	await Settings.init({ inMemory: true, cwd });
	const settings = Settings.isolated({});

	const tools = flags.noTools ? [] : await resolveTools(cwd, settings);
	const inspection = await inspectSystemPrompt({
		tools: new Map<string, Tool>(tools.map(tool => [tool.name, tool])) as never,
		toolNames: tools.map(tool => tool.name),
		cwd,
	});

	// A required section that did not render means assembly broke, and the reader
	// asked what this prompt contains. Reporting success would hand them a
	// truncated prompt with a zero exit, which is the same answer a correct minimal
	// prompt gets — the exact confusion `optional` exists to remove. Optional
	// sections being absent is ordinary and stays exit 0.
	const incomplete = inspection.missing.some(section => !section.optional);
	const inspectExit = incomplete ? 1 : 0;

	if (flags.section !== undefined) return renderOneSection(inspection, flags.section);
	if (flags.json) return { output: JSON.stringify(toJson(inspection), null, 2), exitCode: inspectExit };
	if (flags.sections) return { output: formatInspectionTable(inspection), exitCode: inspectExit };
	// Blocks are joined with a marker rather than concatenated: they are separate
	// messages to the provider and the boundary between them is the caching
	// contract, so a dump that hid it would misrepresent what is sent.
	return {
		output: inspection.blocks.map((block, index) => `${blockHeader(index)}\n${block}`).join("\n"),
		exitCode: 0,
	};
}

async function resolveTools(cwd: string, settings: ReturnType<typeof Settings.isolated>): Promise<Tool[]> {
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	} as ToolSession;
	return await createTools(session);
}

/**
 * Where a prompt's template lives, derived from its id.
 *
 * The path is COMPUTED rather than stored. An earlier registry recorded it as a
 * string beside each row, which meant every prompt's location was written twice
 * (once as the import the compiler checks, once as a string it cannot see) and
 * a rename left the string pointing at nothing. Since the id IS the path under
 * `src/prompts/`, one line reconstructs it and the two can no longer disagree.
 */
function templatePathFor(id: string): string {
	return `packages/coding-agent/src/prompts/${id}.md`;
}

/**
 * List every prompt a model can be sent.
 *
 * This is the answer to the question that had none: before the registry, "which
 * prompts does this thing send" could only be reconstructed by grepping for
 * `systemPrompt` and following each template import by hand.
 */
function listRegisteredPrompts(): PromptCommandResult {
	// `system/system-prompt` is registered like every other prompt, but the useful
	// view of it is the live assembly with its per-section costs rather than the
	// raw template, so the list points at the command that produces that.
	const lines = ["system       the assembled system prompt (see `veyyon prompt --sections` for its breakdown)"];
	const width = Math.max(...PROMPT_IDS.map(id => id.length));
	for (const id of PROMPT_IDS) {
		const entry: PromptEntry = PROMPTS[id];
		const count = entry.sections?.length ?? 1;
		const sections = count === 1 ? "1 section " : `${count} sections`;
		lines.push(`${id.padEnd(width)} ${sections}  ${entry.purpose}`);
	}
	return { output: lines.join("\n"), exitCode: 0 };
}

/**
 * Describe a registered prompt other than the system prompt.
 *
 * Reports the declared sections with whether each is optional, so a reader can
 * tell a prompt that renders three of five sections from one that lost two.
 * Falls back to a loud error naming the known ids, because a silent empty
 * result would read as "this prompt has nothing in it".
 */
function describeRegisteredPrompt(id: string): PromptCommandResult {
	let entry: PromptEntry;
	try {
		entry = requirePrompt(id);
	} catch (error) {
		return { output: (error as Error).message, exitCode: 1 };
	}
	const lines = [`${id} — ${entry.purpose}`, `template: ${templatePathFor(id)}`, "", "sections:"];
	const sections = entry.sections ?? [{ id: "body", purpose: entry.purpose, optional: false }];
	for (const section of sections) {
		lines.push(`  ${section.id.padEnd(12)} ${section.optional ? "optional" : "always  "}  ${section.purpose}`);
	}
	return { output: lines.join("\n"), exitCode: 0 };
}

function blockHeader(index: number): string {
	return `# ---- system prompt block ${index} ----`;
}

function renderOneSection(inspection: PromptInspection, id: string): PromptCommandResult {
	const matches = inspection.sections.filter(section => section.id === id);
	if (matches.length === 0) {
		const known = inspection.sections.map(section => section.id).join(", ");
		return {
			output: `Unknown section \`${id}\`. This prompt contains: ${known}`,
			exitCode: 1,
		};
	}
	// A section id can legitimately appear more than once (a custom template with
	// two same-named banners), so all matches print rather than the first.
	return { output: matches.map(section => section.text).join("\n"), exitCode: 0 };
}

function toJson(inspection: PromptInspection): Record<string, unknown> {
	return {
		totalBytes: inspection.totalBytes,
		totalTokens: inspection.totalTokens,
		blocks: inspection.blocks.length,
		sections: inspection.sections.map((section: InspectedSection) => ({
			id: section.id,
			source: section.source,
			blockIndex: section.blockIndex,
			bytes: section.bytes,
			tokens: section.tokens,
			text: section.text,
		})),
		// Present even when empty, so a consumer comparing two configurations can
		// read the field unconditionally instead of treating its absence as "nothing
		// missing" — which is also what an older veyyon's output looks like.
		missing: inspection.missing.map(section => ({
			id: section.id,
			optional: section.optional,
			purpose: section.purpose,
		})),
	};
}
