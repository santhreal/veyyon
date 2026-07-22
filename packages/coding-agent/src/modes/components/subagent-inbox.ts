/**
 * Subagent Inbox overlay (experimental, opencode-style).
 *
 * A persistent split, not a modal table. The left column is a live per-agent
 * sidebar — one compact row per registered subagent (cursor, status glyph,
 * id, short label, elapsed) with a dim activity line under it — sorted by
 * status then registration order and frozen while open. The right column is
 * the focused agent's detail pane: its current activity plus the IRC messages
 * addressed to it, so inter-agent chatter that the flat transcript mashes
 * together reads as one calm, per-agent stream.
 *
 * The two columns are joined per line by a single sharp vertical rule (`│`)
 * with `┬`/`┴` where it meets the top and bottom dividers — silver structure,
 * deep-blue highlight only on the focused agent, no frames or glow (brand
 * law). It composes the existing surfaces (AgentRegistry, IrcBus, the ONE
 * status→color owner) rather than reinventing them; it does not replace the
 * Agent Hub until the layout is refined, so it ships behind the
 * `display.subagentInbox` flag (off by default).
 */
import { clamp, clampLow, Container, matchesKey, padding, type TUI, visibleWidth } from "@veyyon/tui";
import { formatAge } from "@veyyon/utils";
import type { KeyId } from "../../config/keybindings";
import { IrcBus } from "../../irc/bus";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { AGENT_STATUS_ORDER, agentStatusGlyph } from "./agent-status-display";

/** Refresh cadence for the relative-time labels (ages only; no layout change). */
const AGE_TICK_MS = 5_000;
/** Coalesce window for registry/bus change bursts into a single repaint. */
const DATA_CHANGE_RENDER_COALESCE_MS = 100;
/** Double-tap window for the left-left "close" gesture, matching the hub. */
const LEFT_TAP_WINDOW_MS = 500;
/** Newest inbound IRC messages shown in the detail pane. */
const DETAIL_IRC_LIMIT = 6;

export interface SubagentInboxDeps {
	/** Keys that toggle the inbox closed from inside (same as the hub keys). */
	hubKeys: KeyId[];
	onDone: () => void;
	requestRender: () => void;
	/** Injectable for tests; defaults to the process-global registry. */
	registry?: AgentRegistry;
	/** Injectable for tests; defaults to the process-global bus. */
	irc?: IrcBus;
	/** TUI handle for the component-scoped age repaint; tests omit it. */
	ui?: TUI;
	/** Enter on a row: focus/open the agent. Absent in render-only tests. */
	onOpenAgent?: (id: string) => void;
}

/** Truncate to width with tabs/newlines flattened, so a cell never wraps. */
function cellText(text: string, width: number): string {
	return truncateToWidth(replaceTabs(text).replace(/[\r\n]+/g, " "), Math.max(0, width));
}

/** Pad a (possibly colored) line to exactly `width` visible columns. */
function padCell(line: string, width: number): string {
	const truncated = cellText(line, width);
	return truncated + padding(Math.max(0, width - visibleWidth(truncated)));
}

export class SubagentInboxComponent extends Container {
	#registry: AgentRegistry;
	#irc: IrcBus;
	#hubKeys: KeyId[];
	#onDone: () => void;
	#requestRender: () => void;
	#onOpenAgent: ((id: string) => void) | undefined;
	#ui: TUI;

	#unsubscribers: Array<() => void> = [];
	#ageTimer: NodeJS.Timeout | undefined;
	#dataChangeTimer: NodeJS.Timeout | undefined;

	#rows: AgentRef[] = [];
	#selectedRow = 0;
	/** Frozen relative order captured on first refresh; new agents append. */
	#rowOrder: Map<string, number> | undefined;
	#lastLeftTap = 0;

	constructor(deps: SubagentInboxDeps) {
		super();
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#irc = deps.irc ?? IrcBus.global();
		this.#hubKeys = deps.hubKeys;
		this.#onDone = deps.onDone;
		this.#requestRender = deps.requestRender;
		this.#onOpenAgent = deps.onOpenAgent;
		this.#ui =
			deps.ui ??
			({
				requestRender: () => deps.requestRender(),
				requestComponentRender: () => deps.requestRender(),
			} as unknown as TUI);

		// The registry fires on every agent status/activity change; inbound IRC is
		// read fresh from the bus each render, so a registry subscription plus the
		// idle age tick is enough to keep the pane live without a second feed.
		this.#unsubscribers.push(this.#registry.onChange(() => this.#scheduleDataChange()));
		// Only the age labels move on this tick, never the row count or layout, so
		// a component-scoped repaint avoids re-walking the whole UI tree. The timer
		// lives only while the overlay is mounted.
		this.#ageTimer = setInterval(() => this.#ui.requestComponentRender(this), AGE_TICK_MS);
		this.#ageTimer.unref?.();

		this.#refreshRows();
	}

	/** Whether there are no subagents to show yet. */
	get isEmpty(): boolean {
		return this.#rows.length === 0;
	}

	/** Tear down every subscription and timer. Called by the overlay owner. */
	dispose(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		if (this.#ageTimer) {
			clearInterval(this.#ageTimer);
			this.#ageTimer = undefined;
		}
		if (this.#dataChangeTimer) {
			clearTimeout(this.#dataChangeTimer);
			this.#dataChangeTimer = undefined;
		}
	}

	/**
	 * Seed the left-left close detector so a single subsequent `←` dismisses the
	 * inbox, matching the hub's handoff from the `←←` opener gesture.
	 */
	armCloseTap(): void {
		this.#lastLeftTap = Date.now();
	}

	// ========================================================================
	// Live data
	// ========================================================================

	#scheduleDataChange(): void {
		if (this.#dataChangeTimer) return;
		this.#dataChangeTimer = setTimeout(() => {
			this.#dataChangeTimer = undefined;
			this.#refreshRows();
			this.#requestRender();
		}, DATA_CHANGE_RENDER_COALESCE_MS);
		this.#dataChangeTimer.unref?.();
	}

	#refreshRows(): void {
		const selectedId = this.#rows[this.#selectedRow]?.id;
		const refs = this.#registry.list().filter(ref => ref.id !== MAIN_AGENT_ID);

		if (!this.#rowOrder) {
			this.#rows = refs.sort(
				(a, b) => AGENT_STATUS_ORDER[a.status] - AGENT_STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity,
			);
			this.#rowOrder = new Map(this.#rows.map((ref, i) => [ref.id, i]));
		} else {
			this.#rows = refs.sort((a, b) => {
				const statusDiff = AGENT_STATUS_ORDER[a.status] - AGENT_STATUS_ORDER[b.status];
				if (statusDiff !== 0) return statusDiff;
				const aOrder = this.#rowOrder!.get(a.id) ?? Number.MAX_SAFE_INTEGER;
				const bOrder = this.#rowOrder!.get(b.id) ?? Number.MAX_SAFE_INTEGER;
				return aOrder - bOrder;
			});
			for (const ref of this.#rows) {
				if (!this.#rowOrder.has(ref.id)) this.#rowOrder.set(ref.id, this.#rowOrder.size);
			}
		}

		const keptIndex = selectedId ? this.#rows.findIndex(ref => ref.id === selectedId) : -1;
		this.#selectedRow = keptIndex >= 0 ? keptIndex : clamp(this.#selectedRow, 0, Math.max(0, this.#rows.length - 1));
	}

	// ========================================================================
	// Render
	// ========================================================================

	override render(width: number): readonly string[] {
		const sidebarW = clamp(Math.round(width * 0.42), 24, 48);
		const detailW = clampLow(width - sidebarW - 1, 1, width);
		const rule = theme.fg("border", "│");
		const focused = this.#rows[this.#selectedRow];

		const lines: string[] = [];
		lines.push(this.#headerLine(sidebarW, detailW, focused));
		lines.push(theme.fg("border", `${"─".repeat(sidebarW)}┬${"─".repeat(detailW)}`));

		const sidebarLines = this.#sidebarLines(sidebarW);
		const detailLines = this.#detailLines(detailW, focused);
		const bodyHeight = Math.max(sidebarLines.length, detailLines.length, 1);
		for (let y = 0; y < bodyHeight; y++) {
			const left = padCell(sidebarLines[y] ?? "", sidebarW);
			const right = padCell(detailLines[y] ?? "", detailW);
			lines.push(`${left}${rule}${right}`);
		}

		lines.push(theme.fg("border", `${"─".repeat(sidebarW)}┴${"─".repeat(detailW)}`));
		lines.push(this.#footerLine(width));
		return lines;
	}

	/** ` agents · N running · M idle …` on the left, focused agent title on the right. */
	#headerLine(sidebarW: number, detailW: number, focused: AgentRef | undefined): string {
		const counts = this.#statusSummary();
		const heading = theme.fg("accent", "agents");
		const left = ` ${heading}${counts ? theme.fg("dim", ` ${theme.sep.dot} ${counts}`) : ""}`;
		const right = focused
			? ` ${agentStatusGlyph(focused.status)} ${theme.fg("link", theme.bold(replaceTabs(focused.id)))}${
					focused.activity ? theme.fg("dim", ` ${theme.sep.dot} ${cellText(focused.activity, Math.max(8, detailW - 20))}`) : ""
				}`
			: ` ${theme.fg("dim", "no agent focused")}`;
		return `${padCell(left, sidebarW)} ${padCell(right, detailW)}`;
	}

	#statusSummary(): string {
		const counts = { running: 0, idle: 0, parked: 0, aborted: 0 };
		for (const ref of this.#rows) counts[ref.status]++;
		const parts: string[] = [];
		for (const status of ["running", "idle", "parked", "aborted"] as const) {
			if (counts[status] > 0) parts.push(`${counts[status]} ${status}`);
		}
		return parts.join(theme.sep.dot);
	}

	/** Sidebar body: each agent as a 1-2 line entry, windowed around the selection. */
	#sidebarLines(width: number): string[] {
		if (this.#rows.length === 0) return [` ${theme.fg("dim", "no subagents yet")}`];
		const entries = this.#rows.map((ref, i) => this.#sidebarEntry(ref, i === this.#selectedRow, width));
		const budget = clampLow((process.stdout.rows || 40) - 6, 4, 1_000);

		let start = this.#selectedRow;
		let end = this.#selectedRow + 1;
		let used = entries[start]?.length ?? 0;
		for (let grew = true; grew; ) {
			grew = false;
			if (end < entries.length && used + entries[end].length <= budget) {
				used += entries[end].length;
				end++;
				grew = true;
			}
			if (start > 0 && used + entries[start - 1].length <= budget) {
				start--;
				used += entries[start].length;
				grew = true;
			}
		}

		const out: string[] = [];
		if (start > 0) out.push(` ${theme.fg("dim", `↑ ${start} more`)}`);
		for (let i = start; i < end; i++) out.push(...entries[i]);
		if (end < entries.length) out.push(` ${theme.fg("dim", `↓ ${entries.length - end} more`)}`);
		return out;
	}

	/** One agent row: `‹cursor› ‹glyph› ‹id› ‹label›  ‹age›` plus a dim activity line. */
	#sidebarEntry(ref: AgentRef, selected: boolean, width: number): string[] {
		const cursor = selected ? theme.fg("link", theme.nav.cursor) : " ";
		const id = selected ? theme.fg("link", theme.bold(replaceTabs(ref.id))) : theme.bold(replaceTabs(ref.id));
		const parts = [` ${cursor} ${agentStatusGlyph(ref.status)} ${id}`];
		if (ref.displayName && ref.displayName !== ref.id) {
			parts.push(theme.fg("dim", cellText(ref.displayName, Math.max(6, Math.floor(width / 2)))));
		}
		const unread = this.#irc.unreadCount(ref.id);
		if (unread > 0) parts.push(theme.fg("warning", `⧉ ${unread}`));
		const left = parts.join("  ");

		const age = theme.fg("dim", formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000))));
		const lw = visibleWidth(left);
		const aw = visibleWidth(age);
		const line = lw + 1 + aw <= width ? left + padding(width - lw - aw) + age : cellText(left, width);

		const entry = [line];
		if (ref.activity) entry.push(`     ${theme.fg("muted", cellText(ref.activity, Math.max(6, width - 6)))}`);
		return entry;
	}

	/** Detail pane for the focused agent: current activity, then inbound IRC. */
	#detailLines(width: number, focused: AgentRef | undefined): string[] {
		if (!focused) return ["", ` ${theme.fg("dim", "select an agent to see its activity")}`];
		const out: string[] = [""];

		if (focused.activity) {
			out.push(` ${theme.fg("muted", `${theme.sep.dot} ${cellText(focused.activity, Math.max(8, width - 4))}`)}`);
		} else {
			out.push(` ${theme.fg("dim", "no activity reported yet")}`);
		}

		const inbox = this.#irc.inbox(focused.id, { peek: true });
		if (inbox.length > 0) {
			out.push("");
			for (const msg of inbox.slice(-DETAIL_IRC_LIMIT)) {
				const head = `${theme.fg("link", "←")} ${theme.fg("accent", replaceTabs(msg.from))}: `;
				const bodyW = Math.max(6, width - visibleWidth(head) - 2);
				out.push(` ${head}${theme.fg("muted", cellText(msg.body, bodyW))}`);
			}
		}
		return out;
	}

	/** Footer: key hints left, the `experimental` tag right-aligned. */
	#footerLine(width: number): string {
		const hint = ` ${theme.fg("dim", "j/k select  ·  enter focus  ·  esc close")}`;
		const tag = theme.fg("warning", "experimental ");
		const gap = clampLow(width - visibleWidth(hint) - visibleWidth(tag), 1, width);
		return `${hint}${padding(gap)}${tag}`;
	}

	// ========================================================================
	// Input
	// ========================================================================

	handleInput(keyData: string): void {
		for (const key of this.#hubKeys) {
			if (matchesKey(keyData, key)) {
				this.#onDone();
				return;
			}
		}
		if (matchesKey(keyData, "escape")) {
			this.#onDone();
			return;
		}
		if (matchesKey(keyData, "left")) {
			const now = Date.now();
			if (now - this.#lastLeftTap < LEFT_TAP_WINDOW_MS) {
				this.#lastLeftTap = 0;
				this.#onDone();
			} else {
				this.#lastLeftTap = now;
			}
			return;
		}
		if (matchesKey(keyData, "j") || matchesSelectDown(keyData)) {
			if (this.#rows.length > 0) this.#selectedRow = Math.min(this.#selectedRow + 1, this.#rows.length - 1);
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			if (this.#rows.length > 0) this.#selectedRow = Math.max(this.#selectedRow - 1, 0);
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			const selected = this.#rows[this.#selectedRow];
			if (selected) this.#onOpenAgent?.(selected.id);
			return;
		}
	}
}
