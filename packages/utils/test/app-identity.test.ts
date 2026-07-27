/**
 * The two forms of the product's name, and why they must not share one.
 *
 * Why this suite exists: `APP_NAME` meant two different values in two packages. `utils/dirs.ts` exported
 * `"veyyon"`, the lowercase slug that appears in config, cache and data paths, while `tui/desktop-notify.ts`
 * declared `APP_NAME = "Veyyon"`, the capitalized name a person reads, and that second value was declared
 * again as `OSC99_APP_NAME` in `tui/terminal-capabilities.ts` and as `DISPLAY_NAME` in
 * `coding-agent/discovery/builtin.ts`.
 *
 * One name for two values is the harmful kind, because both are strings and nothing complains when the wrong
 * one is carried across the boundary. A slug in a notification title looks like a bug report waiting to
 * happen; a capitalized name in a PATH is worse, because a case-insensitive filesystem accepts it on the
 * machine it was written on and a user's Linux box ends up with two directories.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { APP_DIRECTORY_SLUG, APP_DISPLAY_NAME } from "../src/app-identity";
import { APP_NAME } from "../src/dirs";

const PACKAGES = path.resolve(import.meta.dir, "../..");

describe("the product's two names", () => {
	/** The path slug, lowercase, with nothing in it a filesystem treats specially. */
	it("holds a lowercase directory slug", () => {
		expect(APP_DIRECTORY_SLUG).toBe("veyyon");
		expect(APP_DIRECTORY_SLUG).toBe(APP_DIRECTORY_SLUG.toLowerCase());
		expect(APP_DIRECTORY_SLUG).toMatch(/^[a-z][a-z0-9-]*$/);
	});

	/** The name a person reads. */
	it("holds a capitalized display name", () => {
		expect(APP_DISPLAY_NAME).toBe("Veyyon");
	});

	/**
	 * They are the same word in different cases, which is exactly why the collision was invisible: a check
	 * comparing them case-insensitively would find no fault, and a reader skimming two files would see the same
	 * word twice.
	 */
	it("differs only in case", () => {
		expect(APP_DISPLAY_NAME).not.toBe(APP_DIRECTORY_SLUG);
		expect(APP_DISPLAY_NAME.toLowerCase()).toBe(APP_DIRECTORY_SLUG);
	});

	/** `dirs.ts` keeps its published name and reads the slug, so the path form has one statement. */
	it("keeps the published dirs name pointing at the slug", () => {
		expect(APP_NAME).toBe(APP_DIRECTORY_SLUG);
	});
});

describe("the product name has one owner per form", () => {
	const TREES = ["utils/src", "tui/src", "coding-agent/src", "ai/src", "catalog/src"] as const;

	async function sources(): Promise<ReadonlyArray<{ file: string; text: string }>> {
		const collected: Array<{ file: string; text: string }> = [];
		for (const tree of TREES) {
			const root = path.join(PACKAGES, tree);
			for (const file of new Bun.Glob("**/*.ts").scanSync(root)) {
				const full = path.join(root, file);
				if (full === path.join(PACKAGES, "utils/src/app-identity.ts")) continue;
				collected.push({ file: `${tree}/${file}`, text: await Bun.file(full).text() });
			}
		}
		return collected;
	}

	/**
	 * The ratchet on the DISPLAY name, keyed on the literal because the three copies used three names. The slug
	 * is not ratcheted the same way: `"veyyon"` appears legitimately in dozens of unrelated places, package
	 * names and env prefixes among them, so a literal scan for it would be noise rather than a finding.
	 */
	it("declares the display name nowhere else", async () => {
		const offenders: string[] = [];
		for (const { file, text } of await sources()) {
			if (new RegExp(`^\\s*(?:export )?const \\w+ = "${APP_DISPLAY_NAME}";`, "m").test(text)) {
				offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * Nor under `OSC99_APP_NAME`, the one retired name that was unique to this value.
	 *
	 * `DISPLAY_NAME`, the third copy's name, is deliberately NOT ratcheted. Eighteen modules under
	 * `coding-agent/src/discovery/` declare a `DISPLAY_NAME` holding the name of the provider that module is
	 * about, one file per provider, and there the name is a schema field rather than a shared value: the file
	 * IS the entity. `discovery/builtin.ts` was the odd one out because the provider it describes is veyyon
	 * itself, so its `DISPLAY_NAME` was the product's name wearing a per-provider name. The literal ratchet
	 * above is what catches a return of that, and it catches it whatever the copy calls itself.
	 */
	it("declares no retired unique name", async () => {
		const offenders: string[] = [];
		for (const { file, text } of await sources()) {
			if (/^\s*(?:export )?const OSC99_APP_NAME\b/m.test(text)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * And the per-provider `DISPLAY_NAME` convention is intact, which is the reason the case above is narrow.
	 * Asserted rather than assumed, so a reader can see the exemption is a decision about a real convention.
	 */
	it("leaves the per-provider display-name convention alone", async () => {
		const discovery = path.join(PACKAGES, "coding-agent/src/discovery");
		const declarers: string[] = [];
		for (const file of new Bun.Glob("*.ts").scanSync(discovery)) {
			const text = await Bun.file(path.join(discovery, file)).text();
			if (/^const DISPLAY_NAME = "/m.test(text)) declarers.push(file);
		}
		expect(declarers.length).toBeGreaterThan(10);
		// And none of them is the product's own name any more.
		for (const file of declarers) {
			const text = await Bun.file(path.join(discovery, file)).text();
			expect(text, file).not.toContain(`const DISPLAY_NAME = "${APP_DISPLAY_NAME}"`);
		}
	});

	/** The non-vacuity twin: the scan reaches all five package trees and every module that held a copy. */
	it("scans every package that named the product", async () => {
		const files = (await sources()).map(entry => entry.file);
		expect(files.length).toBeGreaterThan(500);
		for (const declarer of [
			"tui/src/desktop-notify.ts",
			"tui/src/terminal-capabilities.ts",
			"coding-agent/src/discovery/builtin.ts",
			"utils/src/dirs.ts",
		]) {
			expect(files).toContain(declarer);
		}
	});

	/** The positive half: each former declarer reads the display name from the owner. */
	it("has every former declarer importing the display name", async () => {
		for (const file of [
			"tui/src/desktop-notify.ts",
			"tui/src/terminal-capabilities.ts",
			"coding-agent/src/discovery/builtin.ts",
		]) {
			const text = await Bun.file(path.join(PACKAGES, file)).text();
			expect(text, file).toContain("APP_DISPLAY_NAME");
			expect(text, file).toContain('from "@veyyon/utils/app-identity"');
		}
	});

	/**
	 * The owner is a leaf, so the lowest package in the tree can hold it and every layer above pays one module
	 * to read a name.
	 */
	it("imports nothing", async () => {
		const owner = await Bun.file(path.join(PACKAGES, "utils/src/app-identity.ts")).text();
		expect(owner).not.toMatch(/^\s*import\s/m);
		expect(owner).not.toMatch(/\bfrom\s+"/);
	});
});
