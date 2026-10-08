import { tryParseJson } from "@veyyon/utils";
import { throwIfCancelled } from "../abort";
import { markdownLink } from "../markdown-link";
import type { LoadPageResult, RenderResult, ScraperDegrade, SpecialHandler } from "./types";
import {
	buildResult,
	formatNumber,
	htmlToBasicMarkdown,
	loadFailure,
	loadPage,
	scraperDegrade,
	tryParseUrl,
} from "./types";

interface MastodonAccount {
	id: string;
	username: string;
	acct: string;
	display_name: string;
	note: string;
	url: string;
	avatar: string;
	header: string;
	followers_count: number;
	following_count: number;
	statuses_count: number;
	created_at: string;
	bot: boolean;
	fields?: Array<{ name: string; value: string }>;
}

interface MastodonMediaAttachment {
	id: string;
	type: "image" | "video" | "gifv" | "audio" | "unknown";
	url: string;
	preview_url?: string;
	description?: string;
}

interface MastodonStatus {
	id: string;
	created_at: string;
	content: string;
	url: string;
	account: MastodonAccount;
	reblogs_count: number;
	favourites_count: number;
	replies_count: number;
	reblog?: MastodonStatus;
	media_attachments: MastodonMediaAttachment[];
	spoiler_text?: string;
	sensitive: boolean;
	visibility: "public" | "unlisted" | "private" | "direct";
	in_reply_to_id?: string;
	poll?: {
		options: Array<{ title: string; votes_count: number }>;
		votes_count: number;
		expired: boolean;
	};
}

/**
 * Check if a domain is a Mastodon instance by probing the API
 */
async function isMastodonInstance(hostname: string, timeout: number, signal?: AbortSignal): Promise<boolean> {
	try {
		const result = await loadPage(`https://${hostname}/api/v1/instance`, {
			timeout: Math.min(timeout, 5),
			headers: { Accept: "application/json" },
			signal,
		});
		if (!result.ok) return false;
		const data = JSON.parse(result.content);
		// Mastodon instances return uri/domain field
		return !!(data.uri || data.domain || data.title);
	} catch {
		throwIfCancelled(signal);
		// This is a probe against an ARBITRARY host, so "not a Mastodon instance" arrives as a refused
		// connection, a timeout, an HTML error page that will not parse as JSON, or a 404 -- every one of
		// which is the answer rather than a swallowed failure. The caller falls back to fetching the page
		// normally, which is what a non-Mastodon host deserves.
		return false;
	}
}

/**
 * Format a date string to readable format
 */
function formatDate(isoDate: string): string {
	try {
		const date = new Date(isoDate);
		return date.toLocaleDateString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return isoDate;
	}
}

function renderMastodonPoll(poll: NonNullable<MastodonStatus["poll"]>): string {
	let md = "**Poll:**\n";
	for (const option of poll.options) {
		const pct = poll.votes_count > 0 ? ((option.votes_count / poll.votes_count) * 100).toFixed(1) : "0";
		md += `- ${option.title} (${pct}%, ${option.votes_count} votes)\n`;
	}
	return `${md}Total: ${poll.votes_count} votes${poll.expired ? " (closed)" : ""}\n\n`;
}

function renderMastodonAttachments(attachments: MastodonMediaAttachment[]): string {
	let md = "**Attachments:**\n";
	for (const media of attachments) {
		const desc = media.description ? ` - ${media.description}` : "";
		md += `- ${markdownLink(media.type, media.url)}${desc}\n`;
	}
	return `${md}\n`;
}

/** The author line: handle, bot marker, date, and the visibility when it is not public. */
function renderMastodonByline(status: MastodonStatus): string {
	const { account } = status;
	const bot = account.bot ? " 🤖" : "";
	const visibility = status.visibility !== "public" ? ` · ${status.visibility}` : "";
	return `**@${account.acct}**${bot} · ${formatDate(status.created_at)}${visibility}\n\n`;
}

/**
 * Format a status/post as markdown
 */
async function formatStatus(status: MastodonStatus, isReblog = false): Promise<string> {
	// Handle reblogs (boosts)
	if (status.reblog && !isReblog) {
		const booster = status.account.display_name || status.account.username;
		return `🔁 **${booster}** boosted:\n\n${await formatStatus(status.reblog, true)}`;
	}

	const account = status.account;
	let md = isReblog ? "" : `# Post by ${account.display_name || account.username}\n\n`;
	md += renderMastodonByline(status);
	if (status.spoiler_text) md += `> ⚠️ **CW:** ${status.spoiler_text}\n\n`;
	md += `${await htmlToBasicMarkdown(status.content)}\n\n`;
	if (status.poll) md += renderMastodonPoll(status.poll);
	if (status.media_attachments.length > 0) md += renderMastodonAttachments(status.media_attachments);

	md += `---\n`;
	md += `💬 ${formatNumber(status.replies_count)} replies · `;
	md += `🔁 ${formatNumber(status.reblogs_count)} boosts · `;
	md += `⭐ ${formatNumber(status.favourites_count)} favorites\n`;
	return md;
}

/**
 * Format an account/profile as markdown
 */
async function formatAccount(account: MastodonAccount): Promise<string> {
	let md = `# ${account.display_name || account.username}\n\n`;

	md += `**@${account.acct}**`;
	if (account.bot) md += " 🤖 Bot";
	md += "\n\n";

	// Bio
	if (account.note) {
		const bio = await htmlToBasicMarkdown(account.note);
		if (bio && bio !== account.display_name) {
			md += `${bio}\n\n`;
		}
	}

	// Stats
	md += `**Followers:** ${formatNumber(account.followers_count)} · `;
	md += `**Following:** ${formatNumber(account.following_count)} · `;
	md += `**Posts:** ${formatNumber(account.statuses_count)}\n\n`;

	md += `**Joined:** ${formatDate(account.created_at)}\n`;
	md += `**Profile:** ${account.url}\n`;

	// Profile fields (links, pronouns, etc.)
	if (account.fields && account.fields.length > 0) {
		md += "\n**Profile Fields:**\n";
		for (const field of account.fields) {
			const value = await htmlToBasicMarkdown(field.value);
			md += `- **${field.name}:** ${value}\n`;
		}
	}

	return md;
}

interface MastodonRequest {
	url: string;
	instance: string;
	timeout: number;
	signal?: AbortSignal;
	fetchedAt: string;
}

function loadMastodonJson(apiUrl: string, request: MastodonRequest) {
	return loadPage(apiUrl, {
		timeout: request.timeout,
		headers: { Accept: "application/json" },
		signal: request.signal,
	});
}

function mastodonResult(md: string, finalUrl: string | undefined, request: MastodonRequest): RenderResult {
	return buildResult(md, {
		url: request.url,
		finalUrl: finalUrl || request.url,
		method: "mastodon",
		fetchedAt: request.fetchedAt,
		notes: [`Fetched via Mastodon API (${request.instance})`],
	});
}

async function renderMastodonPost(statusId: string, request: MastodonRequest): Promise<RenderResult | ScraperDegrade> {
	const result = await loadMastodonJson(`https://${request.instance}/api/v1/statuses/${statusId}`, request);
	if (!result.ok) return scraperDegrade("mastodon", loadFailure(result));
	const status = tryParseJson<MastodonStatus>(result.content);
	if (!status) return scraperDegrade("mastodon", "unexpected status response shape");
	return mastodonResult(await formatStatus(status), status.url, request);
}

/** Markdown for the account's recent posts; empty when the statuses request failed or listed none. */
async function renderMastodonRecentPosts(statusesResult: LoadPageResult): Promise<string> {
	if (!statusesResult.ok) return "";
	const statuses = tryParseJson<MastodonStatus[]>(statusesResult.content);
	if (!statuses || !(statuses.length > 0)) return "";
	let md = "\n---\n\n## Recent Posts\n\n";
	for (const status of statuses.slice(0, 5)) {
		md += `### ${formatDate(status.created_at)}\n\n`;
		md += `${await htmlToBasicMarkdown(status.content)}\n\n`;
		md += `💬 ${status.replies_count} · 🔁 ${status.reblogs_count} · ⭐ ${status.favourites_count}\n\n`;
	}
	return md;
}

async function renderMastodonProfile(
	username: string,
	request: MastodonRequest,
): Promise<RenderResult | ScraperDegrade> {
	const lookupUrl = `https://${request.instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(username)}`;
	const result = await loadMastodonJson(lookupUrl, request);
	if (!result.ok) return scraperDegrade("mastodon", loadFailure(result));
	const account = tryParseJson<MastodonAccount>(result.content);
	if (!account) return scraperDegrade("mastodon", "unexpected account response shape");
	// The five most recent posts, replies excluded, load before the account renders.
	const statusesUrl = `https://${request.instance}/api/v1/accounts/${account.id}/statuses?limit=5&exclude_replies=true`;
	const statusesResult = await loadMastodonJson(statusesUrl, request);
	const md = await formatAccount(account);
	return mastodonResult(md + (await renderMastodonRecentPosts(statusesResult)), account.url, request);
}

/**
 * Handle Mastodon/Fediverse URLs
 */
export const handleMastodon: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | ScraperDegrade | null> => {
	try {
		const parsed = tryParseUrl(url);
		if (!parsed) return null;

		// Check for @user/postid or @user pattern
		const postMatch = parsed.pathname.match(/^\/@([^/]+)\/(\d+)$/);
		const profileMatch = parsed.pathname.match(/^\/@([^/]+)$/);
		if (!postMatch && !profileMatch) return null;

		// Verify this is a Mastodon instance
		if (!(await isMastodonInstance(parsed.hostname, timeout, signal))) return null;

		const request: MastodonRequest = {
			url,
			instance: parsed.hostname,
			timeout,
			signal,
			fetchedAt: new Date().toISOString(),
		};
		if (postMatch) return await renderMastodonPost(postMatch[2], request);
		if (profileMatch) return await renderMastodonProfile(profileMatch[1], request);
	} catch (error) {
		// Reached only after the instance probe confirmed a Mastodon server, so
		// a throw here is a real scrape failure, not a non-match.
		return scraperDegrade("mastodon", error);
	}

	return null;
};
