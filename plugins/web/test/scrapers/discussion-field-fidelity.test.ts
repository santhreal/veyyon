import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { DISCUSSION_DECLARATIONS } from "../../src/scrapers/declarations/discussions";
import { createDiscussionHandler } from "../../src/scrapers/engine/discussion";
import * as scraperTypes from "../../src/scrapers/types";

describe("discussion field fidelity across all declared discussion sites", () => {
	let loadPageSpy: { mockRestore: () => void } | null = null;

	afterEach(() => {
		if (loadPageSpy) {
			loadPageSpy.mockRestore();
			loadPageSpy = null;
		}
	});

	it("exports all expected discussion site declarations", () => {
		const declaredSites = DISCUSSION_DECLARATIONS.map(d => d.site);
		expect(declaredSites).toContain("reddit");
		expect(declaredSites).toContain("hackernews");
		expect(declaredSites).toContain("lobsters");
		expect(declaredSites).toContain("lemmy");
		expect(declaredSites).toContain("discourse");
		expect(declaredSites).toContain("devto");
		expect(declaredSites).toContain("stackoverflow");
	});

	describe("reddit discussion scraper", () => {
		const redditDecl = DISCUSSION_DECLARATIONS.find(d => d.site === "reddit")!;
		const handler = createDiscussionHandler(redditDecl, "handleReddit");

		it("renders post page with metadata, selftext, and top comments with correct limit and formatting", async () => {
			const postJson = [
				{
					data: {
						children: [
							{
								kind: "t3",
								data: {
									title: "Deep Dive into TypeScript 5.5",
									selftext: "Here is the full text of the article about TypeScript 5.5 features.",
									author: "alice",
									score: 350,
									num_comments: 42,
									created_utc: 1680000000,
									subreddit: "typescript",
									url: "https://www.reddit.com/r/typescript/comments/abc123/deep_dive/",
									is_self: true,
								},
							},
						],
					},
				},
				{
					data: {
						children: [
							// 12 comments to test the slice(0, 10) limit
							...Array.from({ length: 12 }, (_, i) => ({
								kind: "t1",
								data: {
									author: `commenter_${i + 1}`,
									body: `This is comment number ${i + 1}`,
									score: 100 - i * 5,
									created_utc: 1680001000 + i * 60,
								},
							})),
							// non-t1 child should be filtered out
							{
								kind: "more",
								data: {
									count: 30,
								},
							},
						],
					},
				},
			];

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://www.reddit.com/r/typescript/comments/abc123/deep_dive.json");
				return {
					content: JSON.stringify(postJson),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://www.reddit.com/r/typescript/comments/abc123/deep_dive/",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.method).toBe("reddit");
			expect(result.content).toContain("# Deep Dive into TypeScript 5.5");
			expect(result.content).toContain("**r/typescript** · u/alice · 350 points · 42 comments");
			expect(result.content).toContain("---\n\nHere is the full text of the article");
			expect(result.content).toContain("## Top Comments");

			// Check first comment and 10th comment
			expect(result.content).toContain("### u/commenter_1 · 100 points\n\nThis is comment number 1\n\n---");
			expect(result.content).toContain("### u/commenter_10 · 55 points\n\nThis is comment number 10\n\n---");

			// Verify 11th and 12th comment are excluded by slice(0, 10)
			expect(result.content).not.toContain("commenter_11");
			expect(result.content).not.toContain("commenter_12");
		});

		it("renders subreddit listing page with top 20 posts", async () => {
			const listingJson = {
				data: {
					children: Array.from({ length: 25 }, (_, i) => ({
						kind: "t3",
						data: {
							title: `Story ${i + 1}`,
							author: `user_${i + 1}`,
							score: 50 + i,
							num_comments: 10 + i,
							subreddit: "programming",
						},
					})),
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://www.reddit.com/r/programming.json");
				return {
					content: JSON.stringify(listingJson),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://www.reddit.com/r/programming", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# r/programming");
			expect(result.content).toContain("- **Story 1** (50 pts, 10 comments)\n  by u/user_1");
			expect(result.content).toContain("- **Story 20** (69 pts, 29 comments)\n  by u/user_20");
			expect(result.content).not.toContain("Story 21");
		});
	});

	describe("hackernews discussion scraper", () => {
		const hnDecl = DISCUSSION_DECLARATIONS.find(d => d.site === "hackernews")!;
		const handler = createDiscussionHandler(hnDecl, "handleHackerNews");

		it("renders story with recursive comments tree respecting depth and count limits and indentation", async () => {
			const itemsDb: Record<number, Record<string, unknown>> = {
				1000: {
					id: 1000,
					type: "story",
					title: "Show HN: Fast Web Scraper",
					by: "coder",
					time: Math.floor(Date.now() / 1000) - 3600, // 1h ago
					score: 250,
					descendants: 35,
					url: "https://example.com/project",
					text: '<p>Check out our <code>new</code> tool at <a href="https://example.com">link</a>.</p>',
					kids: [2001, 2002, 2003],
				},
				2001: {
					id: 2001,
					type: "comment",
					by: "bob",
					time: Math.floor(Date.now() / 1000) - 1800,
					text: "<p>Great project! <i>Loved</i> the design.</p>",
					kids: [3001, 3002],
				},
				2002: {
					id: 2002,
					type: "comment",
					deleted: true,
					by: "deleted_user",
					text: "deleted",
				},
				2003: {
					id: 2003,
					type: "comment",
					by: "charlie",
					time: Math.floor(Date.now() / 1000) - 900,
					text: "<p>How does it compare to other tools?</p>",
				},
				3001: {
					id: 3001,
					type: "comment",
					by: "coder",
					time: Math.floor(Date.now() / 1000) - 1200,
					text: "<p>Thanks Bob! We focused on speed.</p>",
					kids: [4001], // depth 2 should not be fetched/rendered because depth < 2 limit
				},
				3002: {
					id: 3002,
					type: "comment",
					dead: true,
					by: "spammer",
					text: "spam",
				},
				4001: {
					id: 4001,
					type: "comment",
					by: "david",
					text: "Level 3 comment should be omitted",
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				const match = url.match(/\/item\/(\d+)\.json/);
				if (match) {
					const id = Number.parseInt(match[1], 10);
					const item = itemsDb[id];
					if (item) {
						return {
							content: JSON.stringify(item),
							contentType: "application/json",
							finalUrl: url,
							ok: true,
							status: 200,
						};
					}
				}
				return { content: "null", contentType: "application/json", finalUrl: url, ok: false, status: 404 };
			});

			const result = (await handler("https://news.ycombinator.com/item?id=1000", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.method).toBe("hackernews");
			expect(result.content).toContain("# Show HN: Fast Web Scraper");
			expect(result.content).toContain("**URL:** https://example.com/project");
			expect(result.content).toContain("**Posted by:** coder | **Score:** 250");
			expect(result.content).toContain("| **Comments:** 35");
			expect(result.content).toContain("Check out our `new` tool at [link](https://example.com).");
			expect(result.content).toContain("---\n\n## Comments\n\n");

			// Top-level comment (depth 0)
			expect(result.content).toContain("**bob** (");
			expect(result.content).toContain("Great project! *Loved* the design.");

			// Deleted and dead comments should be filtered
			expect(result.content).not.toContain("deleted_user");
			expect(result.content).not.toContain("spammer");

			// Nested comment (depth 1) indented by two spaces
			expect(result.content).toContain("  **coder** (");
			expect(result.content).toContain("  Thanks Bob! We focused on speed.");

			// Depth 2 comment should not be rendered
			expect(result.content).not.toContain("Level 3 comment should be omitted");
		});

		it("renders front page, newest, and best story listings", async () => {
			const topIds = Array.from({ length: 25 }, (_, i) => 100 + i);
			const items: Record<number, Record<string, unknown>> = {};
			for (let i = 0; i < 25; i++) {
				items[100 + i] = {
					id: 100 + i,
					title: `HN Story ${i + 1}`,
					by: `author_${i + 1}`,
					score: 100 + i * 10,
					descendants: 20 + i,
					time: Math.floor(Date.now() / 1000) - 3600,
					url: `https://example.com/story_${i + 1}`,
				};
			}

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.endsWith("/topstories.json")) {
					return {
						content: JSON.stringify(topIds),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				const match = url.match(/\/item\/(\d+)\.json/);
				if (match) {
					const id = Number.parseInt(match[1], 10);
					return {
						content: JSON.stringify(items[id]),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return { content: "null", contentType: "application/json", finalUrl: url, ok: false, status: 404 };
			});

			const result = (await handler("https://news.ycombinator.com/", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Hacker News - Top Stories");
			expect(result.content).toContain("1. **HN Story 1**\n   https://example.com/story_1");
			expect(result.content).toContain("20. **HN Story 20**");
			expect(result.content).not.toContain("21. **HN Story 21**");
		});
	});

	describe("lobsters discussion scraper", () => {
		const lobstersDecl = DISCUSSION_DECLARATIONS.find(d => d.site === "lobsters")!;
		const handler = createDiscussionHandler(lobstersDecl, "handleLobsters");

		it("renders story with recursively nested comments up to max depth 5 with proper indentation and separators", async () => {
			const storyResponse = {
				short_id: "xyz123",
				title: "Announcing Lobsters Rewrite",
				submitter_user: "jcs",
				score: 120,
				comment_count: 5,
				created_at: "2023-05-01T12:00:00.000Z",
				tags: ["programming", "ruby"],
				description: "Here is the story summary and release notes.",
				comments: [
					{
						short_id: "c1",
						commenting_user: "alice",
						score: 15,
						created_at: "2023-05-01T13:00:00.000Z",
						indent_level: 1,
						comment: "Top-level comment on Lobsters.\nSecond paragraph.",
						comments: [
							{
								short_id: "c2",
								commenting_user: "bob",
								score: 8,
								created_at: "2023-05-01T14:00:00.000Z",
								indent_level: 2,
								comment: "Reply at depth 2.",
								comments: [
									{
										short_id: "c3",
										commenting_user: "charlie",
										score: 3,
										created_at: "2023-05-01T15:00:00.000Z",
										indent_level: 5, // At or beyond maxDepth 5 -> skipped
										comment: "Too deep comment.",
									},
								],
							},
						],
					},
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://lobste.rs/s/xyz123.json");
				return {
					content: JSON.stringify(storyResponse),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://lobste.rs/s/xyz123/announcing_lobsters_rewrite",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.method).toBe("lobsters");
			expect(result.content).toContain("# Announcing Lobsters Rewrite");
			expect(result.content).toContain("**jcs** · 120 points · 5 comments · [programming, ruby]");
			expect(result.content).toContain("---\n\nHere is the story summary and release notes.\n\n");
			expect(result.content).toContain("---\n\n## Comments\n\n");

			// Check indent_level: 1 (2 spaces)
			expect(result.content).toContain(
				"  ### alice · 15 points\n\n  Top-level comment on Lobsters.\n  Second paragraph.\n\n",
			);
			expect(result.content).toContain("  ---\n\n");

			// Check indent_level: 2 (4 spaces)
			expect(result.content).toContain("    ### bob · 8 points\n\n    Reply at depth 2.\n\n");
			expect(result.content).toContain("    ---\n\n");

			// Check depth >= 5 is omitted
			expect(result.content).not.toContain("Too deep comment.");
		});

		it("renders tag and hottest listings", async () => {
			const stories = Array.from({ length: 25 }, (_, i) => ({
				short_id: `s_${i + 1}`,
				title: `Story ${i + 1}`,
				submitter_user: `user_${i + 1}`,
				score: 30 + i,
				comment_count: 5 + i,
				tags: ["rust"],
			}));

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://lobste.rs/t/rust.json");
				return {
					content: JSON.stringify(stories),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://lobste.rs/t/rust", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Lobste.rs Tag: rust");
			expect(result.content).toContain("- **Story 1** (30 pts, 5 comments)\n  by user_1 · [rust]");
			expect(result.content).toContain("https://lobste.rs/s/s_1");
			expect(result.content).toContain("- **Story 20**");
			expect(result.content).not.toContain("Story 21");
		});
	});

	describe("lemmy discussion scraper", () => {
		const lemmyDecl = DISCUSSION_DECLARATIONS.find(d => d.site === "lemmy")!;
		const handler = createDiscussionHandler(lemmyDecl, "handleLemmy");

		it("reconstructs hierarchical threaded comments from flat comment list and formats federated actors", async () => {
			const postData = {
				post_view: {
					post: {
						id: 500,
						name: "Federated Discussion Post",
						body: "Let's talk about ActivityPub.",
						url: "https://example.com/activitypub",
					},
					creator: {
						name: "lemmy_dev",
						actor_id: "https://lemmy.world/u/lemmy_dev",
					},
					community: {
						name: "technology",
						actor_id: "https://lemmy.ml/c/technology",
					},
					counts: {
						score: 75,
						comments: 3,
					},
				},
			};

			const commentsData = {
				comments: [
					{
						comment: {
							id: 1,
							content: "Root comment 1\nSecond line of comment 1",
							parent_id: null,
							post_id: 500,
						},
						creator: {
							name: "user_one",
							actor_id: "https://hexbear.net/u/user_one",
						},
						counts: { score: 20 },
					},
					{
						comment: {
							id: 2,
							content: "Reply to comment 1",
							parent_id: 1,
							post_id: 500,
						},
						creator: {
							name: "user_two",
							actor_id: "https://feddit.de/u/user_two",
						},
						counts: { score: 10 },
					},
					{
						comment: {
							id: 3,
							content: "Root comment 2",
							parent_id: 0,
							post_id: 500,
						},
						creator: {
							name: "user_three",
						},
						counts: { score: 5 },
					},
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/api/v3/post?id=500")) {
					return {
						content: JSON.stringify(postData),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				if (url.includes("/api/v3/comment/list?post_id=500")) {
					return {
						content: JSON.stringify(commentsData),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return { content: "{}", contentType: "application/json", finalUrl: url, ok: false, status: 404 };
			});

			const result = (await handler("https://lemmy.world/post/500", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.method).toBe("lemmy-api");
			expect(result.content).toContain("# Federated Discussion Post");
			expect(result.content).toContain(
				"**Community:** !technology@lemmy.ml · **Author:** @lemmy_dev@lemmy.world · **Score:** 75 · **Comments:** 3",
			);
			expect(result.content).toContain("**Link:** https://example.com/activitypub");
			expect(result.content).toContain("---\n\nLet's talk about ActivityPub.\n\n");
			expect(result.content).toContain("---\n\n## Comments\n\n");

			// Root comment 1
			expect(result.content).toContain(
				"- **@user_one@hexbear.net** · 20 points\n  Root comment 1\n  Second line of comment 1",
			);

			// Nested reply to comment 1 indented with 2 spaces
			expect(result.content).toContain("  - **@user_two@feddit.de** · 10 points\n    Reply to comment 1");

			// Root comment 2 (no actor_id URL host suffix)
			expect(result.content).toContain("- **user_three** · 5 points\n  Root comment 2");
		});

		it("resolves /comment/123 to its post via dual fetch", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/api/v3/comment?id=999")) {
					return {
						content: JSON.stringify({
							comment_view: {
								comment: { id: 999, post_id: 500 },
							},
						}),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				if (url.includes("/api/v3/post?id=500")) {
					return {
						content: JSON.stringify({
							post_view: {
								post: { id: 500, name: "Resolved Post" },
								creator: { name: "author" },
								community: { name: "comm" },
								counts: { score: 10 },
							},
						}),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				if (url.includes("/api/v3/comment/list?post_id=500")) {
					return {
						content: JSON.stringify({ comments: [] }),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return { content: "{}", contentType: "application/json", finalUrl: url, ok: false, status: 404 };
			});

			const result = (await handler("https://lemmy.world/comment/999", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Resolved Post");
		});
	});

	describe("discourse discussion scraper", () => {
		const discourseDecl = DISCUSSION_DECLARATIONS.find(d => d.site === "discourse")!;
		const handler = createDiscussionHandler(discourseDecl, "handleDiscourse");

		it("renders topic with metadata, category, tags, description, and up to 20 posts with raw markdown", async () => {
			const topicData = {
				id: 12345,
				title: "Discussion on Rust Async",
				posts_count: 25,
				views: 1500,
				like_count: 45,
				created_at: "2023-06-01T10:00:00.000Z",
				category: { id: 3, name: "Rust", slug: "rust" },
				tags: ["async", "tokio"],
				details: {
					created_by: { name: "Jane Doe", username: "janedoe" },
				},
				excerpt: "A discussion about async ecosystem.",
				post_stream: {
					posts: Array.from({ length: 22 }, (_, i) => ({
						id: 100 + i,
						post_number: i + 1,
						name: `User ${i + 1}`,
						username: `user_${i + 1}`,
						created_at: "2023-06-01T11:00:00.000Z",
						raw: `Raw markdown post content for post ${i + 1}.`,
						like_count: 5 + i,
					})),
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://meta.discourse.org/t/12345.json?include_raw=1");
				return {
					content: JSON.stringify(topicData),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://meta.discourse.org/t/discussion-on-rust-async/12345",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.method).toBe("discourse-api");
			expect(result.content).toContain("# Discussion on Rust Async");
			expect(result.content).toContain("**Topic ID:** 12345 | **Posts:** 25 | **Views:** 1500 | **Likes:** 45");
			expect(result.content).toContain("**Category:** Rust #3");
			expect(result.content).toContain("**Tags:** async, tokio");
			expect(result.content).toContain("**Created by:** Jane Doe (@janedoe) - 2023-06-01");
			expect(result.content).toContain("## Description\n\nA discussion about async ecosystem.\n\n");
			expect(result.content).toContain("## Posts\n\n");

			// Check first post and 20th post
			expect(result.content).toContain(
				"### Post 1 - User 1 (@user_1) - 2023-06-01 - Likes: 5\n\nRaw markdown post content for post 1.\n\n---",
			);
			expect(result.content).toContain(
				"### Post 20 - User 20 (@user_20) - 2023-06-01 - Likes: 24\n\nRaw markdown post content for post 20.\n\n---",
			);

			// 21st post should be truncated by MAX_DISCOURSE_POSTS (20)
			expect(result.content).not.toContain("Post 21");
		});

		it("supports subpaths and resolves post URLs", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/posts/987.json?include_raw=1")) {
					return {
						content: JSON.stringify({
							id: 987,
							post_number: 2,
							topic_id: 555,
							username: "helper",
							raw: "Specific answer in post 987",
						}),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				if (url.includes("/t/555.json?include_raw=1")) {
					return {
						content: JSON.stringify({
							id: 555,
							title: "Subpath Forum Topic",
							post_stream: {
								posts: [{ id: 986, post_number: 1, username: "asker", raw: "Question" }],
							},
						}),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return { content: "{}", contentType: "application/json", finalUrl: url, ok: false, status: 404 };
			});

			const result = (await handler("https://meta.discourse.org/posts/987", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Subpath Forum Topic");
			expect(result.content).toContain("Specific answer in post 987");
		});
	});

	describe("devto discussion scraper", () => {
		const devtoDecl = DISCUSSION_DECLARATIONS.find(d => d.site === "devto")!;
		const handler = createDiscussionHandler(devtoDecl, "handleDevTo");

		it("renders article with reading time, reactions, comments count, tags, and body markdown", async () => {
			const articleData = {
				title: "Mastering TypeScript in 2024",
				user: {
					name: "Alex Smith",
					username: "alexsmith",
				},
				published_at: "2024-01-15T08:00:00.000Z",
				reading_time_minutes: 8,
				public_reactions_count: 142,
				comments_count: 18,
				tag_list: ["typescript", "webdev", "javascript"],
				body_markdown: "## Introduction\n\nTypeScript continues to evolve with powerful typing features.",
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://dev.to/api/articles/alexsmith/mastering-typescript-in-2024");
				return {
					content: JSON.stringify(articleData),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://dev.to/alexsmith/mastering-typescript-in-2024",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.method).toBe("devto");
			expect(result.content).toContain("# Mastering TypeScript in 2024");
			expect(result.content).toContain("**Author:** Alex Smith (@alexsmith)");
			expect(result.content).toContain("**Published:** 2024-01-15");
			expect(result.content).toContain("**Reading time:** 8 min");
			expect(result.content).toContain("**Reactions:** 142");
			expect(result.content).toContain("**Comments:** 18");
			expect(result.content).toContain("**Tags:** #typescript, #webdev, #javascript");
			expect(result.content).toContain("---\n\n## Introduction\n\nTypeScript continues to evolve");
		});

		it("renders user profile and tag listings", async () => {
			const userArticles = [
				{
					title: "Building Microservices",
					user: { name: "Ben", username: "ben" },
					reading_time_minutes: 5,
					public_reactions_count: 85,
					published_at: "2024-02-01T00:00:00.000Z",
					tags: ["architecture"],
					description: "A guide to clean microservices.",
				},
			];

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://dev.to/api/articles?username=ben&per_page=20");
				return {
					content: JSON.stringify(userArticles),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://dev.to/ben", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# dev.to/ben");
			expect(result.content).toContain("## Recent Articles (1)");
			expect(result.content).toContain("### Building Microservices");
			expect(result.content).toContain("5 min read · 85 reactions");
			expect(result.content).toContain("Tags: #architecture");
			expect(result.content).toContain("A guide to clean microservices.");
		});
	});

	describe("stackoverflow discussion scraper", () => {
		const soDecl = DISCUSSION_DECLARATIONS.find(d => d.site === "stackoverflow")!;
		const handler = createDiscussionHandler(soDecl, "handleStackOverflow");

		it("renders question and answers with score, accepted status, tags, and answer limit (5)", async () => {
			const qData = {
				items: [
					{
						title: "How to parse JSON in TypeScript?",
						score: 85,
						answer_count: 7,
						is_answered: true,
						tags: ["typescript", "json", "types"],
						owner: { display_name: "DevUser" },
						creation_date: 1670000000,
						body: "<p>What is the best way to <code>safely parse</code> JSON?</p>",
					},
				],
			};

			const aData = {
				items: Array.from({ length: 8 }, (_, i) => ({
					score: 50 - i * 5,
					is_accepted: i === 0,
					owner: { display_name: `Answerer_${i + 1}` },
					creation_date: 1670001000 + i * 3600,
					body: `<p>Answer explanation number ${i + 1}.</p>`,
				})),
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/questions/12345678?")) {
					return {
						content: JSON.stringify(qData),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				if (url.includes("/questions/12345678/answers?")) {
					return {
						content: JSON.stringify(aData),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return { content: "{}", contentType: "application/json", finalUrl: url, ok: false, status: 404 };
			});

			const result = (await handler(
				"https://stackoverflow.com/questions/12345678/how-to-parse-json",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.method).toBe("stackexchange");
			expect(result.notes?.[0]).toBe("Fetched via Stack Exchange API (site=stackoverflow)");
			expect(result.content).toContain("# How to parse JSON in TypeScript?");
			expect(result.content).toContain("**Score:** 85 · **Answers:** 7 (Answered)");
			expect(result.content).toContain("**Tags:** typescript, json, types");
			expect(result.content).toContain("**Asked by:** DevUser · 2022-12-02");
			expect(result.content).toContain("---\n\n## Question\n\nWhat is the best way to `safely parse` JSON?\n\n");
			expect(result.content).toContain("---\n\n## Answers\n\n");

			// Accepted top answer
			expect(result.content).toContain(
				"### Score: 50 (Accepted) · by Answerer_1\n\nAnswer explanation number 1.\n\n---",
			);

			// 5th answer
			expect(result.content).toContain("### Score: 30 · by Answerer_5\n\nAnswer explanation number 5.\n\n---");

			// 6th and 7th answer truncated by slice(0, 5)
			expect(result.content).not.toContain("Answerer_6");
			expect(result.content).not.toContain("Answerer_7");
		});

		it("extracts site parameter for standalone and subdomain Stack Exchange sites", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toContain("site=superuser");
				return {
					content: JSON.stringify({
						items: [
							{
								title: "SuperUser Question",
								score: 10,
								answer_count: 0,
								is_answered: false,
								tags: ["linux"],
								owner: { display_name: "su_user" },
								creation_date: 1670000000,
								body: "<p>body</p>",
							},
						],
					}),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://superuser.com/questions/555/test", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.notes?.[0]).toBe("Fetched via Stack Exchange API (site=superuser)");
		});
	});
});
