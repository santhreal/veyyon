import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { trimTrailingSlashes } from "../src/url";

describe("trimTrailingSlashes", () => {
	it("strips a single trailing slash", () => {
		expect(trimTrailingSlashes("http://x/")).toBe("http://x");
	});

	it("strips every trailing slash, not just one", () => {
		// The one-vs-all divergence this owner exists to kill: two of the six
		// former local copies stripped only one slash.
		expect(trimTrailingSlashes("http://x//")).toBe("http://x");
		expect(trimTrailingSlashes("http://x///")).toBe("http://x");
	});

	it("leaves interior slashes and slashless input untouched", () => {
		expect(trimTrailingSlashes("http://x/v1/models")).toBe("http://x/v1/models");
		expect(trimTrailingSlashes("http://x")).toBe("http://x");
		expect(trimTrailingSlashes("")).toBe("");
	});
});

// Repo-wide source lock: trimTrailingSlashes has exactly ONE owner,
// packages/utils/src/url.ts. Both named local copies (catalog antigravity.ts,
// catalog provider-models/ollama.ts) were converted when this lock landed, so
// no grandfathered set — any new named local definition fails outright.
// (Inline `.replace(/\/+$/, "")` sites are tracked separately in the ledger.)
const PACKAGES_DIR = path.join(import.meta.dir, "../..");

const LOCAL_DEF = /function\s+trimTrailingSlash(?:es)?\s*\(/;

// Inline `.replace(/\/+$/...)` trailing-slash strips are fully drained: every
// former site now calls trimTrailingSlashes. The set is empty, so ANY new inline
// strip in a production `.ts` source fails the lock and must import the owner
// instead. (utils/src/url.ts is the owner and always allowed.)
const INLINE_STRIP_GRANDFATHERED = new Set<string>([]);
const INLINE_STRIP = /replace\(\/\\\/\+\$\//;

async function walk(dir: string, out: string[]): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
			await walk(full, out);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
}

describe("trimTrailingSlashes source lock", () => {
	it("no production source defines a local trimTrailingSlash variant outside utils/src/url.ts", async () => {
		const offenders: string[] = [];
		const inlineOffenders: string[] = [];
		const inlineSeen = new Set<string>();
		for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
			if (!pkg.isDirectory()) continue;
			const files: string[] = [];
			try {
				await walk(path.join(PACKAGES_DIR, pkg.name, "src"), files);
			} catch {
				// Package without a src/ directory (assets-only) — nothing to scan.
			}
			for (const file of files) {
				const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
				if (rel === "utils/src/url.ts") continue;
				const text = await readFile(file, "utf8");
				if (LOCAL_DEF.test(text)) offenders.push(rel);
				if (INLINE_STRIP.test(text)) {
					inlineSeen.add(rel);
					if (!INLINE_STRIP_GRANDFATHERED.has(rel)) inlineOffenders.push(rel);
				}
			}
		}
		const cleared = [...INLINE_STRIP_GRANDFATHERED].filter(rel => !inlineSeen.has(rel));
		expect(offenders, "local trimTrailingSlash copies — import from @veyyon/utils instead").toEqual([]);
		expect(
			inlineOffenders,
			"new inline trailing-slash strip — import trimTrailingSlashes from @veyyon/utils instead",
		).toEqual([]);
		expect(cleared, "grandfathered entries whose inline strip is gone — remove them from the list").toEqual([]);
	});
});
