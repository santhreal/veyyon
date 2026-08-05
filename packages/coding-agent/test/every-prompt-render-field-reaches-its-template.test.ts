/**
 * Every field handed to `prompt.render` is referenced by the template it is handed to.
 *
 * WHY THIS EXISTS. A render payload and its template are joined by a string, so nothing
 * fails when they drift. The field keeps being computed on every render and the template
 * never asks for it, which is the same defect as a settings key nothing reads, one step
 * further downstream: the work is done, the value is passed, and the result is discarded
 * in silence.
 *
 * It is also how a live setting turns into a dead one. `astGrep.enabled` and
 * `astEdit.enabled` were read in the bash tool's `description` and passed as `hasAstGrep`
 * and `hasAstEdit`, which `tools/bash.md` had stopped mentioning; had those been the keys'
 * only readers, the settings would have been unwired with a reader still visibly present
 * in the source. A grep for either key found a read, so nothing looked wrong.
 *
 * WHAT THIS CAUGHT when it was written: `hasAstGrep`, `hasAstEdit` and
 * `autoBackgroundThresholdSeconds` (`tools/bash`), `DEFAULT_MAX_LINES` (`tools/read`),
 * `agentNames` and `hasReadOnlyAgents` (`tools/task`, left behind when the template moved
 * to iterating `agents`), and `baseline_run_number` and `default_metric_name`
 * (`autoresearch/prompt`, the latter a duplicate of the `metric_name` the template uses).
 *
 * A field counts as referenced if its name appears anywhere in the template body, which
 * covers `{{field}}`, `{{#if field}}`, `{{#list field}}` and every other helper form
 * without this test having to parse the template language. That is deliberately generous:
 * the failure being locked out is a name the template never mentions at all.
 */

import { describe, expect, it } from "bun:test";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

const PACKAGE_DIR = path.join(import.meta.dir, "..");
const SRC_DIR = path.join(PACKAGE_DIR, "src");
const PROMPTS_DIR = path.join(SRC_DIR, "prompts");

/** `prompt.render(someNamespace["dir/name"].text, {` — the call whose payload we check. */
const RENDER_CALL = /prompt\.render\(\s*\w+\[["'`]([^"'`]+)["'`]\]\.text\s*,\s*\{/g;

/** A top-level `field:` line inside the payload object literal. */
const PAYLOAD_FIELD = /^\s*([A-Za-z_]\w*)\s*:/gm;

interface UnusedField {
	template: string;
	field: string;
	site: string;
}

async function filesUnder(dir: string, extension: string, out: string[] = []): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			await filesUnder(full, extension, out);
		} else if (entry.name.endsWith(extension)) {
			out.push(full);
		}
	}
	return out;
}

/** Every prompt template, keyed the way the source addresses it (`tools/bash`). */
async function templates(): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	for (const file of await filesUnder(PROMPTS_DIR, ".md")) {
		const key = path.relative(PROMPTS_DIR, file).replace(/\\/g, "/").replace(/\.md$/, "");
		found.set(key, await readFile(file, "utf-8"));
	}
	return found;
}

/** The object literal starting at `open` (the index of its `{`), by brace matching. */
function objectLiteralAt(source: string, open: number): string {
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(open + 1, i);
		}
	}
	return "";
}

const TEMPLATES = await templates();
const SOURCES = (await filesUnder(SRC_DIR, ".ts")).filter(file => !file.endsWith(".test.ts"));

let renderSites = 0;
let fieldsChecked = 0;
const unused: UnusedField[] = [];

for (const file of SOURCES) {
	const source = await readFile(file, "utf-8");
	RENDER_CALL.lastIndex = 0;
	for (let call = RENDER_CALL.exec(source); call !== null; call = RENDER_CALL.exec(source)) {
		const body = TEMPLATES.get(call[1]);
		// A key we cannot resolve to a template on disk is out of scope rather than a
		// failure: the namespace may be assembled elsewhere, and guessing would make this
		// lock report noise instead of drift.
		if (body === undefined) continue;
		renderSites++;
		const payload = objectLiteralAt(source, RENDER_CALL.lastIndex - 1);
		PAYLOAD_FIELD.lastIndex = 0;
		for (let field = PAYLOAD_FIELD.exec(payload); field !== null; field = PAYLOAD_FIELD.exec(payload)) {
			fieldsChecked++;
			const name = field[1];
			if (!new RegExp(`\\b${name}\\b`).test(body)) {
				unused.push({ template: call[1], field: name, site: path.relative(PACKAGE_DIR, file) });
			}
		}
	}
}

describe("the walk this lock depends on", () => {
	/**
	 * NON-VACUITY, first for the same reason as the settings reader lock: the assertion
	 * below is "nothing is unused", which an empty template map or an empty source list
	 * satisfies perfectly. All three inputs are pinned to real sizes.
	 */
	it("reads the templates, the sources, and the payloads", () => {
		expect(TEMPLATES.size).toBeGreaterThan(100);
		expect(SOURCES.length).toBeGreaterThan(200);
		expect(renderSites).toBeGreaterThan(50);
		expect(fieldsChecked).toBeGreaterThan(150);
	});

	/**
	 * The matcher discriminates. Without this, a check that considered every field used
	 * would make the contract below unfalsifiable.
	 */
	it("distinguishes a referenced field from an invented one", () => {
		const bash = TEMPLATES.get("tools/bash");
		expect(bash).toBeDefined();
		expect(/\bhasGrep\b/.test(bash as string)).toBe(true);
		expect(/\baFieldNoTemplateMentions\b/.test(bash as string)).toBe(false);
	});
});

describe("every prompt.render payload field", () => {
	/**
	 * THE contract. A field the template never mentions is computed on every render and
	 * thrown away, and when the value came from a setting it takes the setting's last
	 * reader with it.
	 */
	it("is referenced by the template it is passed to", () => {
		expect(
			unused.map(entry => `${entry.template}.${entry.field} (${entry.site})`),
			"passed to prompt.render but the template never references it. Use it in the template, or stop computing it",
		).toEqual([]);
	});
});
