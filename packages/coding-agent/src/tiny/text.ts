import { ALNUM_WORD_RE, collapseWhitespace } from "@veyyon/utils";
import { cleanTinyMessage, isPreformattedChatContext, stripChatScaffolding } from "./message-preproc";

const FILLER_TITLE_TOKENS = new Set<string>([
	"hi",
	"hii",
	"hiii",
	"hiya",
	"hey",
	"heya",
	"hello",
	"helo",
	"hullo",
	"yo",
	"ya",
	"sup",
	"wassup",
	"whatsup",
	"howdy",
	"greetings",
	"hola",
	"ciao",
	"aloha",
	"gm",
	"gn",
	"good",
	"morning",
	"afternoon",
	"evening",
	"night",
	"day",
	"thanks",
	"thank",
	"thx",
	"ty",
	"tysm",
	"cheers",
	"please",
	"pls",
	"plz",
	"ok",
	"okay",
	"okey",
	"k",
	"kk",
	"yep",
	"yes",
	"yeah",
	"yup",
	"nope",
	"no",
	"nah",
	"sure",
	"cool",
	"nice",
	"great",
	"awesome",
	"perfect",
	"lol",
	"lmao",
	"haha",
	"hehe",
	"test",
	"tests",
	"testing",
	"ping",
	"pong",
	"there",
	"you",
	"u",
	"hmm",
	"hmmm",
	"um",
	"uh",
	"so",
	"well",
	"anyway",
]);

const COMMON_TITLE_ACRONYMS = new Set<string>([
	"API",
	"CLI",
	"CPU",
	"CRUD",
	"CSS",
	"DNS",
	"ETL",
	"GPU",
	"HTML",
	"HTTP",
	"HTTPS",
	"ID",
	"JSON",
	"LLM",
	"REST",
	"SDK",
	"SSH",
	"TCP",
	"TLS",
	"TUI",
	"UI",
	"URI",
	"URL",
	"UX",
	"XML",
	"YAML",
]);

export function isLowSignalTitleInput(message: string): boolean {
	const cleaned = isPreformattedChatContext(message) ? stripChatScaffolding(message) : cleanTinyMessage(message);
	const tokens = cleaned.toLowerCase().match(ALNUM_WORD_RE);
	if (!tokens) return true;
	return tokens.every(token => FILLER_TITLE_TOKENS.has(token) || /^\d+$/.test(token));
}

export const NO_TITLE_SENTINEL = "none";

const MARKUP_TAG_RE = /<\/?[|a-z_][^<>]*>/gi;

export function normalizeGeneratedTitle(value: string | null | undefined, sourceText?: string): string | null {
	const firstLine = value?.trim().split(/\r?\n/, 1)[0]?.trim();
	if (!firstLine) return null;
	const unquoted = firstLine.replace(/^["']|["']$/g, "").trim();
	if (/^<title\s*\/>$/i.test(unquoted)) return null;
	const title = unquoted
		.replace(/^<title>/i, "")
		.replace(/<\/title>$/i, "")
		.replace(/^["']|["']$/g, "")
		.replace(/[.!?]$/, "")
		.trim();
	if (!title || title.toLowerCase() === NO_TITLE_SENTINEL) return null;
	const spoken = sourceText?.toLowerCase();
	const detagged = collapseWhitespace(
		title.replace(MARKUP_TAG_RE, tag => (spoken?.includes(tag.toLowerCase()) ? tag : " ")),
	);
	if (!detagged || detagged.toLowerCase() === NO_TITLE_SENTINEL) return null;
	return sourceText === undefined ? detagged : reconcileTitleCasing(detagged, sourceText);
}

function reconcileTitleCasing(title: string, sourceText: string): string {
	const verbatim = new Set<string>();
	const distinctive = new Map<string, string>();
	const acronyms = new Map<string, string>();
	const shouty = isShoutySource(sourceText);
	for (const [token] of sourceText.matchAll(ALNUM_WORD_RE)) {
		verbatim.add(token);
		if (isDistinctiveCasing(token)) {
			const lower = token.toLowerCase();
			if (!distinctive.has(lower)) distinctive.set(lower, token);
		} else if (!shouty && isAllCapsAcronym(token)) {
			const lower = token.toLowerCase();
			if (!acronyms.has(lower)) acronyms.set(lower, token);
		}
	}
	return title.replace(ALNUM_WORD_RE, token => {
		if (verbatim.has(token)) return token;
		const lower = token.toLowerCase();
		const restored = distinctive.get(lower);
		if (restored) return restored;
		if (isTitleCasedArtifact(token)) {
			const acronym = acronyms.get(lower);
			if (acronym) return acronym;
		}
		return isCamelArtifact(token) ? lower : token;
	});
}

function isDistinctiveCasing(token: string): boolean {
	return /\p{Ll}/u.test(token) && /\p{L}\p{Lu}/u.test(token);
}

function isAllCapsAcronym(token: string): boolean {
	if (!isAllCapsWord(token)) return false;
	const upper = token.toUpperCase();
	if (COMMON_TITLE_ACRONYMS.has(upper)) return true;
	if (/\p{N}/u.test(token)) return true;
	return !/[AEIOU]/.test(upper);
}

function isAllCapsWord(token: string): boolean {
	const letters = token.match(/\p{L}/gu);
	if (!letters || letters.length < 2) return false;
	return /\p{Lu}/u.test(token) && !/\p{Ll}/u.test(token);
}

function isTitleCasedArtifact(token: string): boolean {
	if (!/^\p{Lu}/u.test(token)) return false;
	if (!/\p{Ll}/u.test(token)) return false;
	return !/\p{Lu}/u.test(token.slice(1));
}

function isShoutySource(sourceText: string): boolean {
	let run = 0;
	for (const [token] of sourceText.matchAll(ALNUM_WORD_RE)) {
		if (isAllCapsWord(token)) {
			run += 1;
			if (run >= 2) return true;
		} else {
			run = 0;
		}
	}
	return false;
}

function isCamelArtifact(token: string): boolean {
	return /^\p{Ll}/u.test(token) && /\p{Lu}/u.test(token);
}
