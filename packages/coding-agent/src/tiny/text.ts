import { ALNUM_WORD_RE, collapseWhitespace } from "@veyyon/utils";
import { cleanTinyMessage, isPreformattedChatContext, stripChatScaffolding } from "./message-preproc";

/** Greeting / acknowledgement / filler tokens. A first user message composed entirely of these (or of bare numbers / punctuation / emoji) carries no */
const FILLER_TITLE_TOKENS = new Set<string>([
	// greetings
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
	// politeness / acknowledgement
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
	// poking the agent / fillers
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

/** True when a first user message is too low-signal to title (greeting, ack, bare number, or empty once code/punctuation/emoji are stripped). */
export function isLowSignalTitleInput(message: string): boolean {
	// Preformatted replan contexts are already cleaned per turn; only the
	// scaffolding tags are dropped so the turn text drives the signal check
	// (cleanTinyMessage would strip the paired <chat> envelope to nothing).
	const cleaned = isPreformattedChatContext(message) ? stripChatScaffolding(message) : cleanTinyMessage(message);
	const tokens = cleaned.toLowerCase().match(ALNUM_WORD_RE);
	if (!tokens) return true;
	return tokens.every(token => FILLER_TITLE_TOKENS.has(token) || /^\d+$/.test(token));
}

/** Sentinel a capable title model may emit when a message carries no concrete task. Treated as "no title yet" so the caller can defer titling. Backstop for */
export const NO_TITLE_SENTINEL = "none";

/** A complete markup tag: `<tools>`, `</think>`, `<tool_call>`, `<|channel|>`, `<title/>`. A LEAKED TAG IS NOT A TITLE. The title role resolves to the tiny model, then the commit model, */
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
	// Prose that survives beside a tag is kept and the tag dropped, because a title carrying one leaked marker is still a description of the work; a title that is ONLY markup describes
	const spoken = sourceText?.toLowerCase();
	const detagged = collapseWhitespace(
		title.replace(MARKUP_TAG_RE, tag => (spoken?.includes(tag.toLowerCase()) ? tag : " ")),
	);
	if (!detagged || detagged.toLowerCase() === NO_TITLE_SENTINEL) return null;
	return sourceText === undefined ? detagged : reconcileTitleCasing(detagged, sourceText);
}

/** Reconcile a generated title's casing against the user's own message. The title prompt asks for sentence case, but small title models still mangle */
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

/** Mixed-case identifier the user cased deliberately (`TinyVMM`, `iOS`, `IDs`):
 *  an interior/repeated capital plus at least one lowercase letter. Only these
 *  are restored when the model flattens them. */
function isDistinctiveCasing(token: string): boolean {
	return /\p{Ll}/u.test(token) && /\p{L}\p{Lu}/u.test(token);
}

/** Multi-letter ALL-CAPS source token with a stronger acronym signal than a plain emphasized word. Consonant-only tokens (`CNPG`, `SQL`, `JWT`) are */
function isAllCapsAcronym(token: string): boolean {
	if (!isAllCapsWord(token)) return false;
	const upper = token.toUpperCase();
	if (COMMON_TITLE_ACRONYMS.has(upper)) return true;
	if (/\p{N}/u.test(token)) return true;
	return !/[AEIOU]/.test(upper);
}

/** Multi-letter ALL-CAPS word in the source. Used for shout detection, not for acronym restoration — shouted English words (`FIX`, `WORK`) still count as */
function isAllCapsWord(token: string): boolean {
	const letters = token.match(/\p{L}/gu);
	if (!letters || letters.length < 2) return false;
	return /\p{Lu}/u.test(token) && !/\p{Ll}/u.test(token);
}

/** Plain title-cased word (`Cnpg`, `Etl`): starts uppercase, has one-or-more lowercase letters, no interior uppercase. This is the artifact a title model */
function isTitleCasedArtifact(token: string): boolean {
	if (!/^\p{Lu}/u.test(token)) return false;
	if (!/\p{Ll}/u.test(token)) return false;
	return !/\p{Lu}/u.test(token.slice(1));
}

/** True when the source text is shouting — ≥2 consecutive multi-letter ALL-CAPS tokens (`FIX the BUG NOW` has `BUG NOW`; `ALL ERROR HANDLING` */
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

/** A lowercase word carrying a stray interior capital (`dAemon`, `cReate`): the
 *  model-mangled shape we flatten when the user never wrote it. PascalCase proper
 *  nouns (`GitHub`, `OAuth`) start uppercase and are left untouched. */
function isCamelArtifact(token: string): boolean {
	return /^\p{Ll}/u.test(token) && /\p{Lu}/u.test(token);
}
