/**
 * Bot challenges on a page: whose check it is, and whether it clears on its own, needs a person, or
 * blocks the browser.
 *
 * The page is read once, by {@link PROBE_RUN_CODE}: its URL, title, the start of its text, which of the
 * table's selectors match, its script sources, and every frame's URL. The frame list comes from
 * puppeteer, so a cross-origin frame, or one inside a closed shadow root as Turnstile's is, is seen too;
 * the top document's iframes add whether each is drawn on the page.
 *
 * {@link CHALLENGE_RULES} is data. A vendor is one row; the first row that matches names the challenge,
 * so a row that is a special case of another comes before it.
 */

import { type } from "@veyyon/ai/utils/schema/arktype";
import { lazy } from "@veyyon/utils";

/** `interstitial` clears on its own; `interactive` needs a person; `block` refuses the browser. */
export type ChallengeKind = "interstitial" | "interactive" | "block";

/** What a page shows that a challenge is recognized by. */
export interface PageSignals {
	readonly url: string;
	readonly title: string;
	/** The start of the page's text, whitespace collapsed, at most {@link TEXT_SAMPLE_CHARS} long. */
	readonly text: string;
	/** The length of the page's text, counted up to {@link TEXT_COUNT_LIMIT}. */
	readonly textLength: number;
	/** The selectors of the table that match an element of the top document. */
	readonly markers: readonly string[];
	/** The `src` of the top document's script elements. */
	readonly scripts: readonly string[];
	/** Every frame's URL: puppeteer's frame list, cross-origin frames included, and the top document's iframes. */
	readonly frames: readonly string[];
	/** The `src` of the top document's iframes that are drawn on the page. */
	readonly visibleFrames: readonly string[];
	/** Differs for every document the tab loads: `performance.timeOrigin`. */
	readonly documentId: string;
}

/** Holds when every field it sets holds. */
export interface ChallengeMatcher {
	readonly url?: RegExp;
	readonly title?: RegExp;
	readonly text?: RegExp;
	/** The page's text is at most this long: a challenge page, not an article that quotes one. */
	readonly textMaxLength?: number;
	/** Every selector matches an element of the top document. */
	readonly selectors?: readonly string[];
	/** Some script `src` matches. */
	readonly script?: RegExp;
	/** Some frame URL matches. */
	readonly frame?: RegExp;
	/** Some iframe drawn on the page has a matching `src`. */
	readonly visibleFrame?: RegExp;
}

export interface ChallengeRule {
	readonly id: string;
	readonly vendor: string;
	readonly kind: ChallengeKind;
	/** What the page shows, as a notice names it. */
	readonly label: string;
	/** The page shows the challenge when any matcher holds. */
	readonly anyOf: readonly ChallengeMatcher[];
}

export interface Challenge {
	readonly rule: string;
	readonly vendor: string;
	readonly kind: ChallengeKind;
	readonly label: string;
	/** What matched, one entry per matched field, with no query strings. */
	readonly evidence: readonly string[];
}

export const TEXT_SAMPLE_CHARS = 2_000;
export const TEXT_COUNT_LIMIT = 20_000;
/** A page with more text than this is an ordinary page, whatever words it uses. */
const SHORT_PAGE = 1_500;

const RECAPTCHA = String.raw`^https://(?:www\.)?(?:google\.com|recaptcha\.net)/recaptcha/(?:api2|enterprise)/`;
const GOOGLE_SORRY = /^https?:\/\/[^/]*\bgoogle\.[a-z.]+\/sorry\//i;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const CHALLENGE_RULES: readonly ChallengeRule[] = [
	{
		id: "cloudflare-interstitial",
		vendor: "Cloudflare",
		kind: "interstitial",
		label: "Cloudflare interstitial check",
		anyOf: [
			{ script: /\/cdn-cgi\/challenge-platform\/h\/[^/]+\/orchestrate\/(?:chl_page|managed|jsch|captcha)\// },
			{ url: /[?&]__cf_chl_(?:rt_tk|tk|f_tk|jschl_tk__|captcha_tk__)=/ },
			{ title: /^just a moment\b/i, frame: /^https:\/\/challenges\.cloudflare\.com\// },
			{ selectors: ["form#challenge-form[action*='__cf_chl']"] },
			{ selectors: ["#cf-challenge-running"] },
		],
	},
	{
		id: "cloudflare-block",
		vendor: "Cloudflare",
		kind: "block",
		label: "Cloudflare block page",
		anyOf: [
			{ title: /used cloudflare to restrict access/i },
			{
				selectors: ["#cf-error-details"],
				text: /you have been blocked|you are unable to access|access denied/i,
				textMaxLength: SHORT_PAGE * 2,
			},
		],
	},
	{
		id: "cloudflare-turnstile",
		vendor: "Cloudflare",
		kind: "interactive",
		label: "Cloudflare Turnstile widget",
		// A widget's container is in the page's markup before its script adds the frame, which can land
		// after the load an open waits for. An `interaction-only` widget shows only when it needs a person.
		anyOf: [
			{ frame: /^https:\/\/challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\/[^?#]*\/turnstile\// },
			{ selectors: ["div.cf-turnstile[data-sitekey]:not([data-appearance='interaction-only'])"] },
		],
	},
	{
		id: "google-sorry-captcha",
		vendor: "Google",
		kind: "interactive",
		label: "Google unusual-traffic CAPTCHA",
		anyOf: [
			{ url: GOOGLE_SORRY, frame: new RegExp(`${RECAPTCHA}anchor`) },
			{ url: GOOGLE_SORRY, selectors: ["#captcha-form"] },
			{ url: GOOGLE_SORRY, selectors: [".g-recaptcha"] },
		],
	},
	{
		id: "google-sorry-block",
		vendor: "Google",
		kind: "block",
		label: "Google unusual-traffic block",
		anyOf: [
			{ url: GOOGLE_SORRY },
			{
				url: /^https?:\/\/[^/]*\bgoogle\.[a-z.]+\//i,
				text: /unusual traffic from your computer network/i,
				textMaxLength: SHORT_PAGE * 2,
			},
		],
	},
	{
		id: "recaptcha-challenge",
		vendor: "Google reCAPTCHA",
		kind: "interactive",
		label: "reCAPTCHA image challenge",
		anyOf: [{ visibleFrame: new RegExp(`${RECAPTCHA}bframe`) }],
	},
	{
		id: "recaptcha-checkbox",
		vendor: "Google reCAPTCHA",
		kind: "interactive",
		label: "reCAPTCHA v2 checkbox",
		// v3 and invisible v2 load the same anchor frame with size=invisible, and ask nothing of a person;
		// an invisible v2 bound to a button carries the class on the button.
		anyOf: [
			{ frame: new RegExp(`${RECAPTCHA}anchor\\?(?:[^#]*&)?size=(?:normal|compact)(?:[&#]|$)`) },
			{ selectors: ["div.g-recaptcha[data-sitekey]:not([data-size='invisible'])"] },
		],
	},
	{
		id: "hcaptcha",
		vendor: "hCaptcha",
		kind: "interactive",
		label: "hCaptcha challenge",
		anyOf: [
			{ frame: /^https:\/\/(?:[a-z0-9-]+\.)?hcaptcha\.com\/captcha\/v1\/[^#]*#(?:[^#]*&)?frame=checkbox(?:&|$)/ },
			{
				visibleFrame:
					/^https:\/\/(?:[a-z0-9-]+\.)?hcaptcha\.com\/captcha\/v1\/[^#]*#(?:[^#]*&)?frame=challenge(?:&|$)/,
			},
			{ selectors: ["div.h-captcha[data-sitekey]:not([data-size='invisible'])"] },
		],
	},
	{
		id: "arkose",
		vendor: "Arkose Labs",
		kind: "interactive",
		label: "Arkose Labs FunCaptcha",
		anyOf: [
			{ frame: /^https:\/\/[a-z0-9-]+\.(?:arkoselabs|funcaptcha)\.com\/fc\/(?:gc\/|assets\/ec-game-core\/)/ },
			{ visibleFrame: /^https:\/\/[a-z0-9-]+\.(?:arkoselabs|funcaptcha)\.com\// },
		],
	},
	{
		id: "datadome-block",
		vendor: "DataDome",
		kind: "block",
		label: "DataDome block page",
		anyOf: [{ frame: /^https:\/\/geo\.captcha-delivery\.com\/captcha\/\?(?:[^#]*&)?t=bv(?:[&#]|$)/ }],
	},
	{
		id: "datadome-captcha",
		vendor: "DataDome",
		kind: "interactive",
		label: "DataDome CAPTCHA",
		anyOf: [{ frame: /^https:\/\/geo\.captcha-delivery\.com\/captcha\// }],
	},
	{
		id: "datadome-interstitial",
		vendor: "DataDome",
		kind: "interstitial",
		label: "DataDome device check",
		anyOf: [{ frame: /^https:\/\/geo\.captcha-delivery\.com\/interstitial\// }],
	},
	{
		id: "perimeterx",
		vendor: "HUMAN (PerimeterX)",
		kind: "interactive",
		label: "HUMAN press-and-hold check",
		anyOf: [
			{ selectors: ["#px-captcha"] },
			{ frame: /^https:\/\/captcha\.(?:px-cdn\.net|px-cloud\.net)\// },
			{ script: /^https:\/\/captcha\.(?:px-cdn\.net|px-cloud\.net)\// },
		],
	},
	{
		id: "aws-waf-captcha",
		vendor: "AWS WAF",
		kind: "interactive",
		label: "AWS WAF CAPTCHA",
		anyOf: [{ script: /^https:\/\/[^/]+\.captcha\.awswaf\.com\//, selectors: ["#captcha-container"] }],
	},
	{
		id: "aws-waf-challenge",
		vendor: "AWS WAF",
		kind: "interstitial",
		label: "AWS WAF challenge",
		anyOf: [
			{
				script: /^https:\/\/[^/]+\.token\.awswaf\.com\/.*\/challenge\.js/,
				selectors: ["#challenge-container"],
				textMaxLength: SHORT_PAGE,
			},
		],
	},
	{
		id: "akamai-block",
		vendor: "Akamai",
		kind: "block",
		label: "Akamai access-denied page",
		anyOf: [
			{
				title: /^access denied$/i,
				text: /reference\s*#\s*\d+\.[0-9a-f]+\.\d+\.[0-9a-f]+/i,
				textMaxLength: SHORT_PAGE,
			},
		],
	},
	{
		id: "akamai-challenge",
		vendor: "Akamai",
		kind: "interstitial",
		label: "Akamai browser check",
		anyOf: [
			{ selectors: ["#sec-if-cpt-container"] },
			{ selectors: ["#sec-cpt-if"] },
			{ frame: /\/_sec\/cp_challenge\// },
			{ script: /\/_sec\/cp_challenge\// },
		],
	},
	{
		id: "imperva-block",
		vendor: "Imperva",
		kind: "block",
		label: "Imperva block page",
		anyOf: [
			{ visibleFrame: /\/_Incapsula_Resource\?/ },
			{ text: /incapsula incident id/i, textMaxLength: SHORT_PAGE },
			{ title: /^pardon our interruption/i, textMaxLength: SHORT_PAGE },
		],
	},
	{
		id: "kasada",
		vendor: "Kasada",
		kind: "interstitial",
		label: "Kasada challenge",
		// The challenge page is a blank document that runs the script and reloads.
		anyOf: [{ script: new RegExp(`/${UUID}/${UUID}/ips\\.js`, "i"), textMaxLength: 200 }],
	},
	{
		id: "generic-interstitial",
		vendor: "unrecognized",
		kind: "interstitial",
		label: "browser check",
		anyOf: [
			{
				title: /checking your browser|verifying (?:that )?you are (?:a )?human|ddos protection/i,
				textMaxLength: SHORT_PAGE,
			},
			{
				text: /checking your browser before accessing|verifying (?:that )?you are (?:a )?human\. this may take a few seconds/i,
				textMaxLength: SHORT_PAGE,
			},
		],
	},
	{
		id: "generic-interactive",
		vendor: "unrecognized",
		kind: "interactive",
		label: "human-verification page",
		anyOf: [
			{
				title: /verify (?:that )?you(?:'| a)re (?:a )?human|are you (?:a )?(?:robot|human)|human verification|bot verification|security check\b/i,
				textMaxLength: SHORT_PAGE,
			},
			{
				text: /(?:verify|confirm|prove) (?:that )?you(?:'| a)re (?:a )?human|are you a robot|i'?m not a robot|complete the security check|press (?:&|and) hold/i,
				textMaxLength: SHORT_PAGE,
			},
		],
	},
];

/** A URL as evidence: origin and path, no query or fragment, which can carry the site's tokens. */
function evidenceUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`.slice(0, 120);
	} catch {
		return url.slice(0, 120);
	}
}

/** What `matcher` matched on `signals`, one entry per field; undefined when a field fails. */
function matchEvidence(matcher: ChallengeMatcher, signals: PageSignals): string[] | undefined {
	const evidence: string[] = [];
	if (matcher.textMaxLength !== undefined && signals.textLength > matcher.textMaxLength) return undefined;
	if (matcher.url) {
		if (!matcher.url.test(signals.url)) return undefined;
		evidence.push(`url ${evidenceUrl(signals.url)}`);
	}
	if (matcher.title) {
		if (!matcher.title.test(signals.title)) return undefined;
		evidence.push(`title ${JSON.stringify(signals.title.slice(0, 80))}`);
	}
	if (matcher.text) {
		const found = matcher.text.exec(signals.text);
		if (!found) return undefined;
		evidence.push(`text ${JSON.stringify(found[0].slice(0, 80))}`);
	}
	for (const selector of matcher.selectors ?? []) {
		if (!signals.markers.includes(selector)) return undefined;
		evidence.push(`element ${selector}`);
	}
	const lists = [
		["script", matcher.script, signals.scripts],
		["frame", matcher.frame, signals.frames],
		["visible frame", matcher.visibleFrame, signals.visibleFrames],
	] as const;
	for (const [name, pattern, values] of lists) {
		if (!pattern) continue;
		const hit = values.find(value => pattern.test(value));
		if (hit === undefined) return undefined;
		evidence.push(`${name} ${evidenceUrl(hit)}`);
	}
	return evidence;
}

/** The first challenge of {@link CHALLENGE_RULES} `signals` show, or undefined for an ordinary page. */
export function classifyChallenge(signals: PageSignals): Challenge | undefined {
	for (const rule of CHALLENGE_RULES) {
		for (const matcher of rule.anyOf) {
			const evidence = matchEvidence(matcher, signals);
			if (evidence) {
				return { rule: rule.id, vendor: rule.vendor, kind: rule.kind, label: rule.label, evidence };
			}
		}
	}
	return undefined;
}

/** Every selector of the table, which the page probe checks. */
const PROBE_SELECTORS = [...new Set(CHALLENGE_RULES.flatMap(rule => rule.anyOf.flatMap(m => m.selectors ?? [])))];

/**
 * Reads {@link PageSignals} from the page's DOM, apart from puppeteer's frame list. A string, so the
 * worker and the cmux backend both run it. It calls only DOM methods and getters, which a page can
 * replace in its own world and watch: the worker runs it in puppeteer's isolated world, where the
 * page's replacements are not seen and see nothing.
 */
const PAGE_PROBE_EXPRESSION = `(() => {
	const selectors = ${JSON.stringify(PROBE_SELECTORS)};
	const markers = [];
	for (const selector of selectors) {
		try { if (document.querySelector(selector)) markers.push(selector); } catch {}
	}
	const scripts = [];
	for (const el of document.scripts) {
		if (el.src) scripts.push(el.src);
		if (scripts.length >= 100) break;
	}
	const frames = [];
	const visibleFrames = [];
	for (const el of document.querySelectorAll("iframe, frame")) {
		const src = el.src;
		if (!src) continue;
		frames.push(src);
		const box = el.getBoundingClientRect();
		const shown = typeof el.checkVisibility === "function"
			? el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
			: getComputedStyle(el).visibility !== "hidden";
		if (shown && box.width > 1 && box.height > 1 && box.right + scrollX > 0 && box.bottom + scrollY > 0) visibleFrames.push(src);
		if (frames.length >= 100) break;
	}
	let text = "";
	let textLength = 0;
	if (document.body) {
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
			acceptNode: node => {
				const tag = node.parentElement ? node.parentElement.tagName : "";
				return tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE"
					? NodeFilter.FILTER_REJECT
					: NodeFilter.FILTER_ACCEPT;
			},
		});
		for (let node = walker.nextNode(); node && textLength < ${TEXT_COUNT_LIMIT}; node = walker.nextNode()) {
			const value = (node.nodeValue || "").replace(/\\s+/g, " ").trim();
			if (!value) continue;
			textLength += value.length + 1;
			if (text.length < ${TEXT_SAMPLE_CHARS}) text += (text ? " " : "") + value;
		}
	}
	return {
		url: location.href,
		title: document.title,
		text: text.slice(0, ${TEXT_SAMPLE_CHARS}),
		textLength,
		markers,
		scripts,
		frames,
		visibleFrames,
		documentId: String(performance.timeOrigin),
	};
})()`;

/** How long the probe waits for the page to answer: a page whose main thread is busy answers nothing. */
export const PROBE_READ_MS = 3_000;

/**
 * The run code that reads a tab's {@link PageSignals}, or null when the page does not answer in
 * {@link PROBE_READ_MS} (a navigation in flight, a busy page, an open dialog). `page.evaluate` runs in
 * puppeteer's isolated world on the worker backend; the cmux backend has no `page`, no isolated world
 * and no frame list, and reads the top document's alone through `tab.evaluate`.
 */
export const PROBE_RUN_CODE = `const puppeteerPage = typeof page !== "undefined" && page && typeof page.evaluate === "function" ? page : null;
const expression = ${JSON.stringify(PAGE_PROBE_EXPRESSION)};
const read = await Promise.race([
	(puppeteerPage ? puppeteerPage.evaluate(expression) : tab.evaluate(expression)).catch(() => null),
	wait(${PROBE_READ_MS}).then(() => null),
]);
if (!read || typeof read !== "object") return null;
let frames = [];
try {
	const list = puppeteerPage && typeof puppeteerPage.frames === "function" ? puppeteerPage.frames() : [];
	if (Array.isArray(list)) frames = list.map(frame => frame.url());
} catch {}
return { ...read, frames: [...frames, ...read.frames] };`;

const pageSignalsSchema = lazy(() =>
	type({
		url: "string",
		title: "string",
		text: "string",
		textLength: "number",
		markers: "string[]",
		scripts: "string[]",
		frames: "string[]",
		visibleFrames: "string[]",
		documentId: "string",
	}),
);

/** The signals a probe run returned, or undefined when the page gave none or something else. */
export function parsePageSignals(value: unknown): PageSignals | undefined {
	const parsed = pageSignalsSchema.value(value);
	return parsed instanceof type.errors ? undefined : parsed;
}
