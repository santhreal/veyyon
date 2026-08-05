#!/usr/bin/env node
/**
 * Render the blog from Markdown sources into site-styled HTML.
 *
 *   node website/tools/gen-blog.mjs
 *
 * Source of truth: website/blog/<slug>.md, each with YAML-ish frontmatter
 * (title, slug, date, summary, draft). This renders every post to
 * website/blog/<slug>.html and writes website/blog/index.html listing the
 * published ones. Cloudflare Pages serves /blog/<slug> from <slug>.html, so the
 * public URL for a post is https://veyyon.dev/blog/<slug>.
 *
 * Drafts still render (so a direct link resolves for review) but are marked,
 * excluded from the sitemap, and served `noindex`. `buildBlog()` returns the
 * published post URLs so the site build can fold them into sitemap.xml.
 *
 * The Markdown subset is deliberately small — headings, paragraphs, fenced code,
 * inline code, bold, italic, links, and lists — which is all a design essay
 * needs and keeps the renderer auditable. Anything outside it renders as plain
 * escaped text rather than silently vanishing.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderNav } from "./nav.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = join(HERE, "..", "blog");
const SITE = "https://veyyon.dev";

/** Escape the five HTML-significant characters. */
export function escapeHtml(text) {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Parse `--- ... ---` frontmatter into a flat object plus the remaining body.
 * Values may be bare or wrapped in single/double quotes; `true`/`false` become
 * booleans. Keys with no closing `---` are a hard error, not a silent skip.
 */
export function parseFrontmatter(raw, source) {
	const text = raw.replace(/^﻿/, "");
	if (!text.startsWith("---\n")) {
		throw new Error(`${source}: missing frontmatter (must start with a "---" line)`);
	}
	const end = text.indexOf("\n---", 4);
	if (end === -1) {
		throw new Error(`${source}: frontmatter is not closed with a "---" line`);
	}
	const block = text.slice(4, end);
	const body = text.slice(text.indexOf("\n", end + 1) + 1);
	const data = {};
	for (const line of block.split("\n")) {
		if (!line.trim()) continue;
		const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
		if (!m) throw new Error(`${source}: cannot parse frontmatter line: ${line}`);
		let value = m[2].trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (value === "true") value = true;
		else if (value === "false") value = false;
		data[m[1]] = value;
	}
	return { data, body };
}

/**
 * Sentinel wrapping an extracted inline-code span while the other inline rules run.
 *
 * Written as an escape, and a private-use character rather than NUL. Two literal
 * NUL bytes used to sit in this source, which made the whole file read as BINARY
 * to grep and ripgrep: every repo-wide search for anything in the blog pipeline
 * silently skipped this file, including the searches used to audit it. A post
 * containing the sentinel could also have forged a code span, so the input is
 * stripped of it first.
 */
const CODE_SENTINEL = "\uE000";

/** Render inline spans: code, links, bold, italic. Input is raw Markdown. */
export function renderInline(text) {
	// Protect inline code first so its contents never hit the other rules.
	const codes = [];
	let out = text.replaceAll(CODE_SENTINEL, "").replace(/`([^`]+)`/g, (_m, code) => {
		codes.push(code);
		return `${CODE_SENTINEL}${codes.length - 1}${CODE_SENTINEL}`;
	});
	out = escapeHtml(out);
	out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|[^\s)]+)\)/g, (_m, label, url) => {
		return `<a href="${escapeHtml(url)}">${label}</a>`;
	});
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
	out = out.replace(new RegExp(`${CODE_SENTINEL}(\\d+)${CODE_SENTINEL}`, "g"), (_m, i) => {
		return `<code class="inline">${escapeHtml(codes[Number(i)])}</code>`;
	});
	return out;
}

/** Render a Markdown body (frontmatter already stripped) to HTML. */
export function renderMarkdown(md) {
	const lines = md.split("\n");
	const html = [];
	let i = 0;

	const flushParagraph = (buf) => {
		if (buf.length) html.push(`<p>${renderInline(buf.join(" "))}</p>`);
		buf.length = 0;
	};

	const paragraph = [];
	while (i < lines.length) {
		const line = lines[i];

		// Fenced code block.
		const fence = line.match(/^```(\w*)\s*$/);
		if (fence) {
			flushParagraph(paragraph);
			const lang = fence[1];
			const code = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) {
				code.push(lines[i]);
				i++;
			}
			i++; // consume the closing fence
			const cls = lang ? ` class="language-${lang}"` : "";
			html.push(`<pre class="code"><code${cls}>${escapeHtml(code.join("\n"))}</code></pre>`);
			continue;
		}

		// Heading.
		const head = line.match(/^(#{1,4})\s+(.*)$/);
		if (head) {
			flushParagraph(paragraph);
			const level = head[1].length;
			html.push(`<h${level}>${renderInline(head[2].trim())}</h${level}>`);
			i++;
			continue;
		}

		// Unordered / ordered list block.
		if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
			flushParagraph(paragraph);
			const ordered = /^\s*\d+\.\s+/.test(line);
			const items = [];
			while (
				i < lines.length &&
				(/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))
			) {
				const item = lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, "");
				items.push(`<li>${renderInline(item)}</li>`);
				i++;
			}
			const tag = ordered ? "ol" : "ul";
			html.push(`<${tag}>${items.join("")}</${tag}>`);
			continue;
		}

		// Blank line ends a paragraph.
		if (!line.trim()) {
			flushParagraph(paragraph);
			i++;
			continue;
		}

		paragraph.push(line.trim());
		i++;
	}
	flushParagraph(paragraph);
	return html.join("\n");
}

// The nav comes from the one owner (tools/nav.mjs), the same source build.mjs
// writes into the hand-authored pages. This file used to keep its own copy, which
// is why blog pages never marked Blog as the current page. `../` is the prefix a
// page at /blog/ needs to reach the site root.
const HEADER_NAV = renderNav({ prefix: "../", current: "blog", cta: true, indent: "      " });
const FOOTER_NAV = renderNav({ prefix: "../", current: "blog", cta: false, indent: "      " });

/** The shared header/footer shell, with `../` asset paths for /blog/ depth. */
function shell({ title, description, canonical, noindex, body, tallSunset = true }) {
	const robots = noindex ? '\n<meta name="robots" content="noindex" />' : "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#000000" />
<link rel="icon" type="image/svg+xml" href="../favicon.svg" />
<link rel="icon" href="../favicon.ico" sizes="48x48" />
<link rel="apple-touch-icon" href="../apple-touch-icon.png" />
<link rel="manifest" href="../site.webmanifest" />
<meta property="og:site_name" content="Veyyon" />
<meta property="og:type" content="article" />
<meta property="og:image" content="https://veyyon.dev/og.png" />
${robots}
<title>${escapeHtml(title)} | Veyyon</title>
<meta property="og:title" content="${escapeHtml(title)} | Veyyon" />
<meta property="og:url" content="${canonical}" />
<link rel="canonical" href="${canonical}" />
<meta name="description" content="${escapeHtml(description)}" />
<link rel="preload" href="../fonts/JetBrainsMono-Bold.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="../fonts/Inter-Regular.woff2" as="font" type="font/woff2" crossorigin />
<link rel="stylesheet" href="../site.css" />
</head>
<body>

<header class="site">
  <div class="wrap nav">
    <a class="brand" href="../">veyyon</a>
    <nav>
    <!--NAV:START-->
${HEADER_NAV}
    <!--NAV:END-->
    </nav>
    <details class="nav-menu"><summary>menu</summary>
      <nav>
      <!--NAV:START-->
${HEADER_NAV}
      <!--NAV:END-->
      </nav>
    </details>
  </div>
  <div class="suntrack" aria-hidden="true"><canvas data-sun="progress" width="14" height="14"></canvas></div>
</header>

<main class="wrap">
${body}
</main>

<div class="sunset${tallSunset ? " tall" : ""}" aria-hidden="true"><canvas data-sun="sunset"></canvas></div>

<footer class="site">
  <div class="wrap foot">
    <div>
      <span class="brand">veyyon</span>
      <div class="attrib">A fork of <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a> (MIT), by Can Boluk. Built as its own product.</div>
    </div>
    <nav>
    <!--NAV:START-->
${FOOTER_NAV}
    <!--NAV:END-->
    </nav>
  </div>
</footer>

<script src="../sun-field.js" defer></script>
<script src="../motion.js" defer></script>
<script src="../sunmark.js" defer></script>
</body>
</html>
`;
}

/** Human date like "July 19, 2026" from an ISO `YYYY-MM-DD`, or the raw value. */
export function formatDate(iso) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
	if (!m) return String(iso);
	const months = [
		"January", "February", "March", "April", "May", "June",
		"July", "August", "September", "October", "November", "December",
	];
	return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** A publishable slug: lowercase, digits, dashes. It becomes the public URL. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Dates are ISO `YYYY-MM-DD`; the index sorts on them and the page prints them. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read and parse every `*.md` post, newest first.
 *
 * Every rule below throws instead of warning. Merging a report to `main` deploys
 * the site (see `.github/workflows/site.yml`), so a malformed report has to break
 * the build while it is still a pull request. If these degraded quietly the site
 * would publish a post with no date, an unreachable URL, or — for two files that
 * resolve to the same slug — one report silently overwriting the other's HTML.
 */
export function readPosts(dir = BLOG_DIR) {
	const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	const seen = new Map();
	const posts = files.map((file) => {
		const source = join(dir, file);
		const { data, body } = parseFrontmatter(readFileSync(source, "utf8"), source);
		const slug = data.slug || file.replace(/\.md$/, "");
		if (!data.title) throw new Error(`${source}: frontmatter is missing a title`);
		if (!SLUG_RE.test(slug)) {
			throw new Error(
				`${source}: slug "${slug}" is not URL-safe (lowercase letters, digits, and single dashes only)`,
			);
		}
		if (seen.has(slug)) {
			throw new Error(
				`${source}: slug "${slug}" is already used by ${seen.get(slug)} — two posts cannot share one URL`,
			);
		}
		seen.set(slug, source);
		if (data.draft !== true) {
			if (!DATE_RE.test(String(data.date || ""))) {
				throw new Error(`${source}: published posts need an ISO date (date: YYYY-MM-DD)`);
			}
			if (!String(data.summary || "").trim()) {
				throw new Error(`${source}: published posts need a summary (it is the blog index card text)`);
			}
		}
		// The layout renders the frontmatter title as the page's single <h1>, so a
		// leading `# ...` in the body would be a duplicate (and second) heading.
		// Drop it; the frontmatter title is the one source of truth for the title.
		const trimmed = body.replace(/^\s*#[^\n]*\n+/, "");
		return {
			slug,
			title: data.title,
			date: data.date || "",
			summary: data.summary || "",
			draft: data.draft === true,
			body: trimmed,
		};
	});
	posts.sort((a, b) => String(b.date).localeCompare(String(a.date)));
	return posts;
}

/** Render one post to its HTML file and return its canonical URL. */
function renderPost(post) {
	const canonical = `${SITE}/blog/${post.slug}`;
	const badge = post.draft ? '<span class="pill pending">Draft</span>' : "";
	const dateLine = post.date
		? `<time datetime="${escapeHtml(post.date)}">${escapeHtml(formatDate(post.date))}</time>`
		: "";
	const body = `  <article class="post">
    <div class="post-head">
      <span class="kicker">Blog</span>
      ${badge}
      <h1>${escapeHtml(post.title)}</h1>
      <div class="post-meta">${dateLine}</div>
    </div>
    <div class="post-body">
${renderMarkdown(post.body)}
    </div>
    <div class="post-foot"><a href="../blog/">← All posts</a></div>
  </article>`;
	const html = shell({
		title: post.title,
		description: post.summary || post.title,
		canonical,
		noindex: post.draft,
		body,
	});
	writeFileSync(join(BLOG_DIR, `${post.slug}.html`), html);
	return canonical;
}

/** Render the blog index listing published posts. */
function renderIndex(posts) {
	const published = posts.filter((p) => !p.draft);
	const cards = published
		.map((p) => {
			const date = p.date
				? `<time datetime="${escapeHtml(p.date)}">${escapeHtml(formatDate(p.date))}</time>`
				: "";
			return `      <li class="post-card">
        <a href="./${p.slug}">
          <div class="post-card-meta">${date}</div>
          <h2>${escapeHtml(p.title)}</h2>
          <p>${escapeHtml(p.summary)}</p>
        </a>
      </li>`;
		})
		.join("\n");
	const list = published.length
		? `    <ul class="post-list">\n${cards}\n    </ul>`
		: `    <p class="post-empty">No reports published yet. Until the first one lands, the
      <a href="../docs/">handbook</a> documents how veyyon works and the
      <a href="../changelog.html">changelog</a> records what each release changed.</p>`;
	const body = `  <div class="page-head">
    <span class="kicker">Blog</span>
    <h1>Notes on the tools.</h1>
    <p>Technical reports and engineering notes from building Veyyon. Each one is a Markdown file in the repository, rendered here.</p>
  </div>

  <section>
${list}
  </section>`;
	const html = shell({
		title: "Blog",
		description: "Technical reports and engineering notes from building Veyyon: the harness, the edit format, compaction, and the tools around them.",
		canonical: `${SITE}/blog/`,
		noindex: false,
		body,
		tallSunset: false,
	});
	writeFileSync(join(BLOG_DIR, "index.html"), html);
}

/**
 * Build the whole blog. Returns the canonical URLs of the *published* posts plus
 * the index, for the caller to add to sitemap.xml.
 */
export function buildBlog() {
	const posts = readPosts();
	const publishedUrls = [];
	for (const post of posts) {
		const url = renderPost(post);
		if (!post.draft) publishedUrls.push(url);
	}
	renderIndex(posts);
	const drafts = posts.filter((p) => p.draft).map((p) => p.slug);
	console.log(
		`blog: rendered ${posts.length} post(s)` +
			(drafts.length ? ` (${drafts.length} draft: ${drafts.join(", ")})` : ""),
	);
	return { publishedUrls, indexUrl: `${SITE}/blog/`, drafts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	buildBlog();
}
