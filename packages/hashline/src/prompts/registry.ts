import { definePromptRegistry, type PromptEntry } from "@veyyon/utils/prompt-registry";
import promptDescription from "../prompt.md" with { type: "text" };

export type { PromptEntry };

export const hashlinePrompts = definePromptRegistry("packages/hashline/src", {
	prompt: {
		text: promptDescription,
		purpose: "the hashline patch language, as the edit tool's description",
	},
});

export const HASHLINE_PROMPTS = hashlinePrompts.prompts;
