/** `veyyon prompt` — print the system prompt this configuration would send. See `system-prompt-builder/prompt-inspect.ts` for why an inspection surface */
import { toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import { estimateTokensFromText, type PromptEntry, type PromptRegistryView, type PromptSection } from "@veyyon/utils";
import { Settings } from "../config/settings";
import { PROMPT_REGISTRIES as REGISTRIES } from "../prompts/all-registries";
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
	/** Print the per-STATEMENT cost table. A section is too coarse to act on: TOOL POLICY is one row of that table and 9KB of prompt, so */
	statements?: boolean;
	/** Print only this section's text. */
	section?: string;
	/** Print what the tool definitions cost, which no other view here can show. The system prompt is only half of what a turn pays before its first user */
	tools?: boolean;
	/** Print only this statement's text, by id. The counterpart to `--section` at the granularity a rule actually has. `--statements` says what */
	statement?: string;
	/** Working directory to resolve context files, skills and the tree from. */
	cwd?: string;
	/** Assemble with no tools at all. The baseline for "what does the prompt cost before tools", and the way to */
	noTools?: boolean;
	/** Which prompt to inspect. Defaults to the main system prompt. The other registered prompts are not assembled from live session state the */
	prompt?: string;
	/** List every registered prompt instead of inspecting one. */
	prompts?: boolean;
}

export interface PromptCommandResult {
	readonly output: string;
	readonly exitCode: number;
}

/** Which view of a prompt this invocation asked for, with the id the view needs. ONE OWNER FOR PRECEDENCE, and the reason is that `--json` used to be dropped in silence. */
export type PromptView =
	| { readonly kind: "prompts" }
	| { readonly kind: "prompt"; readonly id: string }
	| { readonly kind: "statement"; readonly id: string }
	| { readonly kind: "tools" }
	| { readonly kind: "section"; readonly id: string }
	| { readonly kind: "inspection" };

/** Every view kind, for a sweep that has to cover all of them. A union cannot be enumerated at run time, so this is the runtime half of it, and */
export const PROMPT_VIEW_KINDS = ["prompts", "prompt", "statement", "tools", "section", "inspection"] as const;

/** Resolve the view from the flags, in the order the flags have always been read in. */
export function selectPromptView(flags: PromptCommandFlags): PromptView {
	if (flags.prompts) return { kind: "prompts" };
	if (flags.prompt !== undefined && flags.prompt !== "system") return { kind: "prompt", id: flags.prompt };
	if (flags.statement !== undefined) return { kind: "statement", id: flags.statement };
	if (flags.tools) return { kind: "tools" };
	if (flags.section !== undefined) return { kind: "section", id: flags.section };
	return { kind: "inspection" };
}

/** Build the inspection for `flags` and render it. Returns the text rather than printing it so tests can assert the bytes, and */
export async function runPromptCommand(flags: PromptCommandFlags = {}): Promise<PromptCommandResult> {
	const view = selectPromptView(flags);
	const asJson = flags.json === true;
	if (view.kind === "prompts") return listRegisteredPrompts(asJson);
	if (view.kind === "prompt") return describeRegisteredPrompt(view.id, asJson);

	const cwd = flags.cwd ?? process.cwd();
	// THE REAL CONFIGURATION, read without writing anything. `Settings.isolated({})` was here, and it is the testing constructor: in-memory, no config
	await Settings.init({ inMemory: true, cwd });
	const settings = await Settings.loadReadOnly({ cwd });

	const tools = flags.noTools ? [] : await resolveTools(cwd, settings);
	const toolMap = new Map<string, Tool>(tools.map(tool => [tool.name, tool]));
	// SETTINGS ARE RESOLVED FOR REAL, for the same reason the tool set is, and from the loaded instance above rather than an empty one.
	const gateInputs = resolveGateInputs(settings, { tools: toolMap as never });
	const inspection = await inspectSystemPrompt({
		...gateInputs,
		tools: toolMap as never,
		toolNames: tools.map(tool => tool.name),
		cwd,
	});

	// A required section that did not render means assembly broke, and the reader asked what this prompt contains. Reporting success would hand them a
	const incomplete = inspection.missing.some(section => !section.optional);
	const inspectExit = incomplete ? 1 : 0;

	if (view.kind === "statement") return renderOneStatement(inspection, view.id, asJson);
	if (view.kind === "tools") return formatToolCostTable(tools, inspection.totalTokens, asJson);
	if (view.kind === "section") return renderOneSection(inspection, view.id, asJson);
	// The three inspection views share one JSON document, because it already carries every
	// field each of their text tables renders: a consumer diffing two configurations reads
	// `sections` or `statements` out of it rather than running the command three times.
	if (asJson) return { output: JSON.stringify(toJson(inspection), null, 2), exitCode: inspectExit };
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

/** What the tool definitions cost, beside what the system prompt costs. Every active tool ships a description and a parameter schema on every */
function formatToolCostTable(tools: readonly Tool[], promptTokens: number, asJson: boolean): PromptCommandResult {
	const rows = tools
		.map(tool => {
			const description = tool.description ?? "";
			const schema = JSON.stringify(toolWireSchema(tool as never));
			const descriptionTokens = estimateTokensFromText(description);
			const schemaTokens = estimateTokensFromText(schema);
			return {
				name: tool.name,
				bytes: Buffer.byteLength(description, "utf8") + Buffer.byteLength(schema, "utf8"),
				descriptionTokens,
				schemaTokens,
				tokens: descriptionTokens + schemaTokens,
			};
		})
		.sort((left, right) => right.tokens - left.tokens);
	const total = rows.reduce((sum, row) => sum + row.tokens, 0);
	if (asJson) {
		// `promptTokens` rides along because the only question this view answers is what a
		// turn pays before its first user message, and the prompt is the other half of it.
		return {
			output: JSON.stringify({ promptTokens, toolTokens: total, tools: rows }, null, 2),
			exitCode: 0,
		};
	}
	if (rows.length === 0) return { output: "No tools are active in this configuration.", exitCode: 0 };

	const nameWidth = Math.max(...rows.map(row => row.name.length), "tool".length, "TOTAL".length);
	const lines = [
		`${"tool".padEnd(nameWidth)}  ${"bytes".padStart(7)}  ${"desc".padStart(7)}  ${"schema".padStart(7)}  ${"tokens".padStart(7)}  share`,
	];
	for (const row of rows) {
		const share = total === 0 ? 0 : (row.tokens / total) * 100;
		lines.push(
			`${row.name.padEnd(nameWidth)}  ${String(row.bytes).padStart(7)}  ${String(row.descriptionTokens).padStart(7)}  ` +
				`${String(row.schemaTokens).padStart(7)}  ${String(row.tokens).padStart(7)}  ${share.toFixed(1).padStart(5)}%`,
		);
	}
	const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
	lines.push(
		`${"TOTAL".padEnd(nameWidth)}  ${String(bytes).padStart(7)}  ${String(rows.reduce((sum, row) => sum + row.descriptionTokens, 0)).padStart(7)}  ` +
			`${String(rows.reduce((sum, row) => sum + row.schemaTokens, 0)).padStart(7)}  ${String(total).padStart(7)}`,
		"",
		`${rows.length} tools cost ${total} tokens; the system prompt costs ${promptTokens}. Every request pays both.`,
	);
	return { output: lines.join("\n"), exitCode: 0 };
}

/** The registry that holds an id, or the coding agent's as the place to complain from. Ids are unique across the registries (`prompt-cli-registry.test.ts` pins that), so the */
function ownerOf(id: string): PromptRegistryView {
	return REGISTRIES.find(registry => registry.has(id)) ?? REGISTRIES[0];
}

/** List every prompt a model can be sent. This is the answer to the question that had none: before the registry, "which */
function listRegisteredPrompts(asJson: boolean): PromptCommandResult {
	if (asJson) {
		// The synthetic `system` row below is a pointer to another command, not data, so the
		// JSON carries the registered prompts and nothing else. `session/system-prompt` is one
		// of them, so a consumer loses nothing by the row being absent.
		return {
			output: JSON.stringify(
				{
					prompts: REGISTRIES.flatMap(registry =>
						registry.ids.map(id => ({
							id,
							dir: registry.dir,
							template: registry.fileFor(id),
							purpose: registry.require(id).purpose,
							sections: registry.require(id).sections ?? null,
						})),
					),
				},
				null,
				2,
			),
			exitCode: 0,
		};
	}
	// `session/system-prompt` is registered like every other prompt, but the useful
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

/** Describe a registered prompt other than the system prompt. Reports the declared sections with whether each is optional, so a reader can */
function describeRegisteredPrompt(id: string, asJson: boolean): PromptCommandResult {
	const owner = ownerOf(id);
	let entry: PromptEntry;
	try {
		entry = owner.require(id);
	} catch (error) {
		// The refusal is JSON too when JSON was asked for, and it keeps its non-zero exit: a
		// consumer that has to parse prose to find out an id was wrong is being told twice.
		const message = (error as Error).message;
		return { output: asJson ? JSON.stringify({ error: message }, null, 2) : message, exitCode: 1 };
	}
	const template = owner.fileFor(id);
	const lines = [`${id} — ${entry.purpose}`, `template: ${template}`, "", "sections:"];
	// Annotated, so the stand-in row is checked against the real section type rather than inferred into a shape of its own. It was missing `name` and nothing said
	const sections: readonly PromptSection[] = entry.sections ?? [
		// A prompt with no declared sections is one undivided body, so it has no banner.
		{ id: "body", name: null, purpose: entry.purpose, optional: false },
	];
	if (asJson) {
		return {
			output: JSON.stringify({ id, template, purpose: entry.purpose, sections }, null, 2),
			exitCode: 0,
		};
	}
	for (const section of sections) {
		lines.push(`  ${section.id.padEnd(12)} ${section.optional ? "optional" : "always  "}  ${section.purpose}`);
	}
	return { output: lines.join("\n"), exitCode: 0 };
}

function blockHeader(index: number): string {
	return `# ---- system prompt block ${index} ----`;
}

function renderOneSection(inspection: PromptInspection, id: string, asJson: boolean): PromptCommandResult {
	const matches = inspection.sections.filter(section => section.id === id);
	if (matches.length === 0) {
		const known = inspection.sections.map(section => section.id).join(", ");
		const message = `Unknown section \`${id}\`. This prompt contains: ${known}`;
		return {
			output: asJson ? JSON.stringify({ error: message, sections: known.split(", ") }, null, 2) : message,
			exitCode: 1,
		};
	}
	// A section id can legitimately appear more than once (a custom template with
	// two same-named banners), so all matches print rather than the first.
	if (asJson) {
		return {
			output: JSON.stringify(
				{
					id,
					matches: matches.map(section => ({
						source: section.source,
						blockIndex: section.blockIndex,
						bytes: section.bytes,
						tokens: section.tokens,
						text: section.text,
					})),
				},
				null,
				2,
			),
			exitCode: 0,
		};
	}
	return { output: matches.map(section => section.text).join("\n"), exitCode: 0 };
}

/** Print one statement, or say why it is not in this prompt. Mirrors {@link renderOneSection}, including the non-zero exit and the valid list on an unknown id, */
function renderOneStatement(inspection: PromptInspection, id: string, asJson: boolean): PromptCommandResult {
	if (!inspection.fromStatements) {
		const message =
			"This prompt was not assembled from statements (a custom system prompt replaced it), " +
			"so there is no statement to print.";
		return {
			output: asJson ? JSON.stringify({ error: message, fromStatements: false }, null, 2) : message,
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
		const message = `Unknown statement \`${id}\`. Try \`veyyon prompt --statements\`. ${known}`;
		return {
			output: asJson
				? JSON.stringify({ error: message, nearby: nearby.map(statement => statement.id) }, null, 2)
				: message,
			exitCode: 1,
		};
	}
	// An absent rule exits 0 in both formats, and the JSON says `present: false` rather than
	// omitting the rule: a consumer that cannot tell "off in this configuration" from "no such
	// rule" has the same ambiguity the text form was written to remove.
	if (asJson) {
		return {
			output: JSON.stringify(
				{
					id: found.id,
					section: found.section,
					purpose: found.purpose,
					condition: found.condition,
					present: found.present,
					bytes: found.bytes,
					tokens: found.tokens,
					text: found.present ? found.text : null,
				},
				null,
				2,
			),
			exitCode: 0,
		};
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
