/**
 * Rewrite markdown prompt files against an editorial style guide using an LLM.
 *
 * Identifies mutable prose lines in prompt files while preserving code blocks, Handlebars
 * expressions, HTML tags, and markdown markers. Sends prose chunks to an OpenRouter model
 * endpoint with style instructions and writes the updated markdown files to disk.
 *
 * Usage:
 *   bun scripts/rewrite-system-prompt.ts [-i <file>] [-o <file>] [--all] [--model <model>] [--dry-run]
 */

import * as path from "node:path";
import { parseArgs } from "node:util";
import STYLE_GUIDE from "./rewrite-system-prompt.style.md" with { type: "text" };

const DEFAULT_INPUT = "packages/coding-agent/src/prompts/system/system-prompt.md";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

const PROMPT_GLOBS = [
	"packages/coding-agent/src/prompts/**/*.md",
	"packages/coding-agent/src/commit/prompts/*.md",
	"packages/coding-agent/src/commit/agentic/prompts/*.md",
	"packages/coding-agent/src/autoresearch/*.md",
	"packages/coding-agent/src/discovery/builtin-rules/*.md",
	"packages/agent/src/compaction/prompts/*.md",
	"packages/ai/src/prompts/*.md",
	"tests/evals/src/suites/typescript-edit/adapter/prompts/*.md",
	"plugins/hashline/src/prompt.md",
];

const FRAGILE_RE = /\{\{[^}]*\}\}|<[^>]*>|`[^`]*`|[A-Za-z][\w+.-]*:\/\/\S+/g;

export interface ProseEntry {
	lineIndex: number;
	prefix: string;
	suffix: string;
	core: string;
	tokens: string[];
}

export interface RewritePlan {
	lines: string[];
	prose: ProseEntry[];
}

export interface RewriteItem {
	id: number;
	text: string;
	tokens: readonly string[];
}

export type RewriteChunk = (items: RewriteItem[]) => Promise<Map<number, string>>;

export function peel(line: string): { prefix: string; core: string; suffix: string } {
	let s = line;
	let suffix = "";
	for (;;) {
		const m = s.match(/(\s*\{\{[^}]*\}\}\s*)$/);
		if (!m) break;
		suffix = m[1] + suffix;
		s = s.slice(0, s.length - m[1].length);
	}
	let prefix = "";
	for (;;) {
		const m = s.match(/^(\s*\{\{[^}]*\}\}\s*)/);
		if (!m) break;
		prefix += m[1];
		s = s.slice(m[1].length);
	}
	const marker = s.match(/^(\s*(?:[-*+]\s+|\d+\.\s+))/);
	if (marker) {
		prefix += marker[1];
		s = s.slice(marker[1].length);
	}
	return { prefix, core: s, suffix };
}

export function isVerbatimLine(line: string): boolean {
	const t = line.trim();
	if (t === "" || /^#{1,6}\s/.test(t) || /^[-*=_]{3,}\s*$/.test(t)) return true;
	const residue = t
		.replace(/\{\{[^}]*\}\}/g, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/[A-Za-z][\w+.-]*:\/\/\S+/g, " ");
	const words = residue.match(/[A-Za-z]{2,}/g) ?? [];
	if (words.length === 0) return true;
	return words.length < 3 && !/[.;?!]/.test(residue);
}

export function preservesTokens(rewritten: string, tokens: readonly string[]): boolean {
	const want = new Map<string, number>();
	for (const tok of tokens) want.set(tok, (want.get(tok) ?? 0) + 1);
	for (const [tok, n] of want) {
		if (rewritten.split(tok).length - 1 < n) return false;
	}
	return true;
}

export function blockSkipMask(lines: readonly string[]): boolean[] {
	const skip = new Array<boolean>(lines.length).fill(false);
	let start = 0;
	if (lines.length > 0 && lines[0].trim() === "---") {
		let close = -1;
		for (let j = 1; j < lines.length; j++) {
			if (lines[j].trim() === "---") {
				close = j;
				break;
			}
		}
		if (close >= 0) {
			for (let k = 0; k <= close; k++) skip[k] = true;
			start = close + 1;
		}
	}
	let fenceChar: string | null = null;
	for (let i = start; i < lines.length; i++) {
		const m = lines[i].trim().match(/^(```+|~~~+)/);
		if (fenceChar === null) {
			if (m) {
				fenceChar = m[1][0];
				skip[i] = true;
			}
		} else {
			skip[i] = true;
			if (m && m[1][0] === fenceChar) fenceChar = null;
		}
	}
	return skip;
}

export function planRewrite(content: string): RewritePlan {
	const lines = content.split("\n");
	const skip = blockSkipMask(lines);
	const prose: ProseEntry[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (skip[i]) continue;
		const line = lines[i];
		if (isVerbatimLine(line)) continue;
		const { prefix, core, suffix } = peel(line);
		if (core.trim() === "") continue;
		const tokens = Array.from(core.matchAll(FRAGILE_RE), m => m[0]);
		prose.push({ lineIndex: i, prefix, suffix, core, tokens });
	}
	return { lines, prose };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
	const groups: T[][] = [];
	const step = Math.max(1, size);
	for (let i = 0; i < items.length; i += step) groups.push(items.slice(i, i + step));
	return groups;
}

async function mapPool<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const width = Math.max(1, Math.min(limit, items.length));
	const workers = Array.from({ length: width }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) break;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

export interface RewriteStats {
	totalLines: number;
	proseLines: number;
	attempted: number;
	changed: number;
	fallback: number;
}

export interface RewriteOptions {
	chunkSize: number;
	concurrency: number;
	limit: number;
	onProgress?: (done: number, total: number) => void;
}

export async function rewriteAll(
	content: string,
	rewriteChunk: RewriteChunk,
	opts: RewriteOptions,
): Promise<{ content: string; stats: RewriteStats }> {
	const plan = planRewrite(content);
	const lines = [...plan.lines];
	const toRewrite = opts.limit > 0 ? plan.prose.slice(0, opts.limit) : plan.prose;
	const groups = chunk(toRewrite, opts.chunkSize);

	let done = 0;
	const resolved = await mapPool(groups, opts.concurrency, async group => {
		const items: RewriteItem[] = group.map(e => ({ id: e.lineIndex, text: e.core, tokens: e.tokens }));
		let map: Map<number, string>;
		try {
			map = await rewriteChunk(items);
		} catch {
			map = new Map();
		}
		const out = group.map(entry => {
			const candidate = map.get(entry.lineIndex);
			return { entry, text: candidate ?? entry.core, ok: candidate != null };
		});
		done += group.length;
		opts.onProgress?.(done, toRewrite.length);
		return out;
	});

	let changed = 0;
	let fallback = 0;
	for (const group of resolved) {
		for (const { entry, text, ok } of group) {
			const rebuilt = entry.prefix + text + entry.suffix;
			lines[entry.lineIndex] = rebuilt;
			if (!ok) fallback++;
			else if (rebuilt !== plan.lines[entry.lineIndex]) changed++;
		}
	}

	return {
		content: lines.join("\n"),
		stats: {
			totalLines: plan.lines.length,
			proseLines: plan.prose.length,
			attempted: toRewrite.length,
			changed,
			fallback,
		},
	};
}

export function parseItemsResponse(text: string): { id: number; text: string }[] {
	let s = text.trim();
	const fence = s.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
	if (fence) s = fence[1].trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(s);
	} catch {
		const start = s.indexOf("{");
		const end = s.lastIndexOf("}");
		if (start < 0 || end <= start) throw new Error("response is not JSON");
		parsed = JSON.parse(s.slice(start, end + 1));
	}
	if (!parsed || typeof parsed !== "object" || !("items" in parsed) || !Array.isArray(parsed.items)) {
		throw new Error("response missing items[]");
	}
	const out: { id: number; text: string }[] = [];
	for (const it of parsed.items) {
		if (it && typeof it === "object" && "id" in it && "text" in it) {
			if (typeof it.id === "number" && typeof it.text === "string") {
				out.push({ id: it.id, text: it.text });
			}
		}
	}
	return out;
}

interface OpenRouterOptions {
	apiKey: string;
	model: string;
	baseUrl: string;
	temperature: number;
	retries: number;
	system: string;
}

const REWRITE_RESPONSE_FORMAT = {
	type: "json_schema",
	json_schema: {
		name: "rewrites",
		strict: true,
		schema: {
			type: "object",
			additionalProperties: false,
			properties: {
				items: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: { type: "integer" },
							text: { type: "string" },
						},
						required: ["id", "text"],
					},
				},
			},
			required: ["items"],
		},
	},
} as const;

export function makeOpenRouterRewriter(opts: OpenRouterOptions): RewriteChunk {
	return async items => {
		const result = new Map<number, string>();
		let pending = items;
		let lastErr: unknown;
		for (let attempt = 0; attempt <= opts.retries && pending.length > 0; attempt++) {
			try {
				const body = JSON.stringify({
					model: opts.model,
					temperature: opts.temperature,
					response_format: REWRITE_RESPONSE_FORMAT,
					messages: [
						{ role: "system", content: opts.system },
						{ role: "user", content: JSON.stringify({ items: pending.map(p => ({ id: p.id, text: p.text })) }) },
					],
				});
				const res = await fetch(`${opts.baseUrl}/chat/completions`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${opts.apiKey}`,
						"Content-Type": "application/json",
						"HTTP-Referer": "https://veyyon.dev/",
						"X-Title": "Veyyon",
					},
					body,
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
				const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
				const content = data.choices?.[0]?.message?.content;
				if (typeof content !== "string") throw new Error("no message content");
				const got = new Map<number, string>();
				for (const it of parseItemsResponse(content)) got.set(it.id, it.text);
				const stillPending: RewriteItem[] = [];
				for (const p of pending) {
					const text = got.get(p.id);
					if (text != null && preservesTokens(text, p.tokens)) result.set(p.id, text);
					else stillPending.push(p);
				}
				pending = stillPending;
			} catch (err) {
				lastErr = err;
			}
			if (pending.length > 0 && attempt < opts.retries) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, 400 * (attempt + 1));
				await promise;
			}
		}
		if (pending.length > 0) {
			console.error(
				`  ${pending.length} line(s) [${pending.map(p => p.id).join(",")}] kept original: ${String(lastErr ?? "rewrite dropped a token")}`,
			);
		}
		return result;
	};
}

async function collectPromptFiles(): Promise<string[]> {
	const root = path.resolve(import.meta.dir, "..");
	const seen = new Set<string>();
	for (const pattern of PROMPT_GLOBS) {
		for await (const rel of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
			if (!rel.endsWith(".rewritten.md")) seen.add(path.join(root, rel));
		}
	}
	return [...seen].sort();
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			input: { type: "string", short: "i" },
			output: { type: "string", short: "o" },
			all: { type: "boolean", default: false },
			model: { type: "string", default: DEFAULT_MODEL },
			"base-url": { type: "string", default: DEFAULT_BASE_URL },
			chunk: { type: "string", default: "3" },
			concurrency: { type: "string", default: "6" },
			retries: { type: "string", default: "2" },
			temperature: { type: "string", default: "0.4" },
			limit: { type: "string", default: "0" },
			"dry-run": { type: "boolean", default: false },
		},
		allowPositionals: false,
	});

	const input = values.input ?? DEFAULT_INPUT;
	const output = values.output ?? input;
	const dryRun = values["dry-run"] ?? false;
	const model = values.model ?? DEFAULT_MODEL;
	const chunkSize = Number(values.chunk ?? 3);
	const concurrency = Number(values.concurrency ?? 6);
	const retries = Number(values.retries ?? 2);
	const temperature = Number(values.temperature ?? 0.4);
	const limit = Number(values.limit ?? 0);

	const files = values.all ? await collectPromptFiles() : [input];
	if (files.length === 0) {
		console.error("No prompt files matched.");
		return;
	}

	if (dryRun) {
		for (const file of files) {
			const content = await Bun.file(file).text();
			const plan = planRewrite(content);
			const groups = chunk(limit > 0 ? plan.prose.slice(0, limit) : plan.prose, chunkSize);
			console.error(
				`${file}: ${plan.lines.length} lines, ${plan.prose.length} prose, ${plan.lines.length - plan.prose.length} verbatim, ${groups.length} chunk(s).`,
			);
		}
		console.error("Dry run: no network calls, nothing written.");
		return;
	}

	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		console.error("Error: OPENROUTER_API_KEY is not set.");
		process.exit(1);
	}

	const rewriteChunk = makeOpenRouterRewriter({
		apiKey,
		model,
		baseUrl: values["base-url"] ?? DEFAULT_BASE_URL,
		temperature,
		retries,
		system: STYLE_GUIDE,
	});

	for (const file of files) {
		const outPath = values.all ? file : output;
		const content = await Bun.file(file).text();
		const { content: rewritten, stats } = await rewriteAll(content, rewriteChunk, {
			chunkSize,
			concurrency,
			limit,
			onProgress: (done, total) => {
				if (done === total || done % 10 === 0) console.error(`  ${file}: ${done}/${total} prose lines`);
			},
		});
		await Bun.write(outPath, rewritten);
		console.error(
			`Wrote ${outPath}: ${stats.changed} changed, ${stats.fallback} fallback, ${stats.proseLines} prose / ${stats.totalLines} lines (model ${model}).`,
		);
	}
}

if (import.meta.main) {
	await main();
}
