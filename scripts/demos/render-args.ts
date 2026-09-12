/**
 * Argument reading shared by the proof-render scripts.
 *
 * The renderers under `scripts/demos/render-*.ts` exist to put a real component
 * on screen off-display, so they all take the same shape of argument: a
 * theme, a width, and a variant or two. Each one hand-rolled the same
 * `indexOf("--name")` lookup, and copies of an argument reader drift in exactly
 * the way that ruins a proof — one script defaulting to a different width than
 * another makes two captures incomparable, and nothing about the images says
 * why.
 */

import { setAnsiPolicy } from "@veyyon/tui";
import type { TUI } from "../../hosts/terminal/engine/src/index";
import type { AgentSession } from "../../packages/coding-agent/src/session/agent-session";
import { theme } from "../../packages/coding-agent/src/theme/theme";

/** The value after `--name`, or `fallback` when the flag is absent. */
export function flag(name: string, fallback: string, argv: readonly string[] = process.argv): string {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

/** Whether `--name` is present at all. */
export function hasFlag(name: string, argv: readonly string[] = process.argv): boolean {
	return argv.includes(`--${name}`);
}

/** The numeric value after `--name`, or `fallback` when absent or not finite. */
export function flagNumber(name: string, fallback: number, argv: readonly string[] = process.argv): number {
	const val = Number(flag(name, String(fallback), argv));
	return Number.isFinite(val) ? val : fallback;
}

/** Two dimmed lines showing column indices (tens and units) up to `width`. */
export function renderRuler(width: number): string[] {
	let tens = "";
	let units = "";
	for (let col = 0; col < width; col++) {
		tens += col % 10 === 0 ? String(Math.floor(col / 10) % 10) : " ";
		units += String(col % 10);
	}
	return [theme.fg("dim", tens), theme.fg("dim", units)];
}

/** A minimal no-op TUI interface for standalone component rendering. */
export function mockTui(): TUI {
	return { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
}

export interface StateLoad {
	readonly label?: string;
	readonly bypassed?: boolean;
	readonly approvalMode?: string;
	readonly plan?: { enabled: boolean; paused: boolean };
	readonly goal?: { enabled: boolean; paused: boolean };
	readonly goalState?: { tokensUsed: number; tokenBudget?: number; status?: string };
	readonly vibe?: boolean;
	readonly loop?: boolean;
	readonly agents?: number;
}

/** A stub agent session with fixed usage statistics for demo/proof rendering. */
export function createStubStatusSession(load: StateLoad = {}, cwd = "/home/you/code/veyyon"): AgentSession {
	const usage = {
		input: 12_000,
		output: 3_400,
		cacheRead: 48_000,
		cacheWrite: 1_200,
		totalTokens: 64_600,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 2,
		cost: 0.42,
		tokensPerSecond: 58.4,
	};
	const goal = load.goalState
		? {
				goal: {
					tokensUsed: load.goalState.tokensUsed,
					tokenBudget: load.goalState.tokenBudget,
					status: load.goalState.status ?? "active",
				},
			}
		: undefined;
	return {
		messages: [],
		model: { contextWindow: 200_000, id: "gpt-5", name: "gpt-5", provider: "openai" },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 84_000, contextWindow: 200_000 }),
		state: { messages: [], model: { contextWindow: 200_000, id: "gpt-5", name: "gpt-5" } },
		sessionManager: {
			getUsageStatistics: () => usage,
			getSessionName: () => "parser-rewrite",
			getCwd: () => cwd,
		},
		getPrewalkState: () => undefined,
		getAsyncJobSnapshot: () => undefined,
		getGoalModeState: () => goal,
		settings: {
			getGroup: () => ({ enabled: false }),
			get: (path: string) => (path === "goal.modelBudgetsEnabled" ? true : undefined),
		},
		isAdvisorActive: () => false,
		isApprovalBypassed: () => load.bypassed === true,
		effectiveApprovalMode: () => load.approvalMode ?? "auto",
		isFastModeActive: () => false,
		isStreaming: false,
		configuredThinkingLevel: () => "medium",
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

/**
 * The capture width in columns.
 *
 * One default across every proof script, so two captures taken for the same
 * change are the same size and can be compared side by side.
 */
export function renderWidth(argv: readonly string[] = process.argv): number {
	return Number(flag("width", "100", argv));
}

/**
 * Bring up the theme (and settings, when the component needs them) for a capture.
 *
 * Order is the whole reason this exists. `Settings.init` applies the CONFIGURED
 * theme, so a script that initialised the theme first had it silently replaced
 * by whatever theme the capturing machine happens to use — and the resulting
 * image looks like a real render, just of the wrong theme. That is how a
 * "light-ground" settings capture came out in titanium and produced a defect
 * report for a near-black selection slab that the light theme does not have.
 *
 * Both slots get the same theme on purpose: the render must not depend on the
 * capturing terminal's background luminance, which is the variable the tapes
 * are deliberately changing.
 *
 * COLOUR IS FORCED ON, because a proof render's destination is a rasterizer and
 * not a terminal. The ansi policy downgrades a piped stream to `plain`, which is
 * right for ordinary output and wrong for exactly this one case: every proof
 * taken the documented way (`render-*.ts | render-proof.ts`) came out with the
 * component's body in default white. `theme.fg("error", …)` returned its input,
 * so a red refusal and a dim hint rasterized as the same colour and the image
 * could not answer the question it was taken to answer. Only the modal border
 * survived, because that path writes truecolor escapes itself.
 *
 * Pass `settings: true` for any component that reads `Settings`.
 *
 * `--ground <#rrggbb>` reports a terminal ground, the way a real session learns
 * one from OSC 11. Chrome that is mixed RELATIVE to the visible ground — a card's
 * specular sweep, any surface material — is off until something reports one, so a
 * proof of that chrome taken without this flag renders the no-material fallback
 * and cannot answer the question it was taken for.
 */
export async function initRender(themeName: string, options: { settings?: boolean } = {}): Promise<void> {
	const { initTheme } = await import("../../packages/coding-agent/src/theme/theme");
	if (options.settings) {
		const { Settings } = await import("../../packages/coding-agent/src/config/settings");
		await Settings.init({ inMemory: true });
	}
	await initTheme(false, "unicode", false, themeName, themeName);
	// AFTER the inits, both of which set the policy from the environment and would
	// undo this.
	setAnsiPolicy("full");
	const ground = flag("ground", "");
	if (ground !== "") {
		const { setDetectedTerminalGround } = await import("../../packages/coding-agent/src/theme/ground-tints");
		setDetectedTerminalGround(ground);
	}
}

export interface RenderContext {
	theme: string;
	width: number;
	height: number;
	flag: (name: string, fallback?: string) => string;
	hasFlag: (name: string) => boolean;
}

/**
 * Standard driver for proof renderers: brings up theme/settings and writes stdout.
 */
export async function renderDemo(
	draw: (ctx: RenderContext) => Promise<readonly string[] | string> | readonly string[] | string,
	options: { settings?: boolean; defaultTheme?: string; defaultHeight?: number } = {},
): Promise<void> {
	const themeName = flag("theme", options.defaultTheme ?? "titanium");
	const width = renderWidth();
	const height = Number(flag("height", String(options.defaultHeight ?? Number(flag("rows", "24")))));
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => height });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => width });
	await initRender(themeName, { settings: options.settings });
	const result = await draw({
		theme: themeName,
		width,
		height,
		flag: (name: string, fallback = "") => flag(name, fallback),
		hasFlag: (name: string) => hasFlag(name),
	});
	const lines = typeof result === "string" ? [result] : result;
	process.stdout.write(`${lines.join("\n")}\n`);
}
