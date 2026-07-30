#!/usr/bin/env bun
/**
 * Assert that every installer URL on `get.veyyon.dev` and `veyyon.dev` serves
 * the install script in THIS repository, byte for byte.
 *
 * The release workflow already checked that the endpoint serves a shell script
 * ("does the body contain `#!/bin/sh`"). That check passes for any install.sh
 * ever deployed, including one from months ago, so it could not see the failure
 * it was standing next to: dogfooding a fresh install in a clean container
 * found `https://get.veyyon.dev` serving a 539-line script while
 * `scripts/install.sh` in the repository was 1272 lines. Everything added in
 * between was missing from what users actually ran — `install_dir`,
 * `ALIAS_IS_OURS` and the alias-clobber protection, `PATH_MARKER` and the
 * uninstall that takes its own PATH line back out, and the "already on PATH"
 * check that stops a redundant rc edit. All of it was in main, tested, and
 * unreachable.
 *
 * A content check is the only one that can catch that, so this compares
 * sha256 digests and refuses anything else.
 *
 * Run it after a deploy, not before: Cloudflare returns from `wrangler deploy`
 * before propagation finishes, so a mismatch is retried for a bounded window and
 * only then reported as a failure.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Every documented endpoint, and the repository file whose bytes it must serve. */
export const DEPLOYED_INSTALLERS: readonly { url: string; source: string }[] = [
	// The bare host is the documented one-liner (`curl -fsSL https://get.veyyon.dev | sh`),
	// served through a root rewrite. It is checked separately from /install.sh because
	// the rewrite is its own failure mode: it has served the marketing index.html before.
	{ url: "https://get.veyyon.dev", source: "scripts/install.sh" },
	{ url: "https://get.veyyon.dev/install.sh", source: "scripts/install.sh" },
	{ url: "https://get.veyyon.dev/install.ps1", source: "scripts/install.ps1" },
	{ url: "https://veyyon.dev/install.sh", source: "scripts/install.sh" },
	{ url: "https://veyyon.dev/install.ps1", source: "scripts/install.ps1" },
];

/** How long to keep retrying a mismatch before calling it a stale deploy. */
export const PROPAGATION_ATTEMPTS = 12;
export const PROPAGATION_DELAY_MS = 10_000;

export function sha256(body: string): string {
	return createHash("sha256").update(body).digest("hex");
}

/**
 * What went wrong, in the words the operator needs. A digest mismatch and a body
 * that is not a script at all have different fixes (redeploy vs. fix the rewrite),
 * so they are never reported as the same thing.
 */
export function describeMismatch(url: string, expected: string, body: string): string {
	const got = sha256(body);
	if (body.trimStart().startsWith("<")) {
		return `${url} served HTML, not a script (${body.length} bytes). The root rewrite is wrong: piping this into sh fails for every new user.`;
	}
	return `${url} served a DIFFERENT script than this repository ships.\n  expected sha256 ${expected} (${url.endsWith(".ps1") ? "scripts/install.ps1" : "scripts/install.sh"})\n  served   sha256 ${got} (${body.length} bytes, ${body.split("\n").length} lines)\nThe deploy is stale: users are running an older installer than the one in main.`;
}

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) {
		throw new Error(`${url} responded ${response.status} ${response.statusText}`);
	}
	return await response.text();
}

async function main(): Promise<void> {
	const repoRoot = path.join(import.meta.dir, "..");
	const failures: string[] = [];

	for (const { url, source } of DEPLOYED_INSTALLERS) {
		const expected = sha256(fs.readFileSync(path.join(repoRoot, source), "utf8"));
		let last = "";
		let matched = false;

		for (let attempt = 1; attempt <= PROPAGATION_ATTEMPTS; attempt++) {
			try {
				last = await fetchText(url);
			} catch (error) {
				last = "";
				console.log(`attempt ${attempt}: ${url} ${error instanceof Error ? error.message : String(error)}`);
			}
			if (last !== "" && sha256(last) === expected) {
				console.log(`OK  ${url} serves ${source} exactly (sha256 ${expected.slice(0, 12)}…)`);
				matched = true;
				break;
			}
			if (attempt < PROPAGATION_ATTEMPTS) {
				console.log(`attempt ${attempt}: ${url} does not match ${source} yet; retrying…`);
				await new Promise(resolve => setTimeout(resolve, PROPAGATION_DELAY_MS));
			}
		}

		if (!matched) {
			failures.push(describeMismatch(url, expected, last));
		}
	}

	if (failures.length > 0) {
		for (const failure of failures) {
			console.error(`::error::${failure}`);
		}
		process.exit(1);
	}
	console.log(`every deployed installer matches this repository (${DEPLOYED_INSTALLERS.length} endpoints)`);
}

if (import.meta.main) {
	await main();
}
