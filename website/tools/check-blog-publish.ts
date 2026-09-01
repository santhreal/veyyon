#!/usr/bin/env bun
/**
 * Publish gate for the report/blog sync.
 *
 *   bun website/tools/check-blog-publish.ts
 *
 * `website/blog/*.md` is the single source of truth for technical reports, and
 * merging one to `main` deploys the site (`.github/workflows/site.yml`). This
 * asserts the rendered tree actually matches those sources before anything is
 * published, because every failure mode here is silent otherwise: a post that
 * renders but never reaches the sitemap is invisible to search, a post missing
 * from the index is unreachable by a reader, and a draft that leaks into the
 * sitemap or loses its `noindex` is published by accident.
 *
 * Run it after `node website/build.mjs`; it reads the build's output, never
 * regenerates it, so a stale build fails instead of being papered over.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs module, no types; imported for its exports.
import { readPosts } from "./gen-blog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = join(HERE, "..", "blog");
const SITEMAP = join(HERE, "..", "sitemap.xml");

type Post = { slug: string; title: string; date: string; summary: string; draft: boolean };

const problems: string[] = [];
const posts: Post[] = readPosts();
const sitemap = readFileSync(SITEMAP, "utf8");
const index = readFileSync(join(BLOG_DIR, "index.html"), "utf8");

for (const post of posts) {
	let html: string;
	try {
		html = readFileSync(join(BLOG_DIR, `${post.slug}.html`), "utf8");
	} catch {
		problems.push(`${post.slug}: no rendered blog/${post.slug}.html — run \`node website/build.mjs\``);
		continue;
	}
	const url = `https://veyyon.dev/blog/${post.slug}`;
	const inSitemap = sitemap.includes(`<loc>${url}</loc>`);
	const inIndex = index.includes(`href="./${post.slug}"`);
	const noindex = html.includes('<meta name="robots" content="noindex" />');

	if (post.draft) {
		if (inSitemap) problems.push(`${post.slug}: draft is in sitemap.xml — drafts must not be indexed`);
		if (inIndex) problems.push(`${post.slug}: draft is listed on the blog index — drafts are link-only`);
		if (!noindex) problems.push(`${post.slug}: draft page is missing its noindex robots meta`);
	} else {
		if (!inSitemap) problems.push(`${post.slug}: published post is missing from sitemap.xml`);
		if (!inIndex) problems.push(`${post.slug}: published post is missing from the blog index`);
		if (noindex) problems.push(`${post.slug}: published post is served noindex`);
		if (!html.includes(`>${post.title.replace(/&/g, "&amp;")}<`) && !html.includes(post.title)) {
			problems.push(`${post.slug}: rendered page does not contain the frontmatter title`);
		}
		if (!html.includes(`datetime="${post.date}"`)) {
			problems.push(`${post.slug}: rendered page does not carry the frontmatter date ${post.date}`);
		}
	}
}

// The reverse direction: a sitemap entry with no source is a dead URL, which
// happens when a report is renamed or deleted and the region is not reconciled.
const slugs = new Set(posts.map((p) => p.slug));
for (const [, slug] of sitemap.matchAll(/<loc>https:\/\/veyyon\.dev\/blog\/([a-z0-9-]+)<\/loc>/g)) {
	if (!slugs.has(slug)) problems.push(`sitemap.xml lists /blog/${slug}, which has no source in website/blog/`);
}

const published = posts.filter((p) => !p.draft).length;
if (problems.length) {
	console.error(`blog publish gate FAILED (${problems.length} problem(s)):`);
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log(
	`blog publish gate OK: ${published} published post(s), ${posts.length - published} draft(s) held back`,
);
