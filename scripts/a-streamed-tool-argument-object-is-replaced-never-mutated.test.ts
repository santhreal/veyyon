/**
 * A streamed tool call's `arguments` object is replaced, never written into.
 *
 * `agentLoop` pushes a `message_update` snapshot on every streaming delta, and
 * subscribers hold those snapshots: the transcript rebuild, the tool-call
 * preview, the collab wire. A delta snapshot copies the block but shares the
 * `arguments` object by reference, because cloning it per delta made per-delta
 * cost scale with the accumulated argument size — a `write` streaming a large
 * file paid for the whole body again on every token.
 *
 * That sharing is only correct while every producer of `arguments` REPLACES the
 * value. Every site does today: each provider assigns a freshly parsed or merged
 * object (`parseStreamingJson`, `parseStreamingJsonThrottled`,
 * `mergeStreamingArgumentObjects`, `mergeCursorMcpToolCallArgs`), and each of
 * those allocates. One `block.arguments.path = …` anywhere in a provider would
 * instead reach backwards into every snapshot a subscriber already holds, and no
 * assertion in `packages/agent` can see it: the loop's own tests can only drive
 * the providers they fake.
 *
 * THE CLASS this closes: "a producer mutates a tool-call argument object a
 * subscriber is already holding". It is closed by membership rather than by
 * example — the sweep reads every package's shipped source, so a provider added
 * next week is covered without touching this file, and a mutating write turns it
 * red naming the file and line.
 *
 * WHAT IT DOES NOT CATCH, stated plainly: a mutation written through an alias
 * (`const args = block.arguments; args.path = …`), through a helper that takes
 * the object as a parameter, or through `structuredClone`-free reuse of a nested
 * value two levels down. The sweep sees a write whose target is spelled through
 * `.arguments`, which is how every current producer spells its assignment. The
 * per-provider streaming-argument suites in `packages/ai/test` remain the proof
 * that a given provider's accumulated arguments are correct; this file is the
 * proof that none of them writes into an object it already handed out.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGES = path.join(REPO_ROOT, "packages");

/** Trees that are not ours to edit or are generated from something else. */
const SKIPPED_DIRS = new Set(["vendor", "node_modules", "dist", "generated"]);

/**
 * Packages whose `arguments` is not a tool call's.
 *
 * `typescript-edit-benchmark` mutates TypeScript AST nodes to generate edit
 * tasks, and a `CallExpression` carries its own `arguments` array. Swapping two
 * of them (`node.arguments[0] = second`) is the mutation the benchmark exists to
 * produce, and it never reaches a stream. Pinned by exact equality so a second
 * exclusion has to be argued for rather than appended.
 */
const NOT_A_TOOL_CALL = ["typescript-edit-benchmark"];

/** A write whose target is spelled through an `arguments` property. */
const MUTATION = new RegExp(
	[
		// x.arguments.key = / += / ??= / ||=, and the same through an index.
		String.raw`\.arguments\s*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])\s*(?:=[^=>]|\+=|-=|\*=|\/=|\?\?=|\|\|=|&&=)`,
		// delete x.arguments.key / delete x.arguments["key"]
		String.raw`\bdelete\s+[^;]*\.arguments\s*(?:\.|\[)`,
		// Object.assign(x.arguments, …) — a merge INTO the live object.
		String.raw`\bObject\.assign\(\s*[^,()]*\.arguments\b`,
		// An in-place array method on the live object.
		String.raw`\.arguments\s*\.\s*(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)\s*\(`,
	].join("|"),
);

/** A whole-value replacement, which is the shape every producer must use. */
const REPLACEMENT = /\.arguments\s*=[^=]/;

/** Strip a line comment, keeping string content that precedes it. */
function withoutTrailingComment(line: string): string {
	const marker = line.indexOf("//");
	return marker === -1 ? line : line.slice(0, marker);
}

interface Hit {
	key: string;
	line: number;
	text: string;
}

/** Lines that write INTO an `arguments` object rather than replacing it. */
export function argumentMutations(source: string): Array<{ line: number; text: string }> {
	const found: Array<{ line: number; text: string }> = [];
	source.split("\n").forEach((raw, index) => {
		const line = withoutTrailingComment(raw);
		const trimmed = line.trim();
		if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
		if (MUTATION.test(line)) found.push({ line: index + 1, text: raw.trim() });
	});
	return found;
}

/** Lines that replace an `arguments` value wholesale. */
function argumentReplacements(source: string): number {
	return source.split("\n").filter(raw => {
		const line = withoutTrailingComment(raw);
		const trimmed = line.trim();
		if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
		return REPLACEMENT.test(line) && !MUTATION.test(line);
	}).length;
}

/** Every shipped `.ts` file under `packages/*\/src`, keyed by `<package>/src/<path>`. */
function sourceFiles(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRS.has(entry.name)) walk(full);
				continue;
			}
			if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(full);
		}
	};
	for (const pkg of fs.readdirSync(PACKAGES, { withFileTypes: true })) {
		if (!pkg.isDirectory() || NOT_A_TOOL_CALL.includes(pkg.name)) continue;
		const src = path.join(PACKAGES, pkg.name, "src");
		if (fs.existsSync(src)) walk(src);
	}
	return found;
}

function relativeKey(file: string): string {
	return path.relative(PACKAGES, file).split(path.sep).join("/");
}

function violations(): Hit[] {
	return sourceFiles().flatMap(file =>
		argumentMutations(fs.readFileSync(file, "utf8")).map(hit => ({
			key: relativeKey(file),
			line: hit.line,
			text: hit.text,
		})),
	);
}

describe("a streamed tool argument object is replaced, never mutated", () => {
	it("has no producer writing into a live arguments object", () => {
		expect(violations()).toEqual([]);
	});

	/**
	 * Non-vacuity. The sweep proves nothing if the field it looks for is gone, or
	 * if the walk reads no provider: a rename of `arguments` would otherwise turn
	 * this file green while the contract it defends evaporated.
	 */
	it("still finds the replacements it is the counterpart to", () => {
		const perFile = new Map(
			sourceFiles().map(file => [relativeKey(file), argumentReplacements(fs.readFileSync(file, "utf8"))]),
		);
		const providerReplacements = [...perFile]
			.filter(([key]) => key.startsWith("ai/src/providers/"))
			.reduce((total, [, count]) => total + count, 0);

		expect(perFile.get("ai/src/providers/openai-shared.ts")).toBeGreaterThan(0);
		expect(perFile.get("ai/src/providers/anthropic.ts")).toBeGreaterThan(0);
		expect(providerReplacements).toBeGreaterThanOrEqual(10);
	});

	/** And the exclusion is exactly the one argued for above. */
	it("excludes only the AST-node package", () => {
		expect(NOT_A_TOOL_CALL).toEqual(["typescript-edit-benchmark"]);
		expect(fs.existsSync(path.join(PACKAGES, "typescript-edit-benchmark", "src"))).toBe(true);
	});
});

describe("the sweep tells a mutation from a replacement", () => {
	it("catches every in-place spelling", () => {
		const source = [
			"block.arguments.path = next;",
			'block.arguments["path"] = next;',
			"block.arguments[key] += next;",
			"delete block.arguments.path;",
			"Object.assign(block.arguments, patch);",
			"block.arguments.push(next);",
		].join("\n");

		expect(argumentMutations(source).map(hit => hit.line)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("allows a whole-value replacement, however it is built", () => {
		const source = [
			"block.arguments = parseStreamingJson(buffer);",
			"block.arguments = { ...previous, ...fragment };",
			"block.arguments = mergeCursorMcpToolCallArgs(streamed, completion);",
			"state.currentToolCall.arguments = throttled.value;",
			"params.arguments = args;",
		].join("\n");

		expect(argumentMutations(source)).toEqual([]);
		expect(argumentReplacements(source)).toBe(5);
	});

	it("reads neither a comment nor a comparison as a write", () => {
		const source = [
			"// block.arguments.path = next;",
			" * `block.arguments.path = next` would reach a held snapshot.",
			"if (block.arguments.path === next) return;",
			"const same = block.arguments[key] == next;",
			"if (block.arguments.path => next) return;",
		].join("\n");

		expect(argumentMutations(source)).toEqual([]);
	});
});
