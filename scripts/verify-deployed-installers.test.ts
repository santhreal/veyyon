/**
 * Guards `scripts/verify-deployed-installers.ts`, the gate that proves
 * get.veyyon.dev serves the install scripts this repository ships.
 *
 * The gate it replaced grepped the served body for `#!/bin/sh`. That predicate is
 * true of every install.sh ever written, so it reported OK while the endpoint
 * served a script hundreds of lines behind main, and the drift was found by
 * installing in a clean container instead. These tests exist so nothing weakens
 * the check back into a shape test: they pin that the comparison is over content,
 * that both documented endpoints and the PowerShell one are covered, and that a
 * stale deploy and an HTML body produce different, actionable messages.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEPLOYED_INSTALLERS, describeMismatch, sha256 } from "./verify-deployed-installers.ts";

const repoRoot = path.join(import.meta.dir, "..");

describe("the endpoint list", () => {
	/**
	 * The bare host is what README and the website tell people to curl. It is served
	 * through a root rewrite that has failed on its own before (the marketing
	 * index.html was published at the get root), so checking only /install.sh would
	 * leave the documented one-liner unverified.
	 */
	it("covers the bare host, /install.sh, and /install.ps1", () => {
		expect(DEPLOYED_INSTALLERS.map(entry => entry.url)).toEqual([
			"https://get.veyyon.dev",
			"https://get.veyyon.dev/install.sh",
			"https://get.veyyon.dev/install.ps1",
		]);
	});

	/**
	 * The bare host and /install.sh must resolve to the same file. If the rewrite
	 * ever pointed the root at a different script, comparing each endpoint against
	 * its own source would call that correct.
	 */
	it("holds the root and /install.sh to the same source file", () => {
		const bySource = DEPLOYED_INSTALLERS.filter(entry => entry.source === "scripts/install.sh");
		expect(bySource.map(entry => entry.url)).toEqual(["https://get.veyyon.dev", "https://get.veyyon.dev/install.sh"]);
	});

	/** A source file the gate names but the repository does not ship is a gate that always fails. */
	it("names files that exist", () => {
		for (const { source } of DEPLOYED_INSTALLERS) {
			expect(fs.existsSync(path.join(repoRoot, source))).toBe(true);
		}
	});
});

describe("sha256", () => {
	/**
	 * The whole gate rests on this digest, so it is pinned against a known vector
	 * rather than against itself: a hash function that silently became a no-op
	 * would make every comparison pass.
	 */
	it("is the real digest of the exact bytes", () => {
		expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	/** One byte of difference has to be visible, since that is the drift being caught. */
	it("separates two scripts that differ by a single character", () => {
		expect(sha256("#!/bin/sh\necho a\n")).not.toBe(sha256("#!/bin/sh\necho b\n"));
	});

	/**
	 * The failure that motivated this file: a stale installer is still a valid
	 * shell script. Anything that tests for shape rather than content passes it.
	 */
	it("rejects a stale installer that the old contains-a-shebang check accepted", () => {
		const current = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");
		const stale = current.split("\n").slice(0, 400).join("\n");
		expect(stale.startsWith("#!/bin/sh")).toBe(true);
		expect(sha256(stale)).not.toBe(sha256(current));
	});
});

describe("describeMismatch", () => {
	/** A wrong rewrite and a stale deploy have different fixes, so they read differently. */
	it("names an HTML body as a broken root rewrite, not a stale deploy", () => {
		const message = describeMismatch("https://get.veyyon.dev", sha256("#!/bin/sh\n"), "<!doctype html>\n<html>");
		expect(message).toContain("served HTML, not a script");
		expect(message).toContain("root rewrite is wrong");
		expect(message).not.toContain("stale");
	});

	/** Leading whitespace must not disguise HTML as a script body. */
	it("still recognises HTML behind leading whitespace", () => {
		const message = describeMismatch("https://get.veyyon.dev", sha256("#!/bin/sh\n"), "\n  <!doctype html>");
		expect(message).toContain("served HTML, not a script");
	});

	/**
	 * A stale deploy is diagnosed from the message alone: both digests, the size,
	 * and the sentence that says what it means for users.
	 */
	it("reports both digests and the size for a stale script", () => {
		const expected = createHash("sha256").update("#!/bin/sh\nnew\n").digest("hex");
		const served = "#!/bin/sh\nold\n";
		const message = describeMismatch("https://get.veyyon.dev/install.sh", expected, served);
		expect(message).toContain(expected);
		expect(message).toContain(sha256(served));
		expect(message).toContain(`${served.length} bytes`);
		expect(message).toContain("users are running an older installer than the one in main");
	});

	/** The .ps1 endpoint must not be told to look at install.sh. */
	it("names install.ps1 as the source for the PowerShell endpoint", () => {
		const message = describeMismatch("https://get.veyyon.dev/install.ps1", sha256("x"), "$ErrorActionPreference");
		expect(message).toContain("scripts/install.ps1");
		expect(message).not.toContain("scripts/install.sh");
	});
});

describe("the workflows that run the gate", () => {
	const workflow = (name: string) => fs.readFileSync(path.join(repoRoot, ".github", "workflows", name), "utf8");

	/**
	 * site.yml triggers on `scripts/install.sh` and used to deploy only veyyon.dev,
	 * so an installer change updated the docs about the installer and left the
	 * installer itself on whatever the last release published. That is the root
	 * cause of the drift; this pins the missing deploy in place.
	 */
	it("site.yml deploys the get tree, not only the marketing site", () => {
		const site = workflow("site.yml");
		expect(site).toContain("pages deploy website-get --project-name veyyon-get");
		expect(site).toContain("pages deploy website --project-name veyyon");
	});

	/** Both workflows that publish the endpoint must verify what it then serves. */
	it("both deploying workflows run the content check", () => {
		for (const name of ["site.yml", "ci.yml"]) {
			expect(workflow(name)).toContain("bun scripts/verify-deployed-installers.ts");
		}
	});

	/**
	 * The shape check is what let the drift through. If it reappears next to the
	 * content check, the weaker one will be the one someone trusts.
	 */
	it("no workflow still verifies the endpoint by grepping for a shebang", () => {
		for (const name of ["site.yml", "ci.yml"]) {
			expect(workflow(name)).not.toContain('check_script "https://get.veyyon.dev"');
		}
	});
});
