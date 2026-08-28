import { preferredDialect } from "@veyyon/catalog/identity";
import { getDialectDefinition } from "./factory";
import { THINK_CLOSE, THINK_OPEN } from "./wire-tags";

export function renderDemotedThinking(modelId: string, text: string): string {
	if (!text) return "";
	text = text.toWellFormed();
	const dialect = preferredDialect(modelId);
	if (dialect === "anthropic") return text;
	if (dialect === "harmony" || dialect === "gemma") return `${THINK_OPEN}\n${text}\n${THINK_CLOSE}`;
	return getDialectDefinition(dialect).renderThinking(text);
}
