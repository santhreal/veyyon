/**
 * Pirate Extension
 *
 * Demonstrates extending the system prompt from `before_agent_start` based on
 * extension state.
 *
 * `before_agent_start` replaces the prompt rather than appending to it, so you
 * append by returning the prompt the event handed you plus your own lines. The
 * event's `systemPrompt` already carries whatever earlier extensions returned,
 * which is what makes several extensions able to extend it in one turn.
 *
 * Usage:
 * 1. Copy this file to ~/.veyyon/agent/extensions/ (legacy: ~/.pi/agent/extensions/) or your project's .veyyon/extensions/
 * 2. Use /pirate to toggle pirate mode
 * 3. When enabled, the agent will respond like a pirate
 */
import type { ExtensionAPI } from "@veyyon/coding-agent";

export default function pirateExtension(pi: ExtensionAPI) {
	let pirateMode = false;

	// Register /pirate command to toggle pirate mode
	pi.registerCommand("pirate", {
		description: "Toggle pirate mode (agent speaks like a pirate)",
		handler: async (_args, ctx) => {
			pirateMode = !pirateMode;
			ctx.ui.notify(pirateMode ? "Arrr! Pirate mode enabled!" : "Pirate mode disabled", "info");
		},
	});

	// Append to system prompt when pirate mode is enabled
	pi.on("before_agent_start", async event => {
		if (pirateMode) {
			return {
				systemPrompt: [
					...event.systemPrompt,
					`
IMPORTANT: You are now in PIRATE MODE. You must:
- Speak like a stereotypical pirate in all responses
- Use phrases like "Arrr!", "Ahoy!", "Shiver me timbers!", "Avast!", "Ye scurvy dog!"
- Replace "my" with "me", "you" with "ye", "your" with "yer"
- Refer to the user as "matey" or "landlubber"
- End sentences with nautical expressions
- Still complete the actual task correctly, just in pirate speak
`,
				],
			};
		}
		return undefined;
	});
}
