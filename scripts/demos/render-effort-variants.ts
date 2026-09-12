/**
 * Render reasoning effort picker step interfaces for different model effort ladders.
 *
 * Constructs mock models for a two-tier effort ladder and a five-tier effort ladder.
 * Renders the effort picker step container for Gemini and GPT models side by side or
 * individually, and prints the rendered components as ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-effort-variants.ts [--wide-only] [--two-tier-only] [--width 100] [--theme titanium]
 */

import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { Container, Spacer } from "@veyyon/tui";
import { renderEffortStep } from "../../packages/coding-agent/src/modes/terminal/components/selectors/effort-picker";
import { renderDemo } from "./render-args";

const gemini = buildModel({
	id: "gemini-two-tier",
	name: "Gemini two tier",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com",
	reasoning: true,
	thinking: { mode: "google-level", efforts: [Effort.Low, Effort.High] },
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
});
const openai = buildModel({
	id: "gpt-wide-ladder",
	name: "GPT wide ladder",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	thinking: {
		mode: "effort",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	},
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
});

await renderDemo(({ width, hasFlag }) => {
	const root = new Container();
	const showGemini = !hasFlag("wide-only");
	const showOpenAi = !hasFlag("two-tier-only");
	if (showGemini) {
		const geminiPicker = new Container();
		renderEffortStep(
			geminiPicker,
			"google/gemini-two-tier",
			gemini,
			() => {},
			() => {},
		);
		root.addChild(geminiPicker);
	}
	if (showGemini && showOpenAi) root.addChild(new Spacer(2));
	if (showOpenAi) {
		const openaiPicker = new Container();
		renderEffortStep(
			openaiPicker,
			"openai/gpt-wide-ladder",
			openai,
			() => {},
			() => {},
		);
		root.addChild(openaiPicker);
	}
	return root.render(width);
});
