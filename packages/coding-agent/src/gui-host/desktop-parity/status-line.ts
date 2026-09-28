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
	/** `ServingAccountView`, stated when `logins` is two or more as the terminal does. */
	account: { section: "ServingAccount" },
	/** `SessionHeaderView.mode`. */
	mode: { section: "ActiveSession" },
	/** `SessionHeaderView.cwd`. */
	path: { section: "ActiveSession" },
	/** `CheckoutView.branch` and `CheckoutView.dirty`. */
	git: { section: "Checkout" },
	/** `CheckoutView.pull_request`. */
	pr: { section: "Checkout" },
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
	/** `PaceView.tokens_per_second_tenths`. */
	token_rate: { section: "Pace" },
	/** `UsageTotals.cost_microusd`. */
	cost: { section: "Usage" },
	/** `ContextBreakdownView.total_tokens` over `limit_tokens`. */
	context_pct: { section: "ContextBreakdown" },
	/** `ContextBreakdownView.total_tokens`. */
	context_total: { section: "ContextBreakdown" },
	/** `PaceView.worked_ms` plus the running window from `PaceView.working_since_ms`. */
	time_spent: { section: "Pace" },
	time: { optOut: "The operating system clock is on screen beside the window." },
	/** `SessionHeaderView.id`. */
	session: { section: "ActiveSession" },
	/** `HostView.hostname`, drawn before its first `.` as the terminal does. */
	hostname: { section: "Host" },
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
	/** `QuotaView`: the plan tier and the five-hour and seven-day windows. */
	usage: { section: "Quota" },
	/** `ShareView.role` and `ShareView.participants`. */
	collab: { section: "Share" },
};
