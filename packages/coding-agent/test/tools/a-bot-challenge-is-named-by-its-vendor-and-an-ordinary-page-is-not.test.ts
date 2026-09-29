/**
 * WHY: the browser tool met Cloudflare, reCAPTCHA, DataDome and other bot checks and reported nothing:
 * a model read a "Just a moment..." page as the site, clicked at an hCaptcha frame, or retried a
 * blocked page until its turns ran out. The classifier names the check, its vendor and whether it
 * clears on its own, needs a person, or blocks the browser.
 *
 * The class: a challenge named wrong, or an ordinary page named a challenge. Every row of the vendor
 * table has one fixture per way it matches, swept from the table at run time, so a new row, or a new
 * matcher in a row, fails until it has a fixture; each fixture pins the rule, vendor, kind and the
 * evidence, which states the field that matched. Rows that are special cases of others (a Google
 * block page carrying a reCAPTCHA, a Cloudflare interstitial carrying a Turnstile frame, a DataDome
 * block) are pinned to the specific row. Ordinary pages that share words, scripts or frames with a
 * challenge (an article about CAPTCHAs, a reCAPTCHA v3 badge, a login page with an invisible
 * hCaptcha, Cloudflare's bot-management script, a page with an element named like AWS WAF's) match
 * nothing.
 *
 * What it does NOT catch: whether the page probe reads these signals from a real page, which the
 * real-Chromium suite for challenge notices drives, or a vendor changing its markup.
 */

import { describe, expect, it } from "bun:test";
import {
	CHALLENGE_RULES,
	type ChallengeKind,
	classifyChallenge,
	type PageSignals,
} from "@veyyon/coding-agent/tools/web/browser/challenge";

function page(signals: Partial<PageSignals>): PageSignals {
	const text = signals.text ?? "";
	return {
		url: "https://shop.example/",
		title: "",
		text,
		textLength: signals.textLength ?? text.length,
		markers: [],
		scripts: [],
		frames: [],
		visibleFrames: [],
		documentId: "1700000000000.5",
		...signals,
	};
}

interface Fixture {
	readonly signals: PageSignals;
	readonly evidence: readonly string[];
}

const RECAPTCHA_ANCHOR =
	"https://www.google.com/recaptcha/api2/anchor?ar=1&k=not-a-real-key&co=x&hl=en&v=v1&size=normal&cb=1";
const TURNSTILE =
	"https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/light/normal";
/** The widget containers the page probe checks, as it reports them. */
const TURNSTILE_CONTAINER = "div.cf-turnstile[data-sitekey]:not([data-appearance='interaction-only'])";
const RECAPTCHA_CONTAINER = "div.g-recaptcha[data-sitekey]:not([data-size='invisible'])";
const HCAPTCHA_CONTAINER = "div.h-captcha[data-sitekey]:not([data-size='invisible'])";
const KASADA_SCRIPT =
	"https://shop.example/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/ips.js?KP_UIDz=not-a-real-token";

/** The vendor and kind each row states, written out rather than read from the table. */
const EXPECTED: Record<string, { vendor: string; kind: ChallengeKind }> = {
	"cloudflare-interstitial": { vendor: "Cloudflare", kind: "interstitial" },
	"cloudflare-block": { vendor: "Cloudflare", kind: "block" },
	"cloudflare-turnstile": { vendor: "Cloudflare", kind: "interactive" },
	"google-sorry-captcha": { vendor: "Google", kind: "interactive" },
	"google-sorry-block": { vendor: "Google", kind: "block" },
	"recaptcha-challenge": { vendor: "Google reCAPTCHA", kind: "interactive" },
	"recaptcha-checkbox": { vendor: "Google reCAPTCHA", kind: "interactive" },
	hcaptcha: { vendor: "hCaptcha", kind: "interactive" },
	arkose: { vendor: "Arkose Labs", kind: "interactive" },
	"datadome-block": { vendor: "DataDome", kind: "block" },
	"datadome-captcha": { vendor: "DataDome", kind: "interactive" },
	"datadome-interstitial": { vendor: "DataDome", kind: "interstitial" },
	perimeterx: { vendor: "HUMAN (PerimeterX)", kind: "interactive" },
	"aws-waf-captcha": { vendor: "AWS WAF", kind: "interactive" },
	"aws-waf-challenge": { vendor: "AWS WAF", kind: "interstitial" },
	"akamai-block": { vendor: "Akamai", kind: "block" },
	"akamai-challenge": { vendor: "Akamai", kind: "interstitial" },
	"imperva-block": { vendor: "Imperva", kind: "block" },
	kasada: { vendor: "Kasada", kind: "interstitial" },
	"generic-interstitial": { vendor: "unrecognized", kind: "interstitial" },
	"generic-interactive": { vendor: "unrecognized", kind: "interactive" },
};

/** One fixture per matcher of each row, in the row's order. */
const FIXTURES: Record<string, readonly Fixture[]> = {
	"cloudflare-interstitial": [
		{
			signals: page({
				title: "Just a moment...",
				scripts: ["https://shop.example/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=not-a-real-ray"],
				frames: [TURNSTILE],
			}),
			evidence: ["script https://shop.example/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"],
		},
		{
			signals: page({ url: "https://shop.example/cart?__cf_chl_rt_tk=not-a-real-token" }),
			evidence: ["url https://shop.example/cart"],
		},
		{
			signals: page({ title: "Just a moment...", frames: [TURNSTILE] }),
			evidence: ['title "Just a moment..."', `frame ${TURNSTILE}`],
		},
		{
			signals: page({ markers: ["form#challenge-form[action*='__cf_chl']"] }),
			evidence: ["element form#challenge-form[action*='__cf_chl']"],
		},
		{ signals: page({ markers: ["#cf-challenge-running"] }), evidence: ["element #cf-challenge-running"] },
	],
	"cloudflare-block": [
		{
			signals: page({ title: "Access denied | shop.example used Cloudflare to restrict access" }),
			evidence: ['title "Access denied | shop.example used Cloudflare to restrict access"'],
		},
		{
			signals: page({
				title: "Attention Required! | Cloudflare",
				markers: ["#cf-error-details"],
				text: "Sorry, you have been blocked You are unable to access shop.example",
			}),
			evidence: ['text "you have been blocked"', "element #cf-error-details"],
		},
	],
	"cloudflare-turnstile": [
		{
			signals: page({ title: "Sign up", text: "Create your account", frames: [TURNSTILE] }),
			evidence: [`frame ${TURNSTILE}`],
		},
		{
			signals: page({ markers: [TURNSTILE_CONTAINER] }),
			evidence: [`element ${TURNSTILE_CONTAINER}`],
		},
	],
	"google-sorry-captcha": [
		{
			signals: page({ url: "https://www.google.com/sorry/index?continue=x", frames: [RECAPTCHA_ANCHOR] }),
			evidence: ["url https://www.google.com/sorry/index", "frame https://www.google.com/recaptcha/api2/anchor"],
		},
		{
			signals: page({ url: "https://www.google.com/sorry/index", markers: ["#captcha-form"] }),
			evidence: ["url https://www.google.com/sorry/index", "element #captcha-form"],
		},
		{
			signals: page({ url: "https://ipv4.google.com/sorry/index", markers: [".g-recaptcha"] }),
			evidence: ["url https://ipv4.google.com/sorry/index", "element .g-recaptcha"],
		},
	],
	"google-sorry-block": [
		{
			signals: page({ url: "https://www.google.com/sorry/index" }),
			evidence: ["url https://www.google.com/sorry/index"],
		},
		{
			signals: page({
				url: "https://www.google.com/search?q=x",
				text: "Our systems have detected unusual traffic from your computer network.",
			}),
			evidence: ["url https://www.google.com/search", 'text "unusual traffic from your computer network"'],
		},
	],
	"recaptcha-challenge": [
		{
			signals: page({
				frames: ["https://www.google.com/recaptcha/api2/bframe?hl=en&v=v1&k=not-a-real-key"],
				visibleFrames: ["https://www.google.com/recaptcha/api2/bframe?hl=en&v=v1&k=not-a-real-key"],
			}),
			evidence: ["visible frame https://www.google.com/recaptcha/api2/bframe"],
		},
	],
	"recaptcha-checkbox": [
		{
			signals: page({
				title: "Contact us",
				frames: [RECAPTCHA_ANCHOR.replace("www.google.com", "www.recaptcha.net")],
			}),
			evidence: ["frame https://www.recaptcha.net/recaptcha/api2/anchor"],
		},
		{
			signals: page({ title: "Contact us", markers: [RECAPTCHA_CONTAINER] }),
			evidence: [`element ${RECAPTCHA_CONTAINER}`],
		},
	],
	hcaptcha: [
		{
			signals: page({
				frames: [
					"https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=0&host=shop.example",
				],
			}),
			evidence: ["frame https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html"],
		},
		{
			signals: page({
				visibleFrames: ["https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge&id=0"],
			}),
			evidence: ["visible frame https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html"],
		},
		{
			signals: page({ markers: [HCAPTCHA_CONTAINER] }),
			evidence: [`element ${HCAPTCHA_CONTAINER}`],
		},
	],
	arkose: [
		{
			signals: page({ frames: ["https://client-api.arkoselabs.com/fc/gc/?token=not-a-real-token"] }),
			evidence: ["frame https://client-api.arkoselabs.com/fc/gc/"],
		},
		{
			signals: page({ visibleFrames: ["https://shop-api.arkoselabs.com/v2/not-a-real-key/enforcement.html"] }),
			evidence: ["visible frame https://shop-api.arkoselabs.com/v2/not-a-real-key/enforcement.html"],
		},
	],
	"datadome-block": [
		{
			signals: page({ frames: ["https://geo.captcha-delivery.com/captcha/?initialCid=not-a-real-cid&t=bv&s=1"] }),
			evidence: ["frame https://geo.captcha-delivery.com/captcha/"],
		},
	],
	"datadome-captcha": [
		{
			signals: page({ frames: ["https://geo.captcha-delivery.com/captcha/?initialCid=not-a-real-cid&t=fe&s=1"] }),
			evidence: ["frame https://geo.captcha-delivery.com/captcha/"],
		},
	],
	"datadome-interstitial": [
		{
			signals: page({ frames: ["https://geo.captcha-delivery.com/interstitial/?initialCid=not-a-real-cid"] }),
			evidence: ["frame https://geo.captcha-delivery.com/interstitial/"],
		},
	],
	perimeterx: [
		{
			signals: page({ title: "Access to this page has been denied", markers: ["#px-captcha"] }),
			evidence: ["element #px-captcha"],
		},
		{
			signals: page({ frames: ["https://captcha.px-cdn.net/PXnot-a-real-app/captcha.js"] }),
			evidence: ["frame https://captcha.px-cdn.net/PXnot-a-real-app/captcha.js"],
		},
		{
			signals: page({ scripts: ["https://captcha.px-cloud.net/PXnot-a-real-app/captcha.js?a=c"] }),
			evidence: ["script https://captcha.px-cloud.net/PXnot-a-real-app/captcha.js"],
		},
	],
	"aws-waf-captcha": [
		{
			signals: page({
				title: "Human Verification",
				scripts: ["https://abc123.us-east-1.captcha.awswaf.com/abc123/def/captcha.js"],
				markers: ["#captcha-container"],
			}),
			evidence: [
				"element #captcha-container",
				"script https://abc123.us-east-1.captcha.awswaf.com/abc123/def/captcha.js",
			],
		},
	],
	"aws-waf-challenge": [
		{
			signals: page({
				scripts: ["https://abc123.us-east-1.token.awswaf.com/abc123/def/challenge.js"],
				markers: ["#challenge-container"],
			}),
			evidence: [
				"element #challenge-container",
				"script https://abc123.us-east-1.token.awswaf.com/abc123/def/challenge.js",
			],
		},
	],
	"akamai-block": [
		{
			signals: page({
				title: "Access Denied",
				text: 'Access Denied You don\'t have permission to access "http://shop.example/" on this server. Reference #18.2a3b4c5d.1695742365.1b2c3d4',
			}),
			evidence: ['title "Access Denied"', 'text "Reference #18.2a3b4c5d.1695742365.1b2c3d4"'],
		},
	],
	"akamai-challenge": [
		{ signals: page({ markers: ["#sec-if-cpt-container"] }), evidence: ["element #sec-if-cpt-container"] },
		{ signals: page({ markers: ["#sec-cpt-if"] }), evidence: ["element #sec-cpt-if"] },
		{
			signals: page({ frames: ["https://shop.example/_sec/cp_challenge/sec-cpt-if-4-3.html"] }),
			evidence: ["frame https://shop.example/_sec/cp_challenge/sec-cpt-if-4-3.html"],
		},
		{
			signals: page({ scripts: ["https://shop.example/_sec/cp_challenge/sec-4-3.js"] }),
			evidence: ["script https://shop.example/_sec/cp_challenge/sec-4-3.js"],
		},
	],
	"imperva-block": [
		{
			signals: page({
				visibleFrames: ["https://shop.example/_Incapsula_Resource?CWUDNSAI=9&xinfo=not-a-real-info"],
			}),
			evidence: ["visible frame https://shop.example/_Incapsula_Resource"],
		},
		{
			signals: page({ text: "Request unsuccessful. Incapsula incident ID: 0-000000000" }),
			evidence: ['text "Incapsula incident ID"'],
		},
		{
			signals: page({
				title: "Pardon Our Interruption",
				text: "As you were browsing something about your browser made us think you were a bot.",
			}),
			evidence: ['title "Pardon Our Interruption"'],
		},
	],
	kasada: [{ signals: page({ scripts: [KASADA_SCRIPT] }), evidence: [`script ${KASADA_SCRIPT.split("?")[0]}`] }],
	"generic-interstitial": [
		{
			signals: page({ title: "DDoS Protection", text: "Please wait" }),
			evidence: ['title "DDoS Protection"'],
		},
		{
			signals: page({ title: "shop.example", text: "Checking your browser before accessing shop.example." }),
			evidence: ['text "Checking your browser before accessing"'],
		},
	],
	"generic-interactive": [
		{
			signals: page({ title: "Human Verification", text: "Click the button below." }),
			evidence: ['title "Human Verification"'],
		},
		{
			signals: page({ title: "shop.example", text: "Please verify you are a human to continue." }),
			evidence: ['text "verify you are a human"'],
		},
	],
};

describe("the challenge classifier", () => {
	it("has a fixture for every way every row of the vendor table matches, and none for a row that is gone", () => {
		const shape = Object.fromEntries(CHALLENGE_RULES.map(rule => [rule.id, rule.anyOf.length]));
		const fixtures = Object.fromEntries(Object.entries(FIXTURES).map(([id, list]) => [id, list.length]));
		expect(fixtures).toEqual(shape);
		expect(Object.keys(EXPECTED).sort()).toEqual(CHALLENGE_RULES.map(rule => rule.id).sort());
	});

	for (const rule of CHALLENGE_RULES) {
		it(`names the ${rule.id} row with its vendor, kind and the evidence that matched`, () => {
			const expected = EXPECTED[rule.id];
			const got = (FIXTURES[rule.id] ?? []).map(fixture => classifyChallenge(fixture.signals));
			expect(got).toEqual(
				(FIXTURES[rule.id] ?? []).map(fixture => ({
					rule: rule.id,
					vendor: expected?.vendor,
					kind: expected?.kind,
					label: rule.label,
					evidence: fixture.evidence,
				})),
			);
		});
	}

	it("names no challenge on ordinary pages that share its words, scripts or frames", () => {
		const article = [
			"How CAPTCHAs work. Sites ask you to verify you are human, to press and hold a button, or to wait while",
			"Checking your browser before accessing the site. Google says: our systems have detected unusual traffic",
			"from your computer network. Imperva shows an Incapsula incident ID; Akamai shows Access Denied with a",
			"Reference #18.2a3b4c5d.1695742365.1b2c3d4. ",
		].join(" ");
		const ordinary = {
			article: page({
				title: "Verify you are human: how CAPTCHAs work",
				text: article.repeat(8),
				scripts: [
					"https://blog.example/cdn-cgi/challenge-platform/scripts/jsd/main.js",
					"https://www.google.com/recaptcha/api.js",
				],
			}),
			recaptchaV3Badge: page({
				title: "Shop",
				text: "Products",
				scripts: ["https://www.google.com/recaptcha/api.js?render=not-a-real-key"],
				frames: ["https://www.google.com/recaptcha/api2/anchor?ar=1&k=not-a-real-key&size=invisible&cb=1"],
			}),
			loginWithInvisibleHcaptcha: page({
				title: "Sign in",
				text: "Email Password Sign in Forgot your password?",
				frames: [
					"https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox-invisible&id=0",
					"https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge&id=0",
				],
			}),
			hiddenRecaptchaChallengeFrame: page({
				title: "Checkout",
				frames: ["https://www.google.com/recaptcha/api2/bframe?hl=en&k=not-a-real-key"],
			}),
			quizWithAChallengeContainer: page({
				title: "Daily quiz",
				text: "Question 1",
				markers: ["#challenge-container"],
				scripts: ["https://quiz.example/app.js"],
			}),
			awsSdkOnAnOrdinaryPage: page({
				title: "Store",
				text: "Welcome back",
				scripts: ["https://abc123.us-east-1.token.awswaf.com/abc123/def/challenge.js"],
			}),
			justAMomentLoadingScreen: page({ title: "Just a moment...", text: "Loading" }),
		};
		const named = Object.fromEntries(
			Object.entries(ordinary).map(([name, signals]) => [name, classifyChallenge(signals)?.rule ?? null]),
		);
		expect(named).toEqual({
			article: null,
			recaptchaV3Badge: null,
			loginWithInvisibleHcaptcha: null,
			hiddenRecaptchaChallengeFrame: null,
			quizWithAChallengeContainer: null,
			awsSdkOnAnOrdinaryPage: null,
			justAMomentLoadingScreen: null,
		});
	});
});
