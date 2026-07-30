#!/usr/bin/env bun
/**
 * Dispatch the remote Release workflow after proving this checkout names the
 * exact main commit the operator intends to release.
 */
import * as path from "node:path";
import { $ } from "bun";

const REPO_ROOT = path.join(import.meta.dir, "..");
const RELEASE_REPOSITORY = "santhreal/veyyon";
const RELEASE_WORKFLOW = "release.yml";
const REQUIRED_GH_LOGIN = "santhsecurity";

export interface ReleaseTriggerOperations {
	currentBranch(): Promise<string>;
	workingTreeStatus(): Promise<string>;
	fetchMain(): Promise<void>;
	localHead(): Promise<string>;
	originMainHead(): Promise<string>;
	authStatus(): Promise<string>;
	dispatch(version: string, expectedSha: string): Promise<void>;
}

export interface ReleaseDispatch {
	version: string;
	sha: string;
}

export function parseReleaseRequest(args: readonly string[]): string {
	if (args.length > 1) {
		throw new Error("Release accepts one version: major, minor, patch, or an explicit x.y.z.");
	}
	const version = args[0] ?? "patch";
	if (version === "major" || version === "minor" || version === "patch" || /^\d+\.\d+\.\d+$/.test(version)) {
		return version;
	}
	throw new Error(`Invalid release version ${JSON.stringify(version)}. Use major, minor, patch, or x.y.z.`);
}

export function hasRequiredActiveGitHubAccount(status: string): boolean {
	let account: string | undefined;
	for (const line of status.split("\n")) {
		const match = line.match(/Logged in to github\.com account ([^\s(]+)/);
		if (match) account = match[1];
		if (account === REQUIRED_GH_LOGIN && /Active account:\s*true/.test(line)) return true;
	}
	return false;
}

export async function triggerRelease(
	version: string,
	operations: ReleaseTriggerOperations = releaseTriggerOperations,
): Promise<ReleaseDispatch> {
	const branch = await operations.currentBranch();
	if (branch !== "main") {
		throw new Error(`Release must be triggered from main, but this checkout is on ${JSON.stringify(branch)}.`);
	}

	const status = await operations.workingTreeStatus();
	if (status.trim()) {
		throw new Error("Release requires a clean working tree. Commit the intended release candidate first.");
	}

	await operations.fetchMain();
	const [localHead, originMainHead] = await Promise.all([operations.localHead(), operations.originMainHead()]);
	if (localHead !== originMainHead) {
		throw new Error(
			`Local main (${localHead}) does not match origin/main (${originMainHead}). Push or update main, then wait for its exact-SHA gates.`,
		);
	}

	const authStatus = await operations.authStatus();
	if (!hasRequiredActiveGitHubAccount(authStatus)) {
		throw new Error(
			`GitHub account ${REQUIRED_GH_LOGIN} must be active. Run: gh auth switch --user ${REQUIRED_GH_LOGIN}`,
		);
	}

	await operations.dispatch(version, originMainHead);
	return { version, sha: originMainHead };
}

const releaseTriggerOperations: ReleaseTriggerOperations = {
	currentBranch: async () => (await $`git branch --show-current`.cwd(REPO_ROOT).quiet()).text().trim(),
	workingTreeStatus: async () => (await $`git status --porcelain`.cwd(REPO_ROOT).quiet()).text(),
	fetchMain: async () => {
		await $`git fetch origin main`.cwd(REPO_ROOT).quiet();
	},
	localHead: async () => (await $`git rev-parse HEAD`.cwd(REPO_ROOT).quiet()).text().trim(),
	originMainHead: async () => (await $`git rev-parse origin/main`.cwd(REPO_ROOT).quiet()).text().trim(),
	authStatus: async () => {
		const result = await $`gh auth status --hostname github.com`
			.cwd(REPO_ROOT)
			.env({ ...Bun.env, NO_COLOR: "1" })
			.quiet()
			.nothrow();
		return `${result.text()}\n${result.stderr.toString()}`;
	},
	dispatch: async (version, expectedSha) => {
		await $`gh workflow run ${RELEASE_WORKFLOW} --repo ${RELEASE_REPOSITORY} --ref main -f version=${version} -f expected_sha=${expectedSha}`
			.cwd(REPO_ROOT)
			.quiet();
	},
};

if (import.meta.main) {
	try {
		const version = parseReleaseRequest(process.argv.slice(2));
		const release = await triggerRelease(version);
		console.log(`Release workflow dispatched for ${release.sha}: ${release.version}.`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
