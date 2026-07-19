import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import {
	containsUrlScheme,
	hasUriScheme,
	hasUrlScheme,
	normalizeBaseUrl,
	trimTrailingSlashes,
	URI_SCHEME_PREFIX_RE,
	URL_SCHEME_ANYWHERE_RE,
	URL_SCHEME_PREFIX_RE,
	urlScheme,
} from "../src/url";

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

describe("normalizeBaseUrl", () => {
	it("trims whitespace and strips trailing slashes on a real value", () => {
		expect(normalizeBaseUrl("  https://api.example.com/v1//  ", "")).toBe("https://api.example.com/v1");
		expect(normalizeBaseUrl("https://api.example.com", "")).toBe("https://api.example.com");
	});

	it("returns the default constant unchanged for missing or blank input (gemini/codex contract)", () => {
		const fallback = "https://generativelanguage.googleapis.com/v1beta";
		expect(normalizeBaseUrl(undefined, fallback)).toBe(fallback);
		expect(normalizeBaseUrl("   ", fallback)).toBe(fallback);
		expect(normalizeBaseUrl("", fallback)).toBe(fallback);
	});

	it("returns the empty-string sentinel for blank input (openai-compatible contract)", () => {
		expect(normalizeBaseUrl(undefined, "")).toBe("");
		expect(normalizeBaseUrl("  ", "")).toBe("");
	});

	it("returns undefined for blank input when no fallback is given (anthropic contract)", () => {
		expect(normalizeBaseUrl(undefined)).toBeUndefined();
		expect(normalizeBaseUrl("   ")).toBeUndefined();
		expect(normalizeBaseUrl("https://api.anthropic.com/")).toBe("https://api.anthropic.com");
	});
});

// `URL_SCHEME_PREFIX_RE` / `hasUrlScheme` / `urlScheme` are the ONE owner for
// the anchored `scheme://` grammar. Seven former local copies (path-tree
// isUrlLikePath, coding-agent read-tool-group / read / router / bash-skill-urls
// / write / path-utils) re-point here; the capture group and the `.test`-only
// callers share the same const because a capture group does not change `.test`.
describe("hasUrlScheme / urlScheme (anchored scheme prefix)", () => {
	it("accepts a leading scheme:// for web and internal URLs", () => {
		expect(hasUrlScheme("https://example.com/x")).toBe(true);
		expect(hasUrlScheme("skill://plugin:name")).toBe(true);
		expect(hasUrlScheme("artifact://5:1-50")).toBe(true);
		expect(hasUrlScheme("mcp://server/resource")).toBe(true);
	});

	it("rejects filesystem paths and scheme-less strings", () => {
		expect(hasUrlScheme("/home/user/file.ts")).toBe(false);
		expect(hasUrlScheme("./rel/path")).toBe(false);
		expect(hasUrlScheme("C:/win/path")).toBe(false); // drive letter, no `//`
		expect(hasUrlScheme("plainword")).toBe(false);
		expect(hasUrlScheme("")).toBe(false);
	});

	it("is anchored — a scheme in the middle is not a prefix", () => {
		expect(hasUrlScheme("file.ts:https://x")).toBe(false);
	});

	it("urlScheme returns the lowercased scheme, or null when absent", () => {
		expect(urlScheme("HTTPS://Example.com")).toBe("https");
		expect(urlScheme("Skill://x")).toBe("skill");
		expect(urlScheme("git+ssh://host/repo")).toBe("git+ssh"); // full scheme charset
		expect(urlScheme("/home/user")).toBeNull();
		expect(urlScheme("")).toBeNull();
	});

	it("stays stateless across repeated calls (non-global regex, no lastIndex drift)", () => {
		expect(URL_SCHEME_PREFIX_RE.global).toBe(false);
		expect(urlScheme("https://a")).toBe("https");
		expect(urlScheme("https://a")).toBe("https");
		expect(hasUrlScheme("https://a")).toBe(true);
		expect(hasUrlScheme("https://a")).toBe(true);
	});
});

// `containsUrlScheme` / `URL_SCHEME_ANYWHERE_RE` is the unanchored sibling: the
// ONE owner for "is this a URL rather than a file" in compaction file-summary
// passes (snapcompact, agent/compaction). It matches a scheme anywhere so the
// tolerated `file.ts:conflict://1` prefix form still counts as a URL.
describe("containsUrlScheme (unanchored)", () => {
	it("matches a scheme:// anywhere, not only at the start", () => {
		expect(containsUrlScheme("https://x")).toBe(true);
		expect(containsUrlScheme("file.ts:conflict://1")).toBe(true);
		expect(containsUrlScheme("artifact://3")).toBe(true);
	});

	it("rejects real filesystem paths", () => {
		expect(containsUrlScheme("/home/user/a.ts")).toBe(false);
		expect(containsUrlScheme("src/mod/file.ts")).toBe(false);
		expect(containsUrlScheme("")).toBe(false);
	});

	it("is non-global (stateless)", () => {
		expect(URL_SCHEME_ANYWHERE_RE.global).toBe(false);
	});
});

// `URI_SCHEME_PREFIX_RE` / `hasUriScheme` is the looser sibling: the ONE owner
// for "begins with a `scheme:` prefix" (no `//` required). Three former local
// copies (custom-editor isExplicitPastedPath, local-module-loader
// resolveImportSpecifier, legacy-pi-compat isBareExtensionDependencySpecifier)
// re-point here to tell an absolute URI / module specifier from a bare path.
describe("hasUriScheme (scheme prefix, no // required)", () => {
	it("accepts any absolute-URI prefix, with or without //", () => {
		expect(hasUriScheme("https://x")).toBe(true);
		expect(hasUriScheme("file:/etc/hosts")).toBe(true);
		expect(hasUriScheme("node:fs")).toBe(true);
		expect(hasUriScheme("mailto:a@b.com")).toBe(true);
		expect(hasUriScheme("data:text/plain,hi")).toBe(true);
	});

	it("rejects bare paths, package names, and relative specifiers", () => {
		expect(hasUriScheme("/home/user/a.ts")).toBe(false);
		expect(hasUriScheme("./rel")).toBe(false);
		expect(hasUriScheme("lodash")).toBe(false);
		expect(hasUriScheme("@scope/pkg")).toBe(false);
		expect(hasUriScheme("")).toBe(false);
	});

	it("is anchored and non-global (stateless)", () => {
		expect(URI_SCHEME_PREFIX_RE.global).toBe(false);
		expect(hasUriScheme("x/node:fs")).toBe(false); // scheme in the middle is not a prefix
	});
});

// Repo-wide source lock: trimTrailingSlashes has exactly ONE owner,
// packages/utils/src/url.ts. Both named local copies (catalog antigravity.ts,
// catalog provider-models/ollama.ts) were converted when this lock landed, so
// no grandfathered set — any new named local definition fails outright.
// (Inline `.replace(/\/+$/, "")` sites are tracked separately in the ledger.)
const PACKAGES_DIR = path.join(import.meta.dir, "../..");

const LOCAL_DEF = /function\s+trimTrailingSlash(?:es)?\s*\(/;

// normalizeBaseUrl has exactly ONE owner too (utils/src/url.ts). Five former
// local copies (ai anthropic-auth, ai usage/kimi, catalog discovery
// gemini/codex/openai-compatible) diverged only in their blank-input fallback
// (undefined / "" / a default constant) and were folded into the owner's
// `fallback` parameter. Provider-specific *resolution* wrappers keep their own
// distinct names (resolveKimiBaseUrl, normalizeOllamaCloudBaseUrl,
// normalizeAnthropicBaseUrl); only the exact bare name `normalizeBaseUrl`
// defined outside the owner is an offender. No grandfathered set.
const LOCAL_NORMALIZE_BASE_URL = /function\s+normalizeBaseUrl\s*\(/;

// Inline `.replace(/\/+$/...)` trailing-slash strips are fully drained: every
// former site now calls trimTrailingSlashes. The set is empty, so ANY new inline
// strip in a production `.ts` source fails the lock and must import the owner
// instead. (utils/src/url.ts is the owner and always allowed.)
const INLINE_STRIP_GRANDFATHERED = new Set<string>([]);
const INLINE_STRIP = /replace\(\/\\\/\+\$\//;

// Strip-ONE `X.endsWith("/") ? X.slice(0, -1) : X` variants. On a base URL these
// diverge from strip-all on doubled slashes ("http://x//"), so every URL
// normalizer was converted to trimTrailingSlashes. The only two survivors are
// dir-marker sites where a single trailing slash is a filesystem-path separator,
// not a URL, and the doubled-slash case never arises: keep them local. Any NEW
// strip-one URL normalizer fails this lock — call trimTrailingSlashes instead.
const STRIPONE_GRANDFATHERED = new Set<string>(["tui/src/autocomplete.ts", "utils/src/path-tree.ts"]);
const STRIPONE = /endsWith\("\/"\) \? \w+(?:\.\w+)*\.slice\(0, ?-1\)/;

// Bare-`scheme://` literal lock. Matches the two unified forms only — the RFC
// scheme charset immediately followed by `:\/\/` and then the regex-literal
// close `/` (anchored `/^([a-z][a-z0-9+.-]*):\/\//` and unanchored
// `/[a-z][a-z0-9+.-]*:\/\//`, with or without the capture group). Richer
// patterns that legitimately embed the charset never end in bare `:\/\//`:
// parse.ts host/path (`:\/\/([^/?#]*)`), helpers scheme+rest (`:\/\/(.*)$`),
// autocomplete/editor single-or-double slash (`:\/{1,2}`), and scheme+colon-only
// URI checks (`:` with no `//`) all differ after the scheme, so none match. The
// grandfathered set is therefore empty: any new bare `scheme://` literal outside
// utils/src/url.ts must import hasUrlScheme / urlScheme / containsUrlScheme.
const SCHEME_LITERAL = /\[a-z\]\[a-z0-9\+\.-\]\*\)?:\\\/\\\/\//;

// Bare-`scheme:` (colon-only, no `//`) literal lock. Matches the scheme charset
// immediately followed by `:` and the regex-literal close `/` — the exact
// `/^[a-z][a-z0-9+.-]*:/i` form the three former copies used. The `://` family
// never matches (its `:` is followed by `\`, not the closing `/`), nor do the
// scheme+host/path parsers or the bare-scheme-name check. Empty grandfathered
// set: any new colon-only scheme literal outside utils/src/url.ts must import
// hasUriScheme instead.
const URI_LITERAL = /\[a-z\]\[a-z0-9\+\.-\]\*:\//;

async function walk(dir: string, out: string[], includeTests = false): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
			await walk(full, out, includeTests);
		} else if (entry.name.endsWith(".ts") && (includeTests || !entry.name.endsWith(".test.ts"))) {
			out.push(full);
		}
	}
}

// Collect every .ts under each package's test/ dir. Only the function-definition
// checks (LOCAL_DEF, LOCAL_NORMALIZE_BASE_URL) run against these — a test helper
// that reimplements trimTrailingSlashes/normalizeBaseUrl is a second definition
// that drifts, and the src-only scan never saw it. The inline-pattern checks
// (INLINE_STRIP/STRIPONE) stay src-only: those regexes legitimately match test
// assertions constructing expected values, so scanning tests would false-flag.
async function testFiles(): Promise<string[]> {
	const files: string[] = [];
	for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		try {
			await walk(path.join(PACKAGES_DIR, pkg.name, "test"), files, true);
		} catch {
			// Package without a test/ directory — nothing to scan.
		}
	}
	return files;
}

describe("trimTrailingSlashes source lock", () => {
	it("no production source defines a local trimTrailingSlash variant outside utils/src/url.ts", async () => {
		const offenders: string[] = [];
		const normalizeOffenders: string[] = [];
		const inlineOffenders: string[] = [];
		const inlineSeen = new Set<string>();
		const striponeOffenders: string[] = [];
		const striponeSeen = new Set<string>();
		const schemeOffenders: string[] = [];
		const uriOffenders: string[] = [];
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
				if (LOCAL_NORMALIZE_BASE_URL.test(text)) normalizeOffenders.push(rel);
				if (INLINE_STRIP.test(text)) {
					inlineSeen.add(rel);
					if (!INLINE_STRIP_GRANDFATHERED.has(rel)) inlineOffenders.push(rel);
				}
				if (STRIPONE.test(text)) {
					striponeSeen.add(rel);
					if (!STRIPONE_GRANDFATHERED.has(rel)) striponeOffenders.push(rel);
				}
				if (SCHEME_LITERAL.test(text)) schemeOffenders.push(rel);
				if (URI_LITERAL.test(text)) uriOffenders.push(rel);
			}
		}
		const cleared = [
			...[...INLINE_STRIP_GRANDFATHERED].filter(rel => !inlineSeen.has(rel)),
			...[...STRIPONE_GRANDFATHERED].filter(rel => !striponeSeen.has(rel)),
		];
		expect(offenders, "local trimTrailingSlash copies — import from @veyyon/utils instead").toEqual([]);
		expect(
			normalizeOffenders,
			"local normalizeBaseUrl copies — import from @veyyon/utils instead (use a distinct name for provider-specific resolution wrappers)",
		).toEqual([]);
		expect(
			inlineOffenders,
			"new inline trailing-slash strip — import trimTrailingSlashes from @veyyon/utils instead",
		).toEqual([]);
		expect(
			striponeOffenders,
			"new strip-one `endsWith('/') ? slice(0,-1)` URL normalizer — call trimTrailingSlashes instead",
		).toEqual([]);
		expect(
			schemeOffenders,
			"new bare `scheme://` regex literal — import hasUrlScheme / urlScheme / containsUrlScheme from @veyyon/utils instead",
		).toEqual([]);
		expect(
			uriOffenders,
			"new bare `scheme:` (colon-only) regex literal — import hasUriScheme from @veyyon/utils instead",
		).toEqual([]);
		expect(cleared, "grandfathered entries whose strip is gone — remove them from the list").toEqual([]);
	});

	it("no test file defines a local trimTrailingSlashes or normalizeBaseUrl — tests dogfood the owner too", async () => {
		const defOffenders: string[] = [];
		const normalizeOffenders: string[] = [];
		for (const file of await testFiles()) {
			const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
			const text = await readFile(file, "utf8");
			if (LOCAL_DEF.test(text)) defOffenders.push(rel);
			if (LOCAL_NORMALIZE_BASE_URL.test(text)) normalizeOffenders.push(rel);
		}
		expect(defOffenders, "test-local trimTrailingSlash copies — import from @veyyon/utils instead").toEqual([]);
		expect(normalizeOffenders, "test-local normalizeBaseUrl copies — import from @veyyon/utils instead").toEqual([]);
	});
});
