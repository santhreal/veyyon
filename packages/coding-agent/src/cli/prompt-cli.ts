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
import { agentCorePrompts } from "@veyyon/agent-core/prompts/registry";
import { aiPrompts } from "@veyyon/ai/prompts/registry";
import { hashlinePrompts } from "@veyyon/hashline/prompts/registry";
import type { PromptEntry, PromptRegistryView, PromptSection } from "@veyyon/utils";
import { Settings } from "../config/settings";
import { codingAgentPrompts } from "../prompts/registry";
import { resolveGateInputs } from "../system-prompt-builder/gate-inputs";
import {
	formatInspectionTable,
	formatStatementTable,
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
	/**
	 * Print the per-STATEMENT cost table.
	 *
	 * A section is too coarse to act on: TOOL POLICY is one row of that table and 9KB of prompt, so
	 * the answer it gives is "tool policy is large". A statement is one rule, which is the level at
	 * which someone decides a rule is not earning its tokens, and the level an ablation operates on.
	 */
	statements?: boolean;
	/** Print only this section's text. */
	section?: string;
	/**
	 * Print only this statement's text, by id.
	 *
	 * The counterpart to `--section` at the granularity a rule actually has. `--statements` says what
	 * each rule costs and which are off; this is how you read one, which is the next thing anybody
	 * wants after seeing a row they do not recognise.
	 */
	statement?: string;
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
	// THE REAL CONFIGURATION, read without writing anything.
	//
	// `Settings.isolated({})` was here, and it is the testing constructor: in-memory, no config
	// file, no project providers, so every gate below read a schema default. The command still
	// printed a prompt, so nothing failed -- it just answered for a configuration nobody has, which
	// is worse than refusing, because the whole point of `veyyon prompt` is showing your settings
	// reaching the model. `loadReadOnly` is the loader written for exactly this: it reads
	// `config.yml` and the project providers, opens no database, runs no legacy migration and
	// writes no marker files, so inspecting the prompt cannot change what the next session does.
	//
	// `Settings.init` still runs because the tool resolution below reaches modules that read the
	// singleton, and it stays in-memory for the same no-writes reason.
	await Settings.init({ inMemory: true, cwd });
	const settings = await Settings.loadReadOnly({ cwd });

	const tools = flags.noTools ? [] : await resolveTools(cwd, settings);
	const toolMap = new Map<string, Tool>(tools.map(tool => [tool.name, tool]));
	// SETTINGS ARE RESOLVED FOR REAL, for the same reason the tool set is, and from the loaded
	// instance above rather than an empty one.
	//
	// This call used to pass tools, tool names and cwd and nothing else, so every settings-fed
	// gate fell to `system-prompt.ts`'s omitted-option default and this command rendered a prompt
	// no session sends. With `subagent.delegation=required` and `personality=none` it printed no
	// Eager Tasks section and a personality block, both the opposite of the configuration. The
	// derivation is shared with `sdk.ts` (`system-prompt-builder/gate-inputs.ts`) rather than
	// copied, so a gate cannot reach the session path and miss this one.
	const gateInputs = resolveGateInputs(settings, { tools: toolMap as never });
	const inspection = await inspectSystemPrompt({
		...gateInputs,
		tools: toolMap as never,
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

	if (flags.statement !== undefined) return renderOneStatement(inspection, flags.statement);
	if (flags.section !== undefined) return renderOneSection(inspection, flags.section);
	if (flags.json) return { output: JSON.stringify(toJson(inspection), null, 2), exitCode: inspectExit };
	if (flags.statements) return { output: formatStatementTable(inspection), exitCode: inspectExit };
	if (flags.sections) return { output: formatInspectionTable(inspection), exitCode: inspectExit };
	// Blocks are joined with a marker rather than concatenated: they are separate
	// messages to the provider and the boundary between them is the caching
	// contract, so a dump that hid it would misrepresent what is sent.
	return {
		output: inspection.blocks.map((block, index) => `${blockHeader(index)}\n${block}`).join("\n"),
		exitCode: 0,
	};
}

async function resolveTools(cwd: string, settings: Settings): Promise<Tool[]> {
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
 * Every registry this command can read, and where each one's prompts live.
 *
 * WHY FOUR AND NOT ONE. A package owns its own prompts, so there is one registry per
 * package that ships them, and this command is the operator-facing view ACROSS them.
 * It listed the coding agent's alone, which meant `veyyon prompt --prompts` answered
 * "which prompts does veyyon send" with a subset and looked complete doing it: the
 * compaction prompts that rewrite a session's whole history were absent, so was every
 * dialect format guide that tells a model how to write a tool call, and so was the
 * hashline patch language, which is the edit tool's description and the only tool
 * description missing from a list that held every other one.
 *
 * `@veyyon/metaharness`'s benchmark prompts are deliberately NOT here. They are asked
 * by a measurement harness, not by the agent, and the agent must not depend on the
 * harness that scores it.
 */
const REGISTRIES: readonly PromptRegistryView[] = [codingAgentPrompts, agentCorePrompts, aiPrompts, hashlinePrompts];

/**
 * The registry that holds an id, or the coding agent's as the place to complain from.
 *
 * Ids are unique across the registries (`prompt-cli-registry.test.ts` pins that), so the
 * first hit is the only hit and an operator does not have to know which package owns a
 * prompt before asking about it. A miss reports against the largest registry, whose ids
 * are the ones an operator is most likely to have been typing, so the near-miss
 * suggestion is drawn from 160 candidates rather than from fourteen format guides.
 */
function ownerOf(id: string): PromptRegistryView {
	return REGISTRIES.find(registry => registry.has(id)) ?? REGISTRIES[0];
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
	const width = Math.max(...REGISTRIES.flatMap(registry => registry.ids).map(id => id.length));
	for (const registry of REGISTRIES) {
		// Grouped by owner, with the directory as the heading, because the id IS the
		// path under it: a reader who wants to edit a prompt has its file from the two
		// lines together and needs nothing else.
		lines.push("", `# ${registry.dir}`);
		for (const id of registry.ids) {
			const entry = registry.require(id);
			const count = entry.sections?.length ?? 1;
			const sections = count === 1 ? "1 section " : `${count} sections`;
			lines.push(`${id.padEnd(width)} ${sections}  ${entry.purpose}`);
		}
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
	const owner = ownerOf(id);
	let entry: PromptEntry;
	try {
		entry = owner.require(id);
	} catch (error) {
		return { output: (error as Error).message, exitCode: 1 };
	}
	const lines = [`${id} — ${entry.purpose}`, `template: ${owner.fileFor(id)}`, "", "sections:"];
	// Annotated, so the stand-in row is checked against the real section type rather
	// than inferred into a shape of its own. It was missing `name` and nothing said
	// so, because this function happens not to print it — the row would have started
	// rendering `undefined` the moment it did.
	const sections: readonly PromptSection[] = entry.sections ?? [
		// A prompt with no declared sections is one undivided body, so it has no banner.
		{ id: "body", name: null, purpose: entry.purpose, optional: false },
	];
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

/**
 * Print one statement, or say why it is not in this prompt.
 *
 * Mirrors {@link renderOneSection}, including the non-zero exit and the valid list on an unknown id,
 * because an empty stdout reads as an empty rule rather than as a typo.
 *
 * AN ABSENT RULE IS NOT AN ERROR, and that is the case worth getting right. It exits 0 and reports the
 * condition that would include it, because "this rule is off because the task tool is not built" is
 * the answer to the question being asked. Printing nothing would be indistinguishable from a rule that
 * renders to nothing, and exiting non-zero would report a working configuration as broken.
 */
function renderOneStatement(inspection: PromptInspection, id: string): PromptCommandResult {
	if (!inspection.fromStatements) {
		return {
			output:
				"This prompt was not assembled from statements (a custom system prompt replaced it), " +
				"so there is no statement to print.",
			exitCode: 1,
		};
	}
	const found = inspection.statements.find(statement => statement.id === id);
	if (found === undefined) {
		// The full list is 68 ids, so the message narrows to the section the operator named, which is
		// where a typo almost always is, and falls back to the section list when the id has no section.
		const section = id.includes("/") ? id.slice(0, id.indexOf("/")) : "";
		const nearby = inspection.statements.filter(statement => statement.section === section);
		const known =
			nearby.length > 0
				? `statements in ${section}: ${nearby.map(statement => statement.id).join(", ")}`
				: `sections: ${[...new Set(inspection.statements.map(statement => statement.section))].join(", ")}`;
		return { output: `Unknown statement \`${id}\`. Try \`veyyon prompt --statements\`. ${known}`, exitCode: 1 };
	}
	if (!found.present) {
		return {
			output: `\`${id}\` is not in this prompt. It needs: ${found.condition}\nWhy it exists: ${found.purpose}`,
			exitCode: 0,
		};
	}
	return { output: found.text, exitCode: 0 };
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
		// Reported unconditionally alongside `fromStatements`, which is what tells a consumer whether
		// an empty list means "no rules" or "this prompt was not built from rules".
		fromStatements: inspection.fromStatements,
		statements: inspection.statements.map(statement => ({
			id: statement.id,
			section: statement.section,
			purpose: statement.purpose,
			condition: statement.condition,
			present: statement.present,
			bytes: statement.bytes,
			tokens: statement.tokens,
			text: statement.text,
		})),
	};
}
