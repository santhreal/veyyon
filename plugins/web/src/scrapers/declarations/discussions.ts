import { trimTrailingSlashes } from "@veyyon/utils/url";
import { markdownLink } from "../../markdown-link";
import type { DiscussionContext, DiscussionDeclaration } from "../engine/discussion";
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

async function renderHNStory(item: HNItem, ctx: DiscussionContext, depth = 0): Promise<string> {
	let output = "";

	if (depth === 0) {
		output += `# ${item.title}\n\n`;
		if (item.url) {
			output += `**URL:** ${item.url}\n\n`;
		}
		output += `**Posted by:** ${item.by} | **Score:** ${item.score ?? 0} | **Time:** ${formatHNTimestamp(item.time ?? 0)}`;
		if (item.descendants) {
			output += ` | **Comments:** ${item.descendants}`;
		}
		output += "\n\n";
	}

	if (item.text) {
		output += `${decodeHNText(item.text)}\n\n`;
	}

	if (item.kids && item.kids.length > 0 && depth < 2) {
		const topComments = item.kids.slice(0, depth === 0 ? 20 : 10);
		const comments = await fetchHNItems(topComments, ctx, topComments.length);

		if (comments.length > 0) {
			if (depth === 0) output += "---\n\n## Comments\n\n";

			for (const comment of comments) {
				const indent = "  ".repeat(depth);
				output += `${indent}**${comment.by}** (${formatHNTimestamp(comment.time ?? 0)})`;
				if (comment.score !== undefined) output += ` [${comment.score}]`;
				output += "\n";
				if (comment.text) {
					const text = decodeHNText(comment.text);
					const lines = text.split("\n");
					output += `${lines.map(line => `${indent}${line}`).join("\n")}\n\n`;
				}

				if (comment.kids && comment.kids.length > 0 && depth < 1) {
					const childOutput = await renderHNStory(comment, ctx, depth + 1);
					output += childOutput;
				}
			}
		}
	}

	return output;
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

			content = await renderHNStory(item, ctx, 0);
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

interface RedditChild {
	kind: string;
	data: RedditPost | RedditComment;
}

interface RedditListingData {
	data?: {
		children?: RedditChild[];
	};
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
		const parsed = match.parsedUrl;
		let jsonUrl = `${ctx.url.replace(/\/$/, "")}.json`;
		if (parsed.search) {
			jsonUrl = `${ctx.url.replace(/\/$/, "").replace(parsed.search, "")}.json${parsed.search}`;
		}

		const result = await ctx.loadPage(jsonUrl, { timeout: ctx.timeout, signal: ctx.signal });
		if (!result.ok) return ctx.scraperDegrade("reddit", ctx.loadFailure(result));
		const data = ctx.tryParseJson<RedditListingData[] | RedditListingData>(result.content);
		if (!data) return ctx.scraperDegrade("reddit", "unexpected response shape");

		let md = "";

		// Handle different Reddit URL types
		if (Array.isArray(data) && data.length >= 1) {
			// Post page (with comments)
			const postData = data[0]?.data?.children?.[0]?.data as RedditPost | undefined;
			if (postData) {
				md = `# ${postData.title}\n\n`;
				md += `**r/${postData.subreddit}** · u/${postData.author} · ${postData.score} points · ${postData.num_comments} comments\n`;
				md += `*${formatIsoDate(postData.created_utc * 1000)}*\n\n`;

				if (postData.is_self && postData.selftext) {
					md += `---\n\n${postData.selftext}\n\n`;
				} else if (!postData.is_self) {
					md += `**Link:** ${postData.url}\n\n`;
				}

				// Add comments if available
				if (data.length >= 2 && data[1]?.data?.children) {
					md += `---\n\n## Top Comments\n\n`;
					const comments = data[1].data.children.filter(c => c.kind === "t1").slice(0, 10) as Array<{
						kind: string;
						data: RedditComment;
					}>;

					for (const { data: comment } of comments) {
						md += `### u/${comment.author} · ${comment.score} points\n\n`;
						md += `${comment.body}\n\n---\n\n`;
					}
				}
			}
		} else if (!Array.isArray(data) && data?.data?.children) {
			// Subreddit or listing page
			const posts = data.data.children.slice(0, 20) as Array<{ kind: string; data: RedditPost }>;
			const subreddit = posts[0]?.data?.subreddit;

			md = `# r/${subreddit || "Reddit"}\n\n`;
			for (const { data: post } of posts) {
				md += `- **${post.title}** (${post.score} pts, ${post.num_comments} comments)\n`;
				md += `  by u/${post.author}\n\n`;
			}
		}

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
	description?: string;
	submitter_user: string;
	score: number;
	comment_count: number;
	created_at: string;
	tags: string[];
}

interface LobstersComment {
	short_id: string;
	comment: string;
	commenting_user: string;
	score: number;
	created_at: string;
	indent_level: number;
	comments?: LobstersComment[];
}

interface LobstersStoryResponse {
	short_id: string;
	title: string;
	url?: string;
	description?: string;
	submitter_user: string;
	score: number;
	comment_count: number;
	created_at: string;
	tags: string[];
	comments: LobstersComment[];
}

function renderLobstersComments(comments: LobstersComment[], maxDepth = 5): string {
	let md = "";
	for (const comment of comments) {
		if (comment.indent_level >= maxDepth) continue;

		const indent = "  ".repeat(comment.indent_level);
		md += `${indent}### ${comment.commenting_user} · ${comment.score} points\n\n`;
		md += `${indent}${comment.comment.split("\n").join(`\n${indent}`)}\n\n`;

		if (comment.comments && comment.comments.length > 0) {
			md += renderLobstersComments(comment.comments, maxDepth);
		}

		md += `${indent}---\n\n`;
	}
	return md;
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
		const parsed = match.parsedUrl;
		let jsonUrl = "";
		let md = "";

		if (match.kind === "story") {
			jsonUrl = `https://lobste.rs/s/${match.id}.json`;
			const result = await ctx.loadPage(jsonUrl, { timeout: ctx.timeout, signal: ctx.signal });
			if (!result.ok) return ctx.scraperDegrade("lobsters", ctx.loadFailure(result));

			const story = ctx.tryParseJson<LobstersStoryResponse>(result.content);
			if (!story) return ctx.scraperDegrade("lobsters", "unexpected response shape");

			md = `# ${story.title}\n\n`;
			md += `**${story.submitter_user}** · ${story.score} points · ${story.comment_count} comments`;
			if (story.tags?.length > 0) {
				md += ` · [${story.tags.join(", ")}]`;
			}
			md += `\n`;
			md += `*${formatIsoDate(story.created_at)}*\n\n`;

			if (story.description) {
				md += `---\n\n${story.description}\n\n`;
			} else if (story.url) {
				md += `**Link:** ${story.url}\n\n`;
			}

			// Add comments
			if (story.comments && story.comments.length > 0) {
				md += `---\n\n## Comments\n\n`;
				md += renderLobstersComments(story.comments);
			}
		} else if (match.kind === "listing") {
			if (parsed.pathname === "/") {
				jsonUrl = "https://lobste.rs/hottest.json";
			} else if (parsed.pathname === "/newest") {
				jsonUrl = "https://lobste.rs/newest.json";
			} else {
				const tagMatch = parsed.pathname.match(/^\/t\/([^/]+)/);
				if (tagMatch) {
					jsonUrl = `https://lobste.rs/t/${tagMatch[1]}.json`;
				}
			}

			if (!jsonUrl) return null;

			const result = await ctx.loadPage(jsonUrl, { timeout: ctx.timeout, signal: ctx.signal });
			if (!result.ok) return ctx.scraperDegrade("lobsters", ctx.loadFailure(result));

			const stories = ctx.tryParseJson<LobstersStory[]>(result.content);
			if (!stories) return ctx.scraperDegrade("lobsters", "unexpected response shape");
			const listingStories = stories.slice(0, 20);

			const title =
				parsed.pathname === "/"
					? "Lobste.rs Front Page"
					: parsed.pathname === "/newest"
						? "Lobste.rs Newest"
						: `Lobste.rs Tag: ${parsed.pathname.split("/")[2]}`;

			md = `# ${title}\n\n`;

			for (const story of listingStories) {
				md += `- **${story.title}** (${story.score} pts, ${story.comment_count} comments)\n`;
				md += `  by ${story.submitter_user}`;
				if (story.tags?.length > 0) {
					md += ` · [${story.tags.join(", ")}]`;
				}
				md += `\n`;
				if (story.url) {
					md += `  ${story.url}\n`;
				}
				md += `  https://lobste.rs/s/${story.short_id}\n\n`;
			}
		} else {
			return null;
		}

		return buildResult(md, {
			url: ctx.url,
			finalUrl: jsonUrl,
			method: "lobsters",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Lobste.rs JSON API"],
		});
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
	path?: string;
	parent_id?: number | null;
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
		const parentId = commentView.comment.parent_id;
		const resolvedParent = parentId && commentIds.has(parentId) ? parentId : 0;
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
		let postId = Number.parseInt(match.id, 10);

		if (match.kind === "comment") {
			const commentUrl = `${baseUrl}/api/v3/comment?id=${postId}`;
			const commentResult = await ctx.loadPage(commentUrl, { timeout: ctx.timeout, signal: ctx.signal });
			if (!commentResult.ok) return null;

			const commentData = ctx.tryParseJson<LemmyCommentResponse>(commentResult.content);
			const commentView = commentData?.comment_view;
			const commentPostId = commentView?.comment?.post_id;
			if (!commentPostId) return null;
			postId = commentPostId;
		}

		const postUrl = `${baseUrl}/api/v3/post?id=${postId}`;
		const commentsUrl = `${baseUrl}/api/v3/comment/list?post_id=${postId}`;

		const [postResult, commentsResult] = await Promise.all([
			ctx.loadPage(postUrl, { timeout: ctx.timeout, signal: ctx.signal }),
			ctx.loadPage(commentsUrl, { timeout: ctx.timeout, signal: ctx.signal }),
		]);

		if (!postResult.ok || !commentsResult.ok) return null;

		const postData = ctx.tryParseJson<LemmyPostResponse>(postResult.content);
		const postView = postData?.post_view;
		if (!postView) return null;

		const commentsData = ctx.tryParseJson<LemmyCommentListResponse>(commentsResult.content);
		const comments = commentsData?.comments ?? [];

		let md = `# ${postView.post.name}\n\n`;

		const communityLabel = formatLemmyCommunity(postView.community);
		const authorLabel = formatLemmyAuthor(postView.creator);
		const score = postView.counts?.score ?? 0;
		const commentCount = postView.counts?.comments ?? comments.length;

		md += `**Community:** ${communityLabel} · **Author:** ${authorLabel} · **Score:** ${score} · **Comments:** ${commentCount}\n`;
		if (postView.post.url) {
			md += `**Link:** ${postView.post.url}\n`;
		}
		md += "\n";

		if (postView.post.body) {
			md += `---\n\n${postView.post.body}\n\n`;
		}

		if (comments.length > 0) {
			const threadedComments = renderLemmyComments(comments);
			if (threadedComments) {
				md += `---\n\n## Comments\n\n${threadedComments}\n`;
			}
		}

		return buildResult(md, {
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
	like_count?: number;
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
	tags?: string[];
	category_id?: number;
	category_slug?: string;
	category?: { id?: number; name?: string; slug?: string };
	excerpt?: string;
	details?: { created_by?: DiscourseUser };
	post_stream?: { posts?: DiscoursePost[] };
}

const MAX_DISCOURSE_POSTS = 20;

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
		const parsed = match.parsedUrl;
		const basePath = trimTrailingSlashes(match.subpath ?? "");
		const baseUrl = `${parsed.origin}${basePath}`;

		let requestedPost: DiscoursePost | null = null;
		let topicId = match.kind === "topic" ? match.id : null;

		if (!topicId && match.kind === "post") {
			const postResult = await ctx.loadPage(`${baseUrl}/posts/${match.id}.json?include_raw=1`, {
				timeout: ctx.timeout,
				signal: ctx.signal,
			});

			const postData = ctx.tryParseJson<DiscoursePostResponse>(postResult.content);
			if (!postData?.topic_id) return null;
			topicId = String(postData.topic_id);
			requestedPost = postData;
		}

		if (!topicId) return null;

		const topicResult = await ctx.loadPage(`${baseUrl}/t/${topicId}.json?include_raw=1`, {
			timeout: ctx.timeout,
			signal: ctx.signal,
		});
		if (!topicResult.ok) return null;

		const topic = ctx.tryParseJson<DiscourseTopic>(topicResult.content);
		if (!topic) return null;

		const title = topic.title || topic.fancy_title;
		if (!title) return null;

		const posts: DiscoursePost[] = [...(topic.post_stream?.posts ?? [])];
		if (requestedPost && !posts.some(post => post.id === requestedPost?.id)) {
			posts.unshift(requestedPost);
		}

		let md = `# ${title}\n\n`;

		const metaParts: string[] = [];
		if (topic.id != null) metaParts.push(`**Topic ID:** ${topic.id}`);
		if (topic.posts_count != null) metaParts.push(`**Posts:** ${topic.posts_count}`);
		if (topic.views != null) metaParts.push(`**Views:** ${topic.views}`);
		if (topic.like_count != null) metaParts.push(`**Likes:** ${topic.like_count}`);
		if (metaParts.length) md += `${metaParts.join(" | ")}\n`;

		const categoryLabel = formatDiscourseCategory(topic);
		if (categoryLabel) md += `**Category:** ${categoryLabel}\n`;
		if (topic.tags?.length) md += `**Tags:** ${topic.tags.join(", ")}\n`;

		const createdBy = formatDiscourseAuthor(topic.details?.created_by ?? null);
		if (createdBy !== "unknown" || topic.created_at) {
			md += `**Created by:** ${createdBy} - ${formatIsoDate(topic.created_at)}\n`;
		}

		md += "\n";

		const description = topic.excerpt
			? await htmlToBasicMarkdown(topic.excerpt)
			: posts.length
				? await formatDiscoursePostBody(posts[0])
				: "";
		if (description) {
			md += `## Description\n\n${description}\n\n`;
		}

		if (posts.length) {
			md += "## Posts\n\n";
			for (const post of posts.slice(0, MAX_DISCOURSE_POSTS)) {
				const author = formatDiscourseAuthor({ name: post.name, username: post.username });
				const date = formatIsoDate(post.created_at);
				const likes = post.like_count ?? 0;
				const content = await formatDiscoursePostBody(post);
				const postLabel = post.post_number != null ? `Post ${post.post_number}` : `Post ${post.id}`;

				md += `### ${postLabel} - ${author} - ${date} - Likes: ${likes}\n\n`;
				md += content ? `${content}\n\n---\n\n` : "_No content available._\n\n---\n\n";
			}
		}

		return buildResult(md, {
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
	tags?: string[];
	tag_list?: string[];
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

function renderDevToArticleCard(article: DevToArticle, includeAuthor = true): string {
	const tags = article.tag_list || article.tags || [];
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
		const notes: string[] = [];

		// Tag page: /t/{tag}
		if (pathParts[0] === "t" && pathParts.length >= 2) {
			const tag = pathParts[1];
			const apiUrl = `https://dev.to/api/articles?tag=${encodeURIComponent(tag)}&per_page=20`;

			const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
			if (!result.ok) return ctx.scraperDegrade("devto", ctx.loadFailure(result));

			const articles = ctx.tryParseJson<DevToArticle[]>(result.content);
			if (!articles?.length) return null;

			let md = `# dev.to/t/${tag}\n\n`;
			md += `## Recent Articles (${articles.length})\n\n`;

			for (const article of articles) {
				md += renderDevToArticleCard(article, true);
			}

			notes.push("Fetched via dev.to API");
			return buildResult(md, { url: ctx.url, method: "devto", fetchedAt: ctx.fetchedAt, notes });
		}

		// User profile: /{username} (only if single path segment)
		if (pathParts.length === 1) {
			const username = pathParts[0];
			const apiUrl = `https://dev.to/api/articles?username=${encodeURIComponent(username)}&per_page=20`;

			const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
			if (!result.ok) return ctx.scraperDegrade("devto", ctx.loadFailure(result));

			const articles = ctx.tryParseJson<DevToArticle[]>(result.content);
			if (!articles?.length) return null;

			let md = `# dev.to/${username}\n\n`;
			md += `## Recent Articles (${articles.length})\n\n`;

			for (const article of articles) {
				md += renderDevToArticleCard(article, false);
			}

			notes.push("Fetched via dev.to API");
			return buildResult(md, { url: ctx.url, method: "devto", fetchedAt: ctx.fetchedAt, notes });
		}

		// Article: /{username}/{slug}
		if (pathParts.length >= 2) {
			const username = pathParts[0];
			const slug = pathParts[1];
			const apiUrl = `https://dev.to/api/articles/${encodeURIComponent(username)}/${encodeURIComponent(slug)}`;

			const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
			if (!result.ok) return ctx.scraperDegrade("devto", ctx.loadFailure(result));

			const article = ctx.tryParseJson<DevToArticle>(result.content);
			if (!article?.title) return null;

			const tags = article.tag_list || article.tags || [];
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

			if (article.body_markdown) {
				md += article.body_markdown;
			} else if (article.body_html) {
				md += await htmlToBasicMarkdown(article.body_html);
			}

			notes.push("Fetched via dev.to API");
			return buildResult(md, { url: ctx.url, method: "devto", fetchedAt: ctx.fetchedAt, notes });
		}

		return null;
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
		const questionId = match.id;

		const apiUrl = `https://api.stackexchange.com/2.3/questions/${questionId}?order=desc&sort=votes&site=${site}&filter=withbody`;
		const qResult = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
		if (!qResult.ok) return ctx.scraperDegrade("stackoverflow", ctx.loadFailure(qResult));

		const qData = ctx.tryParseJson<{ items: SOQuestion[] }>(qResult.content);
		if (!qData?.items?.length) return null;

		const question = qData.items[0];

		let md = `# ${question.title}\n\n`;
		md += `**Score:** ${question.score} · **Answers:** ${question.answer_count}`;
		md += question.is_answered ? " (Answered)" : "";
		md += `\n**Tags:** ${question.tags.join(", ")}\n`;
		md += `**Asked by:** ${question.owner?.display_name || "anonymous"} · ${formatIsoDate(question.creation_date * 1000)}\n\n`;
		md += `---\n\n## Question\n\n${await htmlToBasicMarkdown(question.body)}\n\n`;

		const aUrl = `https://api.stackexchange.com/2.3/questions/${questionId}/answers?order=desc&sort=votes&site=${site}&filter=withbody`;
		const aResult = await ctx.loadPage(aUrl, { timeout: ctx.timeout, signal: ctx.signal });

		if (aResult.ok) {
			const aData = ctx.tryParseJson<{ items: SOAnswer[] }>(aResult.content);
			if (aData?.items?.length) {
				md += `---\n\n## Answers\n\n`;
				for (const answer of aData.items.slice(0, 5)) {
					const accepted = answer.is_accepted ? " (Accepted)" : "";
					md += `### Score: ${answer.score}${accepted} · by ${answer.owner?.display_name || "anonymous"}\n\n`;
					md += `${await htmlToBasicMarkdown(answer.body)}\n\n---\n\n`;
				}
			}
		}

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
