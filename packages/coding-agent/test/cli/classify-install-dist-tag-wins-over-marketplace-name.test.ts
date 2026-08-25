/**
 * `classifyInstallTarget` decides whether `veyyon plugin install <spec>` is a
 * filesystem path, a marketplace ref (`name@marketplace`), or an npm spec.
 *
 * WHY THIS SUITE EXISTS. The existing marketplace CLI suite pins the happy
 * split (`hello@my-marketplace`) and the obvious local-path roster (`.`,
 * `~/x`, `C:\abs`). It does not pin the two collisions that actually send
 * an operator's install to the wrong installer:
 *
 *   1. DIST-TAG / VERSION vs MARKETPLACE NAME. Rule 2 splits on the last `@`.
 *      If the right-hand side is in `NPM_DIST_TAGS` or matches
 *      `LOOKS_LIKE_VERSION`, the spec is npm even when that same string is a
 *      registered marketplace. A marketplace named `latest` (or `1.0.0`)
 *      must not hijack `pkg@latest`.
 *
 *   2. DRIVE LETTER WITHOUT A SLASH. `C:\abs` is local. `C:foo` is a DOS
 *      working-directory relative path on that drive, but the predicate
 *      requires `[A-Za-z]:[\\/]`. `C:foo` therefore falls through to npm
 *      and is fetched as a package named `C:foo`. Same class: `~foo` is not
 *      home, `.env` is not cwd, `file:./x` is not a local path.
 *
 * Failures here stay red: a dist-tag that becomes a marketplace install is
 * an operator-facing install of the wrong thing.
 */
import { describe, expect, it } from "bun:test";
import { classifyInstallTarget } from "@veyyon/coding-agent/cli/classify-install-target";

const DIST_TAGS = [
	"latest",
	"next",
	"beta",
	"alpha",
	"canary",
	"rc",
	"dev",
	"stable",
	"nightly",
	"experimental",
] as const;

describe("a dist-tag is npm even when a marketplace is registered under that name", () => {
	it("classifies pkg@latest as npm when 'latest' is also a known marketplace", () => {
		const known = new Set(["latest", "my-marketplace"]);
		expect(classifyInstallTarget("pkg@latest", known)).toEqual({ type: "npm", spec: "pkg@latest" });
	});

	it("classifies every published dist-tag as npm against a marketplace set that contains that tag", () => {
		for (const tag of DIST_TAGS) {
			const known = new Set([tag]);
			expect(classifyInstallTarget(`left-pad@${tag}`, known)).toEqual({
				type: "npm",
				spec: `left-pad@${tag}`,
			});
		}
	});

	it("still classifies a non-tag marketplace name as marketplace when it is registered", () => {
		const known = new Set(["latest", "clawhub"]);
		expect(classifyInstallTarget("hello@clawhub", known)).toEqual({
			type: "marketplace",
			name: "hello",
			marketplace: "clawhub",
		});
	});

	it("does not let a marketplace named like a semver steal pkg@1.2.3", () => {
		const known = new Set(["1.2.3"]);
		expect(classifyInstallTarget("pkg@1.2.3", known)).toEqual({ type: "npm", spec: "pkg@1.2.3" });
	});

	it("treats range prefixes as versions, not marketplace names: ~ ^ > < =", () => {
		const known = new Set(["~1.2.3", "^2", ">=1", "<2", "=1.0"]);
		expect(classifyInstallTarget("pkg@~1.2.3", known)).toEqual({ type: "npm", spec: "pkg@~1.2.3" });
		expect(classifyInstallTarget("pkg@^2", known)).toEqual({ type: "npm", spec: "pkg@^2" });
		expect(classifyInstallTarget("pkg@>=1", known)).toEqual({ type: "npm", spec: "pkg@>=1" });
		expect(classifyInstallTarget("pkg@<2", known)).toEqual({ type: "npm", spec: "pkg@<2" });
		expect(classifyInstallTarget("pkg@=1.0", known)).toEqual({ type: "npm", spec: "pkg@=1.0" });
	});

	it("splits on the LAST @ so foo@bar@latest is the dist-tag latest, not marketplace bar@latest", () => {
		const known = new Set(["bar@latest", "latest", "bar"]);
		expect(classifyInstallTarget("foo@bar@latest", known)).toEqual({
			type: "npm",
			spec: "foo@bar@latest",
		});
	});

	it("splits on the last @ for a real marketplace after an extra @ in the name", () => {
		const known = new Set(["clawhub"]);
		expect(classifyInstallTarget("org@pkg@clawhub", known)).toEqual({
			type: "marketplace",
			name: "org@pkg",
			marketplace: "clawhub",
		});
	});
});

describe("LOOKS_LIKE_VERSION is a prefix check, not a semver parser", () => {
	it("classifies pkg@2beta as npm because the rhs starts with a digit", () => {
		const known = new Set(["2beta"]);
		expect(classifyInstallTarget("pkg@2beta", known)).toEqual({ type: "npm", spec: "pkg@2beta" });
	});

	it("does NOT treat v1.2.3 as a version (no leading digit or range prefix)", () => {
		const known = new Set(["v1.2.3"]);
		expect(classifyInstallTarget("pkg@v1.2.3", known)).toEqual({
			type: "marketplace",
			name: "pkg",
			marketplace: "v1.2.3",
		});
	});

	it("treats an empty rhs (pkg@) as not a version and not a dist-tag", () => {
		expect(classifyInstallTarget("pkg@", new Set())).toEqual({ type: "npm", spec: "pkg@" });
		expect(classifyInstallTarget("pkg@", new Set([""]))).toEqual({
			type: "marketplace",
			name: "pkg",
			marketplace: "",
		});
	});
});

describe("a drive letter without a separator is not a local path", () => {
	it("leaves C:foo as npm — the local predicate requires a slash after the colon", () => {
		expect(classifyInstallTarget("C:foo", new Set())).toEqual({ type: "npm", spec: "C:foo" });
		expect(classifyInstallTarget("c:foo", new Set())).toEqual({ type: "npm", spec: "c:foo" });
		expect(classifyInstallTarget("C:", new Set())).toEqual({ type: "npm", spec: "C:" });
	});

	it("still classifies C:/foo and C:\\foo as local", () => {
		expect(classifyInstallTarget("C:/foo", new Set())).toEqual({ type: "local", path: "C:/foo" });
		expect(classifyInstallTarget("C:\\foo", new Set())).toEqual({ type: "local", path: "C:\\foo" });
		expect(classifyInstallTarget("d:/abs", new Set())).toEqual({ type: "local", path: "d:/abs" });
	});

	it("does not treat a leading digit-colon as a drive", () => {
		expect(classifyInstallTarget("1:/not-a-drive", new Set())).toEqual({
			type: "npm",
			spec: "1:/not-a-drive",
		});
	});
});

describe("near-misses that look like paths but are package names", () => {
	it("does not treat .env or ..foo as the cwd / parent sentinels", () => {
		expect(classifyInstallTarget(".env", new Set())).toEqual({ type: "npm", spec: ".env" });
		expect(classifyInstallTarget(".foo", new Set())).toEqual({ type: "npm", spec: ".foo" });
		expect(classifyInstallTarget("..foo", new Set())).toEqual({ type: "npm", spec: "..foo" });
		expect(classifyInstallTarget(".../x", new Set())).toEqual({ type: "npm", spec: ".../x" });
	});

	it("does not treat ~foo (no separator) as home", () => {
		expect(classifyInstallTarget("~foo", new Set())).toEqual({ type: "npm", spec: "~foo" });
		expect(classifyInstallTarget("~.", new Set())).toEqual({ type: "npm", spec: "~." });
	});

	it("does not treat a file: URL as a local filesystem spec", () => {
		expect(classifyInstallTarget("file:./pkg", new Set())).toEqual({
			type: "npm",
			spec: "file:./pkg",
		});
		expect(classifyInstallTarget("file:///abs/pkg", new Set())).toEqual({
			type: "npm",
			spec: "file:///abs/pkg",
		});
	});

	it("does not treat a single backslash as UNC", () => {
		expect(classifyInstallTarget("\\not-unc", new Set())).toEqual({
			type: "npm",
			spec: "\\not-unc",
		});
	});

	it("does not treat a windows-style relative path without a dot prefix as local", () => {
		expect(classifyInstallTarget("foo\\bar", new Set())).toEqual({ type: "npm", spec: "foo\\bar" });
	});

	it("an empty spec is npm, not a local cwd", () => {
		expect(classifyInstallTarget("", new Set())).toEqual({ type: "npm", spec: "" });
	});

	it("a scoped spec is always npm even when the last @ names a marketplace AND a dist-tag", () => {
		const known = new Set(["latest", "clawhub"]);
		expect(classifyInstallTarget("@scope/pkg@latest", known)).toEqual({
			type: "npm",
			spec: "@scope/pkg@latest",
		});
		expect(classifyInstallTarget("@scope/pkg@clawhub", known)).toEqual({
			type: "npm",
			spec: "@scope/pkg@clawhub",
		});
	});
});
