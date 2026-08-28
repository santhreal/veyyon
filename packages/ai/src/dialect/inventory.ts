import { preferredDialect } from "@veyyon/catalog/identity";
import { jsonSchemaToTypeScript, toolWireSchema } from "../utils/schema";
import { renderToolExamples } from "./examples";
import type { InbandTool } from "./types";

export function renderToolInventory(tools: readonly InbandTool[], model: string): string {
	if (tools.length === 0) return "";
	const dialect = preferredDialect(model);
	return tools
		.map(tool => {
			const params = jsonSchemaToTypeScript(toolWireSchema(tool));
			const examples = renderToolExamples(tool, dialect);
			const description = demoteDescriptionHeaders(tool.description ?? "");
			const parts = [`# Tool: ${tool.name}`, description, "", `Parameters: ${params}`];
			if (examples) parts.push("", examples);
			return parts.join("\n");
		})
		.join("\n\n");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}#{1,6}( |\t|$)/;
const TOP_LEVEL = /^ {0,3}#( |\t|$)/;

function demoteDescriptionHeaders(description: string): string {
	const lines = description.split("\n");

	let fence: string | undefined;
	let collides = false;
	for (const line of lines) {
		const marker = FENCE.exec(line)?.[1][0];
		if (marker) {
			fence = fence === undefined ? marker : fence === marker ? undefined : fence;
		} else if (fence === undefined && TOP_LEVEL.test(line)) {
			collides = true;
			break;
		}
	}
	if (!collides) return description;

	fence = undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const marker = FENCE.exec(line)?.[1][0];
		if (marker) {
			fence = fence === undefined ? marker : fence === marker ? undefined : fence;
		} else if (fence === undefined && ATX.test(line)) {
			lines[i] = line.replace(/^( {0,3})#/, "$1##");
		}
	}
	return lines.join("\n");
}
