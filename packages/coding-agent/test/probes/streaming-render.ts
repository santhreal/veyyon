/**
 * Manual probe: how does an assistant message with thinking and code RENDER
 * while it streams?
 *
 * Written to reproduce a streaming-render bug and kept because the failure was
 * visual: the frames are correct byte by byte and wrong to look at. It replays a
 * real captured message (`test/fixtures/assistant-message-with-thinking-code.json`)
 * through the actual component into a real terminal, one chunk at a time.
 *
 * Run with: bun test/probes/streaming-render.ts
 * Needs: a terminal. It writes ANSI to stdout and sleeps between chunks, so it
 * proves nothing when captured to a pipe.
 */
import * as path from "node:path";
import type { AssistantMessage } from "@veyyon/ai";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/components/assistant-message";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { ProcessTerminal, TUI } from "@veyyon/tui";
import { sleep } from "bun";

// Initialize dark theme with full color support
Bun.env.COLORTERM = "truecolor";
initTheme();

async function main() {
	// Load the real fixture that caused the bug
	const fixtureMessage: AssistantMessage = JSON.parse(
		await Bun.file(path.join(import.meta.dir, "../fixtures/assistant-message-with-thinking-code.json")).text(),
	);

	// Extract thinking and text content
	const thinkingContent = fixtureMessage.content.find(c => c.type === "thinking");
	const textContent = fixtureMessage.content.find(c => c.type === "text");

	if (thinkingContent?.type !== "thinking") {
		console.error("No thinking content in fixture");
		process.exit(1);
	}

	const fullThinkingText = thinkingContent.thinking;
	const fullTextContent = textContent && textContent.type === "text" ? textContent.text : "";

	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	// Start with empty message
	const message = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "" }],
	} as AssistantMessage;

	const component = new AssistantMessageComponent(message, false);
	tui.addChild(component);
	tui.start();

	// Simulate streaming thinking content
	let thinkingBuffer = "";
	const chunkSize = 10; // characters per "token"

	for (let i = 0; i < fullThinkingText.length; i += chunkSize) {
		thinkingBuffer += fullThinkingText.slice(i, i + chunkSize);

		// Update message content
		const updatedMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: thinkingBuffer }],
		} as AssistantMessage;

		component.updateContent(updatedMessage);
		tui.requestRender();

		await sleep(15); // Simulate token delay
	}

	// Now add the text content
	await sleep(500);

	const finalMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: fullThinkingText },
			{ type: "text", text: fullTextContent },
		],
	} as AssistantMessage;

	component.updateContent(finalMessage);
	tui.requestRender();

	// Keep alive for a moment to see the result
	await sleep(3000);

	tui.stop();
	process.exit(0);
}

main().catch(console.error);
