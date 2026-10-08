import { ThemeToggle } from "@veyyon/tool-render";
import type { SessionState } from "@veyyon/wire";
import { LogOut, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import type { GuestSnapshot } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import { useThemePreference } from "../../lib/theme";

export interface HeaderBarProps {
	snapshot: GuestSnapshot;
	subCount: number;
	railOpen: boolean;
	onToggleRail(): void;
	onLeave(): void;
}

export function HeaderBar({ snapshot, subCount, railOpen, onToggleRail, onLeave }: HeaderBarProps): ReactNode {
	const { header, state, phase, readOnly } = snapshot;
	const title = header?.title ?? state?.sessionName ?? "session";
	const { preference, setPreference } = useThemePreference();

	return (
		<header className="sh-header">
			<div className="sh-header-left">
				<span className="sh-title" title={title}>
					{title}
				</span>
				{state?.cwd && (
					<span className="sh-cwd" title={state.cwd}>
						{shortenPath(state.cwd, { collapseAfter: 4 })}
					</span>
				)}
			</div>
			<div className="sh-header-right">
				{readOnly && (
					<span className="sh-chip" title="you joined with a read-only link — watching only">
						read-only
					</span>
				)}
				{state?.model && <span className="sh-chip sh-chip-meta">{state.model.name}</span>}
				{state?.thinkingLevel && <span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>}
				<ContextGauge usage={state?.contextUsage} />
				{state && state.participants.length > 0 && (
					<span className="sh-avatars">
						{state.participants.map((p, i) => (
							<span
								key={`${p.name}:${i}`}
								className={p.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"}
								title={`${p.name} · ${p.role}${p.readOnly ? " · view-only" : ""}`}
							>
								{(p.name[0] ?? "?").toUpperCase()}
							</span>
						))}
					</span>
				)}
				<span className={`sh-dot sh-dot-${phase}`} title={phase} />
				<ThemeToggle preference={preference} setPreference={setPreference} className="sh-theme-toggle" />
				<button
					type="button"
					className={railOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleRail}
					title={railOpen ? "hide agents" : "show agents"}
				>
					<PanelRight size={14} />
					{subCount > 0 && <span className="sh-badge">{subCount}</span>}
				</button>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onLeave} title="leave session">
					<LogOut size={14} />
				</button>
			</div>
		</header>
	);
}

/** Context-window fill from the reported percent, else from tokens over the window; nothing when neither is known. */
function ContextGauge({ usage }: { usage: SessionState["contextUsage"] | undefined }): ReactNode {
	if (!usage) return null;
	const pct =
		usage.percent ??
		(usage.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0
			? (usage.tokens / usage.contextWindow) * 100
			: null);
	if (pct == null) return null;
	return (
		<span className={pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"} title={`context · ${fmtPercent(pct)}`}>
			<span className="sh-gauge-track">
				<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
			</span>
			<span className="sh-gauge-pct">{fmtPercent(pct)}</span>
		</span>
	);
}
