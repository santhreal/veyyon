/**
 * Every declared setting is read by something that is not a test.
 *
 * WHY THIS EXISTS. A setting is a promise to the operator: it appears in the settings UI
 * and in `docs/settings-reference.md`, so turning it on is supposed to change what the
 * agent does. A key that nothing reads is a control wired to nothing, and it fails in the
 * worst way: silently, and only for the person who trusted it. There is no compiler error
 * for a key whose reader was deleted or renamed, because the schema and the reader are
 * joined by a string.
 *
 * WHAT THIS TEST HAD TO LEARN. A first pass that looked only for the key's literal text
 * reported 54 of 397 keys unwired, and every one of them was a false positive. Settings
 * are read three different ways and a lock that knows only one is worse than none, because
 * it teaches the next person to silence it:
 *
 *   1. By literal, `settings.get("tools.approvalMode")`.
 *   2. By GROUP, `settings.getGroup("shellMinimizer")`, which returns the whole domain as
 *      an object whose fields are then used by their short names. Twelve groups are read
 *      this way and the individual keys never appear anywhere as strings.
 *   3. By TEMPLATE, `settings.get(\`magicKeywords.${keyword}\`)`, where the key is
 *      assembled at runtime and no literal exists to find.
 *
 * And the reader need not be in this package: `auth.broker.url` and `auth.broker.token`
 * are read by `@veyyon/ai/auth-broker/discover`, because broker discovery runs before the
 * settings singleton exists and reads `config.yml` directly.
 *
 * So the walk covers every workspace package, and a key counts as read if its literal
 * appears, or its group is read by `getGroup` and its own field name is used somewhere, or
 * it is listed below as one the code assembles at runtime.
 */

import { describe, expect, it } from "bun:test";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

const PACKAGE_DIR = path.join(import.meta.dir, "..", "..");
const PACKAGES_DIR = path.join(PACKAGE_DIR, "..");
const DOMAINS_DIR = path.join(PACKAGE_DIR, "src", "config", "settings-domains");

/**
 * Keys assembled at runtime rather than written as literals, with the site that builds
 * them. Listed explicitly so adding one is a deliberate act with a place to justify it,
 * rather than a hole the matcher opens by being loose.
 */
const ASSEMBLED_AT_RUNTIME: Readonly<Record<string, string>> = {
	// `session/agent-session.ts`: settings.get(`magicKeywords.${keyword}`)
	"magicKeywords.ultrathink": "session/agent-session.ts",
	"magicKeywords.orchestrate": "session/agent-session.ts",
	"magicKeywords.workflow": "session/agent-session.ts",
};

/** Every `.ts` file under a directory, skipping dependencies and build output. */
async function typescriptFiles(dir: string, out: string[] = []): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
			await typescriptFiles(full, out);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			out.push(full);
		}
	}
	return out;
}

/** Every dotted key declared across the settings domain files. */
async function declaredKeys(): Promise<string[]> {
	const keys: string[] = [];
	for (const entry of await readdir(DOMAINS_DIR)) {
		if (!entry.endsWith(".ts")) continue;
		const text = await readFile(path.join(DOMAINS_DIR, entry), "utf8");
		for (const match of text.matchAll(/^\t"([a-zA-Z0-9._]+)":\s*\{/gm)) {
			const key = match[1];
			if (key !== undefined) keys.push(key);
		}
	}
	return keys;
}

/** All non-test source across every workspace package, joined, excluding the schema itself. */
async function productionSourceText(): Promise<string> {
	const packages = await readdir(PACKAGES_DIR, { withFileTypes: true });
	const parts: string[] = [];
	for (const pkg of packages) {
		if (!pkg.isDirectory()) continue;
		for (const file of await typescriptFiles(path.join(PACKAGES_DIR, pkg.name, "src"))) {
			if (file.includes(`${path.sep}settings-domains${path.sep}`)) continue;
			if (file.includes(`${path.sep}__tests__${path.sep}`) || file.endsWith(".test.ts")) continue;
			parts.push(await readFile(file, "utf8"));
		}
	}
	return parts.join("\n");
}

const SOURCE = await productionSourceText();
const KEYS = await declaredKeys();
const GROUPS_READ = new Set(Array.from(SOURCE.matchAll(/getGroup\("([a-zA-Z0-9._]+)"\)/g), match => match[1]));

/** How a key is reached, or `null` when nothing reads it. */
function readerOf(key: string): "literal" | "group" | "assembled" | null {
	if (SOURCE.includes(`"${key}"`) || SOURCE.includes(`'${key}'`)) return "literal";
	if (key in ASSEMBLED_AT_RUNTIME) return "assembled";
	const separator = key.lastIndexOf(".");
	if (separator > 0) {
		const group = key.slice(0, separator);
		const field = key.slice(separator + 1);
		if (GROUPS_READ.has(group) && new RegExp(`\\b${field}\\b`).test(SOURCE)) return "group";
	}
	return null;
}

describe("the walk this lock depends on", () => {
	/**
	 * NON-VACUITY, and the reason it comes first. Every assertion below is of the form
	 * "nothing is unwired", which an empty key list or an empty source blob satisfies
	 * perfectly. Both inputs are pinned to real sizes so the lock cannot pass by finding
	 * nothing.
	 */
	it("reads the whole schema and the whole workspace", () => {
		expect(KEYS.length).toBeGreaterThan(350);
		expect(SOURCE.length).toBeGreaterThan(1_000_000);
		expect(GROUPS_READ.size).toBeGreaterThan(5);
	});

	/** No key is declared twice, or the counts above would be measuring duplicates. */
	it("declares each key once", () => {
		expect(new Set(KEYS).size).toBe(KEYS.length);
	});

	/**
	 * The matcher itself is discriminating: it finds a key that genuinely is read and
	 * reports nothing for a key that does not exist. Without this, a matcher that
	 * accepted everything would make the main assertion unfalsifiable.
	 */
	it("distinguishes a wired key from an invented one", () => {
		expect(readerOf("tools.approval")).not.toBeNull();
		expect(readerOf("a.setting.that.does.not.exist")).toBeNull();
	});
});

describe("every settings key", () => {
	/**
	 * THE contract. A key with no reader is a control the settings UI offers and nothing
	 * honours, which is worse than an absent feature because the operator believes it
	 * took effect.
	 */
	it("is read by production code", () => {
		const unwired = KEYS.filter(key => readerOf(key) === null);

		expect(
			unwired,
			"declared in the settings schema but nothing reads it. Wire it, or delete the key and its documentation",
		).toEqual([]);
	});

	/**
	 * The runtime-assembled list stays honest in the other direction too. An entry for a
	 * key that has since gained a literal reader, or that no longer exists, is a
	 * standing exemption nobody is checking, and the next unwired key at that name would
	 * inherit it.
	 */
	it("does not carry a stale runtime-assembled exemption", () => {
		const declared = new Set(KEYS);
		for (const [key, site] of Object.entries(ASSEMBLED_AT_RUNTIME)) {
			expect(declared.has(key), `${key} is exempted but no longer declared`).toBe(true);
			expect(SOURCE.includes(`"${key}"`), `${key} is exempted but now has a literal reader (${site})`).toBe(false);
		}
	});

	/**
	 * A group exemption is only sound while the group really is read as a whole. If
	 * `getGroup("shellMinimizer")` were deleted, every key under it would go quietly
	 * unread while this lock still passed on the strength of the field-name match.
	 */
	it("keeps the groups its group-read keys depend on", () => {
		const groupsRelied = new Set(
			KEYS.filter(key => readerOf(key) === "group").map(key => key.slice(0, key.lastIndexOf("."))),
		);

		expect(groupsRelied.size).toBeGreaterThan(0);
		for (const group of groupsRelied) {
			expect(GROUPS_READ.has(group), `${group} is relied on but no longer read by getGroup`).toBe(true);
		}
	});
});
