/**
 * A 5x7 bitmap font, owned here so a render proof needs no font file.
 *
 * A proof image has to be READ, not just measured: the whole point is that a
 * person looks at the picture and sees the fill, the spacing, and the words that
 * sit in them. That needs glyphs, and every way of getting glyphs from the system
 * is a way for the proof to differ between machines: an installed TTF, a console
 * font, a browser's fallback. A tiny bitmap font kept in the repo renders the same
 * pixels on every host and in CI, forever.
 *
 * 5x7 is the smallest cell that keeps lowercase legible with real descenders, and
 * it is the classic character-generator size, so the shapes are familiar rather
 * than invented. Each glyph is seven rows of five columns, `#` for ink and `.` for
 * ground, written out so a wrong pixel is visible in the diff.
 *
 * A glyph this font does not have is drawn as a hollow box, and the rasterizer
 * REPORTS every unmapped character rather than letting the substitution pass
 * unnoticed (Law 10): a proof full of anonymous boxes that nobody was told about
 * would be read as a rendering bug in the component under test.
 */

/** Columns per glyph cell. */
export const GLYPH_WIDTH = 5;
/** Rows per glyph cell. */
export const GLYPH_HEIGHT = 7;

/** Rows are `/`-separated so a glyph fits on one line and diffs read cleanly. */
const FONT: Readonly<Record<string, string>> = {
	" ": "...../...../...../...../...../...../.....",
	"!": "..#../..#../..#../..#../..#../...../..#..",
	'"': ".#.#./.#.#./...../...../...../...../.....",
	"#": ".#.#./.#.#./#####/.#.#./#####/.#.#./.#.#.",
	$: "..#../.####/#.#../.###./..#.#/####./..#..",
	"%": "#...#/#..#./...#./..#../.#.../#..#./#...#",
	"&": ".##../#..#./#.#../.#.../#.#.#/#..#./.##.#",
	"'": "..#../..#../...../...../...../...../.....",
	"(": "...#./..#../.#.../.#.../.#.../..#../...#.",
	")": ".#.../..#../...#./...#./...#./..#../.#...",
	"*": "...../#.#.#/.###./#####/.###./#.#.#/.....",
	"+": "...../..#../..#../#####/..#../..#../.....",
	",": "...../...../...../...../..#../..#../.#...",
	"-": "...../...../...../#####/...../...../.....",
	".": "...../...../...../...../...../..#../..#..",
	"/": "....#/...#./...#./..#../.#.../.#.../#....",
	"0": ".###./#...#/#..##/#.#.#/##..#/#...#/.###.",
	"1": "..#../.##../..#../..#../..#../..#../.###.",
	"2": ".###./#...#/....#/...#./..#../.#.../#####",
	"3": ".###./#...#/....#/..##./....#/#...#/.###.",
	"4": "...#./..##./.#.#./#..#./#####/...#./...#.",
	"5": "#####/#..../####./....#/....#/#...#/.###.",
	"6": "..##./.#.../#..../####./#...#/#...#/.###.",
	"7": "#####/....#/...#./..#../.#.../.#.../.#...",
	"8": ".###./#...#/#...#/.###./#...#/#...#/.###.",
	"9": ".###./#...#/#...#/.####/....#/...#./.##..",
	":": "...../..#../..#../...../..#../..#../.....",
	";": "...../..#../..#../...../..#../..#../.#...",
	"<": "....#/...#./..#../.#.../..#../...#./....#",
	"=": "...../...../#####/...../#####/...../.....",
	">": "#..../.#.../..#../...#./..#../.#.../#....",
	"?": ".###./#...#/....#/...#./..#../...../..#..",
	"@": ".###./#...#/#.###/#.#.#/#.###/#..../.###.",
	A: "..#../.#.#./#...#/#####/#...#/#...#/#...#",
	B: "####./#...#/#...#/####./#...#/#...#/####.",
	C: ".###./#...#/#..../#..../#..../#...#/.###.",
	D: "####./#...#/#...#/#...#/#...#/#...#/####.",
	E: "#####/#..../#..../####./#..../#..../#####",
	F: "#####/#..../#..../####./#..../#..../#....",
	G: ".###./#...#/#..../#.###/#...#/#...#/.###.",
	H: "#...#/#...#/#...#/#####/#...#/#...#/#...#",
	I: ".###./..#../..#../..#../..#../..#../.###.",
	J: "...##/....#/....#/....#/....#/#...#/.###.",
	K: "#...#/#..#./#.#../##.../#.#../#..#./#...#",
	L: "#..../#..../#..../#..../#..../#..../#####",
	M: "#...#/##.##/#.#.#/#...#/#...#/#...#/#...#",
	N: "#...#/##..#/#.#.#/#..##/#...#/#...#/#...#",
	O: ".###./#...#/#...#/#...#/#...#/#...#/.###.",
	P: "####./#...#/#...#/####./#..../#..../#....",
	Q: ".###./#...#/#...#/#...#/#.#.#/#..#./.##.#",
	R: "####./#...#/#...#/####./#.#../#..#./#...#",
	S: ".###./#...#/#..../.###./....#/#...#/.###.",
	T: "#####/..#../..#../..#../..#../..#../..#..",
	U: "#...#/#...#/#...#/#...#/#...#/#...#/.###.",
	V: "#...#/#...#/#...#/#...#/#...#/.#.#./..#..",
	W: "#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#",
	X: "#...#/#...#/.#.#./..#../.#.#./#...#/#...#",
	Y: "#...#/#...#/.#.#./..#../..#../..#../..#..",
	Z: "#####/....#/...#./..#../.#.../#..../#####",
	"[": "..##./..#../..#../..#../..#../..#../..##.",
	"\\": "#..../.#.../.#.../..#../...#./...#./....#",
	"]": ".##../..#../..#../..#../..#../..#../.##..",
	"^": "..#../.#.#./#...#/...../...../...../.....",
	_: "...../...../...../...../...../...../#####",
	"`": ".#.../..#../...../...../...../...../.....",
	a: "...../...../.###./....#/.####/#...#/.####",
	b: "#..../#..../####./#...#/#...#/#...#/####.",
	c: "...../...../.###./#..../#..../#..../.###.",
	d: "....#/....#/.####/#...#/#...#/#...#/.####",
	e: "...../...../.###./#...#/#####/#..../.###.",
	f: "..##./.#..#/.#.../###../.#.../.#.../.#...",
	g: "...../.####/#...#/#...#/.####/....#/.###.",
	h: "#..../#..../#.##./##..#/#...#/#...#/#...#",
	i: "..#../...../..#../..#../..#../..#../..#..",
	j: "...#./...../...#./...#./...#./#..#./.##..",
	k: "#..../#..../#..#./#.#../##.../#.#../#..#.",
	l: ".##../..#../..#../..#../..#../..#../.###.",
	m: "...../...../##.#./#.#.#/#.#.#/#.#.#/#.#.#",
	n: "...../...../#.##./##..#/#...#/#...#/#...#",
	o: "...../...../.###./#...#/#...#/#...#/.###.",
	p: "...../...../####./#...#/#...#/####./#....",
	q: "...../...../.####/#...#/#...#/.####/....#",
	r: "...../...../#.##./##..#/#..../#..../#....",
	s: "...../...../.####/#..../.###./....#/####.",
	t: ".#.../.#.../###../.#.../.#.../.#..#/..##.",
	u: "...../...../#...#/#...#/#...#/#...#/.####",
	v: "...../...../#...#/#...#/#...#/.#.#./..#..",
	w: "...../...../#...#/#.#.#/#.#.#/#.#.#/.#.#.",
	x: "...../...../#...#/.#.#./..#../.#.#./#...#",
	y: "...../...../#...#/#...#/#...#/.####/....#",
	z: "...../...../#####/...#./..#../.#.../#####",
	"{": "...##/..#../..#../.##../..#../..#../...##",
	"|": "..#../..#../..#../..#../..#../..#../..#..",
	"}": "##.../..#../..#../..##./..#../..#../##...",
	"~": "...../...../.#..#/#.#.#/#..#./...../.....",

	// Box drawing. The line sits on row 4 and column 3, so a horizontal run joins
	// seamlessly across cells and a vertical run joins down the column.
	"─": "...../...../...../#####/...../...../.....",
	"│": "..#../..#../..#../..#../..#../..#../..#..",
	"┌": "...../...../...../..###/..#../..#../..#..",
	"┐": "...../...../...../###../..#../..#../..#..",
	"└": "..#../..#../..#../..###/...../...../.....",
	"┘": "..#../..#../..#../###../...../...../.....",
	"├": "..#../..#../..#../..###/..#../..#../..#..",
	"┤": "..#../..#../..#../###../..#../..#../..#..",
	"┬": "...../...../...../#####/..#../..#../..#..",
	"┴": "..#../..#../..#../#####/...../...../.....",
	"┼": "..#../..#../..#../#####/..#../..#../..#..",

	// Blocks and shading, drawn as what they are: solid or dithered fills.
	"█": "#####/#####/#####/#####/#####/#####/#####",
	"▀": "#####/#####/#####/...../...../...../.....",
	"▄": "...../...../...../...../#####/#####/#####",
	"░": "#.#.#/...../#.#.#/...../#.#.#/...../#.#.#",
	"▒": "#.#.#/.#.#./#.#.#/.#.#./#.#.#/.#.#./#.#.#",
	"▓": "##.##/#####/##.##/#####/##.##/#####/##.##",

	// Eighth blocks, vertical and horizontal. These are how a terminal animates
	// below one cell: a card that grows by an eighth of a row per frame has eight
	// times the resolution of one that grows by a row, and that is the difference
	// between motion a viewer sees and motion a viewer is told about. A proof of
	// sub-cell motion is a proof about WHICH of these glyphs each frame chose, so
	// the font has to be able to draw all of them.
	//
	// A 5x7 cell cannot hold eight distinct fill levels. Each glyph rounds to the
	// nearest row (or column), so three pairs land on the same bitmap: ▃ with the
	// existing ▄, ▆ with ▇, and ▏ with ▎, ▍ with ▌, ▊ with ▉ horizontally. The
	// collision is in the picture only: an assertion about sub-cell motion reads
	// the glyph out of the bytes, where all eight levels differ.
	"▁": "...../...../...../...../...../...../#####",
	"▂": "...../...../...../...../...../#####/#####",
	"▃": "...../...../...../...../#####/#####/#####",
	"▅": "...../...../#####/#####/#####/#####/#####",
	"▆": "...../#####/#####/#####/#####/#####/#####",
	"▇": "...../#####/#####/#####/#####/#####/#####",
	"▏": "#..../#..../#..../#..../#..../#..../#....",
	"▎": "#..../#..../#..../#..../#..../#..../#....",
	"▍": "##.../##.../##.../##.../##.../##.../##...",
	"▌": "##.../##.../##.../##.../##.../##.../##...",
	"▋": "###../###../###../###../###../###../###..",
	"▊": "####./####./####./####./####./####./####.",
	"▉": "####./####./####./####./####./####./####.",

	// The handful of symbols veyyon's status lines and lists actually use.
	"•": "...../...../.###./.###./.###./...../.....",
	"·": "...../...../...../..#../...../...../.....",
	"✓": "...../....#/...#./#.#../.##../...../.....",
	"✗": "...../#...#/.#.#./..#../.#.#./#...#/.....",
	"→": "...../..#../...#./#####/...#./..#../.....",
	"←": "...../..#../.#.../#####/.#.../..#../.....",
	"↑": "..#../.###./#.#.#/..#../..#../..#../.....",
	"↓": "..#../..#../..#../#.#.#/.###./..#../.....",
	// Reply arrow: the Comms stream marks a message that answers another with it.
	"↩": "....#/....#/..#.#/.#..#/#####/.#.../..#..",
	"⌕": "...../.###./#...#/#...#/.###./...#./....#",
	"…": "...../...../...../...../...../#.#.#/.....",
	"▶": ".#.../.##../.###./.####/.###./.##../.#...",
	"›": ".#.../..#../...#./..#../.#.../...../.....",
	"‹": "...#./..#../.#.../..#../...#./...../.....",
	"▪": "...../...../.###./.###./.###./...../.....",
	// The context gauge's own glyphs: a filled and an empty segment, plus the
	// unmetered-window mark. The gauge is the footline's one live value, so a proof
	// of that line is worthless without them.
	"▰": "...../...../#####/#####/#####/...../.....",
	"▱": "...../...../#####/#...#/#####/...../.....",
	"∞": "...../...../##.##/#.#.#/##.##/...../.....",
	"▫": "...../...../.###./.#.#./.###./...../.....",
	"┆": "..#../...../..#../...../..#../...../..#..",
	"┊": "..#../...../..#../...../..#../...../..#..",
	"◀": "...#./..##./.###./####./.###./..##./...#.",
	// The agent roster's status column: a rotating arrow for running and a filled
	// stop for aborted. A roster proof exists to show WHICH agents are running, so
	// the two glyphs that say so cannot be the ones drawn as anonymous boxes. `▪`
	// (idle) and `▫` (parked) are already above.
	"⟳": ".##.#/#..##/#..../#...#/#...#/.###./.....",
	"∎": "...../.###./.###./.###./.###./...../.....",
	// The checkbox pair. A toggle whose ON and OFF states both raster as hollow
	// boxes is a proof that cannot show what it was taken to show, which is what
	// happened to the setup wizard's theme step: filled vs outline is the whole
	// picture, so both get real bitmaps rather than an alias.
	"■": "...../.###./.###./.###./.###./...../.....",
	"□": "...../.###./.#.#./.#.#./.###./...../.....",
	"▣": "...../.###./.#.#./.###./.#.#./.###./.....",
	// The in-progress box. A board proof exists to show three task states at once,
	// so the middle one cannot be the one drawn as an anonymous placeholder. The
	// terminal glyph splits left/right, which a three-column box cannot express;
	// the raster splits top/bottom instead, because what the proof has to show is
	// that the state is neither `■` nor `□`, not which way the fill runs.
	"◧": "...../.###./.#.#./.###./.###./...../.....",
	// The account-state marks from the `/providers` card, and the reason all three are here: the
	// card's whole claim is that you can tell at a glance which of several accounts is spending your
	// tokens, which is idle, and which is temporarily unusable. Rastering any of them as an
	// anonymous box leaves the proof unable to show the one thing it was taken to show.
	// `●` serving, `◦` idle (its lighter twin, deliberately smaller so the pair reads as a
	// difference in weight), `⊗` rate-limit blocked (a ring struck through: usable again later, so
	// it must not read as the `✗` of a dead credential).
	"●": "...../.###./#####/#####/#####/.###./.....",
	"◦": "...../...../..#../.#.#./..#../...../.....",
	"⊗": "...../.###./##.##/#.#.#/##.##/.###./.....",
	// The settings screen's group bullet, which marks the section a filtered row belongs to. A
	// settings differential is a picture of ONE row and its group heading, so drawing the heading's
	// mark as a hollow box makes the shot ambiguous about whether the row is in a group at all.
	"◆": "..#../.###./#####/#####/.###./..#../.....",
	// The cache-miss divider's mark. A transcript divider proof is a picture of a short rule and its
	// label, so the mark IS the subject: rastered as a hollow box it says only that the font is
	// missing something. A ring struck by one diagonal, and deliberately not `⊗`'s full cross, since
	// the two mean different things and a proof that confuses them is worse than no proof.
	"⊘": "...../.###./#..##/#.#.#/##..#/.###./.....",
};

/**
 * Characters that render as another character's glyph.
 *
 * A rounded corner, a heavy line and a light line are the same STROKE at 5x7 —
 * there is no room for a curve or a second pixel of weight — so aliasing them is
 * honest rather than lossy, and it keeps a bordered card from filling with boxes.
 * Anything whose SHAPE would be misrepresented is deliberately absent instead, so
 * it is reported as unmapped and can be added on purpose.
 */
const ALIASES: Readonly<Record<string, string>> = {
	"╭": "┌", // ╭
	"╮": "┐", // ╮
	"╰": "└", // ╰
	"╯": "┘", // ╯
	"━": "─", // ━
	"┃": "│", // ┃
	"═": "─", // ═
	"║": "│", // ║
	"╔": "┌",
	"╗": "┐",
	"╚": "└",
	"╝": "┘",
	"−": "-", // − minus sign
	"–": "-", // – en dash
	"—": "-", // — em dash
	"‘": "'",
	"’": "'",
	"“": '"',
	"”": '"',
	" ": " ",
	"​": " ",
};

/** Drawn for a character the font has no glyph for. Reported, never silent. */
export const MISSING_GLYPH = "#####/#...#/#...#/#...#/#...#/#...#/#####";

/** Rows of `#`/`.` for a character, or `undefined` when the font has none. */
export function glyphRows(char: string): string[] | undefined {
	const direct = FONT[char] ?? FONT[ALIASES[char] ?? ""];
	return direct ? direct.split("/") : undefined;
}

/** Every character the font can draw, aliases included. Used by the font's tests. */
export function mappedCharacters(): string[] {
	return [...Object.keys(FONT), ...Object.keys(ALIASES)];
}
