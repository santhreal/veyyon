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
 * appears, or its group is read by `getGroup` AND its field is reached off an object as
 * `.field` or bound out of one by destructuring, or it is listed below as one the code
 * assembles at runtime.
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

/** All non-test source across every workspace package, excluding the schema itself. */
async function productionFiles(): Promise<Array<{ file: string; text: string }>> {
	const packages = await readdir(PACKAGES_DIR, { withFileTypes: true });
	const out: Array<{ file: string; text: string }> = [];
	for (const pkg of packages) {
		if (!pkg.isDirectory()) continue;
		for (const file of await typescriptFiles(path.join(PACKAGES_DIR, pkg.name, "src"))) {
			if (file.includes(`${path.sep}settings-domains${path.sep}`)) continue;
			if (file.includes(`${path.sep}__tests__${path.sep}`) || file.endsWith(".test.ts")) continue;
			out.push({ file: path.relative(PACKAGES_DIR, file), text: await readFile(file, "utf8") });
		}
	}
	return out;
}

const FILES = await productionFiles();
const SOURCE = FILES.map(entry => entry.text).join("\n");
const KEYS = await declaredKeys();
const GROUPS_READ = new Set(Array.from(SOURCE.matchAll(/getGroup\("([a-zA-Z0-9._]+)"\)/g), match => match[1]));

/**
 * How a key is reached, or `null` when nothing reads it.
 *
 * The group case is the loose one, so it is the one that has to be careful. Accepting a
 * key because its group is read by `getGroup` and its bare leaf name appears ANYWHERE in
 * a million lines of source accepts almost anything: `enabled`, `only`, `except`,
 * `threshold` and `model` all occur thousands of times as ordinary local names, so the
 * field half of that test was very nearly free. The field must instead be reached the way
 * a field of a returned group object actually is — read off an object as `.field`, or
 * bound out of one by destructuring — which is still a text match, but one a coincidental
 * local variable does not satisfy.
 */
function readerOf(key: string): "literal" | "group" | "assembled" | null {
	if (SOURCE.includes(`"${key}"`) || SOURCE.includes(`'${key}'`)) return "literal";
	if (key in ASSEMBLED_AT_RUNTIME) return "assembled";
	const separator = key.lastIndexOf(".");
	if (separator > 0) {
		const group = key.slice(0, separator);
		const field = key.slice(separator + 1);
		if (!GROUPS_READ.has(group)) return null;
		if (new RegExp(`\\.${field}\\b`).test(SOURCE)) return "group";
		if (new RegExp(`[{,]\\s*${field}\\s*[,}=:]`).test(SOURCE)) return "group";
	}
	return null;
}

/**
 * HAVING A READER IS NOT HAVING AN EFFECT, which is the gap that shipped a dead knob.
 *
 * `commands.enableClaudeProject` passed everything above. The literal was right there,
 * `settings.get("commands.enableClaudeProject")` in `discovery/claude.ts`, so the key had
 * a reader. What it did not have was a consumer: the value was read, returned from the
 * toggle reader as a field of an object, and the only caller destructured the SIBLING
 * field and dropped it. Every check above is satisfied by a read whose result goes
 * nowhere, so the promise this file opens with, that turning a setting on changes what the
 * agent does, was stronger than what it verified.
 *
 * This is the one shape of that failure that can be found mechanically: a settings read
 * assigned to a field of an object literal, where no code anywhere reads that field back
 * off an object or binds it out of one. It is not a proof of reachability and does not try
 * to be. It catches the specific move of routing a setting into a field nobody collects.
 *
 * Two enclosing calls are excused, because in both the consumer is real and simply is not
 * TypeScript:
 *   - `prompt.render`, where the template consumes the field. That pairing has its own
 *     lock, `every-prompt-render-field-reaches-its-template.test.ts`, which is what
 *     actually holds those payloads honest.
 *   - `logger`/`telemetry`, where recording a value without branching on it is the point.
 */

/** A comment line carries neither a read nor a consumption. */
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/** `field: <expression containing a settings read>`, a settings value routed into an object. */
const SETTINGS_MAPPING = /^\s*([A-Za-z_]\w*)\s*:\s*.*?settings[\w.#?[\]"']*\.get(?:Group)?\s*\(/;

/** `.field`, the field read back off an object. */
const PROPERTY_READ = /\.([A-Za-z_]\w*)/g;

/**
 * `{ field }`, `{ field, x }`, `{ field = 1 }`, `{ field: alias }`, `f(a, field, b)`, bound
 * out of an object or handed on as an argument.
 *
 * The terminator is a LOOKAHEAD, not consumed. Consuming it made a run of comma-separated
 * names skip every other one: in `f(configuredPaths, cwd, disabledExtensionIds)` the match
 * for `cwd` ate the comma that the match for `disabledExtensionIds` needed to start, so a
 * genuinely collected field looked uncollected.
 */
const DESTRUCTURED = /[{,(]\s*([A-Za-z_]\w*)\s*(?=[,)}=:])/g;

/**
 * A multi-line destructuring entry or shorthand property, where the name is alone on its
 * line and the brace or comma that introduces it is on the line above:
 * `const {\n\tfield,\n\tother = 1,\n} = options;`
 */
const BOUND_ON_OWN_LINE = /^\s*([A-Za-z_]\w*)\s*(?:,|=[^=>])/;

/**
 * The call whose object literal a mapping sits in, when it is one of the two this lock
 * excuses. Stops at the first line that opens a declaration, so the scan cannot wander out
 * of the expression it started in.
 */
function excusedEnclosingCall(lines: string[], index: number): "log" | "render" | null {
	for (let n = index - 1; n >= 0 && n > index - 25; n--) {
		const line = lines[n] ?? "";
		if (/\b(?:logger|telemetry)\.\w+\(/.test(line)) return "log";
		if (/prompt\.render\(/.test(line)) return "render";
		if (/^\s*(?:export\s+)?(?:async\s+)?(?:function|const|class|\w+\s*\()/.test(line)) return null;
	}
	return null;
}

const settingsMappings: Array<{ field: string; site: string }> = [];
/** Where a name is CONSUMED and where it is MAPPED, so a mapping cannot satisfy itself. */
const consumedAt = new Map<string, Set<string>>();
const mappedAt = new Map<string, Set<string>>();
let excusedMappings = 0;

function record(index: Map<string, Set<string>>, name: string, site: string): void {
	const existing = index.get(name);
	if (existing) existing.add(site);
	else index.set(name, new Set([site]));
}

for (const { file, text } of FILES) {
	const lines = text.split("\n");
	for (let n = 0; n < lines.length; n++) {
		const line = lines[n] ?? "";
		if (COMMENT_LINE.test(line)) continue;
		const site = `${file}:${n + 1}`;
		const mapped = SETTINGS_MAPPING.exec(line)?.[1];
		if (mapped !== undefined) {
			if (excusedEnclosingCall(lines, n) === null) settingsMappings.push({ field: mapped, site });
			else excusedMappings++;
			record(mappedAt, mapped, site);
		}
		for (const pattern of [PROPERTY_READ, DESTRUCTURED]) {
			pattern.lastIndex = 0;
			for (let hit = pattern.exec(line); hit !== null; hit = pattern.exec(line)) {
				if (hit[1] !== undefined) record(consumedAt, hit[1], site);
			}
		}
		const boundAlone = BOUND_ON_OWN_LINE.exec(line)?.[1];
		if (boundAlone !== undefined) record(consumedAt, boundAlone, site);
	}
}

/** A field is collected when something reads it somewhere other than a mapping of itself. */
const unconsumedMappings = settingsMappings.filter(({ field }) => {
	const own = mappedAt.get(field);
	for (const site of consumedAt.get(field) ?? []) {
		if (own?.has(site) !== true) return false;
	}
	return true;
});

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
		expect(FILES.length).toBeGreaterThan(1_000);
	});

	/**
	 * The effect walk found real mappings to judge. Zero of them, from a broken pattern or
	 * an empty file list, would make "none of them is unconsumed" true and meaningless.
	 */
	it("finds the settings values routed into objects", () => {
		expect(settingsMappings.length).toBeGreaterThan(150);
		expect(consumedAt.size).toBeGreaterThan(1_000);
		expect(excusedMappings).toBeGreaterThan(0);
	});

	/**
	 * The consumption test discriminates. `enabled` is collected off objects constantly;
	 * a name nothing mentions is collected nowhere. Without this, a test that considered
	 * every field consumed would make the contract below unfalsifiable.
	 */
	it("distinguishes a collected field from an uncollected one", () => {
		expect(consumedAt.has("enabled")).toBe(true);
		expect(consumedAt.has("aFieldNoConsumerCollects")).toBe(false);
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

	/**
	 * The group rule does not accept a coincidental bare word. `compaction` is a group
	 * that really is read by `getGroup`, and `instanceof` is a word this repository
	 * contains many times but never as a field, so under the old rule an invented
	 * `compaction.instanceof` would have been reported as wired on the strength of the
	 * bare-word match alone. It has to be reached AS a field for the exemption to apply.
	 */
	it("does not accept a group field that only appears as a bare word", () => {
		expect(GROUPS_READ.has("compaction")).toBe(true);
		expect(/\binstanceof\b/.test(SOURCE)).toBe(true);
		expect(readerOf("compaction.instanceof")).toBeNull();
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

describe("every settings value routed into an object", () => {
	/**
	 * THE second contract, and the one `commands.enableClaudeProject` needed. A setting
	 * read into a field that nothing ever collects is a reader without an effect: it
	 * satisfies every check above while the operator's choice reaches nothing.
	 */
	it("lands on a field something reads back", () => {
		expect(
			unconsumedMappings.map(entry => `${entry.field} (${entry.site})`),
			"a settings value is assigned to this object field and no code reads that field off an object. Consume it, or stop reading the setting here",
		).toEqual([]);
	});
});
