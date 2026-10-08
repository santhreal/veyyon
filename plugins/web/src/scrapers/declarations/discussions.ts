import { trimTrailingSlashes } from "@veyyon/utils/url";
import { markdownLink } from "../../markdown-link";
import type { DiscussionContext, DiscussionDeclaration, DiscussionMatch } from "../engine/discussion";
import { buildResult, decodeHtmlEntities, formatIsoDate, formatNumber, htmlToBasicMarkdown } from "../types";

// =============================================================================
// Hacker News Helper & Declaration
// =============================================================================

export function decodeHNText(html: string): string {
	return decodeHtmlEntities(
		html
			.replace(/<p>/g, "\n\n")
			.replace(/<\/p>/g, "")
			.replace(/<pre><code>/g, "\n```\n")
			.replace(/<\/code><\/pre>/g, "\n```\n")
			.replace(/<code>/g, "`")
			.replace(/<\/code>/g, "`")
			.replace(/<i>/g, "*")
			.replace(/<\/i>/g, "*")
			// HN comment anchors carry arbitrary hrefs and label text. Route both halves
			// through markdownLink so links stay whole and withstand trailing entity decode.
			.replace(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g, (_m, href, text) => markdownLink(text, href))
			.replace(/<[^>]+>/g, ""),
	).trim();
}

function formatHNTimestamp(unixTime: number): string {
	const date = new Date(unixTime * 1000);
	const now = Date.now();
	const diff = now - date.getTime();
	const hours = Math.floor(diff / (1000 * 60 * 60));
	const days = Math.floor(hours / 24);

	if (days > 7) return formatIsoDate(unixTime * 1000);
	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	const minutes = Math.floor(diff / (1000 * 60));
	return `${minutes}m ago`;
}

interface HNItem {
	id: number;
	deleted?: boolean;
	type?: "job" | "story" | "comment" | "poll" | "pollopt";
	by?: string;
	time?: number;
	text?: string;
	dead?: boolean;
	parent?: number;
	poll?: number;
	kids?: number[];
	url?: string;
	score?: number;
	title?: string;
	parts?: number[];
	descendants?: number;
}

const HN_API_BASE = "https://hacker-news.firebaseio.com/v0";

async function fetchHNItem(id: number, ctx: DiscussionContext): Promise<HNItem | null> {
	const url = `${HN_API_BASE}/item/${id}.json`;
	const { content, ok } = await ctx.loadPage(url, { timeout: ctx.timeout, signal: ctx.signal });
	if (!ok) return null;
	return ctx.tryParseJson<HNItem>(content);
}

async function fetchHNItems(ids: number[], ctx: DiscussionContext, limit = 20): Promise<HNItem[]> {
	const promises = ids.slice(0, limit).map(id => fetchHNItem(id, ctx));
	const results = await Promise.all(promises);
	return results.filter((item): item is HNItem => item !== null && !item.deleted && !item.dead);
}

/** Up to 20 replies to the story and 10 under each of them, the second level indented. */
async function renderHNComments(kids: number[], ctx: DiscussionContext, depth: number): Promise<string> {
	const comments = await fetchHNItems(kids, ctx, depth === 0 ? 20 : 10);
	const indent = "  ".repeat(depth);
	let output = "";
	for (const comment of comments) {
		output += `${indent}**${comment.by}** (${formatHNTimestamp(comment.time ?? 0)})`;
		if (comment.score !== undefined) output += ` [${comment.score}]`;
		output += "\n";
		if (comment.text) {
			const lines = decodeHNText(comment.text).split("\n");
			output += `${lines.map(line => `${indent}${line}`).join("\n")}\n\n`;
		}
		if (depth === 0 && comment.kids?.length) output += await renderHNComments(comment.kids, ctx, 1);
	}
	return output;
}

async function renderHNStory(item: HNItem, ctx: DiscussionContext): Promise<string> {
	let output = `# ${item.title}\n\n`;
	if (item.url) output += `**URL:** ${item.url}\n\n`;
	output += `**Posted by:** ${item.by} | **Score:** ${item.score ?? 0} | **Time:** ${formatHNTimestamp(item.time ?? 0)}`;
	if (item.descendants) output += ` | **Comments:** ${item.descendants}`;
	output += "\n\n";
	if (item.text) output += `${decodeHNText(item.text)}\n\n`;
	const comments = item.kids?.length ? await renderHNComments(item.kids, ctx, 0) : "";
	return comments ? `${output}---\n\n## Comments\n\n${comments}` : output;
}

async function renderHNListing(ids: number[], ctx: DiscussionContext, title: string): Promise<string> {
	let output = `# ${title}\n\n`;
	const stories = await fetchHNItems(ids, ctx, 20);

	for (let i = 0; i < stories.length; i++) {
		const story = stories[i];
		output += `${i + 1}. **${story.title}**\n`;
		if (story.url) {
			output += `   ${story.url}\n`;
		}
		output += `   ${story.score ?? 0} points by ${story.by} | ${formatHNTimestamp(story.time ?? 0)}`;
		if (story.descendants) {
			output += ` | ${story.descendants} comments`;
		}
		output += `\n   https://news.ycombinator.com/item?id=${story.id}\n\n`;
	}

	return output;
}

const HN_LISTING_CONFIG: Record<string, { endpoint: string; label: string; title: string; note: string }> = {
	top: {
		endpoint: "topstories",
		label: "top stories",
		title: "Hacker News - Top Stories",
		note: "Fetched top 20 stories from HN front page",
	},
	newest: {
		endpoint: "newstories",
		label: "new stories",
		title: "Hacker News - New Stories",
		note: "Fetched top 20 new stories",
	},
	best: {
		endpoint: "beststories",
		label: "best stories",
		title: "Hacker News - Best Stories",
		note: "Fetched top 20 best stories",
	},
};

export const hackerNewsDeclaration: DiscussionDeclaration = {
	site: "hackernews",
	method: "hackernews",
	hosts: ["news.ycombinator.com"],
	canonicalUrls: ["https://news.ycombinator.com/item?id=38888888"],
	match: parsed => {
		if (!parsed.hostname.includes("news.ycombinator.com")) return null;
		const itemId = parsed.searchParams.get("id");
		if (itemId) {
			return { id: itemId, kind: "item", parsedUrl: parsed };
		}
		if (parsed.pathname === "/" || parsed.pathname === "/news") {
			return { id: "top", kind: "top", parsedUrl: parsed };
		}
		if (parsed.pathname === "/newest") {
			return { id: "newest", kind: "newest", parsedUrl: parsed };
		}
		if (parsed.pathname === "/best") {
			return { id: "best", kind: "best", parsedUrl: parsed };
		}
		return null;
	},
	notes: ["Fetched via Hacker News Firebase API"],
	fetch: async (match, ctx) => {
		const notes: string[] = [];
		let content = "";

		if (match.kind === "item") {
			const itemId = Number.parseInt(match.id, 10);
			const item = await fetchHNItem(itemId, ctx);
			if (!item) return ctx.scraperDegrade("hackernews", `Failed to fetch item ${match.id}`);

			content = await renderHNStory(item, ctx);
			notes.push(`Fetched HN item ${match.id} with top-level comments (depth 2)`);
		} else {
			const listingCfg = HN_LISTING_CONFIG[match.kind ?? ""];
			if (listingCfg) {
				const { content: raw, ok } = await ctx.loadPage(`${HN_API_BASE}/${listingCfg.endpoint}.json`, {
					timeout: ctx.timeout,
					signal: ctx.signal,
				});
				if (!ok) return ctx.scraperDegrade("hackernews", `Failed to fetch ${listingCfg.label}`);
				const ids = ctx.tryParseJson<number[]>(raw);
				if (!ids) return ctx.scraperDegrade("hackernews", `Failed to parse ${listingCfg.label}`);
				content = await renderHNListing(ids, ctx, listingCfg.title);
				notes.push(listingCfg.note);
			} else {
				return null;
			}
		}

		return buildResult(content, {
			url: ctx.url,
			method: "hackernews",
			fetchedAt: ctx.fetchedAt,
			notes,
		});
	},
};

// =============================================================================
// Reddit Types & Declaration
// =============================================================================

interface RedditPost {
	title: string;
	selftext?: string;
	author: string;
	score: number;
	num_comments: number;
	created_utc: number;
	subreddit: string;
	url: string;
	is_self: boolean;
}

interface RedditComment {
	body: string;
	author: string;
	score: number;
	created_utc?: number;
}

interface RedditListing<T> {
	data?: {
		children?: { kind: string; data: T }[];
	};
}

/** A post page: the post as a one-item listing, then its comments. */
type RedditPostPage = [RedditListing<RedditPost>?, RedditListing<RedditComment>?];

function redditJsonUrl(url: string, search: string): string {
	const base = url.replace(/\/$/, "");
	return search ? `${base.replace(search, "")}.json${search}` : `${base}.json`;
}

function renderRedditPost(page: RedditPostPage): string {
	const post = page[0]?.data?.children?.[0]?.data;
	if (!post) return "";
	let md = `# ${post.title}\n\n`;
	md += `**r/${post.subreddit}** · u/${post.author} · ${post.score} points · ${post.num_comments} comments\n`;
	md += `*${formatIsoDate(post.created_utc * 1000)}*\n\n`;
	if (!post.is_self) md += `**Link:** ${post.url}\n\n`;
	else if (post.selftext) md += `---\n\n${post.selftext}\n\n`;

	const children = page[1]?.data?.children;
	if (!children) return md;
	md += `---\n\n## Top Comments\n\n`;
	for (const { data: comment } of children.filter(child => child.kind === "t1").slice(0, 10)) {
		md += `### u/${comment.author} · ${comment.score} points\n\n${comment.body}\n\n---\n\n`;
	}
	return md;
}

function renderRedditListing(listing: RedditListing<RedditPost>): string {
	const children = listing.data?.children;
	if (!children) return "";
	const posts = children.slice(0, 20);
	let md = `# r/${posts[0]?.data?.subreddit || "Reddit"}\n\n`;
	for (const { data: post } of posts) {
		md += `- **${post.title}** (${post.score} pts, ${post.num_comments} comments)\n  by u/${post.author}\n\n`;
	}
	return md;
}

export const redditDeclaration: DiscussionDeclaration = {
	site: "reddit",
	method: "reddit",
	hosts: ["reddit.com", "www.reddit.com", "old.reddit.com"],
	canonicalUrls: ["https://www.reddit.com/r/programming/comments/12345/test/"],
	match: parsed => {
		if (!parsed.hostname.includes("reddit.com")) return null;
		return { id: parsed.pathname, parsedUrl: parsed };
	},
	notes: ["Fetched via Reddit JSON API"],
	fetch: async (match, ctx) => {
		const jsonUrl = redditJsonUrl(ctx.url, match.parsedUrl.search);
		const result = await ctx.loadPage(jsonUrl, { timeout: ctx.timeout, signal: ctx.signal });
		if (!result.ok) return ctx.scraperDegrade("reddit", ctx.loadFailure(result));
		const data = ctx.tryParseJson<RedditPostPage | RedditListing<RedditPost>>(result.content);
		if (!data) return ctx.scraperDegrade("reddit", "unexpected response shape");

		const md = Array.isArray(data) ? renderRedditPost(data) : renderRedditListing(data);
		if (!md) return null;
		return buildResult(md, {
			url: ctx.url,
			method: "reddit",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Reddit JSON API"],
		});
	},
};

// =============================================================================
// Lobste.rs Types & Declaration
// =============================================================================

interface LobstersStory {
	short_id: string;
	title: string;
	url?: string;
	/** The text post as HTML. */
	description?: string;
	/** The text post as its author wrote it, in Markdown. */
	description_plain?: string;
	submitter_user: string;
	score: number;
	comment_count: number;
	created_at: string;
	tags: string[];
}

/** One entry of the flat, depth-first comment list a story record returns. */
interface LobstersComment {
	short_id: string;
	/** The comment as HTML. */
	comment: string;
	/** The comment as its author wrote it, in Markdown. */
	comment_plain?: string;
	commenting_user: string;
	score: number;
	created_at: string;
	/** 0 for a reply to the story, one more for each level of reply below it. */
	depth: number;
}

interface LobstersStoryResponse extends LobstersStory {
	comments: LobstersComment[];
}

function renderLobstersComments(comments: LobstersComment[], maxDepth = 5): string {
	let md = "";
	for (const comment of comments) {
		if (comment.depth >= maxDepth) continue;
		const indent = "  ".repeat(comment.depth);
		const body = (comment.comment_plain ?? "").split("\n").join(`\n${indent}`);
		md += `${indent}### ${comment.commenting_user} · ${comment.score} points\n\n`;
		md += `${indent}${body}\n\n${indent}---\n\n`;
	}
	return md;
}

function renderLobstersStory(story: LobstersStoryResponse): string {
	let md = `# ${story.title}\n\n`;
	md += `**${story.submitter_user}** · ${story.score} points · ${story.comment_count} comments`;
	if (story.tags?.length > 0) md += ` · [${story.tags.join(", ")}]`;
	md += `\n*${formatIsoDate(story.created_at)}*\n\n`;
	if (story.url) md += `**Link:** ${story.url}\n\n`;
	if (story.description_plain) md += `---\n\n${story.description_plain}\n\n`;
	if (story.comments?.length > 0) md += `---\n\n## Comments\n\n${renderLobstersComments(story.comments)}`;
	return md;
}

function renderLobstersListing(stories: LobstersStory[], title: string): string {
	let md = `# ${title}\n\n`;
	for (const story of stories.slice(0, 20)) {
		md += `- **${story.title}** (${story.score} pts, ${story.comment_count} comments)\n  by ${story.submitter_user}`;
		if (story.tags?.length > 0) md += ` · [${story.tags.join(", ")}]`;
		md += "\n";
		if (story.url) md += `  ${story.url}\n`;
		md += `  https://lobste.rs/s/${story.short_id}\n\n`;
	}
	return md;
}

/** The JSON feed and heading for the front page, the newest page, or a tag page. */
function lobstersListing(pathname: string): { jsonUrl: string; title: string } | null {
	if (pathname === "/") return { jsonUrl: "https://lobste.rs/hottest.json", title: "Lobste.rs Front Page" };
	if (pathname === "/newest") return { jsonUrl: "https://lobste.rs/newest.json", title: "Lobste.rs Newest" };
	const tag = pathname.match(/^\/t\/([^/]+)/)?.[1];
	return tag ? { jsonUrl: `https://lobste.rs/t/${tag}.json`, title: `Lobste.rs Tag: ${tag}` } : null;
}

async function fetchLobstersRecord<T>(jsonUrl: string, ctx: DiscussionContext, render: (record: T) => string) {
	const result = await ctx.loadPage(jsonUrl, { timeout: ctx.timeout, signal: ctx.signal });
	if (!result.ok) return ctx.scraperDegrade("lobsters", ctx.loadFailure(result));
	const record = ctx.tryParseJson<T>(result.content);
	if (!record) return ctx.scraperDegrade("lobsters", "unexpected response shape");
	return buildResult(render(record), {
		url: ctx.url,
		finalUrl: jsonUrl,
		method: "lobsters",
		fetchedAt: ctx.fetchedAt,
		notes: ["Fetched via Lobste.rs JSON API"],
	});
}

export const lobstersDeclaration: DiscussionDeclaration = {
	site: "lobsters",
	method: "lobsters",
	hosts: ["lobste.rs"],
	canonicalUrls: ["https://lobste.rs/s/123456/test_story"],
	match: parsed => {
		if (!parsed.hostname.includes("lobste.rs")) return null;
		const storyMatch = parsed.pathname.match(/^\/s\/([^/]+)/);
		if (storyMatch) return { id: storyMatch[1], kind: "story", parsedUrl: parsed };
		if (parsed.pathname === "/" || parsed.pathname === "/newest" || parsed.pathname.startsWith("/t/")) {
			return { id: parsed.pathname, kind: "listing", parsedUrl: parsed };
		}
		return null;
	},
	notes: ["Fetched via Lobste.rs JSON API"],
	fetch: async (match, ctx) => {
		if (match.kind === "story") {
			return fetchLobstersRecord(`https://lobste.rs/s/${match.id}.json`, ctx, renderLobstersStory);
		}
		const listing = match.kind === "listing" ? lobstersListing(match.parsedUrl.pathname) : null;
		if (!listing) return null;
		return fetchLobstersRecord<LobstersStory[]>(listing.jsonUrl, ctx, stories =>
			renderLobstersListing(stories, listing.title),
		);
	},
};

// =============================================================================
// Lemmy Types & Declaration
// =============================================================================

interface LemmyCreator {
	name: string;
	actor_id?: string;
}

interface LemmyCommunity {
	name: string;
	actor_id?: string;
}

interface LemmyCounts {
	score: number;
	comments?: number;
}

interface LemmyPost {
	id: number;
	name: string;
	body?: string;
	url?: string;
}

interface LemmyPostView {
	post: LemmyPost;
	creator: LemmyCreator;
	community: LemmyCommunity;
	counts: LemmyCounts;
}

interface LemmyPostResponse {
	post_view?: LemmyPostView;
}

interface LemmyComment {
	id: number;
	content?: string;
	/** Ancestry as dot-delimited ids, `0.<root id>.<…>.<own id>`; the next-to-last id is the parent comment. */
	path?: string;
	post_id?: number;
}

interface LemmyCommentView {
	comment: LemmyComment;
	creator: LemmyCreator;
	counts: LemmyCounts;
}

interface LemmyCommentListResponse {
	comments?: LemmyCommentView[];
}

interface LemmyCommentResponse {
	comment_view?: LemmyCommentView;
}

function formatLemmyCommunity(community: LemmyCommunity): string {
	if (community.actor_id) {
		try {
			const host = new URL(community.actor_id).hostname;
			return `!${community.name}@${host}`;
		} catch {
			// A federated actor id that is not a URL just loses its host suffix.
		}
	}
	return `!${community.name}`;
}

function formatLemmyAuthor(creator: LemmyCreator): string {
	if (creator.actor_id) {
		try {
			const host = new URL(creator.actor_id).hostname;
			return `@${creator.name}@${host}`;
		} catch {
			// As above: no host suffix when the actor id is not a URL.
		}
	}
	return creator.name;
}

function renderLemmyComments(comments: LemmyCommentView[]): string {
	const childrenByParent = new Map<number, LemmyCommentView[]>();
	const commentIds = new Set(comments.map(view => view.comment.id));

	for (const commentView of comments) {
		// A reply to the post has `0` as its next-to-last id, which is no comment's id.
		const parentId = Number(commentView.comment.path?.split(".").at(-2));
		const resolvedParent = commentIds.has(parentId) ? parentId : 0;
		const list = childrenByParent.get(resolvedParent);
		if (list) {
			list.push(commentView);
		} else {
			childrenByParent.set(resolvedParent, [commentView]);
		}
	}

	const renderThread = (parentId: number, depth: number): string => {
		const items = childrenByParent.get(parentId) ?? [];
		let output = "";

		for (const view of items) {
			const author = view.creator?.name ? formatLemmyAuthor(view.creator) : "unknown";
			const score = view.counts?.score ?? 0;
			const content = (view.comment.content ?? "").trim();
			const indent = "  ".repeat(depth);

			output += `${indent}- **${author}** · ${score} points\n`;
			if (content) {
				output += `${content
					.split("\n")
					.map(line => `${indent}  ${line}`)
					.join("\n")}\n`;
			}

			output += renderThread(view.comment.id, depth + 1);
			output += "\n";
		}

		return output;
	};

	return renderThread(0, 0).trim();
}

/** The id of the post a comment URL points into, or `null` when the comment does not resolve. */
async function lemmyPostIdOfComment(baseUrl: string, commentId: string, ctx: DiscussionContext) {
	const result = await ctx.loadPage(`${baseUrl}/api/v3/comment?id=${commentId}`, {
		timeout: ctx.timeout,
		signal: ctx.signal,
	});
	if (!result.ok) return null;
	return ctx.tryParseJson<LemmyCommentResponse>(result.content)?.comment_view?.comment?.post_id || null;
}

function renderLemmyPost(postView: LemmyPostView, comments: LemmyCommentView[]): string {
	const { post, counts } = postView;
	let md = `# ${post.name}\n\n`;
	md += `**Community:** ${formatLemmyCommunity(postView.community)} · **Author:** ${formatLemmyAuthor(postView.creator)}`;
	md += ` · **Score:** ${counts?.score ?? 0} · **Comments:** ${counts?.comments ?? comments.length}\n`;
	if (post.url) md += `**Link:** ${post.url}\n`;
	md += "\n";
	if (post.body) md += `---\n\n${post.body}\n\n`;
	const threadedComments = comments.length > 0 ? renderLemmyComments(comments) : "";
	if (threadedComments) md += `---\n\n## Comments\n\n${threadedComments}\n`;
	return md;
}

export const lemmyDeclaration: DiscussionDeclaration = {
	site: "lemmy",
	method: "lemmy-api",
	hosts: ["lemmy.world", "lemmy.ml", "hexbear.net", "sh.itjust.works", "feddit.de"],
	canonicalUrls: ["https://lemmy.world/post/12345"],
	match: parsed => {
		const match = parsed.pathname.match(/^\/(post|comment)\/(\d+)/);
		if (!match) return null;
		const id = Number.parseInt(match[2], 10);
		if (!Number.isFinite(id)) return null;
		return { id: String(id), kind: match[1], parsedUrl: parsed };
	},
	notes: ["Fetched via Lemmy API"],
	fetch: async (match, ctx) => {
		const baseUrl = match.parsedUrl.origin;
		const postId =
			match.kind === "comment" ? await lemmyPostIdOfComment(baseUrl, match.id, ctx) : Number.parseInt(match.id, 10);
		if (postId === null) return null;

		const [postResult, commentsResult] = await Promise.all([
			ctx.loadPage(`${baseUrl}/api/v3/post?id=${postId}`, { timeout: ctx.timeout, signal: ctx.signal }),
			ctx.loadPage(`${baseUrl}/api/v3/comment/list?post_id=${postId}`, { timeout: ctx.timeout, signal: ctx.signal }),
		]);
		if (!postResult.ok || !commentsResult.ok) return null;

		const postView = ctx.tryParseJson<LemmyPostResponse>(postResult.content)?.post_view;
		if (!postView) return null;
		const comments = ctx.tryParseJson<LemmyCommentListResponse>(commentsResult.content)?.comments ?? [];

		return buildResult(renderLemmyPost(postView, comments), {
			url: ctx.url,
			method: "lemmy-api",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Lemmy API"],
		});
	},
};

// =============================================================================
// Discourse Types & Declaration
// =============================================================================

interface DiscourseUser {
	username?: string;
	name?: string;
}

interface DiscoursePost {
	id: number;
	username?: string;
	name?: string;
	created_at?: string;
	cooked?: string;
	raw?: string;
	/** Absent on current releases, which report likes in `actions_summary`. */
	like_count?: number;
	/** Per-action totals; the like total is the entry whose id is {@link DISCOURSE_LIKE_ACTION_ID}. */
	actions_summary?: { id: number; count?: number }[];
	post_number?: number;
}

interface DiscoursePostResponse extends DiscoursePost {
	topic_id?: number;
}

interface DiscourseTopic {
	id?: number;
	title?: string;
	fancy_title?: string;
	posts_count?: number;
	created_at?: string;
	views?: number;
	like_count?: number;
	/** Tag names on older releases, tag records on current ones. */
	tags?: (string | { name: string })[];
	category_id?: number;
	category_slug?: string;
	category?: { id?: number; name?: string; slug?: string };
	excerpt?: string;
	details?: { created_by?: DiscourseUser };
	post_stream?: { posts?: DiscoursePost[] };
}

const MAX_DISCOURSE_POSTS = 20;
const DISCOURSE_LIKE_ACTION_ID = 2;

function parseDiscourseTopicPath(pathname: string): { basePath: string; topicId: string } | null {
	const match = pathname.match(/^(.*?)(?:\/t\/)(?:[^/]+\/)?(\d+)(?:\.json)?(?:\/|$)/);
	if (!match) return null;
	return { basePath: match[1] ?? "", topicId: match[2] };
}

function parseDiscoursePostPath(pathname: string): { basePath: string; postId: string } | null {
	const match = pathname.match(/^(.*?)(?:\/posts\/)(\d+)(?:\.json)?(?:\/|$)/);
	if (!match) return null;
	return { basePath: match[1] ?? "", postId: match[2] };
}

function formatDiscourseAuthor(user?: DiscourseUser | null): string {
	if (!user) return "unknown";
	const name = user.name?.trim();
	const username = user.username?.trim();
	if (name && username && name !== username) return `${name} (@${username})`;
	if (username) return `@${username}`;
	if (name) return name;
	return "unknown";
}

function formatDiscourseCategory(topic: DiscourseTopic): string | null {
	const parts: string[] = [];
	const name = topic.category?.name ?? topic.category_slug;
	if (name) parts.push(name);
	const id = topic.category?.id ?? topic.category_id;
	if (id != null) parts.push(`#${id}`);
	return parts.length ? parts.join(" ") : null;
}

async function formatDiscoursePostBody(post: DiscoursePost): Promise<string> {
	const raw = post.raw?.trim();
	if (raw) return raw;
	const cooked = post.cooked?.trim();
	if (!cooked) return "";
	return await htmlToBasicMarkdown(cooked);
}

const DISCOURSE_TOPIC_COUNTS: [label: string, key: "id" | "posts_count" | "views" | "like_count"][] = [
	["Topic ID", "id"],
	["Posts", "posts_count"],
	["Views", "views"],
	["Likes", "like_count"],
];

function renderDiscourseTopicHeader(topic: DiscourseTopic): string {
	const counts = DISCOURSE_TOPIC_COUNTS.filter(([, key]) => topic[key] != null).map(
		([label, key]) => `**${label}:** ${topic[key]}`,
	);
	let md = counts.length ? `${counts.join(" | ")}\n` : "";
	const categoryLabel = formatDiscourseCategory(topic);
	if (categoryLabel) md += `**Category:** ${categoryLabel}\n`;
	if (topic.tags?.length) {
		md += `**Tags:** ${topic.tags.map(tag => (typeof tag === "string" ? tag : tag.name)).join(", ")}\n`;
	}
	const createdBy = formatDiscourseAuthor(topic.details?.created_by ?? null);
	if (createdBy !== "unknown" || topic.created_at) {
		md += `**Created by:** ${createdBy} - ${formatIsoDate(topic.created_at)}\n`;
	}
	return md;
}

async function renderDiscoursePost(post: DiscoursePost): Promise<string> {
	const author = formatDiscourseAuthor({ name: post.name, username: post.username });
	const likes =
		post.like_count ?? post.actions_summary?.find(action => action.id === DISCOURSE_LIKE_ACTION_ID)?.count ?? 0;
	const content = await formatDiscoursePostBody(post);
	const heading = `### Post ${post.post_number ?? post.id} - ${author} - ${formatIsoDate(post.created_at)} - Likes: ${likes}`;
	return `${heading}\n\n${content || "_No content available._"}\n\n---\n\n`;
}

async function renderDiscourseTopic(topic: DiscourseTopic, title: string, posts: DiscoursePost[]): Promise<string> {
	let md = `# ${title}\n\n${renderDiscourseTopicHeader(topic)}\n`;
	const description = topic.excerpt
		? await htmlToBasicMarkdown(topic.excerpt)
		: posts.length
			? await formatDiscoursePostBody(posts[0])
			: "";
	if (description) md += `## Description\n\n${description}\n\n`;
	if (!posts.length) return md;
	md += "## Posts\n\n";
	for (const post of posts.slice(0, MAX_DISCOURSE_POSTS)) md += await renderDiscoursePost(post);
	return md;
}

/** The topic a URL names and, for a post URL, the post itself, which the topic page may not include. */
async function resolveDiscourseTopic(
	match: DiscussionMatch,
	baseUrl: string,
	ctx: DiscussionContext,
): Promise<{ topicId: string; requestedPost: DiscoursePost | null } | null> {
	if (match.kind === "topic") return { topicId: match.id, requestedPost: null };
	if (match.kind !== "post") return null;
	const postResult = await ctx.loadPage(`${baseUrl}/posts/${match.id}.json?include_raw=1`, {
		timeout: ctx.timeout,
		signal: ctx.signal,
	});
	const post = ctx.tryParseJson<DiscoursePostResponse>(postResult.content);
	return post?.topic_id ? { topicId: String(post.topic_id), requestedPost: post } : null;
}

export const discourseDeclaration: DiscussionDeclaration = {
	site: "discourse",
	method: "discourse-api",
	hosts: ["*.discourse.group", "*.discourse.org", "meta.discourse.org"],
	canonicalUrls: ["https://meta.discourse.org/t/topic-title/12345"],
	match: parsed => {
		const topicMatch = parseDiscourseTopicPath(parsed.pathname);
		const postMatch = topicMatch ? null : parseDiscoursePostPath(parsed.pathname);
		if (!topicMatch && !postMatch) return null;
		return {
			id: topicMatch?.topicId ?? postMatch!.postId,
			subpath: topicMatch?.basePath ?? postMatch?.basePath,
			kind: topicMatch ? "topic" : "post",
			parsedUrl: parsed,
		};
	},
	notes: ["Fetched via Discourse API"],
	fetch: async (match, ctx) => {
		const baseUrl = `${match.parsedUrl.origin}${trimTrailingSlashes(match.subpath ?? "")}`;
		const target = await resolveDiscourseTopic(match, baseUrl, ctx);
		if (!target) return null;

		const topicResult = await ctx.loadPage(`${baseUrl}/t/${target.topicId}.json?include_raw=1`, {
			timeout: ctx.timeout,
			signal: ctx.signal,
		});
		if (!topicResult.ok) return null;
		const topic = ctx.tryParseJson<DiscourseTopic>(topicResult.content);
		if (!topic) return null;
		const title = topic.title || topic.fancy_title;
		if (!title) return null;

		const posts: DiscoursePost[] = [...(topic.post_stream?.posts ?? [])];
		const { requestedPost } = target;
		if (requestedPost && !posts.some(post => post.id === requestedPost.id)) posts.unshift(requestedPost);

		return buildResult(await renderDiscourseTopic(topic, title, posts), {
			url: ctx.url,
			method: "discourse-api",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Discourse API"],
		});
	},
};

// =============================================================================
// Dev.to Types & Declaration
// =============================================================================

interface DevToArticle {
	title: string;
	description?: string;
	published_at?: string;
	published_timestamp?: string;
	/** An array from the single-article endpoint, a comma-separated string from the listing endpoint. */
	tags?: string[] | string;
	/** An array from the listing endpoint, a comma-separated string from the single-article endpoint. */
	tag_list?: string[] | string;
	reading_time_minutes?: number;
	public_reactions_count?: number;
	positive_reactions_count?: number;
	comments_count?: number;
	user?: {
		name?: string;
		username?: string;
	};
	body_markdown?: string;
	body_html?: string;
}

function devToTags(article: DevToArticle): string[] {
	if (Array.isArray(article.tag_list)) return article.tag_list;
	return Array.isArray(article.tags) ? article.tags : [];
}

function renderDevToArticleCard(article: DevToArticle, includeAuthor = true): string {
	const tags = devToTags(article);
	const reactions = article.positive_reactions_count ?? article.public_reactions_count ?? 0;
	const readTime = article.reading_time_minutes ? ` · ${article.reading_time_minutes} min read` : "";
	const reactStr = reactions > 0 ? ` · ${formatNumber(reactions)} reactions` : "";

	let md = `### ${article.title}\n\n`;
	if (includeAuthor) {
		md += `by **${article.user?.name || "Unknown"}** (@${article.user?.username || "unknown"})`;
		md += `${readTime}${reactStr}\n`;
	} else {
		md += `${readTime.substring(3)}${reactStr}\n`;
	}
	md += `*${formatIsoDate(article.published_at || article.published_timestamp || "")}*\n`;
	if (tags.length > 0) md += `Tags: ${tags.map(t => `#${t}`).join(", ")}\n`;
	if (article.description) md += `\n${article.description}\n`;
	md += `\n---\n\n`;
	return md;
}

interface DevToListing {
	query: string;
	heading: string;
	includeAuthor: boolean;
}

/** A tag page lists recent articles under their authors; a profile page lists the user's own. */
function devToListing(pathParts: string[]): DevToListing | null {
	const [first, second] = pathParts;
	if (first === "t" && pathParts.length >= 2) {
		return { query: `tag=${encodeURIComponent(second)}`, heading: `dev.to/t/${second}`, includeAuthor: true };
	}
	if (pathParts.length === 1) {
		return { query: `username=${encodeURIComponent(first)}`, heading: `dev.to/${first}`, includeAuthor: false };
	}
	return null;
}

async function fetchDevToListing(listing: DevToListing, ctx: DiscussionContext) {
	const result = await ctx.loadPage(`https://dev.to/api/articles?${listing.query}&per_page=20`, {
		timeout: ctx.timeout,
		signal: ctx.signal,
	});
	if (!result.ok) return ctx.scraperDegrade("devto", ctx.loadFailure(result));
	const articles = ctx.tryParseJson<DevToArticle[]>(result.content);
	if (!articles?.length) return null;

	let md = `# ${listing.heading}\n\n## Recent Articles (${articles.length})\n\n`;
	for (const article of articles) md += renderDevToArticleCard(article, listing.includeAuthor);
	return buildResult(md, {
		url: ctx.url,
		method: "devto",
		fetchedAt: ctx.fetchedAt,
		notes: ["Fetched via dev.to API"],
	});
}

async function renderDevToArticle(article: DevToArticle, username: string): Promise<string> {
	const tags = devToTags(article);
	const reactions = article.positive_reactions_count ?? article.public_reactions_count ?? 0;
	const comments = article.comments_count ?? 0;
	const readTime = article.reading_time_minutes ?? 0;

	let md = `# ${article.title}\n\n`;
	md += `**Author:** ${article.user?.name || "Unknown"} (@${article.user?.username || username})\n`;
	md += `**Published:** ${formatIsoDate(article.published_at || article.published_timestamp || "")}\n`;
	if (readTime > 0) md += `**Reading time:** ${readTime} min\n`;
	if (reactions > 0) md += `**Reactions:** ${formatNumber(reactions)}\n`;
	if (comments > 0) md += `**Comments:** ${formatNumber(comments)}\n`;
	if (tags.length > 0) md += `**Tags:** ${tags.map(t => `#${t}`).join(", ")}\n`;
	md += `\n---\n\n`;
	if (article.body_markdown) return md + article.body_markdown;
	return article.body_html ? md + (await htmlToBasicMarkdown(article.body_html)) : md;
}

async function fetchDevToArticle(username: string, slug: string, ctx: DiscussionContext) {
	const apiUrl = `https://dev.to/api/articles/${encodeURIComponent(username)}/${encodeURIComponent(slug)}`;
	const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
	if (!result.ok) return ctx.scraperDegrade("devto", ctx.loadFailure(result));
	const article = ctx.tryParseJson<DevToArticle>(result.content);
	if (!article?.title) return null;
	return buildResult(await renderDevToArticle(article, username), {
		url: ctx.url,
		method: "devto",
		fetchedAt: ctx.fetchedAt,
		notes: ["Fetched via dev.to API"],
	});
}

export const devtoDeclaration: DiscussionDeclaration = {
	site: "devto",
	method: "devto",
	hosts: ["dev.to"],
	canonicalUrls: ["https://dev.to/user/awesome-post-1234"],
	match: parsed => {
		if (parsed.hostname !== "dev.to") return null;
		const pathParts = parsed.pathname.split("/").filter(Boolean);
		if (pathParts.length === 0) return null;
		return { id: parsed.pathname, subpath: pathParts.join("/"), parsedUrl: parsed };
	},
	notes: ["Fetched via dev.to API"],
	fetch: async (match, ctx) => {
		const pathParts = match.subpath!.split("/");
		const listing = devToListing(pathParts);
		if (listing) return fetchDevToListing(listing, ctx);
		return pathParts.length >= 2 ? fetchDevToArticle(pathParts[0], pathParts[1], ctx) : null;
	},
};

// =============================================================================
// Stack Overflow & Stack Exchange Types & Declaration
// =============================================================================

interface SOQuestion {
	title: string;
	body: string;
	score: number;
	owner: { display_name: string };
	creation_date: number;
	tags: string[];
	answer_count: number;
	is_answered: boolean;
}

interface SOAnswer {
	body: string;
	score: number;
	is_accepted: boolean;
	owner: { display_name: string };
	creation_date: number;
}

const STANDALONE_SE_SITES: Record<string, string> = {
	"stackoverflow.com": "stackoverflow",
	"superuser.com": "superuser",
	"serverfault.com": "serverfault",
	"askubuntu.com": "askubuntu",
	"mathoverflow.net": "mathoverflow",
	"stackapps.com": "stackapps",
};

function getStackExchangeSiteParam(hostname: string): string | null {
	const host = hostname.replace(/^www\./, "");
	if (STANDALONE_SE_SITES[host]) {
		return STANDALONE_SE_SITES[host];
	}
	const seMatch = host.match(/^([a-z0-9-]+)\.stackexchange\.com$/);
	if (seMatch) {
		return seMatch[1];
	}
	return null;
}

const STACK_EXCHANGE_QUESTIONS_API = "https://api.stackexchange.com/2.3/questions";

async function renderStackExchangeQuestion(question: SOQuestion): Promise<string> {
	let md = `# ${decodeHtmlEntities(question.title)}\n\n`;
	md += `**Score:** ${question.score} · **Answers:** ${question.answer_count}`;
	md += question.is_answered ? " (Answered)" : "";
	md += `\n**Tags:** ${question.tags.join(", ")}\n`;
	md += `**Asked by:** ${decodeHtmlEntities(question.owner?.display_name || "anonymous")} · ${formatIsoDate(question.creation_date * 1000)}\n\n`;
	md += `---\n\n## Question\n\n${await htmlToBasicMarkdown(question.body)}\n\n`;
	return md;
}

/** The five highest-voted answers, or nothing when the answers request fails or returns none. */
async function fetchStackExchangeAnswers(questionId: string, site: string, ctx: DiscussionContext): Promise<string> {
	const apiUrl = `${STACK_EXCHANGE_QUESTIONS_API}/${questionId}/answers?order=desc&sort=votes&site=${site}&filter=withbody`;
	const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
	if (!result.ok) return "";
	const answers = ctx.tryParseJson<{ items: SOAnswer[] }>(result.content)?.items;
	if (!answers?.length) return "";

	let md = `---\n\n## Answers\n\n`;
	for (const answer of answers.slice(0, 5)) {
		const accepted = answer.is_accepted ? " (Accepted)" : "";
		md += `### Score: ${answer.score}${accepted} · by ${decodeHtmlEntities(answer.owner?.display_name || "anonymous")}\n\n`;
		md += `${await htmlToBasicMarkdown(answer.body)}\n\n---\n\n`;
	}
	return md;
}

export const stackOverflowDeclaration: DiscussionDeclaration = {
	site: "stackoverflow",
	method: "stackexchange",
	hosts: [
		"stackoverflow.com",
		"www.stackoverflow.com",
		"superuser.com",
		"www.superuser.com",
		"serverfault.com",
		"www.serverfault.com",
		"askubuntu.com",
		"www.askubuntu.com",
		"mathoverflow.net",
		"www.mathoverflow.net",
		"stackapps.com",
		"www.stackapps.com",
		"*.stackexchange.com",
	],
	canonicalUrls: [
		"https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array",
	],
	match: parsed => {
		const site = getStackExchangeSiteParam(parsed.hostname);
		if (!site) return null;
		const match = parsed.pathname.match(/\/questions\/(\d+)/);
		if (!match) return null;
		return { id: match[1], site, parsedUrl: parsed };
	},
	notes: ["Fetched via Stack Exchange API"],
	fetch: async (match, ctx) => {
		const site = match.site ?? "stackoverflow";
		const apiUrl = `${STACK_EXCHANGE_QUESTIONS_API}/${match.id}?order=desc&sort=votes&site=${site}&filter=withbody`;
		const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
		if (!result.ok) return ctx.scraperDegrade("stackoverflow", ctx.loadFailure(result));
		const questions = ctx.tryParseJson<{ items: SOQuestion[] }>(result.content)?.items;
		if (!questions?.length) return null;

		const md =
			(await renderStackExchangeQuestion(questions[0])) + (await fetchStackExchangeAnswers(match.id, site, ctx));
		return buildResult(md, {
			url: ctx.url,
			method: "stackexchange",
			fetchedAt: ctx.fetchedAt,
			notes: [`Fetched via Stack Exchange API (site=${site})`],
		});
	},
};

export const stackoverflowDeclaration = stackOverflowDeclaration;

export const DISCUSSION_DECLARATIONS = [
	redditDeclaration,
	hackerNewsDeclaration,
	lobstersDeclaration,
	lemmyDeclaration,
	discourseDeclaration,
	devtoDeclaration,
	stackOverflowDeclaration,
];
