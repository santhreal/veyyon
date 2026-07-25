/**
 * Per-tool schema cost, alongside the system prompt's per-section cost.
 *
 * The prompt half is NOT measured here. It comes from `inspectSystemPrompt`,
 * the same call `veyyon prompt --sections` makes, because this script used to
 * assemble and measure the prompt itself with a private `est()` that
 * re-implemented `estimateTokensFromText` — two owners for one number, and they
 * drift the moment either changes. What remains is the part the command does
 * not cover: the tool schemas, which are sent alongside the prompt and are
 * usually the larger of the two.
 */
import { Settings } from "@veyyon/coding-agent/config/settings";
import { estimateToolSchemaTokens } from "@veyyon/coding-agent/modes/utils/context-usage";
import { formatInspectionTable, inspectSystemPrompt } from "@veyyon/coding-agent/system-prompt-builder/prompt-inspect";
import { createTools, type Tool, type ToolSession } from "@veyyon/coding-agent/tools";
import { estimateTokensFromText } from "@veyyon/utils";

await Settings.init({ inMemory: true, cwd: process.cwd() });
const settings = Settings.isolated({});

const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings,
} as ToolSession;

const tools = await createTools(session);

console.log(`active tools (${tools.length}): ${tools.map(t => t.name).join(", ")}\n`);

const rows = tools
	.map((tool: Tool) => {
		const total = estimateToolSchemaTokens([tool as never]);
		const description = tool.description ?? "";
		return {
			name: tool.name,
			descBytes: Buffer.byteLength(description, "utf8"),
			total,
			schema: total - estimateTokensFromText(description),
		};
	})
	.sort((a, b) => b.total - a.total);

console.log("per-tool tokens (sorted): name | total tok | desc bytes | ~schema tok");
for (const row of rows) {
	console.log(
		`  ${row.name.padEnd(20)} ${String(row.total).padStart(6)}  ${String(row.descBytes).padStart(7)}  ${String(row.schema).padStart(6)}`,
	);
}
console.log(`\nTOOLS TOTAL tokens: ${estimateToolSchemaTokens(tools as never)}\n`);

const inspection = await inspectSystemPrompt({
	tools: new Map<string, Tool>(tools.map(t => [t.name, t])) as never,
	toolNames: tools.map(t => t.name),
	cwd: process.cwd(),
});
console.log(formatInspectionTable(inspection));
