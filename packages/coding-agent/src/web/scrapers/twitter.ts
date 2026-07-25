import { errorMessage, isAbortError } from "@veyyon/utils";
import type { HTMLElement } from "linkedom";
import { throwIfAborted } from "../../tools/tool-errors";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, loadPage, tryParseUrl } from "./types";

const NITTER_INSTANCES = [
	"nitter.privacyredirect.com",
	"nitter.tiekoetter.com",
	"nitter.poast.org",
	"nitter.woodland.cafe",
];

/**
 * Handle Twitter/X URLs via Nitter
 */
export const handleTwitter: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	const parsed = tryParseUrl(url);
	if (!parsed) return null;
	if (!["twitter.com", "x.com", "www.twitter.com", "www.x.com"].includes(parsed.hostname)) {
		return null;
	}

	const fetchedAt = new Date().toISOString();
	// Why each instance did not answer, in the order tried. This is what the
	// fallback message reports, so that message describes what actually happened
	// instead of asserting a conclusion nobody checked.
	const attempts: string[] = [];

	// Try Nitter instances. The try sits INSIDE the loop on purpose: it used to
	// wrap the whole loop, so the first instance that threw ended every remaining
	// attempt, and the handler still returned the "all instances unavailable"
	// message below as though it had tried them.
	for (const instance of NITTER_INSTANCES) {
		const nitterUrl = `https://${instance}${parsed.pathname}`;
		try {
			const result = await loadPage(nitterUrl, { timeout: Math.min(timeout, 10), signal });

			if (!result.ok) {
				attempts.push(`${instance}: ${result.status ? `HTTP ${result.status}` : (result.error ?? "no response")}`);
				continue;
			}
			if (result.content.length <= 500) {
				attempts.push(`${instance}: response too short to be a tweet (${result.content.length} bytes)`);
				continue;
			}
			// Parse the Nitter HTML
			const { parseHTML } = await import("linkedom");
			const doc = parseHTML(result.content).document;

			// Extract tweet content
			const tweetContent = doc.querySelector(".tweet-content")?.textContent?.trim();
			const fullname = doc.querySelector(".fullname")?.textContent?.trim();
			const username = doc.querySelector(".username")?.textContent?.trim();
			const date = doc.querySelector(".tweet-date a")?.textContent?.trim();
			const stats = doc.querySelector(".tweet-stats")?.textContent?.trim();

			if (!tweetContent) {
				attempts.push(`${instance}: responded, but the page carried no tweet content`);
				continue;
			}

			let md = `# Tweet by ${fullname || "Unknown"} (${username || "@?"})\n\n`;
			if (date) md += `*${date}*\n\n`;
			md += `${tweetContent}\n\n`;
			if (stats) md += `---\n${stats.replace(/\s+/g, " ")}\n`;

			// Check for replies/thread
			const replies = Array.from(doc.querySelectorAll(".timeline-item .tweet-content")) as HTMLElement[];
			if (replies.length > 1) {
				md += `\n---\n\n## Thread/Replies\n\n`;
				for (const reply of replies.slice(1, 10)) {
					const replyUser = reply.parentElement?.querySelector(".username")?.textContent?.trim();
					md += `**${replyUser || "@?"}**: ${reply.textContent?.trim()}\n\n`;
				}
			}

			return buildResult(md, {
				url,
				finalUrl: nitterUrl,
				method: "twitter-nitter",
				fetchedAt,
				notes: [`Via Nitter: ${instance}`],
			});
		} catch (error) {
			// This is the one place the `isAbortError` / `isCancellation` split is
			// load-bearing, so it is worth saying which one belongs here and why.
			//
			// The CALLER stopping us ends the walk: the user pressed Escape, or the
			// fetch tool's overall budget ran out, and no mirror can help with either.
			throwIfAborted(signal, "twitter");
			if (isAbortError(error)) throw error;
			// A per-instance DEADLINE does not end the walk, and this is the case the
			// broader `isCancellation` would get wrong. `loadPage` is called with
			// `Math.min(timeout, 10)`, a budget deliberately smaller than the caller's,
			// and its entire purpose is to bound one slow mirror so the other three
			// still get their turn. Its expiry is a fact about this mirror, not about
			// the operation, so it belongs in `attempts` alongside an HTTP 503.
			//
			// Under the old bare `catch {}` neither case worked: the try wrapped the
			// whole loop, so the first mirror to throw ended every remaining attempt,
			// and the handler still returned the "Nitter instances were unavailable"
			// message below as though it had tried them.
			attempts.push(`${instance}: ${errorMessage(error)}`);
		}
	}

	throwIfAborted(signal, "twitter");

	// Every instance was tried and none produced a tweet. X.com itself blocks
	// automated access, so returning a result here rather than null is deliberate:
	// it stops the generic fetch from making a request that is known to fail. The
	// per-instance reasons are included because the operator's next move depends on
	// them -- "all four timed out" is a transient network problem worth retrying,
	// "all four returned HTTP 429" is not, and the old fixed sentence claimed the
	// second regardless of which had happened.
	return {
		url,
		finalUrl: url,
		contentType: "text/plain",
		method: "twitter-blocked",
		content: [
			"Twitter/X blocks automated access, and no Nitter instance returned this tweet.",
			"",
			"Instances tried:",
			...attempts.map(attempt => `- ${attempt}`),
			"",
			"Try:",
			"- Opening the link in a browser",
			"- Using a different Nitter instance manually",
			"- Checking if the tweet is available via an archive service",
		].join("\n"),
		fetchedAt,
		truncated: false,
		notes: [`X.com blocks bots; ${attempts.length} Nitter instance(s) tried, none returned a tweet`],
	};
};
