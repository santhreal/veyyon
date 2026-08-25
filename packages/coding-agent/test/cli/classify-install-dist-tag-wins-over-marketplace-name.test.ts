/**
 * marketplace/cli.test.ts pins `hello@my-marketplace` and `C:\abs` as local.
 * It never registers a marketplace whose name is also an npm dist-tag / version,
 * and it never feeds `C:foo` (drive letter, no separator). Those two collisions
 * send `veyyon plugin install` to the wrong installer.
 */
import { describe, expect, it } from "bun:test";
import { classifyInstallTarget } from "@veyyon/coding-agent/cli/classify-install-target";

describe("a dist-tag or version rhs is npm even when that string is a registered marketplace", () => {
	it("does not let a marketplace named latest steal pkg@latest", () => {
		const known = new Set(["latest", "my-marketplace"]);
		expect(classifyInstallTarget("pkg@latest", known)).toEqual({ type: "npm", spec: "pkg@latest" });
	});

	it("does not let a marketplace named 1.2.3 steal pkg@1.2.3", () => {
		expect(classifyInstallTarget("pkg@1.2.3", new Set(["1.2.3"]))).toEqual({
			type: "npm",
			spec: "pkg@1.2.3",
		});
	});

	it("treats LOOKS_LIKE_VERSION as a leading-digit check: 2beta is npm, v1.2.3 is a marketplace name", () => {
		expect(classifyInstallTarget("pkg@2beta", new Set(["2beta"]))).toEqual({
			type: "npm",
			spec: "pkg@2beta",
		});
		expect(classifyInstallTarget("pkg@v1.2.3", new Set(["v1.2.3"]))).toEqual({
			type: "marketplace",
			name: "pkg",
			marketplace: "v1.2.3",
		});
	});

	it("splits on the last @ so foo@bar@latest is the dist-tag, not marketplace bar@latest", () => {
		expect(classifyInstallTarget("foo@bar@latest", new Set(["bar@latest", "latest", "bar"]))).toEqual({
			type: "npm",
			spec: "foo@bar@latest",
		});
	});
});

describe("near-misses that are not local paths", () => {
	it("leaves C:foo as npm — the local predicate requires a slash after the colon", () => {
		expect(classifyInstallTarget("C:foo", new Set())).toEqual({ type: "npm", spec: "C:foo" });
		expect(classifyInstallTarget("C:", new Set())).toEqual({ type: "npm", spec: "C:" });
	});

	it("does not treat ~foo, .env, or a file: URL as a filesystem spec", () => {
		expect(classifyInstallTarget("~foo", new Set())).toEqual({ type: "npm", spec: "~foo" });
		expect(classifyInstallTarget(".env", new Set())).toEqual({ type: "npm", spec: ".env" });
		expect(classifyInstallTarget("file:./pkg", new Set())).toEqual({ type: "npm", spec: "file:./pkg" });
	});
});
