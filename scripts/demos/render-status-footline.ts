/**
 * Print the composer's metadata footline, one preset per row.
 *
 * The footline is the surface where a separator change is hardest to judge from
 * source: the question is never "which characters divide the segments" but "does the
 * line read as standing state on the left and live values on the right", and that is
 * a thing you see. Rendering all four presets at one width puts them side by side, so
 * a change to the grammar can be compared against the presets it does NOT apply to.
 *
 * Run:
 *     bun scripts/demos/render-status-footline.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/footline --width 100
 *
 * The session is a stub, and deliberately a FIXED one: real values would make two
 * renders differ because the git branch moved or the clock advanced, and a proof you
 * cannot re-take identically is not a proof.
 *
 * Two segments still read the machine rather than the session, and it is worth knowing
 * WHICH before comparing two proofs: `hostname` (`full` and `nerd` only) reports the
 * real host, `profile` reports the active profile, and `git` reports the repository this
 * runs in. Setting `VEYYON_PROFILE` here would not help: the directory resolution is
 * cached at import. A note goes to stderr so nobody reads a hostname or profile
 * difference as a change to the footline itself.
 */
import { StatusLineComponent } from "../../packages/coding-agent/src/modes/components/status-line/component";
import { STATUS_LINE_PRESETS } from "../../packages/coding-agent/src/modes/components/status-line/presets";
import type { StatusLinePreset } from "../../packages/coding-agent/src/modes/components/status-line/types";
import { theme } from "../../packages/coding-agent/src/modes/theme/theme";
import type { AgentSession } from "../../packages/coding-agent/src/session/agent-session";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
await initRender(themeName, { settings: true });

/** A session with every value the footline can read, all of them fixed. */
function stubSession(): AgentSession {
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
			getCwd: () => "/home/you/code/veyyon",
		},
		getPrewalkState: () => undefined,
		getAsyncJobSnapshot: () => undefined,
		settings: { getGroup: () => ({ enabled: false }) },
		isAdvisorActive: () => false,
		isApprovalBypassed: () => false,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => "medium",
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

const presets = Object.keys(STATUS_LINE_PRESETS) as StatusLinePreset[];
const lines: string[] = [];
for (const preset of presets) {
	const statusLine = new StatusLineComponent(stubSession());
	// The preset arrives through settings, which is how the app selects it too, so
	// this demo cannot drift from what a user with `statusLine.preset` set would see.
	statusLine.updateSettings({ preset });
	const rendered = statusLine.renderQuietLine(width);
	// The label goes on its own row: putting it in front of the line would shift every
	// segment and make the presets incomparable, which is the one thing to avoid here.
	lines.push(theme.fg("dim", `${preset}:`));
	lines.push(rendered ?? theme.fg("error", "(no footline rendered)"));
	lines.push("");
}

// The FOOTLINE while the view is proxied onto an agent — the one place that says you are inside
// one and that Esc leaves it. Rendered beside the unproxied row of the same preset, because the
// question a proof has to answer is not "is the hint there" but "does it read as an announcement
// rather than as one more segment".
//
// This used to render `getTopBorder`, a method with zero production callers: the composer is
// borderless, so the badge was being proved on a surface nobody could see.
lines.push(theme.fg("dim", "footline, viewing an agent:"));
{
	const statusLine = new StatusLineComponent(stubSession());
	statusLine.setSession(stubSession(), "designer-3");
	lines.push(statusLine.renderQuietLine(width) ?? theme.fg("error", "(no footline rendered)"));
}
lines.push("");

process.stdout.write(`${lines.join("\n")}\n`);
console.error(
	"note: the `hostname` (full, nerd), `profile` and `git` segments read this machine, so " +
		"those parts differ between hosts and profiles; everything else comes from the fixed stub.",
);
