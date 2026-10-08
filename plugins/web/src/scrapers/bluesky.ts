import { tryParseJson } from "@veyyon/utils";
import { markdownLink } from "../markdown-link";
import type { LoadPageResult, RenderResult, ScraperDegrade, SpecialHandler } from "./types";
import { buildResult, formatNumber, loadFailure, loadPage, scraperDegrade, tryParseUrl } from "./types";

const API_BASE = "https://public.api.bsky.app/xrpc";

interface BlueskyProfile {
	did: string;
	handle: string;
	displayName?: string;
	description?: string;
	avatar?: string;
	followersCount?: number;
	followsCount?: number;
	postsCount?: number;
	createdAt?: string;
}

interface BlueskyPost {
	uri: string;
	cid: string;
	author: BlueskyProfile;
	record: {
		text: string;
		createdAt: string;
		embed?: {
			$type: string;
			external?: { uri: string; title?: string; description?: string };
			images?: Array<{ alt?: string; image: unknown }>;
			record?: { uri: string };
		};
		facets?: Array<{
			features: Array<{ $type: string; uri?: string; tag?: string; did?: string }>;
			index: { byteStart: number; byteEnd: number };
		}>;
	};
	likeCount?: number;
	repostCount?: number;
	replyCount?: number;
	quoteCount?: number;
	embed?: BlueskyEmbedView;
}

/** The hydrated embed of a post: an external link card, images, or a quoted record. */
interface BlueskyEmbedView {
	$type: string;
	external?: { uri: string; title?: string; description?: string };
	images?: Array<{ alt?: string; fullsize?: string; thumb?: string }>;
	record?: { uri: string; value?: { text?: string }; author?: BlueskyProfile };
}

/** Embed view types that quote another record. */
const QUOTE_EMBED_TYPES = new Set(["app.bsky.embed.record#view", "app.bsky.embed.recordWithMedia#view"]);

/** Engagement counts in display order, each shown with its icon when non-zero. */
const POST_STATS = [
	["❤️", "likeCount"],
	["🔁", "repostCount"],
	["💬", "replyCount"],
	["📝", "quoteCount"],
] as const;

const BLUESKY_HOSTS = new Set(["bsky.app", "www.bsky.app"]);

/** Replies rendered under a post; the rest are dropped. */
const MAX_REPLIES = 10;

interface ThreadViewPost {
	post: BlueskyPost;
	parent?: ThreadViewPost | { $type: string };
	replies?: Array<ThreadViewPost | { $type: string }>;
}

function profileUrl(handle: string): string {
	return `${API_BASE}/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`;
}

function loadXrpc(url: string, timeout: number, signal: AbortSignal | undefined): Promise<LoadPageResult> {
	return loadPage(url, { timeout, headers: { Accept: "application/json" }, signal });
}

/**
 * Resolve a handle to DID using the profile API
 */
async function resolveHandle(handle: string, timeout: number, signal?: AbortSignal): Promise<string | null> {
	const result = await loadXrpc(profileUrl(handle), timeout, signal);
	if (!result.ok) return null;

	const data = tryParseJson<BlueskyProfile>(result.content);
	if (!data) return null;
	return data.did;
}

/** Each line of `text` as a markdown blockquote line. */
function blockquote(text: string): string {
	return text
		.split("\n")
		.map(line => `> ${line}`)
		.join("\n");
}

/**
 * Format a post as markdown: its author, date and text, then its embed. A
 * quoted post renders as a blockquote without counts; any other post ends
 * with its non-zero engagement counts.
 */
function formatPost(post: BlueskyPost, isQuote = false): string {
	const author = post.author;
	const name = author.displayName || author.handle;
	const handle = `@${author.handle}`;
	const date = new Date(post.record.createdAt).toLocaleString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});

	const body = isQuote
		? `> **${name}** (${handle}) - ${date}\n>\n${blockquote(post.record.text)}\n`
		: `**${name}** (${handle})\n*${date}*\n\n${post.record.text}\n`;
	const embed = post.embed ? formatEmbed(post.embed) : "";
	return body + embed + (isQuote ? "" : formatStats(post));
}

function formatEmbed(embed: BlueskyEmbedView): string {
	if (embed.$type === "app.bsky.embed.external#view" && embed.external) {
		const ext = embed.external;
		const description = ext.description ? `\n*${ext.description}*` : "";
		return `\n📎 ${markdownLink(ext.title || ext.uri, ext.uri)}${description}\n`;
	}
	if (embed.$type === "app.bsky.embed.images#view" && embed.images) {
		let md = `\n🖼️ ${embed.images.length} image(s)`;
		for (const img of embed.images) {
			if (img.alt) md += `\n- Alt: "${img.alt}"`;
		}
		return `${md}\n`;
	}
	const rec = embed.record;
	if (QUOTE_EMBED_TYPES.has(embed.$type) && rec?.value?.text && rec.author) {
		const author = `**${rec.author.displayName || rec.author.handle}** (@${rec.author.handle})`;
		return `\n**Quoted post:**\n> ${author}\n${blockquote(rec.value.text)}\n`;
	}
	return "";
}

function formatStats(post: BlueskyPost): string {
	const stats: string[] = [];
	for (const [icon, key] of POST_STATS) {
		const count = post[key];
		if (count) stats.push(`${icon} ${formatNumber(count)}`);
	}
	return stats.length > 0 ? `\n${stats.join(" • ")}\n` : "";
}

/**
 * Handle Bluesky post URLs
 */
export const handleBluesky: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | ScraperDegrade | null> => {
	try {
		const parsed = tryParseUrl(url);
		if (!parsed || !BLUESKY_HOSTS.has(parsed.hostname)) return null;

		// /profile/{handle} or /profile/{handle}/post/{rkey}; any other path on the host is not a match.
		const [section, handle, kind, rkey] = parsed.pathname.split("/").filter(Boolean);
		if (section !== "profile" || !handle) return null;

		const fetchedAt = new Date().toISOString();
		if (kind === "post" && rkey) return await renderPostThread(url, handle, rkey, fetchedAt, timeout, signal);
		return await renderProfile(url, handle, fetchedAt, timeout, signal);
	} catch (error) {
		return scraperDegrade("bluesky", error);
	}
};

/** The post at `rkey` by `handle`, with its parent above it and its first replies below. */
async function renderPostThread(
	url: string,
	handle: string,
	rkey: string,
	fetchedAt: string,
	timeout: number,
	signal: AbortSignal | undefined,
): Promise<RenderResult | ScraperDegrade | null> {
	const did = await resolveHandle(handle, timeout, signal);
	if (!did) return null;

	const atUri = `at://${did}/app.bsky.feed.post/${rkey}`;
	const threadUrl = `${API_BASE}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(atUri)}&depth=6&parentHeight=3`;
	const result = await loadXrpc(threadUrl, timeout, signal);
	if (!result.ok) return scraperDegrade("bluesky", loadFailure(result));

	const thread = (JSON.parse(result.content) as { thread: ThreadViewPost }).thread;
	if (!thread.post) return null;

	let md = `# Bluesky Post\n\n`;
	if (thread.parent && "post" in thread.parent) {
		md += `**Replying to:**\n${formatPost(thread.parent.post, true)}\n---\n\n`;
	}
	md += formatPost(thread.post);
	if (thread.replies?.length) {
		md += "\n---\n\n## Replies\n\n";
		const shown = thread.replies.filter((reply): reply is ThreadViewPost => "post" in reply).slice(0, MAX_REPLIES);
		for (const reply of shown) md += `${formatPost(reply.post)}\n---\n\n`;
	}

	return buildResult(md, { url, method: "bluesky-api", fetchedAt, notes: [`AT URI: ${atUri}`] });
}

async function renderProfile(
	url: string,
	handle: string,
	fetchedAt: string,
	timeout: number,
	signal: AbortSignal | undefined,
): Promise<RenderResult | ScraperDegrade> {
	const result = await loadXrpc(profileUrl(handle), timeout, signal);
	if (!result.ok) return scraperDegrade("bluesky", loadFailure(result));

	const profile = JSON.parse(result.content) as BlueskyProfile;

	let md = `# ${profile.displayName || profile.handle}\n\n**@${profile.handle}**\n\n`;
	if (profile.description) md += `${profile.description}\n\n`;
	md += "---\n\n";
	md += `- **Followers:** ${formatNumber(profile.followersCount || 0)}\n`;
	md += `- **Following:** ${formatNumber(profile.followsCount || 0)}\n`;
	md += `- **Posts:** ${formatNumber(profile.postsCount || 0)}\n`;
	if (profile.createdAt) {
		const joined = new Date(profile.createdAt).toLocaleDateString("en-US", {
			year: "numeric",
			month: "long",
			day: "numeric",
		});
		md += `- **Joined:** ${joined}\n`;
	}
	md += `\n**DID:** \`${profile.did}\`\n`;

	return buildResult(md, { url, method: "bluesky-api", fetchedAt, notes: ["Fetched via AT Protocol API"] });
}
