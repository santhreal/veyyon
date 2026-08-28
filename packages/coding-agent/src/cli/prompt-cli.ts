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
	json?: boolean;
	sections?: boolean;
	statements?: boolean;
	section?: string;
	tools?: boolean;
	statement?: string;
	cwd?: string;
	noTools?: boolean;
	prompt?: string;
	prompts?: boolean;
}

export interface PromptCommandResult {
	readonly output: string;
	readonly exitCode: number;
}

export type PromptView =
	| { readonly kind: "prompts" }
	| { readonly kind: "prompt"; readonly id: string }
	| { readonly kind: "statement"; readonly id: string }
	| { readonly kind: "tools" }
	| { readonly kind: "section"; readonly id: string }
	| { readonly kind: "inspection" };

export const PROMPT_VIEW_KINDS = ["prompts", "prompt", "statement", "tools", "section", "inspection"] as const;

export function selectPromptView(flags: PromptCommandFlags): PromptView {
	if (flags.prompts) return { kind: "prompts" };
	if (flags.prompt !== undefined && flags.prompt !== "system") return { kind: "prompt", id: flags.prompt };
	if (flags.statement !== undefined) return { kind: "statement", id: flags.statement };
	if (flags.tools) return { kind: "tools" };
	if (flags.section !== undefined) return { kind: "section", id: flags.section };
	return { kind: "inspection" };
}

export async function runPromptCommand(flags: PromptCommandFlags = {}): Promise<PromptCommandResult> {
	const view = selectPromptView(flags);
	const asJson = flags.json === true;
	if (view.kind === "prompts") return listRegisteredPrompts(asJson);
	if (view.kind === "prompt") return describeRegisteredPrompt(view.id, asJson);

	const cwd = flags.cwd ?? process.cwd();
	await Settings.init({ inMemory: true, cwd });
	const settings = await Settings.loadReadOnly({ cwd });

	const tools = flags.noTools ? [] : await resolveTools(cwd, settings);
	const toolMap = new Map<string, Tool>(tools.map(tool => [tool.name, tool]));
	const gateInputs = resolveGateInputs(settings, { tools: toolMap as never });
	const inspection = await inspectSystemPrompt({
		...gateInputs,
		tools: toolMap as never,
		toolNames: tools.map(tool => tool.name),
		cwd,
	});

	const incomplete = inspection.missing.some(section => !section.optional);
	const inspectExit = incomplete ? 1 : 0;

	if (view.kind === "statement") return renderOneStatement(inspection, view.id, asJson);
	if (view.kind === "tools") return formatToolCostTable(tools, inspection.totalTokens, asJson);
	if (view.kind === "section") return renderOneSection(inspection, view.id, asJson);
	if (asJson) return { output: JSON.stringify(toJson(inspection), null, 2), exitCode: inspectExit };
	if (flags.statements) return { output: formatStatementTable(inspection), exitCode: inspectExit };
	if (flags.sections) return { output: formatInspectionTable(inspection), exitCode: inspectExit };
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

function ownerOf(id: string): PromptRegistryView {
	return REGISTRIES.find(registry => registry.has(id)) ?? REGISTRIES[0];
}

function listRegisteredPrompts(asJson: boolean): PromptCommandResult {
	if (asJson) {
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
	const lines = ["system       the assembled system prompt (see `veyyon prompt --sections` for its breakdown)"];
	const width = Math.max(...REGISTRIES.flatMap(registry => registry.ids).map(id => id.length));
	for (const registry of REGISTRIES) {
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

function describeRegisteredPrompt(id: string, asJson: boolean): PromptCommandResult {
	const owner = ownerOf(id);
	let entry: PromptEntry;
	try {
		entry = owner.require(id);
	} catch (error) {
		const message = (error as Error).message;
		return { output: asJson ? JSON.stringify({ error: message }, null, 2) : message, exitCode: 1 };
	}
	const template = owner.fileFor(id);
	const lines = [`${id} — ${entry.purpose}`, `template: ${template}`, "", "sections:"];
	const sections: readonly PromptSection[] = entry.sections ?? [
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
		missing: inspection.missing.map(section => ({
			id: section.id,
			optional: section.optional,
			purpose: section.purpose,
		})),
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
