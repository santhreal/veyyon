/**
 * WHY: a tool failure is rendered into an error card by `formatErrorMessage` and
 * `formatErrorDetail`. Both sanitized the message by replacing tabs and capping its width but never
 * shortened embedded paths, so an error that quoted an absolute path printed the operator's home
 * directory into the transcript — and, because the shortening was missing, spent the line budget on
 * the prefix so the part naming the actual failure was the part that got truncated away.
 *
 * The class is "one render path sanitizes differently from its siblings": this module already owned
 * `shortenEmbeddedPaths`, and the edit renderer already called it. So this suite sweeps both
 * exported error renderers rather than the one that was reported.
 *
 * The contract these tests defend:
 *   - neither renderer emits the home directory, for a bare path or one wrapped in punctuation;
 *   - shortening happens before the width cap, so the informative tail survives;
 *   - the existing sanitization (tab replacement, width cap, empty-message fallback) still holds.
 *
 * What it does not catch: a home path reaching the transcript through a render path outside this
 * module, and a path spelled with a separator this platform does not use.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import { formatErrorDetail, formatErrorMessage, TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/render-utils";

beforeAll(async () => {
	await initTheme();
});

const HOME = os.homedir();

/** Both exported renderers, so a fix applied to one of them is not mistaken for a fix to the path. */
const RENDERERS: readonly { name: string; render: (message: string | undefined) => string }[] = [
	{ name: "formatErrorMessage", render: message => formatErrorMessage(message, theme) },
	{ name: "formatErrorDetail", render: message => formatErrorDetail(message, theme) },
];

describe("an error card", () => {
	it("never prints the home directory, whichever renderer draws it", () => {
		const leaked: string[] = [];

		for (const { name, render } of RENDERERS) {
			const rendered = render(`ENOENT: no such file ${path.join(HOME, "secrets", "notes.md")}`);
			if (rendered.includes(HOME)) {
				leaked.push(name);
			}
		}

		expect(leaked).toEqual([]);
	});

	it("shortens a path wrapped in punctuation, not only a bare one", () => {
		const quoted = formatErrorMessage(`cannot read '${path.join(HOME, "work", "a.ts")}'`, theme);

		expect(quoted).not.toContain(HOME);
		expect(quoted).toContain("~");
	});

	it("shortens before capping the width, so the reason survives the cap", () => {
		// Sized so the raw message overflows the cap but the shortened one does not: replacing the
		// home prefix with `~` frees more columns than the overflow. Shortening first therefore keeps
		// the trailing reason, while capping first cuts it off — which is what tells the two orders
		// apart. A message that merely contains a home path cannot: both orders strip it.
		const overflow = 12;
		// Replacing the home prefix with `~` must free more than the overflow, or neither order fits.
		expect(HOME.length - 1).toBeGreaterThan(overflow);
		const reason = "permission denied";
		const target = TRUNCATE_LENGTHS.LINE + overflow;
		const base = `${path.join(HOME, "a", "file.ts")} ${reason}`;
		const message = `${path.join(HOME, "a".repeat(target - base.length + 1), "file.ts")} ${reason}`;
		expect(message.length).toBe(target);

		const rendered = formatErrorDetail(message, theme);

		expect(rendered).not.toContain(HOME);
		expect(rendered).toContain(reason);
	});

	it("still replaces tabs and still falls back when there is no message", () => {
		expect(formatErrorDetail("a\tb", theme)).not.toContain("\t");
		expect(formatErrorMessage(undefined, theme)).toContain("Unknown error");
		expect(formatErrorMessage("   ", theme)).toContain("Unknown error");
	});

	it("leaves a message that names no path untouched apart from its styling", () => {
		const rendered = formatErrorDetail("connection reset by peer", theme);

		expect(rendered).toContain("connection reset by peer");
	});
});
