import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { handleBluesky } from "../../src/scrapers/bluesky";
import * as scraperTypes from "../../src/scrapers/types";

/**
 * WHY: a Bluesky URL renders from AT Protocol API records. This suite pins what each record shape
 * owes the markdown: the parent post as a quote above the main post, every embed kind (external
 * link, images with their alt texts, a quoted record), the non-zero engagement counts, at most ten
 * replies with a missing reply skipped, and a profile's counts, join date and DID. It also pins
 * the non-matches (another host, a path that is not a profile) and the degrade when the thread
 * cannot be fetched.
 *
 * It does not pin the locale date format, which comes from `toLocaleString`.
 */

const CREATED_AT = "2024-03-05T14:30:00.000Z";
const POST_DATE = new Date(CREATED_AT).toLocaleString("en-US", {
	year: "numeric",
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});
const PROFILE_URL = "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=alice.bsky.social";
const AT_URI = "at://did:plc:alice/app.bsky.feed.post/abc";
const THREAD_URL = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(AT_URI)}&depth=6&parentHeight=3`;

function servePages(pages: Record<string, unknown>): { mockRestore: () => void } {
	return spyOn(scraperTypes, "loadPage").mockImplementation(async url => {
		if (!(url in pages)) {
			return { content: "", contentType: "text/plain", finalUrl: url, ok: false, status: 404 };
		}
		return {
			content: JSON.stringify(pages[url]),
			contentType: "application/json",
			finalUrl: url,
			ok: true,
			status: 200,
		};
	});
}

function render(result: scraperTypes.RenderResult | scraperTypes.ScraperDegrade | null): scraperTypes.RenderResult {
	if (result === null || scraperTypes.isScraperDegrade(result)) {
		throw new Error(`expected a render, got ${JSON.stringify(result)}`);
	}
	return result;
}

function post(handle: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		uri: `at://${handle}/post`,
		cid: "cid",
		author: { did: `did:${handle}`, handle },
		record: { text, createdAt: CREATED_AT },
		...extra,
	};
}

describe("a Bluesky post renders its thread and a profile its counts", () => {
	let loadPageSpy: { mockRestore: () => void } | null = null;

	afterEach(() => {
		loadPageSpy?.mockRestore();
		loadPageSpy = null;
	});

	it("renders the parent as a quote, the post with its embed and counts, and the first ten replies", async () => {
		const replies: unknown[] = [{ $type: "app.bsky.feed.defs#notFoundPost" }];
		for (let i = 1; i <= 11; i++) {
			const quote =
				i === 1
					? {
							embed: {
								$type: "app.bsky.embed.record#view",
								record: {
									uri: "at://carol/post",
									value: { text: "quoted\ntext" },
									author: { did: "did:carol", handle: "carol.bsky.social", displayName: "Carol" },
								},
							},
						}
					: {};
			replies.push({ post: post(`r${i}.bsky.social`, `reply ${i}`, quote) });
		}
		loadPageSpy = servePages({
			[PROFILE_URL]: { did: "did:plc:alice", handle: "alice.bsky.social" },
			[THREAD_URL]: {
				thread: {
					parent: {
						post: post("bob.bsky.social", "Parent text\nsecond", {
							likeCount: 5,
							embed: { $type: "app.bsky.embed.images#view", images: [{ alt: "a cat" }, {}] },
						}),
					},
					post: {
						...post("alice.bsky.social", "Main line one\nline two", {
							likeCount: 7,
							repostCount: 0,
							replyCount: 3,
							embed: {
								$type: "app.bsky.embed.external#view",
								external: { uri: "https://example.com/a", title: "Example", description: "An example page" },
							},
						}),
						author: { did: "did:plc:alice", handle: "alice.bsky.social", displayName: "Alice" },
					},
					replies,
				},
			},
		});

		const result = render(await handleBluesky("https://bsky.app/profile/alice.bsky.social/post/abc", 10));

		const head = [
			"# Bluesky Post",
			"",
			"**Replying to:**",
			`> **bob.bsky.social** (@bob.bsky.social) - ${POST_DATE}`,
			">",
			"> Parent text",
			"> second",
			"",
			"🖼️ 2 image(s)",
			'- Alt: "a cat"',
			"",
			"---",
			"",
			"**Alice** (@alice.bsky.social)",
			`*${POST_DATE}*`,
			"",
			"Main line one",
			"line two",
			"",
			"📎 [Example](https://example.com/a)",
			"*An example page*",
			"",
			"❤️ 7 • 💬 3",
			"",
			"---",
			"",
			"## Replies",
			"",
		];
		const replyBlocks: string[] = [];
		for (let i = 1; i <= 10; i++) {
			const quoted =
				i === 1 ? ["", "**Quoted post:**", "> **Carol** (@carol.bsky.social)", "> quoted", "> text"] : [];
			replyBlocks.push(
				[
					`**r${i}.bsky.social** (@r${i}.bsky.social)`,
					`*${POST_DATE}*`,
					"",
					`reply ${i}`,
					...quoted,
					"",
					"---",
				].join("\n"),
			);
		}
		expect(result.method).toBe("bluesky-api");
		expect(result.notes).toEqual([`AT URI: ${AT_URI}`]);
		expect(result.content).toBe(`${head.join("\n")}\n${replyBlocks.join("\n\n")}`);
	});

	it("renders a post with no parent, no embed and no counts as its author, date and text", async () => {
		loadPageSpy = servePages({
			[PROFILE_URL]: { did: "did:plc:alice", handle: "alice.bsky.social" },
			[THREAD_URL]: { thread: { post: post("alice.bsky.social", "Just text", { likeCount: 0 }), replies: [] } },
		});

		const result = render(await handleBluesky("https://www.bsky.app/profile/alice.bsky.social/post/abc", 10));

		expect(result.content).toBe(
			["# Bluesky Post", "", "**alice.bsky.social** (@alice.bsky.social)", `*${POST_DATE}*`, "", "Just text"].join(
				"\n",
			),
		);
	});

	it("renders a profile with its counts, join date and DID", async () => {
		loadPageSpy = servePages({
			[PROFILE_URL]: {
				did: "did:plc:alice",
				handle: "alice.bsky.social",
				displayName: "Alice",
				description: "Bio line",
				followersCount: 12,
				followsCount: 0,
				createdAt: "2023-01-02T12:00:00.000Z",
			},
		});

		const result = render(await handleBluesky("https://bsky.app/profile/alice.bsky.social", 10));

		const joined = new Date("2023-01-02T12:00:00.000Z").toLocaleDateString("en-US", {
			year: "numeric",
			month: "long",
			day: "numeric",
		});
		expect(result.notes).toEqual(["Fetched via AT Protocol API"]);
		expect(result.content).toBe(
			[
				"# Alice",
				"",
				"**@alice.bsky.social**",
				"",
				"Bio line",
				"",
				"---",
				"",
				"- **Followers:** 12",
				"- **Following:** 0",
				"- **Posts:** 0",
				`- **Joined:** ${joined}`,
				"",
				"**DID:** `did:plc:alice`",
			].join("\n"),
		);
	});

	it("does not match another host or a path that names no profile", async () => {
		loadPageSpy = servePages({});

		expect(await handleBluesky("https://example.com/profile/alice.bsky.social", 10)).toBeNull();
		expect(await handleBluesky("https://bsky.app/search?q=x", 10)).toBeNull();
		expect(await handleBluesky("https://bsky.app/hashtag/rust", 10)).toBeNull();
		expect(await handleBluesky("https://bsky.app/profile", 10)).toBeNull();
	});

	it("does not match a post whose author handle does not resolve", async () => {
		loadPageSpy = servePages({});

		expect(await handleBluesky("https://bsky.app/profile/alice.bsky.social/post/abc", 10)).toBeNull();
	});

	it("degrades with the HTTP status when the thread cannot be fetched", async () => {
		loadPageSpy = servePages({ [PROFILE_URL]: { did: "did:plc:alice", handle: "alice.bsky.social" } });

		const result = await handleBluesky("https://bsky.app/profile/alice.bsky.social/post/abc", 10);

		expect(scraperTypes.isScraperDegrade(result)).toBe(true);
		if (!scraperTypes.isScraperDegrade(result)) return;
		expect(result.note).toBe("bluesky scraper failed (HTTP 404); fell back to a generic fetch");
	});
});
