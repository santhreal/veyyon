/**
 * Render the effort picker for both shapes of ladder.
 *
 * A two-tier Google model offers low and high, a five-step OpenAI model offers
 * minimal through xhigh, and the step control has to read correctly at both
 * extremes. Both pickers go into one render, stacked with a gap, so the pair is
 * comparable in a single image.
 *
 * Flags: `--width`, plus `--two-tier-only` or `--wide-only` to drop the other
 * model when you want a proof of one ladder alone.
 *
 * Run:
 *     env -u NO_COLOR FORCE_COLOR=3 bun scripts/demos/render-effort-variants.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out assets/effort-variants --width 100 --scale 2
 *
 * The committed single-model pairs come from the same command with
 * `--two-tier-only` and `--out assets/model-effort-two-tier`, or `--wide-only`
 * and `--out assets/model-effort-wide-ladder`.
 */
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { Container, Spacer } from "@veyyon/tui";
import { renderEffortStep } from "../../packages/coding-agent/src/modes/components/effort-picker";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import { renderWidth } from "./render-args";

const args = process.argv.slice(2);
const width = renderWidth(args);
await initTheme();

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

const root = new Container();
const showGemini = !args.includes("--wide-only");
const showOpenAi = !args.includes("--two-tier-only");
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

process.stdout.write(`${root.render(width).join("\n")}\n`);
