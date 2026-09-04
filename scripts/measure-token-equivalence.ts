/**
 * Token equivalence measurement between a git base reference and the working tree.
 *
 * For each candidate TypeScript/TSX file in a diff, tokenizes both the base ref and the working tree
 * using `@babel/parser` (with comments and whitespace stripped) to classify changes:
 * - `identical-tokens`: exact same token stream -> formatting-only file.
 * - `import-reorder`: token streams differ only by the ordering of whole top-level import statements.
 * - `changed`: code token modifications (real changes).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type ParseResult, parse } from "@babel/parser";
import type { File, Statement } from "@babel/types";

export interface TokenRepresentation {
	readonly type: string;
	readonly value: string | number | boolean;
}

export interface TokenWithRange extends TokenRepresentation {
	readonly start: number;
	readonly end: number;
}

export interface TokenizeResult {
	readonly ast: ParseResult<File>;
	readonly tokens: readonly TokenWithRange[];
}

export interface TokenEquivalenceLedger {
	readonly generatedFrom: string;
	readonly formattingOnly: Readonly<Record<string, string>>;
	readonly importReorder: Readonly<Record<string, string>>;
	readonly changedCount: number;
	readonly changed: readonly string[];
}

export interface MeasureOptions {
	readonly repoRoot?: string;
	readonly baseRef?: string;
	/**
	 * The branch side of the comparison. `HEAD` reads each candidate from the working tree, which is
	 * what a checkout of the branch has on disk; any other ref reads the file out of that commit, so
	 * a mirror whose HEAD is not the branch still measures the branch.
	 */
	readonly headRef?: string;
	readonly ledgerPath?: string;
}

/** Repository root, derived from this file's location. */
export const REPO_ROOT = resolve(import.meta.dirname, "..");
export const DEFAULT_LEDGER_PATH = resolve(REPO_ROOT, "scripts/fixtures/token-equivalence.json");

/**
 * Tokenizes ECMAScript / TypeScript / JSX source using `@babel/parser`.
 * Drops comments, whitespace, and EOF tokens, returning normalized `{ type, value, start, end }` tokens.
 */
export function tokenize(code: string): TokenizeResult {
	const ast = parse(code, {
		plugins: ["typescript", "jsx"],
		tokens: true,
		sourceType: "module",
	});

	const rawTokens = (ast.tokens ?? []) as readonly {
		readonly type?: { readonly label?: string } | string;
		readonly value?: unknown;
		readonly start?: number;
		readonly end?: number;
	}[];

	const tokens: TokenWithRange[] = [];
	for (const t of rawTokens) {
		if (
			typeof t.type === "string" &&
			(t.type.startsWith("Comment") || t.type === "CommentLine" || t.type === "CommentBlock")
		) {
			continue;
		}
		if (t.type === "CommentLine" || t.type === "CommentBlock") {
			continue;
		}
		const label = typeof t.type === "object" && t.type !== null ? t.type.label : undefined;
		if (label === "CommentLine" || label === "CommentBlock" || label === "eof") {
			continue;
		}
		const type = label ?? (typeof t.type === "string" ? t.type : String(t.type));
		const value = t.value !== undefined ? (t.value as string | number | boolean) : type;
		tokens.push({
			type,
			value,
			start: t.start ?? 0,
			end: t.end ?? 0,
		});
	}

	return { ast, tokens };
}

/**
 * Computes a SHA-256 hex digest for a sequence of tokens.
 */
export function hashTokenStream(tokens: readonly TokenRepresentation[]): string {
	const simplified = tokens.map(t => ({ type: t.type, value: t.value }));
	return createHash("sha256").update(JSON.stringify(simplified)).digest("hex");
}

/**
 * Normalizes top-level import statement tokens by sorting whole import statement token subsequences,
 * keeping non-import tokens in their relative positions.
 */
export function normalizeImportTokens(
	ast: ParseResult<File>,
	tokens: readonly TokenWithRange[],
): TokenRepresentation[] {
	const importBlocks: Array<{
		readonly node: Statement;
		readonly tokens: readonly TokenRepresentation[];
		readonly key: string;
	}> = [];
	const body = ast.program.body;

	for (const node of body) {
		if (node.type === "ImportDeclaration") {
			const nodeTokens = tokens.filter(t => t.start >= (node.start ?? 0) && t.end <= (node.end ?? 0));
			const simplified = nodeTokens.map(t => ({ type: t.type, value: t.value }));
			importBlocks.push({
				node,
				tokens: simplified,
				key: JSON.stringify(simplified),
			});
		}
	}

	const sortedImports = [...importBlocks].sort((a, b) => a.key.localeCompare(b.key));
	const normalizedTokens: TokenRepresentation[] = [];
	let importIndex = 0;

	for (const node of body) {
		if (node.type === "ImportDeclaration") {
			const block = sortedImports[importIndex];
			if (block) {
				normalizedTokens.push(...block.tokens);
			}
			importIndex++;
		} else {
			const nodeTokens = tokens.filter(t => t.start >= (node.start ?? 0) && t.end <= (node.end ?? 0));
			normalizedTokens.push(...nodeTokens.map(t => ({ type: t.type, value: t.value })));
		}
	}

	return normalizedTokens;
}

/**
 * Computes a SHA-256 hex digest for import-normalized tokens.
 */
export function hashNormalizedImportTokens(ast: ParseResult<File>, tokens: readonly TokenWithRange[]): string {
	const normalized = normalizeImportTokens(ast, tokens);
	return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Tests whether two token streams are identical in type and value.
 */
export function areTokenStreamsEqual(t1: readonly TokenRepresentation[], t2: readonly TokenRepresentation[]): boolean {
	if (t1.length !== t2.length) {
		return false;
	}
	for (let i = 0; i < t1.length; i++) {
		const a = t1[i];
		const b = t2[i];
		if (!a || !b || a.type !== b.type || a.value !== b.value) {
			return false;
		}
	}
	return true;
}

/**
 * Checks whether two ASTs/token streams differ ONLY by the order of top-level import statements.
 */
export function checkImportReorder(
	ast1: ParseResult<File>,
	tokens1: readonly TokenWithRange[],
	ast2: ParseResult<File>,
	tokens2: readonly TokenWithRange[],
): boolean {
	const nonImport1: TokenRepresentation[] = [];
	const importStmts1: string[] = [];
	const nonImport2: TokenRepresentation[] = [];
	const importStmts2: string[] = [];

	for (const node of ast1.program.body) {
		const nodeTokens = tokens1.filter(t => t.start >= (node.start ?? 0) && t.end <= (node.end ?? 0));
		const tokenSeq = nodeTokens.map(t => ({ type: t.type, value: t.value }));
		if (node.type === "ImportDeclaration") {
			importStmts1.push(JSON.stringify(tokenSeq));
		} else {
			nonImport1.push(...tokenSeq);
		}
	}

	for (const node of ast2.program.body) {
		const nodeTokens = tokens2.filter(t => t.start >= (node.start ?? 0) && t.end <= (node.end ?? 0));
		const tokenSeq = nodeTokens.map(t => ({ type: t.type, value: t.value }));
		if (node.type === "ImportDeclaration") {
			importStmts2.push(JSON.stringify(tokenSeq));
		} else {
			nonImport2.push(...tokenSeq);
		}
	}

	if (importStmts1.length === 0 || importStmts2.length === 0) {
		return false;
	}
	if (importStmts1.length !== importStmts2.length) {
		return false;
	}

	if (nonImport1.length !== nonImport2.length) {
		return false;
	}
	for (let i = 0; i < nonImport1.length; i++) {
		const a = nonImport1[i];
		const b = nonImport2[i];
		if (!a || !b || a.type !== b.type || a.value !== b.value) {
			return false;
		}
	}

	const s1 = [...importStmts1].sort();
	const s2 = [...importStmts2].sort();
	for (let i = 0; i < s1.length; i++) {
		if (s1[i] !== s2[i]) {
			return false;
		}
	}

	return true;
}

/**
 * Sweeps diff candidates against baseRef, classifying each candidate and generating the token equivalence ledger.
 */
export function measureTokenEquivalence(options: MeasureOptions = {}): TokenEquivalenceLedger {
	const repoRoot = options.repoRoot ?? REPO_ROOT;
	const baseRef = options.baseRef ?? "origin/main";
	// ONE commit answers both halves. The sweep asks git for `base...HEAD`, which is the MERGE BASE by
	// definition, and every candidate below reads its baseline text with `git show <base>:<path>`.
	// While that second half named the moving ref, the two disagreed as soon as main advanced: a file
	// main deleted past the merge base could not be shown, so it was classified as changed by this
	// branch, which is main's edit charged to this diff.
	const headRef = options.headRef ?? "HEAD";
	const baseSha = execFileSync("git", ["merge-base", baseRef, headRef], {
		cwd: repoRoot,
		encoding: "utf-8",
	}).trim();

	const diffOutput = execFileSync("git", ["diff", "--name-only", `${baseSha}...${headRef}`], {
		cwd: repoRoot,
		encoding: "utf-8",
		maxBuffer: 20 * 1024 * 1024,
	});

	const candidatePaths = diffOutput
		.split("\n")
		.map(s => s.trim())
		.filter(s => (s.endsWith(".ts") || s.endsWith(".tsx")) && !s.endsWith(".d.ts"))
		.sort();

	const formattingOnly: Record<string, string> = {};
	const importReorder: Record<string, string> = {};
	const changed: string[] = [];

	for (const relPath of candidatePaths) {
		const fullPath = resolve(repoRoot, relPath);
		let headCode: string;
		try {
			headCode =
				headRef === "HEAD"
					? readFileSync(fullPath, "utf-8")
					: execFileSync("git", ["show", `${headRef}:${relPath}`], {
							cwd: repoRoot,
							encoding: "utf-8",
							maxBuffer: 20 * 1024 * 1024,
							stdio: ["pipe", "pipe", "ignore"],
						});
		} catch {
			changed.push(relPath);
			continue;
		}

		let mainCode: string;
		try {
			mainCode = execFileSync("git", ["show", `${baseSha}:${relPath}`], {
				cwd: repoRoot,
				encoding: "utf-8",
				maxBuffer: 20 * 1024 * 1024,
				stdio: ["pipe", "pipe", "ignore"],
			});
		} catch {
			changed.push(relPath);
			continue;
		}

		let res1: TokenizeResult;
		let res2: TokenizeResult;
		try {
			res1 = tokenize(mainCode);
			res2 = tokenize(headCode);
		} catch {
			changed.push(relPath);
			continue;
		}

		if (areTokenStreamsEqual(res1.tokens, res2.tokens)) {
			formattingOnly[relPath] = hashTokenStream(res2.tokens);
		} else if (checkImportReorder(res1.ast, res1.tokens, res2.ast, res2.tokens)) {
			importReorder[relPath] = hashNormalizedImportTokens(res2.ast, res2.tokens);
		} else {
			changed.push(relPath);
		}
	}

	return {
		generatedFrom: baseSha,
		formattingOnly,
		importReorder,
		changedCount: changed.length,
		changed,
	};
}

/**
 * Generates and writes the ledger file to disk.
 */
export function generateLedger(options: MeasureOptions = {}): TokenEquivalenceLedger {
	const ledger = measureTokenEquivalence(options);
	const targetPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH;
	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, `${JSON.stringify(ledger, null, "\t")}\n`, "utf-8");
	return ledger;
}

/**
 * `bun scripts/measure-token-equivalence.ts [baseRef] [headRef]`. Both arguments are optional and
 * default to `origin/main` and the working tree, which is what a checkout of the branch measures.
 */
if (import.meta.main) {
	const ledger = generateLedger({ baseRef: process.argv[2], headRef: process.argv[3] });
	console.log(
		`wrote the token ledger against ${ledger.generatedFrom}: ${Object.keys(ledger.formattingOnly).length} formatting-only, ${Object.keys(ledger.importReorder).length} import-reorder, ${ledger.changedCount} changed`,
	);
}
