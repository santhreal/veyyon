#!/usr/bin/env bun
// Internal-link checker for every tracked markdown file: resolves relative
// links/images against the working tree and heading anchors, and fails loudly
// on dead ones. External (http/mailto/tel/data) targets are out of scope;
// site-absolute `/...` targets are counted and reported as skipped, never
// silently dropped. CI gate: .github/workflows/docs.yml.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface DeadLink {
	file: string;
	line: number;
	target: string;
	reason: string;
}

export interface LinkCheckResult {
	filesChecked: number;
	linksChecked: number;
	skippedExternal: number;
	skippedAbsolute: string[];
	dead: DeadLink[];
}

const SKIP_SCHEMES = /^(https?:|mailto:|tel:|data:|ftp:|irc:)/i;

/** GitHub/mdBook-style heading slug (lowercase, punctuation stripped, spaces → dashes). */
export function slugify(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/<[^>]+>/g, "")
		.replace(/[`*_~[\]()!]/g, "")
		.replace(/[^\p{L}\p{N} \-_]/gu, "")
		.replace(/ /g, "-");
}

/** Strip fenced code blocks and inline code spans so sample links are not scanned. */
function stripCode(markdown: string): string {
	const lines = markdown.split("\n");
	let inFence = false;
	let fenceMarker = "";
	const out = lines.map(line => {
		const fence = line.match(/^\s*(```+|~~~+)/);
		if (fence) {
			if (!inFence) {
				inFence = true;
				fenceMarker = fence[1][0].repeat(3);
			} else if (fence[1].startsWith(fenceMarker)) {
				inFence = false;
			}
			return "";
		}
		if (inFence) return "";
		return line.replace(/`[^`]*`/g, "");
	});
	return out.join("\n");
}

/** Collect every anchor a file exposes: heading slugs (deduped -1/-2…), {#custom-id}, and HTML id/name attributes.
 * Headings keep their inline-code text (slugify drops the backticks themselves), so `## The `.env` file`
 * slugs to the-env-file exactly as GitHub/mdBook render it; only fenced blocks are excluded. */
export function collectAnchors(markdown: string): Set<string> {
	const anchors = new Set<string>();
	const counts = new Map<string, number>();
	let inFence = false;
	for (const line of markdown.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
		if (heading) {
			let text = heading[1];
			const custom = text.match(/\{#([^}]+)\}\s*$/);
			if (custom) {
				anchors.add(custom[1]);
				text = text.replace(/\{#[^}]+\}\s*$/, "");
			}
			const base = slugify(text);
			const seen = counts.get(base) ?? 0;
			counts.set(base, seen + 1);
			anchors.add(seen === 0 ? base : `${base}-${seen}`);
		}
	}
	for (const m of markdown.matchAll(/<(?:a|h[1-6]|div|section|span)[^>]*\s(?:id|name)=["']([^"']+)["']/g)) {
		anchors.add(m[1]);
	}
	return anchors;
}

interface FoundLink {
	target: string;
	line: number;
}

/** Extract inline links/images and reference definitions with their 1-based line numbers. */
export function extractLinks(markdown: string): FoundLink[] {
	const found: FoundLink[] = [];
	const lines = stripCode(markdown).split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const m of line.matchAll(/!?\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^()\s]+(?:\([^()]*\)[^()\s]*)*)/g)) {
			let target = m[1];
			if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
			if (target) found.push({ target, line: i + 1 });
		}
		const refDef = line.match(/^\s{0,3}\[[^\]]+\]:\s+(<[^>]*>|\S+)/);
		if (refDef) {
			let target = refDef[1];
			if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
			found.push({ target, line: i + 1 });
		}
	}
	return found;
}

export function checkDocLinks(rootDir: string, relFiles: string[]): LinkCheckResult {
	const anchorCache = new Map<string, Set<string>>();
	const anchorsFor = (absPath: string): Set<string> => {
		let anchors = anchorCache.get(absPath);
		if (!anchors) {
			anchors = collectAnchors(fs.readFileSync(absPath, "utf8"));
			anchorCache.set(absPath, anchors);
		}
		return anchors;
	};

	const result: LinkCheckResult = {
		filesChecked: 0,
		linksChecked: 0,
		skippedExternal: 0,
		skippedAbsolute: [],
		dead: [],
	};
	for (const rel of relFiles) {
		const abs = path.join(rootDir, rel);
		if (!fs.existsSync(abs)) continue;
		const markdown = fs.readFileSync(abs, "utf8");
		result.filesChecked++;
		for (const { target, line } of extractLinks(markdown)) {
			// `$VAR`/`$$$X` targets are template or grep-rule placeholders, not links.
			if (target.includes("$")) continue;
			if (SKIP_SCHEMES.test(target)) {
				result.skippedExternal++;
				continue;
			}
			if (target.startsWith("/")) {
				result.skippedAbsolute.push(`${rel}:${line} -> ${target}`);
				continue;
			}
			result.linksChecked++;
			const hashIndex = target.indexOf("#");
			const filePart = decodeURIComponent(hashIndex === -1 ? target : target.slice(0, hashIndex));
			const anchor = hashIndex === -1 ? "" : decodeURIComponent(target.slice(hashIndex + 1));

			let resolved = abs;
			if (filePart !== "") {
				resolved = path.resolve(path.dirname(abs), filePart);
				// Relative targets that climb out of the repo are GitHub-web-relative
				// (e.g. ../../discussions from a root file resolves to the repo's
				// Discussions tab on github.com) — report as skipped, don't fail.
				if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
					result.skippedAbsolute.push(`${rel}:${line} -> ${target} (escapes repo; github-web-relative)`);
					continue;
				}
				if (!fs.existsSync(resolved)) {
					// mdBook renders foo.md as foo.html; accept an .html target whose .md source exists.
					const mdTwin = resolved.replace(/\.html$/, ".md");
					if (resolved.endsWith(".html") && fs.existsSync(mdTwin)) {
						resolved = mdTwin;
					} else {
						result.dead.push({ file: rel, line, target, reason: "file not found" });
						continue;
					}
				}
			}
			if (anchor !== "" && resolved.endsWith(".md")) {
				if (!anchorsFor(resolved).has(anchor)) {
					result.dead.push({
						file: rel,
						line,
						target,
						reason: `anchor #${anchor} not found in ${path.relative(rootDir, resolved)}`,
					});
				}
			}
		}
	}
	return result;
}

export function listTrackedMarkdown(rootDir: string): string[] {
	const proc = spawnSync("git", ["ls-files", "*.md", "**/*.md"], { cwd: rootDir, encoding: "utf8" });
	if (proc.status !== 0) throw new Error(`git ls-files failed: ${proc.stderr}`);
	return (
		[...new Set(proc.stdout.split("\n"))]
			.filter(f => f !== "")
			.filter(f => !f.startsWith("docs/handbook/book/"))
			.filter(f => !f.includes("/vendor/"))
			.filter(f => !f.includes("node_modules/"))
			// Changelogs are immutable historical records; their old links pointed at
			// upstream trees that no longer exist and must not be rewritten.
			.filter(f => !f.endsWith("CHANGELOG.md"))
			// Grep-rule pattern docs use [...](...) as rule syntax, not markdown links.
			.filter(f => !f.includes("/discovery/builtin-rules/"))
	);
}

if (import.meta.main) {
	const rootDir = path.resolve(import.meta.dir, "..");
	const result = checkDocLinks(rootDir, listTrackedMarkdown(rootDir));
	console.log(
		`checked ${result.linksChecked} internal links across ${result.filesChecked} markdown files ` +
			`(${result.skippedExternal} external skipped, ${result.skippedAbsolute.length} site-absolute skipped)`,
	);
	for (const entry of result.skippedAbsolute) console.log(`  skipped-absolute: ${entry}`);
	if (result.dead.length > 0) {
		console.error(`\n${result.dead.length} dead internal link(s):`);
		for (const d of result.dead) console.error(`  ${d.file}:${d.line}: ${d.target} (${d.reason})`);
		process.exit(1);
	}
}
