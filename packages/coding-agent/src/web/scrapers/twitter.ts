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
	const attempts: string[] = [];

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
			const { parseHTML } = await import("linkedom");
			const doc = parseHTML(result.content).document;

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
			throwIfAborted(signal, "twitter");
			if (isAbortError(error)) throw error;
			attempts.push(`${instance}: ${errorMessage(error)}`);
		}
	}

	throwIfAborted(signal, "twitter");

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
