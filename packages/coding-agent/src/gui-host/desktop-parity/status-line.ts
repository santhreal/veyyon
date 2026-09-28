/**
 * The terminal's status-line segments, and the snapshot section the desktop
 * reads to show the same fact in its run bar, header or composer footer.
 * Members are the keys of `SEGMENTS` in
 * `modes/terminal/components/status-line/segments.ts`.
 */
import type { DesktopCarrier } from "./carrier";

export const STATUS_SEGMENT_CARRIERS: Readonly<Record<string, DesktopCarrier>> = {
	pi: { optOut: "The product mark; the window's title bar and icon draw it." },
	/** `ModelsView.current` and `ModelsView.thinking_level`. */
	model: { section: "Models" },
	account: {
		gap: "When a provider stores more than one login, the desktop does not show which account serves the session.",
	},
	/** `SessionHeaderView.mode`. */
	mode: { section: "ActiveSession" },
	/** `SessionHeaderView.cwd`. */
	path: { section: "ActiveSession" },
	git: { gap: "The desktop lists changed files from Changes but does not show the checked-out branch." },
	pr: { gap: "The pull request for the checked-out branch is not shown on the desktop." },
	/** One row per agent. */
	agents: { section: "Agents" },
	/** A backgrounded conversation is a session listed as running. */
	background: { section: "Sessions" },
	/** `UsageTotals.input_tokens`. */
	token_in: { section: "Usage" },
	/** `UsageTotals.output_tokens`. */
	token_out: { section: "Usage" },
	/** The sum of the `UsageTotals` token counts. */
	token_total: { section: "Usage" },
	token_rate: { gap: "The desktop does not show the reply's tokens per second while it streams." },
	/** `UsageTotals.cost_microusd`. */
	cost: { section: "Usage" },
	/** `ContextBreakdownView.total_tokens` over `limit_tokens`. */
	context_pct: { section: "ContextBreakdown" },
	/** `ContextBreakdownView.total_tokens`. */
	context_total: { section: "ContextBreakdown" },
	time_spent: { gap: "The desktop does not show how long the agent has worked in this session." },
	time: { optOut: "The operating system clock is on screen beside the window." },
	/** `SessionHeaderView.id`. */
	session: { section: "ActiveSession" },
	hostname: {
		gap: "A window attached to another machine's host does not show that machine's name.",
	},
	/** `ProfilesView.active`. */
	profile: { section: "Profiles" },
	/** `UsageTotals.cache_read_tokens`. */
	cache_read: { section: "Usage" },
	/** `UsageTotals.cache_write_tokens`. */
	cache_write: { section: "Usage" },
	/** Cache reads over cache reads, cache writes and input, from `UsageTotals`. */
	cache_hit: { section: "Usage" },
	/** `SessionHeaderView.title`. */
	session_name: { section: "ActiveSession" },
	usage: { gap: "The subscription quota windows (5-hour and 7-day percent and reset) are not shown on the desktop." },
	/** `ShareView.role` and `ShareView.participants`. */
	collab: { section: "Share" },
};
