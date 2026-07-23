/**
 * REAL full-screen render: the shipped transcript components + composer zone
 * classes from THIS worktree's src, assembled the way interactive-mode mounts
 * them, rendered at a fixed width and rasterized to PNG on the grey ground
 * (#1e2127) and black. No mock rows — every byte comes from the real
 * components under the real titanium theme. Usage:
 *   bun mockups/real-shot.ts <label>
 */
const WT = "/media/mukund-thiru/SanthData/Santh/software/veyyon/veyyon/.claude/worktrees/tui-mockups";
const ROOT = `${WT}/packages/coding-agent/src`;
const label = process.argv[2] ?? "baseline";

const { Settings, settings } = await import(`${ROOT}/config/settings.ts`);
const themeMod = await import(`${ROOT}/modes/theme/theme.ts`);
const { getThemeByName, setThemeInstance } = themeMod;
const { KeybindingsManager } = await import(`${ROOT}/config/keybindings.ts`);
const tui = await import(`${WT}/packages/tui/src/index.ts`);
await Settings.init({ inMemory: true });
setThemeInstance((await getThemeByName("titanium"))!);
const theme = themeMod.theme;
tui.setKeybindings(KeybindingsManager.inMemory());

const { UserMessageComponent } = await import(`${ROOT}/modes/components/user-message.ts`);
const { AssistantMessageComponent } = await import(`${ROOT}/modes/components/assistant-message.ts`);
const { TranscriptContainer } = await import(`${ROOT}/modes/components/transcript-container.ts`);
const { ComposerHairline, CardPadRow, QuietZoneLine, COMPOSER_INSET_COLS, resolveComposerAccents } = await import(
	`${ROOT}/modes/components/composer-chrome.ts`
);
const { BashExecutionComponent } = await import(`${ROOT}/modes/components/bash-execution.ts`);

const WIDTH = 104;

function assistant(text: string): InstanceType<typeof AssistantMessageComponent> {
	return new AssistantMessageComponent(
		{ role: "assistant", content: [{ type: "text", text }] } as never,
		undefined as never,
	);
}

const chat = new TranscriptContainer();
chat.addChild(new UserMessageComponent("fix the flaky auth test in ci"));
chat.addChild(
	assistant(
		"The retry loop in auth.test.ts polls the real clock, so under load the token refresh lands after the assertion. Pinning the clock and asserting on the refresh event instead.",
	),
);
const fakeUi = { requestRender() {}, requestComponentRender() {} } as never;
const bash = new BashExecutionComponent("bun test auth --repeat 50", fakeUi, false);
bash.appendOutput("50 pass · 0 fail · 3.2s\n");
bash.setComplete(0, false, {});
chat.addChild(bash);
chat.addChild(assistant("All green. The fix is in auth/refresh.ts:41."));
chat.addChild(new UserMessageComponent("nice, commit it"));

const rows: string[] = [...chat.render(WIDTH)];

// Composer zone, in mountComposerZone order (real parts; the editor's visual
// row is reproduced through the REAL accents owner + placeholder contract).
rows.push("");
rows.push(...new ComposerHairline().render(WIDTH));
rows.push(...new CardPadRow().render(WIDTH));
const accents = resolveComposerAccents({
	bypass: false,
	bashMode: false,
	pythonMode: false,
	planMode: false,
	focusedSubagent: false,
	sessionAccentAnsi: undefined,
	thinkingLevel: "off" as never,
});
rows.push(`${accents.promptGutter}\x1b[7m \x1b[27m${theme.fg("dim", "ask anything · / for commands")}`);
rows.push(...new CardPadRow().render(WIDTH));
const capability = new QuietZoneLine(width => {
	const left = theme.fg("dim", "▫ ~/veyyon · git:main");
	const right = theme.fg("dim", "work · SWE-1.6 · 12%");
	const pad = Math.max(1, width - 21 - 20);
	return `${left}${" ".repeat(pad)}${right}`;
}, COMPOSER_INSET_COLS);
rows.push(...capability.render(WIDTH));
rows.push("");

// ── faithful ANSI raster ────────────────────────────────────────────────────
interface Cell {
	ch: string;
	fg?: string;
	bg?: string;
	bold: boolean;
	dim: boolean;
	inverse: boolean;
}

function parse(line: string): Cell[] {
	const cells: Cell[] = [];
	let fg: string | undefined;
	let bg: string | undefined;
	let bold = false;
	let dim = false;
	let inverse = false;
	let i = 0;
	const s = line;
	while (i < s.length) {
		if (s[i] === "\x1b") {
			if (s[i + 1] === "[") {
				const end = s.indexOf("m", i);
				const endOther = /[A-Za-z]/.exec(s.slice(i + 2));
				if (end === -1) break;
				const seq = s.slice(i + 2, end);
				if (endOther && i + 2 + endOther.index < end) {
					i = i + 2 + endOther.index + 1;
					continue;
				}
				const codes = seq.split(";").map(Number);
				for (let k = 0; k < codes.length; k++) {
					const c = codes[k]!;
					if (c === 38 && codes[k + 1] === 2) {
						fg = `rgb(${codes[k + 2]},${codes[k + 3]},${codes[k + 4]})`;
						k += 4;
					} else if (c === 48 && codes[k + 1] === 2) {
						bg = `rgb(${codes[k + 2]},${codes[k + 3]},${codes[k + 4]})`;
						k += 4;
					} else if (c === 38 && codes[k + 1] === 5) k += 2;
					else if (c === 48 && codes[k + 1] === 5) k += 2;
					else if (c === 39) fg = undefined;
					else if (c === 49) bg = undefined;
					else if (c === 0) {
						fg = undefined;
						bg = undefined;
						bold = dim = inverse = false;
					} else if (c === 1) bold = true;
					else if (c === 2) dim = true;
					else if (c === 22) {
						bold = false;
						dim = false;
					} else if (c === 3 || c === 23) {
						// italic on/off: rendered upright; spacing is what we judge
					} else if (c === 7) inverse = true;
					else if (c === 27) inverse = false;
					else if (c >= 30 && c <= 37) fg = ANSI16[c - 30];
					else if (c >= 90 && c <= 97) fg = ANSI16[c - 90 + 8];
				}
				i = end + 1;
				continue;
			}
			if (s[i + 1] === "]") {
				// OSC ... BEL or ST
				const bel = s.indexOf("\x07", i);
				const st = s.indexOf("\x1b\\", i);
				const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
				if (end === -1) break;
				i = end + (end === st ? 2 : 1);
				continue;
			}
			i += 2;
			continue;
		}
		const cp = s.codePointAt(i)!;
		const ch = String.fromCodePoint(cp);
		cells.push({ ch, fg, bg, bold, dim, inverse });
		i += ch.length;
	}
	return cells;
}

const ANSI16 = [
	"#000000",
	"#cd3131",
	"#0dbc79",
	"#e5e510",
	"#2472c8",
	"#bc3fbc",
	"#11a8cd",
	"#e5e5e5",
	"#666666",
	"#f14c4c",
	"#23d18b",
	"#f5f543",
	"#29b8db",
	"#d670d6",
	"#3b8eea",
	"#e2e2e2",
];

const CW = 9;
const LH = 21;
const PAD = 24;

function screen(ground: string, fgDefault: string, sub: string, yOff: number): { svg: string; h: number } {
	const parts: string[] = [];
	const w = WIDTH * CW + PAD * 2;
	const h = rows.length * LH + PAD * 2 + 20;
	parts.push(`<rect x="0" y="${yOff}" width="${w}" height="${h}" fill="${ground}"/>`);
	parts.push(
		`<text x="${PAD}" y="${yOff + 16}" font-size="12" letter-spacing="2" font-family="DejaVu Sans Mono, monospace" fill="#6b7280">REAL RENDER · ${label} · ${sub}</text>`,
	);
	let y = yOff + PAD + 20 + 14;
	for (const line of rows) {
		const cells = parse(line);
		let x = PAD;
		for (const cell of cells) {
			let fg = cell.fg ?? fgDefault;
			let bg = cell.bg;
			if (cell.inverse) [fg, bg] = [bg ?? ground, fg];
			if (bg) parts.push(`<rect x="${x}" y="${y - 15}" width="${CW}" height="${LH}" fill="${bg}"/>`);
			if (cell.ch !== " ") {
				const esc = cell.ch === "<" ? "&lt;" : cell.ch === "&" ? "&amp;" : cell.ch === ">" ? "&gt;" : cell.ch;
				parts.push(
					`<text x="${x}" y="${y}" font-size="15" font-family="DejaVu Sans Mono, monospace" font-weight="${cell.bold ? 700 : 400}" fill="${fg}"${cell.dim ? ' opacity="0.55"' : ""}>${esc}</text>`,
				);
			}
			x += CW;
		}
		y += LH;
	}
	return { svg: parts.join("\n"), h };
}

const W = WIDTH * CW + PAD * 2;
const a = screen("#1e2127", "#C6CBD4", "grey ground", 0);
const b = screen("#000000", "#C6CBD4", "black ground", a.h + 8);
const H = a.h + 8 + b.h;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#101114"/>
${a.svg}
${b.svg}
</svg>`;
await Bun.write(`${WT}/mockups/real-${label}.svg`, svg);
console.log(`wrote real-${label}.svg (${rows.length} rows)`);
process.exit(0);
