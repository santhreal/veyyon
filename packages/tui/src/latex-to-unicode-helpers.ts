import { clamp01 } from "@veyyon/utils/math";
import { SGR_BG_RESET, SGR_FG_RESET } from "./ansi";
import { TERMINAL } from "./terminal-capabilities";

export const SUPERSCRIPT: Record<string, string> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"−": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	".": "·",
	" ": " ",
	a: "ᵃ",
	b: "ᵇ",
	c: "ᶜ",
	d: "ᵈ",
	e: "ᵉ",
	f: "ᶠ",
	g: "ᵍ",
	h: "ʰ",
	i: "ⁱ",
	j: "ʲ",
	k: "ᵏ",
	l: "ˡ",
	m: "ᵐ",
	n: "ⁿ",
	o: "ᵒ",
	p: "ᵖ",
	r: "ʳ",
	s: "ˢ",
	t: "ᵗ",
	u: "ᵘ",
	v: "ᵛ",
	w: "ʷ",
	x: "ˣ",
	y: "ʸ",
	z: "ᶻ",
	A: "ᴬ",
	B: "ᴮ",
	D: "ᴰ",
	E: "ᴱ",
	G: "ᴳ",
	H: "ᴴ",
	I: "ᴵ",
	J: "ᴶ",
	K: "ᴷ",
	L: "ᴸ",
	M: "ᴹ",
	N: "ᴺ",
	O: "ᴼ",
	P: "ᴾ",
	R: "ᴿ",
	T: "ᵀ",
	U: "ᵁ",
	V: "ⱽ",
	W: "ᵂ",
	α: "ᵅ",
	β: "ᵝ",
	γ: "ᵞ",
	δ: "ᵟ",
	ε: "ᵋ",
	θ: "ᶿ",
	ι: "ᶥ",
	φ: "ᵠ",
	χ: "ᵡ",
};

export const SUBSCRIPT: Record<string, string> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"−": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	" ": " ",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
	β: "ᵦ",
	γ: "ᵧ",
	ρ: "ᵨ",
	φ: "ᵩ",
	χ: "ᵪ",
};

export const PRIMES = ["", "′", "″", "‴", "⁗"] as const;

export const VULGAR: Record<string, string> = {
	"1/2": "½",
	"1/3": "⅓",
	"2/3": "⅔",
	"1/4": "¼",
	"3/4": "¾",
	"1/5": "⅕",
	"2/5": "⅖",
	"3/5": "⅗",
	"4/5": "⅘",
	"1/6": "⅙",
	"5/6": "⅚",
	"1/7": "⅐",
	"1/8": "⅛",
	"3/8": "⅜",
	"5/8": "⅝",
	"7/8": "⅞",
	"1/9": "⅑",
	"1/10": "⅒",
	"0/3": "↉",
};

export const NOT_MAP: Record<string, string> = {
	"=": "≠",
	"<": "≮",
	">": "≯",
	"∈": "∉",
	"∋": "∌",
	"⊂": "⊄",
	"⊃": "⊅",
	"⊆": "⊈",
	"⊇": "⊉",
	"≡": "≢",
	"∃": "∄",
	"≤": "≰",
	"≥": "≱",
	"≈": "≉",
	"≅": "≇",
	"∼": "≁",
	"≃": "≄",
	"∣": "∤",
	"∥": "∦",
	"≺": "⊀",
	"≻": "⊁",
	"⊑": "⋢",
	"⊒": "⋣",
};

export const ACCENTS: Record<string, string> = {
	hat: "\u0302",
	widehat: "\u0302",
	check: "\u030C",
	widecheck: "\u030C",
	tilde: "\u0303",
	widetilde: "\u0303",
	acute: "\u0301",
	grave: "\u0300",
	dot: "\u0307",
	ddot: "\u0308",
	dddot: "\u20DB",
	ddddot: "\u20DC",
	breve: "\u0306",
	bar: "\u0304",
	vec: "\u20D7",
	overrightarrow: "\u20D7",
	overleftarrow: "\u20D6",
	mathring: "\u030A",
	overline: "\u0305",
	underline: "\u0332",
	underbar: "\u0332",
};

export const FUNCTIONS: Record<string, true> = {
	sin: true,
	cos: true,
	tan: true,
	cot: true,
	sec: true,
	csc: true,
	sinh: true,
	cosh: true,
	tanh: true,
	coth: true,
	arcsin: true,
	arccos: true,
	arctan: true,
	arccot: true,
	arcsec: true,
	arccsc: true,
	sech: true,
	csch: true,
	ln: true,
	log: true,
	lg: true,
	exp: true,
	lim: true,
	limsup: true,
	liminf: true,
	max: true,
	min: true,
	sup: true,
	inf: true,
	det: true,
	dim: true,
	ker: true,
	hom: true,
	arg: true,
	deg: true,
	gcd: true,
	lcm: true,
	Pr: true,
	argmax: true,
	argmin: true,
	sgn: true,
	tr: true,
	rank: true,
	diag: true,
	var: true,
	cov: true,
	median: true,
	mod: true,
};

export type FontStyle =
	| "bold"
	| "italic"
	| "bolditalic"
	| "script"
	| "boldscript"
	| "fraktur"
	| "doublestruck"
	| "boldfraktur"
	| "sans"
	| "sansbold"
	| "sansitalic"
	| "sansbolditalic"
	| "mono";

export const FONTS: Record<string, FontStyle> = {
	mathbf: "bold",
	boldsymbol: "bolditalic",
	bm: "bolditalic",
	pmb: "bold",
	mathbb: "doublestruck",
	Bbb: "doublestruck",
	mathds: "doublestruck",
	mathbbm: "doublestruck",
	mathcal: "script",
	mathscr: "boldscript",
	mathfrak: "fraktur",
	mathbfscr: "boldscript",
	mathbfcal: "boldscript",
	mathbffrak: "boldfraktur",
	mathfrakbold: "boldfraktur",
	mathsf: "sans",
	mathsfit: "sansitalic",
	mathsfbf: "sansbold",
	mathbfsf: "sansbold",
	mathsfbfit: "sansbolditalic",
	mathbfsfit: "sansbolditalic",
	mathtt: "mono",
	mathit: "italic",
	mathbfit: "bolditalic",
	textbf: "bold",
	textit: "italic",
	texttt: "mono",
	textsf: "sans",
};
export const MATH_FONT_COMMANDS: ReadonlySet<string> = new Set(Object.keys(FONTS));

export const TEXT_COMMANDS: Record<string, true> = {
	text: true,
	textrm: true,
	textnormal: true,
	textup: true,
	textmd: true,
	textsc: true,
	textsl: true,
	emph: true,
	mathrm: true,
	mathnormal: true,
	mbox: true,
	hbox: true,
};

export interface Plane {
	upper: number;
	lower: number;
	digit?: number;
}
export const PLANES: Record<FontStyle, Plane> = {
	bold: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
	italic: { upper: 0x1d434, lower: 0x1d44e },
	bolditalic: { upper: 0x1d468, lower: 0x1d482 },
	script: { upper: 0x1d49c, lower: 0x1d4b6 },
	boldscript: { upper: 0x1d4d0, lower: 0x1d4ea },
	fraktur: { upper: 0x1d504, lower: 0x1d51e },
	doublestruck: { upper: 0x1d538, lower: 0x1d552, digit: 0x1d7d8 },
	boldfraktur: { upper: 0x1d56c, lower: 0x1d586 },
	sans: { upper: 0x1d5a0, lower: 0x1d5ba, digit: 0x1d7e2 },
	sansbold: { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec },
	sansitalic: { upper: 0x1d608, lower: 0x1d622 },
	sansbolditalic: { upper: 0x1d63c, lower: 0x1d656 },
	mono: { upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 },
};

export const ALPHA_HOLES: Record<string, string> = {
	"italic:h": "ℎ",
	"script:B": "ℬ",
	"script:E": "ℰ",
	"script:F": "ℱ",
	"script:H": "ℋ",
	"script:I": "ℐ",
	"script:L": "ℒ",
	"script:M": "ℳ",
	"script:R": "ℛ",
	"script:e": "ℯ",
	"script:g": "ℊ",
	"script:o": "ℴ",
	"fraktur:C": "ℭ",
	"fraktur:H": "ℌ",
	"fraktur:I": "ℑ",
	"fraktur:R": "ℜ",
	"fraktur:Z": "ℨ",
	"doublestruck:C": "ℂ",
	"doublestruck:H": "ℍ",
	"doublestruck:N": "ℕ",
	"doublestruck:P": "ℙ",
	"doublestruck:Q": "ℚ",
	"doublestruck:R": "ℝ",
	"doublestruck:Z": "ℤ",
};

export const ENV_DELIMS: Record<string, readonly [string, string]> = {
	matrix: ["", ""],
	smallmatrix: ["", ""],
	array: ["", ""],
	tabular: ["", ""],
	pmatrix: ["(", ")"],
	bmatrix: ["[", "]"],
	Bmatrix: ["{", "}"],
	vmatrix: ["|", "|"],
	Vmatrix: ["‖", "‖"],
	cases: ["{", ""],
	"cases*": ["{", ""],
	dcases: ["{", ""],
	"dcases*": ["{", ""],
	rcases: ["", "}"],
	drcases: ["", "}"],
	aligned: ["", ""],
	"aligned*": ["", ""],
	alignedat: ["", ""],
	"alignedat*": ["", ""],
	align: ["", ""],
	"align*": ["", ""],
	alignat: ["", ""],
	"alignat*": ["", ""],
	split: ["", ""],
	gathered: ["", ""],
	equation: ["", ""],
	"equation*": ["", ""],
};

export const SYMBOLS: Record<string, string> = {
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	epsilon: "ϵ",
	varepsilon: "ε",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	vartheta: "ϑ",
	iota: "ι",
	kappa: "κ",
	varkappa: "ϰ",
	lambda: "λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	omicron: "ο",
	pi: "π",
	varpi: "ϖ",
	rho: "ρ",
	varrho: "ϱ",
	sigma: "σ",
	varsigma: "ς",
	tau: "τ",
	upsilon: "υ",
	phi: "ϕ",
	varphi: "φ",
	chi: "χ",
	psi: "ψ",
	omega: "ω",
	digamma: "ϝ",
	Gamma: "Γ",
	Delta: "Δ",
	Theta: "Θ",
	Lambda: "Λ",
	Xi: "Ξ",
	Pi: "Π",
	Sigma: "Σ",
	Upsilon: "Υ",
	Phi: "Φ",
	Psi: "Ψ",
	Omega: "Ω",
	sum: "∑",
	prod: "∏",
	coprod: "∐",
	int: "∫",
	iint: "∬",
	iiint: "∭",
	iiiint: "⨌",
	oint: "∮",
	oiint: "∯",
	oiiint: "∰",
	bigcap: "⋂",
	bigcup: "⋃",
	bigsqcup: "⨆",
	bigvee: "⋁",
	bigwedge: "⋀",
	bigodot: "⨀",
	bigoplus: "⨁",
	bigotimes: "⨂",
	biguplus: "⨄",
	Cap: "⋒",
	Cup: "⋓",
	bigstar: "★",
	pm: "±",
	mp: "∓",
	times: "×",
	div: "÷",
	ast: "∗",
	star: "⋆",
	circ: "∘",
	bullet: "∙",
	cdot: "⋅",
	cdotp: "·",
	centerdot: "·",
	cap: "∩",
	cup: "∪",
	uplus: "⊎",
	sqcap: "⊓",
	sqcup: "⊔",
	vee: "∨",
	wedge: "∧",
	land: "∧",
	lor: "∨",
	setminus: "∖",
	smallsetminus: "∖",
	wr: "≀",
	amalg: "⨿",
	diamond: "⋄",
	Diamond: "◇",
	bigtriangleup: "△",
	bigtriangledown: "▽",
	triangleleft: "◁",
	triangleright: "▷",
	lhd: "⊲",
	rhd: "⊳",
	unlhd: "⊴",
	unrhd: "⊵",
	oplus: "⊕",
	ominus: "⊖",
	otimes: "⊗",
	oslash: "⊘",
	odot: "⊙",
	dagger: "†",
	ddagger: "‡",
	boxplus: "⊞",
	boxtimes: "⊠",
	boxdot: "⊡",
	boxminus: "⊟",
	ltimes: "⋉",
	rtimes: "⋊",
	leftthreetimes: "⋋",
	rightthreetimes: "⋌",
	curlyvee: "⋎",
	curlywedge: "⋏",
	barwedge: "⊼",
	veebar: "⊻",
	doublebarwedge: "⩞",
	circledast: "⊛",
	circledcirc: "⊚",
	circleddash: "⊝",
	divideontimes: "⋇",
	dotplus: "∔",
	leq: "≤",
	le: "≤",
	geq: "≥",
	ge: "≥",
	ll: "≪",
	gg: "≫",
	neq: "≠",
	ne: "≠",
	equiv: "≡",
	doteq: "≐",
	sim: "∼",
	simeq: "≃",
	approx: "≈",
	approxeq: "≊",
	cong: "≅",
	propto: "∝",
	asymp: "≍",
	prec: "≺",
	succ: "≻",
	preceq: "⪯",
	succeq: "⪰",
	subset: "⊂",
	supset: "⊃",
	subseteq: "⊆",
	supseteq: "⊇",
	subsetneq: "⊊",
	supsetneq: "⊋",
	sqsubset: "⊏",
	sqsupset: "⊐",
	sqsubseteq: "⊑",
	sqsupseteq: "⊒",
	in: "∈",
	ni: "∋",
	owns: "∋",
	notin: "∉",
	mid: "∣",
	nmid: "∤",
	parallel: "∥",
	nparallel: "∦",
	perp: "⊥",
	vdash: "⊢",
	dashv: "⊣",
	models: "⊨",
	vDash: "⊨",
	Vdash: "⊩",
	bowtie: "⋈",
	smile: "⌣",
	frown: "⌢",
	between: "≬",
	lessgtr: "≶",
	gtrless: "≷",
	leqslant: "⩽",
	geqslant: "⩾",
	lesssim: "≲",
	gtrsim: "≳",
	lessapprox: "⪅",
	gtrapprox: "⪆",
	leqq: "≦",
	geqq: "≧",
	lneq: "⪇",
	gneq: "⪈",
	lneqq: "≨",
	gneqq: "≩",
	nleq: "≰",
	ngeq: "≱",
	nless: "≮",
	ngtr: "≯",
	nsubseteq: "⊈",
	nsupseteq: "⊉",
	nsim: "≁",
	ncong: "≇",
	triangleq: "≜",
	coloneqq: "≔",
	eqqcolon: "≕",
	risingdotseq: "≓",
	fallingdotseq: "≒",
	circeq: "≗",
	eqcirc: "≖",
	precsim: "≾",
	succsim: "≿",
	precapprox: "⪷",
	succapprox: "⪸",
	curlyeqprec: "⋞",
	curlyeqsucc: "⋟",
	Subset: "⋐",
	Supset: "⋑",
	subseteqq: "⫅",
	supseteqq: "⫆",
	subsetneqq: "⫋",
	supsetneqq: "⫌",
	Vvdash: "⊪",
	shortmid: "∣",
	shortparallel: "∥",
	pitchfork: "⋔",
	leftarrow: "←",
	gets: "←",
	rightarrow: "→",
	to: "→",
	leftrightarrow: "↔",
	Leftarrow: "⇐",
	Rightarrow: "⇒",
	Leftrightarrow: "⇔",
	uparrow: "↑",
	downarrow: "↓",
	updownarrow: "↕",
	Uparrow: "⇑",
	Downarrow: "⇓",
	Updownarrow: "⇕",
	mapsto: "↦",
	longmapsto: "⟼",
	hookleftarrow: "↩",
	hookrightarrow: "↪",
	leftharpoonup: "↼",
	rightharpoonup: "⇀",
	leftharpoondown: "↽",
	rightharpoondown: "⇁",
	rightleftharpoons: "⇌",
	longleftarrow: "⟵",
	longrightarrow: "⟶",
	longleftrightarrow: "⟷",
	Longleftarrow: "⟸",
	Longrightarrow: "⟹",
	Longleftrightarrow: "⟺",
	implies: "⟹",
	impliedby: "⟸",
	iff: "⟺",
	nearrow: "↗",
	searrow: "↘",
	swarrow: "↙",
	nwarrow: "↖",
	nleftarrow: "↚",
	nrightarrow: "↛",
	leadsto: "⇝",
	rightsquigarrow: "⇝",
	leftrightsquigarrow: "↭",
	twoheadrightarrow: "↠",
	twoheadleftarrow: "↞",
	leftrightharpoons: "⇋",
	rightleftarrows: "⇄",
	leftrightarrows: "⇆",
	leftleftarrows: "⇇",
	rightrightarrows: "⇉",
	upuparrows: "⇈",
	downdownarrows: "⇊",
	circlearrowleft: "↺",
	circlearrowright: "↻",
	curvearrowleft: "↶",
	curvearrowright: "↷",
	dashleftarrow: "⇠",
	dashrightarrow: "⇢",
	Lleftarrow: "⇚",
	Rrightarrow: "⇛",
	leftarrowtail: "↢",
	rightarrowtail: "↣",
	looparrowleft: "↫",
	looparrowright: "↬",
	multimap: "⊸",
	infty: "∞",
	partial: "∂",
	nabla: "∇",
	forall: "∀",
	exists: "∃",
	nexists: "∄",
	emptyset: "∅",
	varnothing: "∅",
	neg: "¬",
	lnot: "¬",
	top: "⊤",
	bot: "⊥",
	angle: "∠",
	measuredangle: "∡",
	sphericalangle: "∢",
	aleph: "ℵ",
	beth: "ℶ",
	gimel: "ℷ",
	daleth: "ℸ",
	hbar: "ℏ",
	hslash: "ℏ",
	ell: "ℓ",
	imath: "ı",
	jmath: "ȷ",
	wp: "℘",
	Re: "ℜ",
	Im: "ℑ",
	mho: "℧",
	complement: "∁",
	surd: "√",
	flat: "♭",
	natural: "♮",
	sharp: "♯",
	clubsuit: "♣",
	diamondsuit: "♦",
	heartsuit: "♥",
	spadesuit: "♠",
	clubs: "♣",
	diamonds: "♦",
	hearts: "♥",
	spades: "♠",
	therefore: "∴",
	because: "∵",
	checkmark: "✓",
	maltese: "✠",
	dag: "†",
	ddag: "‡",
	S: "§",
	P: "¶",
	copyright: "©",
	circledR: "®",
	pounds: "£",
	yen: "¥",
	euro: "€",
	degree: "°",
	prime: "′",
	backprime: "‵",
	colon: ":",
	semicolon: ";",
	neper: "₪",
	square: "□",
	Box: "□",
	blacksquare: "■",
	lozenge: "◊",
	blacklozenge: "⧫",
	triangle: "△",
	blacktriangle: "▴",
	blacktriangledown: "▾",
	blacktriangleleft: "◂",
	blacktriangleright: "▸",
	diagup: "╱",
	diagdown: "╲",
	backepsilon: "϶",
	Game: "⅁",
	eth: "ð",
	ldots: "…",
	dots: "…",
	cdots: "⋯",
	vdots: "⋮",
	ddots: "⋱",
	hdots: "…",
	mathellipsis: "…",
	dotsc: "…",
	dotsb: "⋯",
	dotsm: "⋯",
	dotsi: "⋯",
	langle: "⟨",
	rangle: "⟩",
	lceil: "⌈",
	rceil: "⌉",
	lfloor: "⌊",
	rfloor: "⌋",
	lbrace: "{",
	rbrace: "}",
	lbrack: "[",
	rbrack: "]",
	vert: "|",
	Vert: "‖",
	lvert: "|",
	rvert: "|",
	lVert: "‖",
	rVert: "‖",
	backslash: "\\",
	slash: "/",
	ulcorner: "⌜",
	urcorner: "⌝",
	llcorner: "⌞",
	lrcorner: "⌟",
	lmoustache: "⎰",
	rmoustache: "⎱",
	lgroup: "⟮",
	rgroup: "⟯",
	bracevert: "⎪",
	Reals: "ℝ",
	Complex: "ℂ",
	Natural: "ℕ",
	Integer: "ℤ",
	Rational: "ℚ",
};

function mapAll(text: string, table: Record<string, string>): string | null {
	let out = "";
	for (const ch of text) {
		const mapped = table[ch];
		if (mapped === undefined) return null;
		out += mapped;
	}
	return out;
}

export function codePointLength(s: string): number {
	let n = 0;
	for (const _ of s) n++;
	return n;
}

function styleAlnum(ch: string, style: FontStyle): string {
	const hole = ALPHA_HOLES[`${style}:${ch}`];
	if (hole) return hole;
	const plane = PLANES[style];
	const code = ch.charCodeAt(0);
	if (code >= 65 && code <= 90) return String.fromCodePoint(plane.upper + (code - 65));
	if (code >= 97 && code <= 122) return String.fromCodePoint(plane.lower + (code - 97));
	if (code >= 48 && code <= 57 && plane.digit !== undefined) return String.fromCodePoint(plane.digit + (code - 48));
	return ch;
}

export function styleChar(ch: string, style: FontStyle | null): string {
	if (style === null) return ch;
	const code = ch.charCodeAt(0);
	const isAlnum = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
	return isAlnum ? styleAlnum(ch, style) : ch;
}

export function applyCombining(text: string, mark: string): string {
	let out = "";
	for (const ch of text) out += ch === " " ? ch : ch + mark;
	return out;
}

export function unescapeText(s: string): string {
	return s.replace(/\\([&%$#_{}\s])/g, "$1").replace(/~/g, " ");
}

export type AnsiColorFormat = "ansi-16m" | "ansi-256";

export interface AnsiColor {
	foreground: string;
	background: string;
}

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

export const LATEX_NAMED_COLORS: Record<string, string> = {
	black: "#000000",
	blue: "#0000ff",
	brown: "#a52a2a",
	cyan: "#00ffff",
	darkgray: "#404040",
	darkgrey: "#404040",
	gray: "#808080",
	green: "#00ff00",
	grey: "#808080",
	lightgray: "#c0c0c0",
	lightgrey: "#c0c0c0",
	lime: "#00ff00",
	magenta: "#ff00ff",
	olive: "#808000",
	orange: "#ffa500",
	pink: "#ffc0cb",
	purple: "#800080",
	red: "#ff0000",
	teal: "#008080",
	violet: "#ee82ee",
	white: "#ffffff",
	yellow: "#ffff00",
};

function colorFormat(): AnsiColorFormat {
	return TERMINAL.trueColor ? "ansi-16m" : "ansi-256";
}

function clampByte(n: number): number {
	if (n <= 0) return 0;
	if (n >= 255) return 255;
	return Math.round(n);
}

function cssRgb(rgb: Rgb): string {
	return `rgb(${clampByte(rgb.r)}, ${clampByte(rgb.g)}, ${clampByte(rgb.b)})`;
}

export function parseNumber(raw: string): number | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const value = Number(trimmed.endsWith("%") ? Number(trimmed.slice(0, -1)) / 100 : trimmed);
	return Number.isFinite(value) ? value : null;
}

function parseColorComponents(spec: string, expected: number): number[] | null {
	const parts = spec
		.split(/[,\s]+/u)
		.map(part => part.trim())
		.filter(Boolean);
	if (parts.length !== expected) return null;
	const values: number[] = [];
	for (const part of parts) {
		const value = parseNumber(part);
		if (value === null) return null;
		values.push(value);
	}
	return values;
}

function rgbFromUnit(values: readonly number[]): string | null {
	if (values.length !== 3) return null;
	return cssRgb({
		r: clamp01(values[0] ?? 0) * 255,
		g: clamp01(values[1] ?? 0) * 255,
		b: clamp01(values[2] ?? 0) * 255,
	});
}

function rgbFromByte(values: readonly number[]): string | null {
	if (values.length !== 3) return null;
	return cssRgb({ r: values[0] ?? 0, g: values[1] ?? 0, b: values[2] ?? 0 });
}

function rgbFromCmyk(values: readonly number[]): string | null {
	if (values.length !== 4) return null;
	const c = clamp01(values[0] ?? 0);
	const m = clamp01(values[1] ?? 0);
	const y = clamp01(values[2] ?? 0);
	const k = clamp01(values[3] ?? 0);
	return cssRgb({ r: 255 * (1 - c) * (1 - k), g: 255 * (1 - m) * (1 - k), b: 255 * (1 - y) * (1 - k) });
}

function rgbFromHsv(values: readonly number[], hueScale: number): string | null {
	if (values.length !== 3) return null;
	const h = (((values[0] ?? 0) * hueScale) % 360) / 60;
	const s = clamp01(values[1] ?? 0);
	const v = clamp01(values[2] ?? 0);
	const c = v * s;
	const x = c * (1 - Math.abs((h % 2) - 1));
	const m = v - c;
	let r = 0;
	let g = 0;
	let b = 0;
	if (h < 1) {
		r = c;
		g = x;
	} else if (h < 2) {
		r = x;
		g = c;
	} else if (h < 3) {
		g = c;
		b = x;
	} else if (h < 4) {
		g = x;
		b = c;
	} else if (h < 5) {
		r = x;
		b = c;
	} else {
		r = c;
		b = x;
	}
	return cssRgb({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 });
}

function rgbFromWave(spec: string): string | null {
	const wavelength = parseNumber(spec);
	if (wavelength === null || wavelength < 380 || wavelength > 780) return null;
	let r = 0;
	let g = 0;
	let b = 0;
	if (wavelength < 440) {
		r = -(wavelength - 440) / 60;
		b = 1;
	} else if (wavelength < 490) {
		g = (wavelength - 440) / 50;
		b = 1;
	} else if (wavelength < 510) {
		g = 1;
		b = -(wavelength - 510) / 20;
	} else if (wavelength < 580) {
		r = (wavelength - 510) / 70;
		g = 1;
	} else if (wavelength < 645) {
		r = 1;
		g = -(wavelength - 645) / 65;
	} else {
		r = 1;
	}
	const factor =
		wavelength < 420
			? 0.3 + (0.7 * (wavelength - 380)) / 40
			: wavelength > 700
				? 0.3 + (0.7 * (780 - wavelength)) / 80
				: 1;
	return cssRgb({ r: r * factor * 255, g: g * factor * 255, b: b * factor * 255 });
}

function normalizeCssColor(spec: string, allowMix: boolean): string | null {
	const trimmed = spec.trim();
	if (trimmed === "") return null;
	if (allowMix && trimmed.includes("!")) {
		const mixed = resolveMixedColor(trimmed);
		if (mixed !== null) return mixed;
	}
	const named = LATEX_NAMED_COLORS[trimmed] ?? LATEX_NAMED_COLORS[trimmed.toLowerCase()];
	if (named !== undefined) return named;
	if (Bun.color(trimmed, "css") !== null) return trimmed;
	const lower = trimmed.toLowerCase();
	return lower !== trimmed && Bun.color(lower, "css") !== null ? lower : null;
}

function resolveModeledColor(model: string, spec: string): string | null {
	const trimmedModel = model.trim();
	if (trimmedModel === "" || trimmedModel === "named") return normalizeCssColor(spec, true);
	if (trimmedModel === "HTML" || trimmedModel === "Html" || trimmedModel === "html") {
		const hex = spec.trim().replace(/^#/u, "");
		return /^[0-9A-Fa-f]{3,8}$/u.test(hex) ? `#${hex}` : null;
	}
	if (trimmedModel === "wave") return rgbFromWave(spec);
	const lower = trimmedModel.toLowerCase();
	if (trimmedModel === "RGB") return rgbFromByte(parseColorComponents(spec, 3) ?? []);
	if (lower === "rgb") return rgbFromUnit(parseColorComponents(spec, 3) ?? []);
	if (lower === "cmyk") return rgbFromCmyk(parseColorComponents(spec, 4) ?? []);
	if (lower === "gray" || lower === "grey") {
		const value = parseColorComponents(spec, 1)?.[0];
		if (value === undefined) return null;
		const unit = trimmedModel === "Gray" || trimmedModel === "Grey" ? value / 15 : value;
		const byte = clamp01(unit) * 255;
		return cssRgb({ r: byte, g: byte, b: byte });
	}
	if (lower === "hsb" || lower === "hsv") {
		const values = parseColorComponents(spec, 3);
		if (values === null) return null;
		return rgbFromHsv(values, trimmedModel === "Hsb" || trimmedModel === "HSV" ? 1 : 360);
	}
	return normalizeCssColor(spec, true);
}

function resolveLatexColor(model: string | null, spec: string): string | null {
	const unescaped = unescapeText(spec).trim();
	if (unescaped === "") return null;
	return model === null ? normalizeCssColor(unescaped, true) : resolveModeledColor(model, unescaped);
}

function resolveMixedColor(spec: string): string | null {
	const parts = spec.split("!");
	if (parts.length < 2) return null;
	const first = normalizeCssColor(parts[0] ?? "", false);
	if (first === null) return null;
	let current = Bun.color(first, "{rgb}");
	if (current === null) return null;
	for (let i = 1; i < parts.length; i += 2) {
		const percent = parseNumber(parts[i] ?? "");
		if (percent === null) return null;
		const nextSpec = parts[i + 1] ?? "white";
		const nextColor = normalizeCssColor(nextSpec, false);
		if (nextColor === null) return null;
		const next = Bun.color(nextColor, "{rgb}");
		if (next === null) return null;
		const t = clamp01(percent / 100);
		current = {
			r: current.r * t + next.r * (1 - t),
			g: current.g * t + next.g * (1 - t),
			b: current.b * t + next.b * (1 - t),
		};
	}
	return cssRgb(current);
}

export function ansiColor(model: string | null, spec: string): AnsiColor | null {
	const css = resolveLatexColor(model, spec);
	if (css === null) return null;
	const foreground = Bun.color(css, colorFormat());
	if (foreground === null || !foreground.startsWith("\x1b[38;")) return null;
	return { foreground, background: foreground.replace("\x1b[38;", "\x1b[48;") };
}

export function latexColorScope(model: string | null, spec: string): ((text: string) => string) | null {
	const color = ansiColor(model, spec);
	if (color === null) return null;
	const { foreground } = color;
	return text => foreground + text.replaceAll(SGR_FG_RESET, foreground) + SGR_FG_RESET;
}

export function restoreAnsi(
	text: string,
	fromForeground: string | null,
	toForeground: string | null,
	fromBackground: string | null,
	toBackground: string | null,
): string {
	if (fromForeground !== toForeground && fromForeground !== null) text += toForeground ?? SGR_FG_RESET;
	if (fromBackground !== toBackground && fromBackground !== null) text += toBackground ?? SGR_BG_RESET;
	return text;
}

export function toSuperscript(text: string, group: boolean): string {
	if (text === "") return "";
	const mapped = mapAll(text, SUPERSCRIPT);
	if (mapped !== null) return mapped;
	return group ? `^(${text})` : `^${text}`;
}

export function toSubscript(text: string, group: boolean): string {
	if (text === "") return "";
	const mapped = mapAll(text, SUBSCRIPT);
	if (mapped !== null) return mapped;
	return group ? `_(${text})` : `_${text}`;
}

export interface Argument {
	text: string;
	group: boolean;
}

export const BIG_DELIM = /^(?:[bB]igg?|[bB]igg?[lrm])$/;

export const EXTENSIBLE_ARROWS: Record<string, string> = {
	xleftarrow: "←",
	xrightarrow: "→",
	xleftrightarrow: "↔",
	xLeftarrow: "⇐",
	xRightarrow: "⇒",
	xLeftrightarrow: "⇔",
	xhookleftarrow: "↩",
	xhookrightarrow: "↪",
	xtwoheadleftarrow: "↞",
	xtwoheadrightarrow: "↠",
	xmapsto: "↦",
	xrightharpoonup: "⇀",
	xrightharpoondown: "⇁",
	xleftharpoonup: "↼",
	xleftharpoondown: "↽",
	xrightleftharpoons: "⇌",
	xleftrightharpoons: "⇋",
};
