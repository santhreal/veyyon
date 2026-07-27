/**
 * Four predicates asking four questions no longer share one name.
 *
 * WHY THIS EXISTS. A sweep of every `function <name>(` declaration under `packages/*​/src`
 * found `isAssistantMessage` declared privately in four modules across two packages. They
 * were not duplicates. Each asked a genuinely different question, and each was right for
 * its own caller:
 *
 *   - `modes/acp/acp-event-mapper.ts` inspects an `unknown` value and asks only whether it
 *     has `role === "assistant"`. Structural, no other requirement.
 *   - `modes/components/status-line/token-rate.ts` additionally requires a numeric
 *     `timestamp` and a `usage.output`, because it is about to compute a rate.
 *   - `modes/controllers/omfg-rule.ts` additionally requires `content` to be an ARRAY,
 *     because it is about to walk the blocks looking for tool calls.
 *   - `stats/src/parser.ts` additionally requires a non-empty `id`, because a legacy entry
 *     without one violates the `messages.entry_id NOT NULL` constraint downstream.
 *
 * WHY IT STILL MATTERED. Merging them would have been wrong, so the ONE PLACE remedy here
 * is the other one: rename, so the name states the question. Four things under one name is
 * how a reader carries a guarantee from one module into another that never made it, and
 * the two strictest are exactly the ones whose extra requirement is invisible from the
 * name. Each is now named for what it actually demands.
 *
 * These tests pin the distinctions rather than the names alone, because a rename that did
 * not change behaviour is only worth having if the behaviours really do differ.
 */

import { describe, expect, it } from "bun:test";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { tokensPerSecond } from "../src/modes/components/status-line/token-rate";

const PACKAGES_DIR = path.join(import.meta.dir, "..", "..");

/** Every `.ts` file under a package's `src`, skipping dependencies and build output. */
async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			await sourceFiles(full, out);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

/** Files declaring `function <name>(`, as `<package>/<relative path>`. */
async function declarersOf(name: string): Promise<string[]> {
	const declaration = new RegExp(`^\\s*(?:export )?(?:async )?function ${name}\\s*\\(`, "m");
	const found: string[] = [];
	for (const entry of await readdir(PACKAGES_DIR, { withFileTypes: true, encoding: "utf8" })) {
		if (!entry.isDirectory()) continue;
		for (const file of await sourceFiles(path.join(PACKAGES_DIR, entry.name, "src"))) {
			if (declaration.test(await readFile(file, "utf8"))) found.push(path.relative(PACKAGES_DIR, file));
		}
	}
	return found.sort();
}

describe("the walk this lock depends on", () => {
	/**
	 * NON-VACUITY. The assertion below is "nobody declares this name", which a walk that
	 * read nothing satisfies perfectly. Prove the walk finds names that genuinely exist,
	 * and reports nothing for one that does not.
	 */
	it("finds real declarations and none for an invented name", async () => {
		expect((await declarersOf("tokensPerSecond")).length).toBeGreaterThan(0);
		expect(await declarersOf("aFunctionThatDoesNotExist")).toEqual([]);
	});
});

describe("no two modules answer different questions under one name", () => {
	/**
	 * THE regression. `isAssistantMessage` was declared in four modules across two
	 * packages, each with a different requirement beyond the role. The name is now unused,
	 * and a reintroduction is a signal to check what question the new one asks.
	 */
	it("nothing declares isAssistantMessage any more", async () => {
		expect(
			await declarersOf("isAssistantMessage"),
			"pick a name that states the question this predicate asks beyond the role",
		).toEqual([]);
	});

	/** Each replacement is declared exactly once, so the split did not create new pairs. */
	it("each replacement is declared once", async () => {
		expect(await declarersOf("looksLikeAssistantMessage")).toEqual([
			path.join("coding-agent", "src", "modes", "acp", "acp-event-mapper.ts"),
		]);
		expect(await declarersOf("isAssistantMessageWithBlocks")).toEqual([
			path.join("coding-agent", "src", "modes", "controllers", "omfg-rule.ts"),
		]);
		expect(await declarersOf("isLinkableAssistantEntry")).toEqual([path.join("stats", "src", "parser.ts")]);
		expect(await declarersOf("isRateableAssistantTurn")).toEqual([
			path.join("coding-agent", "src", "modes", "components", "status-line", "token-rate.ts"),
		]);
	});
});

describe("the strictest predicate really is stricter", () => {
	/**
	 * The rename is only worth having if the questions differ, and the rate predicate is
	 * the one whose extra requirement was least visible: a message with the right role but
	 * no usable duration yields NO rate, where a bare role check would have said yes.
	 * `tokensPerSecond` is the observable edge of that predicate.
	 */
	it("refuses to rate an assistant turn with no usable duration", () => {
		expect(tokensPerSecond(1200, null)).toBeNull();
		expect(tokensPerSecond(1200, undefined)).toBeNull();
	});

	/** And refuses one with no output tokens, the other half of its extra requirement. */
	it("refuses to rate an assistant turn with no output", () => {
		expect(tokensPerSecond(0, 2000)).toBeNull();
	});

	/** A turn meeting both requirements is rated, so the predicate is not simply strict. */
	it("rates a turn that meets both requirements", () => {
		expect(tokensPerSecond(1200, 2000)).toBe(600);
	});
});
