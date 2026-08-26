import { formatUsd, type RunRole } from "../../wire";
import { useMeasuredWidth } from "../hooks/use-measured-width";

export interface ScatterPt {
	key: string;
	label: string;
	role: RunRole;
	/** Values are linear projections (arm still running). */
	projected: boolean;
	cost: number;
	pass: number;
}

const DOT_COLOR: Record<RunRole, string> = { baseline: "#38bdf8", variant: "#34d399", "": "#a1a1aa" };

interface LabelBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

const boxesOverlap = (a: LabelBox, b: LabelBox): boolean =>
	a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Greedy point-label placement: right → left → above → below; the first spot
 * that stays inside the plot and clears every earlier label + dot wins.
 */
function placeLabels(
	pts: Array<{ key: string; label: string; px: number; py: number }>,
	plot: { x0: number; y0: number; x1: number; y1: number },
): Map<string, { lx: number; ly: number; anchor: "start" | "middle" | "end" }> {
	const placed: LabelBox[] = pts.map(p => ({ x: p.px - 6, y: p.py - 6, w: 12, h: 12 }));
	const out = new Map<string, { lx: number; ly: number; anchor: "start" | "middle" | "end" }>();
	for (const p of [...pts].sort((a, b) => a.py - b.py)) {
		const w = p.label.length * 5.8 + 4;
		const h = 11;
		const candidates: Array<{ lx: number; ly: number; anchor: "start" | "middle" | "end"; box: LabelBox }> = [
			{ lx: p.px + 8, ly: p.py + 3, anchor: "start", box: { x: p.px + 8, y: p.py - 5.5, w, h } },
			{ lx: p.px - 8, ly: p.py + 3, anchor: "end", box: { x: p.px - 8 - w, y: p.py - 5.5, w, h } },
			{ lx: p.px, ly: p.py - 9, anchor: "middle", box: { x: p.px - w / 2, y: p.py - 17, w, h } },
			{ lx: p.px, ly: p.py + 15, anchor: "middle", box: { x: p.px - w / 2, y: p.py + 7, w, h } },
		];
		let chosen = candidates[0];
		for (const c of candidates) {
			if (c.box.x < plot.x0 || c.box.x + c.box.w > plot.x1 || c.box.y < plot.y0 || c.box.y + c.box.h > plot.y1)
				continue;
			if (placed.some(b => boxesOverlap(b, c.box))) continue;
			chosen = c;
			break;
		}
		placed.push(chosen.box);
		out.set(p.key, chosen);
	}
	return out;
}

/**
 * Cost-vs-success tradeoff, one labelled point per arm; the anchor arm gets
 * crosshairs so "cheaper & better" reads as a quadrant.
 */
export function ScatterChart({
	pts,
	anchor,
	focus,
	onFocus,
}: {
	pts: ScatterPt[];
	anchor: ScatterPt | null;
	focus: string | null;
	onFocus: (key: string) => void;
}) {
	const [ref, width] = useMeasuredWidth();
	const H = 268;
	const m = { l: 46, r: 14, t: 12, b: 30 };
	const maxCost = Math.max(...pts.map(p => p.cost), 0.01) * 1.12;
	const passVals = pts.length > 0 ? pts.map(p => p.pass) : [0, 100];
	const passLo = Math.max(0, Math.min(...passVals) - 8);
	const passHi = Math.min(100, Math.max(...passVals) + 8);
	const x = (c: number) => m.l + (c / maxCost) * Math.max(width - m.l - m.r, 1);
	const y = (p: number) => m.t + (1 - (p - passLo) / Math.max(passHi - passLo, 1e-9)) * (H - m.t - m.b);
	const labels = placeLabels(
		pts.map(p => ({ key: p.key, label: p.label, px: x(p.cost), py: y(p.pass) })),
		{ x0: 2, y0: 2, x1: Math.max(width - 2, 4), y1: H - 16 },
	);
	return (
		<div ref={ref} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
			<div className="mb-1 flex items-baseline justify-between">
				<h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">cost vs success</h3>
				<span className="text-[9px] text-zinc-600">↖ cheaper &amp; better</span>
			</div>
			{pts.length === 0 || width === 0 ? (
				<div className="flex h-[268px] items-center justify-center text-xs text-zinc-600">
					no decided trials yet
				</div>
			) : (
				<svg width={width} height={H} role="img" aria-label="pass rate versus cost per task; one point per arm">
					{[0, 1 / 3, 2 / 3, 1].map(f => {
						const v = passLo + f * (passHi - passLo);
						return (
							<g key={`y${f}`}>
								<line x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} stroke="#27272a" strokeDasharray="3,3" />
								<text x={m.l - 6} y={y(v) + 3} textAnchor="end" fontSize={9} fill="#71717a">
									{v.toFixed(0)}%
								</text>
							</g>
						);
					})}
					{[0.25, 0.5, 0.75, 1].map(f => {
						const v = f * maxCost;
						return (
							<g key={`x${f}`}>
								<line x1={x(v)} x2={x(v)} y1={m.t} y2={H - m.b} stroke="#27272a" strokeDasharray="3,3" />
								<text x={x(v)} y={H - m.b + 12} textAnchor="middle" fontSize={9} fill="#71717a">
									{formatUsd(v)}
								</text>
							</g>
						);
					})}
					{anchor && (
						<g stroke="#52525b" strokeDasharray="2,3">
							<line x1={x(anchor.cost)} x2={x(anchor.cost)} y1={m.t} y2={H - m.b} />
							<line x1={m.l} x2={width - m.r} y1={y(anchor.pass)} y2={y(anchor.pass)} />
						</g>
					)}
					{pts.map(p => {
						const px = x(p.cost);
						const py = y(p.pass);
						const focusedPt = focus === p.key;
						const dim = focus !== null && !focusedPt;
						const color = DOT_COLOR[p.role];
						const lab = labels.get(p.key);
						return (
							<g
								key={p.key}
								role="button"
								tabIndex={0}
								aria-label={`focus ${p.label}`}
								opacity={dim ? 0.35 : 1}
								className="cursor-pointer focus:outline-none"
								onClick={() => onFocus(p.key)}
								onKeyDown={ev => {
									if (ev.key === "Enter" || ev.key === " ") {
										ev.preventDefault();
										onFocus(p.key);
									}
								}}
							>
								<title>{`${p.label} · ${p.pass.toFixed(0)}% · ${formatUsd(p.cost)}/task${p.projected ? " (projected)" : ""}`}</title>
								<circle cx={px} cy={py} r={10} fill="transparent" />
								{focusedPt && <circle cx={px} cy={py} r={8} fill="none" stroke="#7dd3fc" />}
								{p.projected ? (
									<circle
										cx={px}
										cy={py}
										r={4.5}
										fill="none"
										stroke={color}
										strokeWidth={1.5}
										strokeDasharray="2,2"
									/>
								) : (
									<circle cx={px} cy={py} r={4.5} fill={color} fillOpacity={0.92} />
								)}
								{lab && (
									<text
										x={lab.lx}
										y={lab.ly}
										textAnchor={lab.anchor}
										fontSize={9.5}
										fill={focusedPt ? "#bae6fd" : "#a1a1aa"}
									>
										{p.label}
									</text>
								)}
							</g>
						);
					})}
				</svg>
			)}
		</div>
	);
}
