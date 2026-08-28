import { stripAnsi } from "@veyyon/utils/strip-ansi";

export interface UserMessageMetrics {
	chars: number;
	words: number;
	yelling: number;
	profanity: number;
	anguish: number;
	negation: number;
	repetition: number;
	blame: number;
}

const PROFANITY: readonly string[] = [
	"fuck",
	"fucks",
	"fucked",
	"fucking",
	"fuckin",
	"fucker",
	"fuckers",
	"fuckup",
	"fuckups",
	"fuckhead",
	"fuckheads",
	"fuckface",
	"fuckwit",
	"fuckwits",
	"fucktard",
	"fuckery",
	"fuckoff",
	"motherfucker",
	"motherfuckers",
	"motherfucking",
	"clusterfuck",
	"ratfuck",
	"unfuck",
	"fk",
	"fks",
	"fking",
	"fkin",
	"fker",
	"fck",
	"fcks",
	"fcking",
	"fckin",
	"fcker",
	"fuk",
	"fuking",
	"fukin",
	"eff",
	"effs",
	"effed",
	"effing",
	"frick",
	"fricks",
	"fricked",
	"fricking",
	"frickin",
	"freaking",
	"freakin",
	"freaked",
	"shit",
	"shits",
	"shat",
	"shitty",
	"shittier",
	"shittiest",
	"shite",
	"shites",
	"shited",
	"shitting",
	"shitter",
	"shitters",
	"shithead",
	"shitheads",
	"shitshow",
	"shitstorm",
	"shitstain",
	"shitfaced",
	"shitload",
	"shitbag",
	"shitcan",
	"shitcanned",
	"shitpost",
	"shitposting",
	"bullshit",
	"bullshits",
	"bullshitting",
	"bullshitter",
	"horseshit",
	"batshit",
	"dogshit",
	"dipshit",
	"jackshit",
	"dumbshit",
	"holyshit",
	"damn",
	"damns",
	"damned",
	"damning",
	"dammit",
	"goddamn",
	"goddamned",
	"goddamnit",
	"goddammit",
	"darn",
	"darns",
	"darned",
	"darnit",
	"dang",
	"danged",
	"dangit",
	"hell",
	"hells",
	"heck",
	"hecks",
	"heckin",
	"gosh",
	"bloody",
	"bollocks",
	"bollox",
	"crap",
	"craps",
	"crappy",
	"crappier",
	"crappiest",
	"crapped",
	"crapping",
	"crapload",
	"crapola",
	"piss",
	"pisses",
	"pissed",
	"pissing",
	"pisser",
	"pisspoor",
	"pisstake",
	"pisshead",
	"ass",
	"asses",
	"asshole",
	"assholes",
	"asshat",
	"asshats",
	"asswipe",
	"asswipes",
	"assclown",
	"assbag",
	"asskisser",
	"dumbass",
	"dumbasses",
	"jackass",
	"jackasses",
	"smartass",
	"smartasses",
	"badass",
	"badasses",
	"lazyass",
	"fatass",
	"hardass",
	"halfass",
	"halfassed",
	"arse",
	"arsed",
	"arsehole",
	"arseholes",
	"arsewipe",
	"bitch",
	"bitches",
	"bitched",
	"bitching",
	"bitchy",
	"bitchier",
	"bitchiest",
	"sonofabitch",
	"biatch",
	"biotch",
	"cunt",
	"cunts",
	"cunty",
	"cuntish",
	"twat",
	"twats",
	"twatty",
	"bastard",
	"bastards",
	"dick",
	"dicks",
	"dickhead",
	"dickheads",
	"dickish",
	"dickwad",
	"dickwads",
	"dickface",
	"dickbag",
	"prick",
	"pricks",
	"prickish",
	"cock",
	"cocks",
	"cocky",
	"cockier",
	"cockiest",
	"cockhead",
	"cockblock",
	"cocksucker",
	"cocksuckers",
	"knobhead",
	"knobheads",
	"knobend",
	"wanker",
	"wankers",
	"wankery",
	"tosser",
	"tossers",
	"jerkoff",
	"jerkoffs",
	"douche",
	"douches",
	"douchebag",
	"douchebags",
	"douchey",
	"scumbag",
	"scumbags",
	"scum",
	"sleazebag",
	"sleazeball",
	"slimeball",
	"lowlife",
	"lowlifes",
	"deadbeat",
	"idiot",
	"idiots",
	"idiotic",
	"idiocy",
	"stupid",
	"stupider",
	"stupidest",
	"stupidity",
	"moron",
	"morons",
	"moronic",
	"imbecile",
	"imbeciles",
	"retard",
	"retards",
	"retarded",
	"dumb",
	"dumber",
	"dumbest",
	"dumbo",
	"fool",
	"fools",
	"foolish",
	"foolery",
	"clown",
	"clowns",
	"clownish",
	"buffoon",
	"buffoons",
	"simpleton",
	"halfwit",
	"halfwits",
	"nitwit",
	"nitwits",
	"dimwit",
	"dimwits",
	"dolt",
	"dolts",
	"doltish",
	"knucklehead",
	"knuckleheads",
	"blockhead",
	"blockheads",
	"lamebrain",
	"airhead",
	"airheads",
	"scatterbrain",
	"numbnuts",
	"numbskull",
	"numpty",
	"numpties",
	"muppet",
	"muppets",
	"pillock",
	"pillocks",
	"plonker",
	"plonkers",
	"prat",
	"prats",
	"berk",
	"berks",
	"ninny",
	"ninnies",
	"dingbat",
	"dingbats",
	"putz",
	"putzes",
	"schmuck",
	"schmucks",
	"jerk",
	"jerks",
	"jerkface",
	"gits",
	"sod",
	"sodding",
	"bugger",
	"buggered",
	"suck",
	"sucks",
	"sucked",
	"sucking",
	"sucky",
	"suckage",
	"trashy",
	"jesus",
	"christ",
	"jeez",
	"jeezus",
	"sheesh",
	"godsake",
	"wtf",
	"wth",
	"wtaf",
	"stfu",
	"gtfo",
	"omfg",
	"omg",
	"ffs",
	"jfc",
	"kys",
	"fml",
	"smh",
	"smdh",
	"smfh",
	"idgaf",
	"idfc",
	"lmfao",
	"fubar",
	"snafu",
];

const PROFANITY_RE = new RegExp(String.raw`\b(?:${PROFANITY.join("|")})\b`, "gi");
const SENTENCE_RE = /[^.!?\n]+/g;
const LETTER_RE = /\p{L}/gu;
const UPPER_LETTER_RE = /\p{Lu}/gu;
const YELLING_MIN_LETTERS = 4;
const YELLING_THRESHOLD = 0.5;
const DRAMA_RE = /[!?][!?1]{2,}/g;
const WORD_RE = /\S+/g;

const ANGUISH_PATTERNS: readonly string[] = [
	"no{3,}", //          nooo, noooooo
	"a+h{2,}", //         ahh, aaaahhh
	"u+r?g+h+", //        ugh, ughh, urgh, uuugh
	"a+r+g+h+", //        argh, aaargh, arrgghhh
	"g+r{2,}", //         grr, grrrr
	"st+o{3,}p+", //      stooop, sttooopp
	"w+h+y{3,}", //       whyyy, whyyyyy
	"f+u{3,}c*k*", //     fuuu, fuuuck
	"wtf{3,}", //         wtfff
	"o+m+g{2,}", //       omgg, omggg
	"ye+s{3,}", //        yesss, yeessss
	"g+o+d{3,}", //       goddd, goddddd
	"br+u+h{2,}", //      bruhh, bruuuhh
];
const ANGUISH_RE = new RegExp(String.raw`\b(?:${ANGUISH_PATTERNS.join("|")})\b`, "gi");
const DUDE_RE = /\bdude\b/gi;
const SAD_EMOTICON_RE = /(?<=^|[\s.!?])[:;]-?\(+/g;

const NEGATION_LEAD_RE =
	/^[ \t]*(?:(?:nope|nah|nvm|wrong|incorrect)\b|no(?=\s*(?:[,.!?;:\u2013\u2014]|-(?!\w)|$|(?:i|im|u|you|ur|we|it|its|that|thats|this|the|they|theyre|he|she|man|dude|bro|wait|dont|not|stop|just|again|please|plz|but|actually|literally|seriously|sorry|no|never|nothing|wtf|why|what|wrong)\b)))/gi;
const NEGATION_PHRASE_RE =
	/\b(?:that['\u2019]?s\s+not\s+(?:what|right|it)|not\s+what\s+i\s+(?:meant|asked|said|wanted)|makes\s+(?:no|zero)\s+sense)\b/gi;

const REPETITION_RECALL_RE =
	/\b(?:(?:like|as)\s+i\s+(?:said|told\s+you|asked)|i\s+(?:meant|said|told\s+you|asked\s+you|already\s+(?:said|told|did|asked|wrote)))\b/gi;
const REPETITION_STILL_RE =
	/\bstill\s+(?:doesn['\u2019]?t|doesnt|isn['\u2019]?t|isnt|not|broken|wrong|fails|failing|the\s+same|same)\b/gi;

const BLAME_YOU_RE = /\byou\s+(?:didn['\u2019]?t|did\s+not|broke|missed|forgot|keep|always|never|still|ignored)\b/gi;
const BLAME_WHY_RE = /\bwhy\s+(?:would|did)\s+(?:you|u)\b/gi;
const BLAME_STOP_RE = /(?:^|(?<=[.!?\n]))\s*stop\s+\w+ing\b/gim;

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const XML_TAG_PAIR_RE = /<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g;
const XML_TAG_BARE_RE = /<\/?[A-Za-z][\w-]*\b[^>]*\/?>/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const FILE_MENTION_RE = /(^|\s)@[\w./-]+/g;
const DOTTED_TOKEN_RE = /(?<=^|[\s("'[])[\w-]+(?:\.[\w-]+)+(?=$|[\s)"'\],:;!?]|\.(?!\w))/g;
const QUOTE_LINE_RE = /^[ \t]*>.*$/gm;
const IMAGE_MARKER_RE = /\[Image #\d+\]/g;

const MAX_PROSE_LINES = 3;

function countMatches(text: string, re: RegExp): number {
	let count = 0;
	re.lastIndex = 0;
	while (re.exec(text) !== null) count++;
	return count;
}

const UPPER_RUN_RE = /\p{Lu}{2,}/gu;
const TRIPLED_LETTER_RE = /(\p{Lu})\1\1/u;

function isShoutedSentence(sentence: string): boolean {
	const runs = sentence.match(UPPER_RUN_RE);
	if (!runs) return false;
	if (runs.length >= 2) return true;
	return runs[0].length >= YELLING_MIN_LETTERS && TRIPLED_LETTER_RE.test(runs[0]);
}

function countYellingSentences(text: string): number {
	let count = 0;
	SENTENCE_RE.lastIndex = 0;
	let match: RegExpExecArray | null = SENTENCE_RE.exec(text);
	while (match !== null) {
		const sentence = match[0];
		const letters = countMatches(sentence, LETTER_RE);
		if (letters >= YELLING_MIN_LETTERS) {
			const upper = countMatches(sentence, UPPER_LETTER_RE);
			if (upper / letters > YELLING_THRESHOLD && isShoutedSentence(sentence)) count++;
		}
		match = SENTENCE_RE.exec(text);
	}
	return count;
}

export function stripStructuredContent(text: string): string {
	return stripAnsi(text)
		.replace(FENCED_CODE_RE, "\n")
		.replace(XML_TAG_PAIR_RE, "\n")
		.replace(XML_TAG_BARE_RE, " ")
		.replace(INLINE_CODE_RE, " ")
		.replace(URL_RE, " ")
		.replace(FILE_MENTION_RE, "$1 ")
		.replace(DOTTED_TOKEN_RE, " ")
		.replace(QUOTE_LINE_RE, "")
		.replace(IMAGE_MARKER_RE, " ");
}

function countNonEmptyLines(text: string): number {
	let count = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length > 0) count++;
	}
	return count;
}

export function computeUserMessageMetrics(text: string): UserMessageMetrics {
	const trimmed = text.trim();
	if (!trimmed) {
		return {
			chars: 0,
			words: 0,
			yelling: 0,
			profanity: 0,
			anguish: 0,
			negation: 0,
			repetition: 0,
			blame: 0,
		};
	}

	const chars = trimmed.length;
	const words = countMatches(trimmed, WORD_RE);

	const prose = stripStructuredContent(trimmed).trim();
	if (!prose || countNonEmptyLines(prose) >= MAX_PROSE_LINES) {
		return {
			chars,
			words,
			yelling: 0,
			profanity: 0,
			anguish: 0,
			negation: 0,
			repetition: 0,
			blame: 0,
		};
	}

	const anguish =
		countMatches(prose, DRAMA_RE) +
		countMatches(prose, ANGUISH_RE) +
		countMatches(prose, DUDE_RE) +
		countMatches(prose, SAD_EMOTICON_RE);

	const negation = countMatches(prose, NEGATION_LEAD_RE) + countMatches(prose, NEGATION_PHRASE_RE);
	const repetition = countMatches(prose, REPETITION_RECALL_RE) + countMatches(prose, REPETITION_STILL_RE);
	const blame =
		countMatches(prose, BLAME_YOU_RE) + countMatches(prose, BLAME_WHY_RE) + countMatches(prose, BLAME_STOP_RE);

	return {
		chars,
		words,
		yelling: countYellingSentences(prose),
		profanity: countMatches(prose, PROFANITY_RE),
		anguish,
		negation,
		repetition,
		blame,
	};
}

export const EMPTY_USER_METRICS: UserMessageMetrics = Object.freeze({
	chars: 0,
	words: 0,
	yelling: 0,
	profanity: 0,
	anguish: 0,
	negation: 0,
	repetition: 0,
	blame: 0,
});
