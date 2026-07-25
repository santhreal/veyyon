/**
 * Five full-screen TUI design variations for the veyyon session view, rendered
 * as PNG pitches (grey #1e2127 ground AND pure black, stacked per file) so the
 * design is judged on real grounds before any code changes. Same session
 * content in every variation; only the design system differs.
 *
 * Palette = titanium vars (theme/defaults/titanium.json).
 */
const P = {
	ember: "#F0862E",
	silver: "#C6CBD4",
	silverDim: "#8B93A4",
	dim: "#565F77",
	borderMuted: "#202329",
	green: "#7FB98A",
	amber: "#C9A24B",
	violet: "#9B7EDE",
};

const COLS = 104;

interface Cell {
	ch: string;
	color: string;
	bold?: boolean;
}
type Row = Cell[];

function blank(): Row {
	return [];
}

function put(row: Row, col: number, text: string, color: string, bold = false): void {
	let x = col;
	for (const ch of text) {
		row[x] = { ch, color, bold };
		x++;
	}
}

function textRow(parts: Array<[number, string, string, boolean?]>): Row {
	const row: Row = [];
	for (const [col, text, color, bold] of parts) put(row, col, text, color, bold ?? false);
	return row;
}

function right(row: Row, endCol: number, text: string, color: string): void {
	put(row, endCol - [...text].length, text, color);
}


/** Right-aligned footline meta ending at endCol: label · gauge (color-encoded fill) · percent. */
function footRight(row: Row, endCol: number, labelColor: string): void {
	const pct = " 12%";
	const track = 8;
	const label = "work · SWE-1.6 · ";
	const start = endCol - [...pct].length - track - [...label].length;
	put(row, start, label, labelColor);
	put(row, start + [...label].length, "██", P.ember);
	put(row, start + [...label].length + 2, "█".repeat(track - 2), "#2A2E36");
	put(row, endCol - [...pct].length, pct, labelColor);
}

/** The shared session script every variation renders. */
const S = {
	user1: "fix the flaky auth test in ci",
	reply1a: "The retry loop in auth.test.ts polls the real clock, so under load the token refresh",
	reply1b: "lands after the assertion. Pinning the clock and asserting on the refresh event instead.",
	cmd: "bun test auth --repeat 50",
	cmdOut: "50 pass · 0 fail · 3.2s",
	reply2: "All green. The fix is in auth/refresh.ts:41.",
	user2: "nice, commit it",
	placeholder: "ask anything · / for commands",
	locLeft: "▫ ~/veyyon · git:main",
	
};

// ── V1 · aligned quiet ──────────────────────────────────────────────────────
// One shared rail at col 2 for EVERY line: history ›, reply prose, tool rows,
// composer › and footline all on the same vertical. Single-blank rhythm.
function v1(): Row[] {
	const r: Row[] = [];
	r.push(blank());
	r.push(textRow([[2, "›", P.dim], [4, S.user1, P.silverDim]]));
	r.push(blank());
	r.push(textRow([[2, S.reply1a, P.silver]]));
	r.push(textRow([[2, S.reply1b, P.silver]]));
	r.push(blank());
	r.push(textRow([[2, "$", P.dim], [4, S.cmd, P.silverDim]]));
	r.push(textRow([[2, "└", P.dim], [4, S.cmdOut, P.dim]]));
	r.push(blank());
	r.push(textRow([[2, S.reply2, P.silver]]));
	r.push(blank());
	r.push(textRow([[2, "›", P.dim], [4, S.user2, P.silverDim]]));
	r.push(blank());
	r.push(blank());
	const hair: Row = [];
	put(hair, 0, "─".repeat(COLS), P.borderMuted);
	r.push(hair);
	r.push(blank());
	r.push(textRow([[2, "›", P.ember, true], [4, "█", P.silver], [5, " " + S.placeholder, P.dim]]));
	r.push(blank());
	const foot: Row = [];
	put(foot, 2, S.locLeft, P.dim);
	footRight(foot, COLS - 2, P.dim);
	r.push(foot);
	r.push(blank());
	return r;
}

// ── V2 · ember spine ────────────────────────────────────────────────────────
// A continuous dim spine at col 1 threads the whole conversation; your turns
// sit ON the spine as ember ›, tools hang off it with ├/└ connectors. The
// composer repeats the spine: hairline opens with a 3-cell ember fade.
function v2(): Row[] {
	const r: Row[] = [];
	const spine = (row: Row) => put(row, 1, "│", P.borderMuted);
	r.push(blank());
	r.push(textRow([[1, "›", P.ember, true], [3, S.user1, P.silver]]));
	{
		const w: Row = [];
		spine(w);
		r.push(w);
	}
	{
		const a: Row = [];
		spine(a);
		put(a, 3, S.reply1a, P.silver);
		r.push(a);
	}
	{
		const a: Row = [];
		spine(a);
		put(a, 3, S.reply1b, P.silver);
		r.push(a);
	}
	{
		const w: Row = [];
		spine(w);
		r.push(w);
	}
	{
		const t: Row = [];
		put(t, 1, "├", P.borderMuted);
		put(t, 3, "$ " + S.cmd, P.silverDim);
		r.push(t);
	}
	{
		const t: Row = [];
		spine(t);
		put(t, 3, "  " + S.cmdOut, P.dim);
		r.push(t);
	}
	{
		const w: Row = [];
		spine(w);
		r.push(w);
	}
	{
		const a: Row = [];
		spine(a);
		put(a, 3, S.reply2, P.silver);
		r.push(a);
	}
	{
		const w: Row = [];
		spine(w);
		r.push(w);
	}
	r.push(textRow([[1, "›", P.ember, true], [3, S.user2, P.silver]]));
	{
		const e: Row = [];
		put(e, 1, "╵", P.borderMuted);
		r.push(e);
	}
	r.push(blank());
	const hair: Row = [];
	put(hair, 0, "─", "#7A4517");
	put(hair, 1, "─", "#B4651F");
	put(hair, 2, "─", P.ember);
	put(hair, 3, "─".repeat(COLS - 3), P.borderMuted);
	r.push(hair);
	r.push(blank());
	r.push(textRow([[1, "›", P.ember, true], [3, "█", P.silver], [4, " " + S.placeholder, P.dim]]));
	r.push(blank());
	const foot: Row = [];
	put(foot, 3, S.locLeft, P.dim);
	footRight(foot, COLS - 2, P.dim);
	r.push(foot);
	r.push(blank());
	return r;
}

// ── V3 · turn headers ───────────────────────────────────────────────────────
// Editorial: every turn opens with a micro-label on a rule fragment
// (─╴you / ─╴◈ veyyon), body indented under it, two-row air between turns.
function v3(): Row[] {
	const r: Row[] = [];
	r.push(blank());
	r.push(textRow([[1, "─╴", P.borderMuted], [3, "you", P.dim]]));
	r.push(textRow([[3, S.user1, P.silver]]));
	r.push(blank());
	r.push(blank());
	r.push(textRow([[1, "─╴", P.borderMuted], [3, "●", P.ember], [5, "veyyon", P.dim]]));
	r.push(textRow([[3, S.reply1a, P.silver]]));
	r.push(textRow([[3, S.reply1b, P.silver]]));
	r.push(blank());
	r.push(textRow([[3, "$ " + S.cmd, P.silverDim], [3 + 2 + S.cmd.length + 3, "· " + S.cmdOut, P.dim]]));
	r.push(blank());
	r.push(textRow([[3, S.reply2, P.silver]]));
	r.push(blank());
	r.push(blank());
	r.push(textRow([[1, "─╴", P.borderMuted], [3, "you", P.dim]]));
	r.push(textRow([[3, S.user2, P.silver]]));
	r.push(blank());
	r.push(blank());
	const hair: Row = [];
	put(hair, 0, "─".repeat(COLS), P.borderMuted);
	put(hair, 1, "╴", P.borderMuted);
	r.push(hair);
	r.push(blank());
	r.push(textRow([[3, "›", P.ember, true], [5, "█", P.silver], [6, " " + S.placeholder, P.dim]]));
	r.push(blank());
	const foot: Row = [];
	put(foot, 3, S.locLeft, P.dim);
	footRight(foot, COLS - 3, P.dim);
	r.push(foot);
	r.push(blank());
	return r;
}

// ── V4 · prompt bar ─────────────────────────────────────────────────────────
// Your words carry an ember edge bar and full brightness; the agent's words
// are open text. Tool runs are hugged, framed cards. Meta lives right.
function v4(): Row[] {
	const r: Row[] = [];
	r.push(blank());
	r.push(textRow([[1, "▌", P.ember], [3, S.user1, P.silver, true]]));
	r.push(blank());
	r.push(textRow([[3, S.reply1a, P.silverDim]]));
	r.push(textRow([[3, S.reply1b, P.silverDim]]));
	r.push(blank());
	{
		const w = S.cmd.length + 4;
		const top: Row = [];
		put(top, 3, "╭" + "─".repeat(w) + "╮", P.borderMuted);
		r.push(top);
		const mid: Row = [];
		put(mid, 3, "│", P.borderMuted);
		put(mid, 5, "$ " + S.cmd, P.silverDim);
		put(mid, 3 + w + 1, "│", P.borderMuted);
		r.push(mid);
		const out: Row = [];
		put(out, 3, "│", P.borderMuted);
		put(out, 5, S.cmdOut, P.dim);
		put(out, 3 + w + 1, "│", P.borderMuted);
		r.push(out);
		const bot: Row = [];
		put(bot, 3, "╰" + "─".repeat(w) + "╯", P.borderMuted);
		r.push(bot);
	}
	r.push(blank());
	r.push(textRow([[3, S.reply2, P.silverDim]]));
	r.push(blank());
	r.push(textRow([[1, "▌", P.ember], [3, S.user2, P.silver, true]]));
	r.push(blank());
	r.push(blank());
	const hair: Row = [];
	put(hair, 0, "─".repeat(COLS), P.borderMuted);
	r.push(hair);
	r.push(blank());
	r.push(textRow([[1, "▌", P.ember], [3, "█", P.silver], [4, " " + S.placeholder, P.dim]]));
	r.push(blank());
	const foot: Row = [];
	put(foot, 3, S.locLeft, P.dim);
	footRight(foot, COLS - 2, P.silverDim);
	r.push(foot);
	r.push(blank());
	return r;
}

// ── V5 · wide air ───────────────────────────────────────────────────────────
// Maximal calm: five-column margins, double-blank turn rhythm, a whisper
// session strip up top, and the hairline inset to the content width with a
// centered sun tick.
function v5(): Row[] {
	const M = 5;
	const r: Row[] = [];
	const strip: Row = [];
	put(strip, M, "v e y y o n", P.dim);
	right(strip, COLS - M, "work · SWE-1.6", P.dim);
	r.push(blank());
	r.push(strip);
	r.push(blank());
	r.push(blank());
	r.push(textRow([[M, "›", P.dim], [M + 2, S.user1, P.silverDim]]));
	r.push(blank());
	r.push(blank());
	r.push(textRow([[M, S.reply1a, P.silver]]));
	r.push(textRow([[M, S.reply1b, P.silver]]));
	r.push(blank());
	r.push(textRow([[M, "$ " + S.cmd + "  ·  " + S.cmdOut, P.dim]]));
	r.push(blank());
	r.push(textRow([[M, S.reply2, P.silver]]));
	r.push(blank());
	r.push(blank());
	r.push(textRow([[M, "›", P.dim], [M + 2, S.user2, P.silverDim]]));
	r.push(blank());
	r.push(blank());
	const hair: Row = [];
	const mid = Math.floor(COLS / 2);
	put(hair, M, "─".repeat(COLS - 2 * M), P.borderMuted);
	put(hair, mid - 1, "──", P.ember);
	r.push(hair);
	r.push(blank());
	r.push(textRow([[M, "›", P.ember, true], [M + 2, "█", P.silver], [M + 3, " " + S.placeholder, P.dim]]));
	r.push(blank());
	const foot: Row = [];
	put(foot, M, S.locLeft, P.dim);
	footRight(foot, COLS - M, P.dim);
	r.push(foot);
	r.push(blank());
	return r;
}

// ── raster ──────────────────────────────────────────────────────────────────
const CW = 9;
const LH = 21;
const PAD = 26;

function screenSvg(rows: Row[], ground: string, label: string, yOff: number, structural: string): { svg: string; height: number } {
	const parts: string[] = [];
	const w = COLS * CW + PAD * 2;
	const h = rows.length * LH + PAD * 2 + 22;
	parts.push(`<rect x="0" y="${yOff}" width="${w}" height="${h}" fill="${ground}"/>`);
	parts.push(
		`<text x="${PAD}" y="${yOff + 18}" font-size="12" letter-spacing="2" font-family="DejaVu Sans Mono, monospace" fill="#6b7280">${label}</text>`,
	);
	let y = yOff + PAD + 22 + 14;
	for (const row of rows) {
		for (let x = 0; x < row.length; x++) {
			const cell = row[x];
			if (!cell || cell.ch === " ") continue;
			const fill = cell.color === P.borderMuted ? structural : cell.color;
			const esc = cell.ch === "<" ? "&lt;" : cell.ch === "&" ? "&amp;" : cell.ch === ">" ? "&gt;" : cell.ch;
			parts.push(
				`<text x="${PAD + x * CW}" y="${y}" font-size="15" font-family="DejaVu Sans Mono, monospace" font-weight="${cell.bold ? 700 : 400}" fill="${fill}">${esc}</text>`,
			);
		}
		y += LH;
	}
	return { svg: parts.join("\n"), height: h };
}

const VARIATIONS: Array<{ name: string; title: string; rows: Row[] }> = [
	{ name: "v1-aligned-quiet", title: "V1 · ALIGNED QUIET — one rail, every line at col 2", rows: v1() },
	{ name: "v2-ember-spine", title: "V2 · EMBER SPINE — the conversation threads one rail", rows: v2() },
	{ name: "v3-turn-headers", title: "V3 · TURN HEADERS — editorial labels, doubled air", rows: v3() },
	{ name: "v4-prompt-bar", title: "V4 · PROMPT BAR — your words carry the ember edge", rows: v4() },
	{ name: "v5-wide-air", title: "V5 · WIDE AIR — five-col margins, doubled rhythm", rows: v5() },
];

for (const variation of VARIATIONS) {
	const w = COLS * CW + PAD * 2;
	const a = screenSvg(variation.rows, "#1e2127", `${variation.title} · grey ground`, 0, "#3A3F49");
	const b = screenSvg(variation.rows, "#000000", `${variation.title} · black ground`, a.height + 8, "#24272E");
	const H = a.height + 8 + b.height;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}">
<rect width="${w}" height="${H}" fill="#101114"/>
${a.svg}
${b.svg}
</svg>`;
	await Bun.write(`${import.meta.dir}/${variation.name}.svg`, svg);
	console.log(`wrote ${variation.name}.svg (${w}x${H})`);
}
