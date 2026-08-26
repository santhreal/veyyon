import type { AnthropicOptions } from "./providers/anthropic";
import type { ToolChoice } from "./types";

export function mapAnthropicToolChoice(choice?: ToolChoice): AnthropicOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string")
		return choice === "required" ? "any" : ["auto", "none", "any"].includes(choice) ? choice : undefined;
	if (choice.type === "tool" || choice.type === "function") {
		const name = choice.type === "tool" ? choice.name : "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "tool", name } : undefined;
	}
	return undefined;
}
