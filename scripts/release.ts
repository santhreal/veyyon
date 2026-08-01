#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
/**
 * The one release controller.
 *
 * Releases are requested only through the GitHub Actions Release workflow.
 * Actions calls the workflow subcommands in this file for source-gate selection,
 * the atomic version cut, exact-tag Checks, tagged CI, and final publication
 * verification.
 */
import { isNewerVersion } from "@veyyon/utils/semver";
import { $, Glob, JSONC } from "bun";
import { runChangelogFixer } from "./fix-changelogs";
import {
	checkedOutHeadSha,
	decideReleaseGate,
	gatherReleaseGateFacts,
	RELEASE_BOT_LOGIN,
	REQUIRED_SOURCE_WORKFLOWS,
	type ReleaseGateFacts,
	requiredSourceGate,
	verifyPublishedAssetManifest,
	verifyReleaseTagGates,
} from "./release-policy";
import { parseUnreleasedBullets } from "./require-changelog.ts";
import { buildRootChangelog, ROOT_PATH } from "./sync-root-changelog";

const changelogGlob = new Glob("packages/*/CHANGELOG.md");
const packageJsonGlob = new Glob("packages/*/package.json");
const cargoTomlGlob = new Glob("crates/*/Cargo.toml");
const REPO_ROOT = path.join(import.meta.dir, "..");
const RELEASE_REPOSITORY = "santhreal/veyyon";

function git(args: readonly string[]) {
	return $`git -c core.fsmonitor=false -c core.untrackedCache=false -c fetch.pruneTags=false ${args}`;
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

function removeEmptyVersionEntries(content: string): string {
	// Remove version entries that have no content (just whitespace until next ## [ or EOF)
	return content.replace(/## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}\s*\n(?=## \[|\s*$)/g, "");
}

/**
 * Roll a single changelog's `## [Unreleased]` into a dated `## [version]` entry.
 *
 * The fresh `## [Unreleased]` header stays exactly where the old one sat, and the
 * dated version section is inserted directly BELOW it. This matters for a
 * changelog whose `## [Unreleased]` lives under a fork-notice blockquote (e.g.
 * `packages/hashline/CHANGELOG.md`): a title-anchored insert (`# Changelog\n\n` +
 * a fresh `## [Unreleased]`) jammed `[Unreleased]` above the fork notice and left
 * the real bullets stranded in a phantom version that never published. When
 * `[Unreleased]` has no bullets, no version entry is created — using the SAME
 * bullet-based predicate (`parseUnreleasedBullets`) the release gate
 * (`has-releasable-changes`) decides on, so the two can never disagree: a stray
 * `### Fixed` header with no bullets does not mint a hollow version section for
 * one package just because another package triggered the cut. Any pre-existing
 * empty dated section is dropped either way. Pure so the ordering contract is
 * pinned by a test rather than only observed after a real release runs.
 */
export function applyReleaseToChangelog(content: string, version: string, date: string): string {
	if (parseUnreleasedBullets(content).length > 0) {
		content = content.replace("## [Unreleased]", `## [Unreleased]\n\n## [${version}] - ${date}`);
	}
	return removeEmptyVersionEntries(content);
}

async function updateChangelogsForRelease(version: string): Promise<void> {
	const date = new Date().toISOString().split("T")[0];

	for await (const changelog of changelogGlob.scan(".")) {
		const content = await Bun.file(changelog).text();

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		await Bun.write(changelog, applyReleaseToChangelog(content, version, date));
		console.log(`  Updated ${changelog}`);
	}
}

// =============================================================================
// Subcommands
// =============================================================================

export function parseVersion(v: string): [number, number, number] {
	const match = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) throw new Error(`Invalid version: ${v}`);
	return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

export function bumpVersion(current: string, bump: "major" | "minor" | "patch"): string {
	const [major, minor, patch] = parseVersion(current);
	switch (bump) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
	}
}

/** Rewrite only a package manifest's own version, preserving every other byte. */
export function rewritePackageVersion(content: string, version: string): string {
	const pattern = /("version":\s*)"[^"]+"/;
	if (!pattern.test(content)) throw new Error('Package manifest has no top-level "version" field.');
	return content.replace(pattern, `$1"${version}"`);
}

/** Rewrite the root Cargo workspace version, never an unrelated package version. */
export function rewriteCargoWorkspaceVersion(content: string, version: string): string {
	const pattern = /^(\[workspace\.package\][\s\S]*?^version = ")[^"]+"/m;
	if (!pattern.test(content)) throw new Error("Cargo.toml has no [workspace.package] version.");
	return content.replace(pattern, `$1${version}"`);
}

/**
 * The release bump commit's subject, which is a contract and not a message.
 *
 * Five workflows key their never-cancel release concurrency group off this
 * subject (`ci.yml`, `checks.yml`, `docs.yml`, `security.yml`), and
 * `release.yml` uses it to refuse to release its own bump commit and loop. They
 * all match the PREFIX `chore: bump version to `, so the version that follows
 * must never be allowed to drift into a form the prefix stops covering.
 *
 * The `v` is the part that was wrong. AGENTS.md mandates
 * `chore: bump version to vX.Y.Z` and every release through v1.0.38 committed
 * the bare `X.Y.Z`, because nothing here or in CI compared the two: the
 * workflows only ever test the prefix, so the missing `v` was invisible to
 * them and shipped for the whole tag history.
 */
export function releaseBumpSubject(version: string): string {
	return `chore: bump version to v${version.replace(/^v/, "")}`;
}

/** The `__veyyonNativesV…` sentinel export name for a version (non-alphanumerics -> `_`). */
export function sentinelExportName(version: string): string {
	return `__veyyonNativesV${version.replace(/^v/, "").replace(/[^A-Za-z0-9]/g, "_")}`;
}

/**
 * The single from->to sentinel rename a release performs: the PREVIOUS release's
 * sentinel to the new one. A release must never blanket-replace every
 * `__veyyonNativesV…` literal — the contract test pins historical fixtures
 * (`versionSentinelExportFor("1.0.14")` -> `"__veyyonNativesV1_0_14"`, and
 * V1_0_13/V16_5_2/V2_0_0_build_5) that must not track the current version, and a
 * blanket replace bricked the native test bucket on every bump. Only the current
 * build's sentinel (lib.rs `js_name`, its generated mirrors, and harnesses that
 * load the current `.node`) moves; every other version literal is left alone.
 */
export function planSentinelRewrite(prevVersion: string, nextVersion: string): { from: string; to: string } {
	return { from: sentinelExportName(prevVersion), to: sentinelExportName(nextVersion) };
}

/**
 * Classify lib.rs' sentinel state for a cut of `sentinelName` (previous release
 * emitted `prevSentinelName`). `rewrite`: the ordinary cut — lib.rs still emits
 * the previous sentinel and the rename applies. `alreadyBumped`: a RE-CUT of a
 * version whose bump commit already landed on main but whose tag died before
 * publish (dead-tag delete, v1.0.37 2026-07-24) — the tree is already correct
 * and the cut must proceed without rewriting. `missing`: neither sentinel is
 * present — a genuinely inconsistent tree the cut must refuse.
 */
export function classifySentinelBumpState(
	libRsText: string,
	prevSentinelName: string,
	sentinelName: string,
): "rewrite" | "alreadyBumped" | "missing" {
	if (libRsText.includes(`js_name = "${prevSentinelName}"`)) return "rewrite";
	if (libRsText.includes(`js_name = "${sentinelName}"`)) return "alreadyBumped";
	return "missing";
}

/**
 * True for a source file the sentinel rewrite must NEVER touch even when it holds
 * the previous sentinel. Test files carry the sentinel as an intentional
 * historical FIXTURE (a `.toBe("__veyyonNativesV<prev>")` where `<prev>` is a
 * deliberate past version). Because `<prev>` can be the IMMEDIATELY previous
 * release, its literal equals the rewrite's `from`, so an `sd -F` rename clobbers
 * the fixture and bricks the native bucket — the recurring NATIVE-SENTINEL bug
 * (it re-fired on v1.0.19, rewriting a 1_0_18 fixture to 1_0_19). Only production
 * source that EMITS or mirrors the CURRENT sentinel must advance (lib.rs
 * `js_name`, the generated native/index.{js,d.ts}, the render-stress harnesses —
 * none of which are `.test.` files). The `.test.` filename convention excludes
 * `foo.test.ts` while keeping non-test mirrors like `render-stress-harness.ts`.
 */
export function isSentinelRewriteExcluded(file: string): boolean {
	return file.includes("node_modules") || file.includes("/dist/") || /\.test\.[cm]?[jt]s$/.test(file);
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, authority: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${authority} must be an object.`);
	}
	return value as JsonObject;
}

function normalizedRelativePath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

async function discoverManifestPaths(
	rootDir: string,
	patterns: readonly string[],
	manifestName: string,
): Promise<string[]> {
	const discovered = new Set<string>();
	for (const pattern of patterns) {
		const normalizedPattern = normalizedRelativePath(pattern);
		const manifestPattern = normalizedPattern.endsWith(`/${manifestName}`)
			? normalizedPattern
			: `${normalizedPattern}/${manifestName}`;
		for await (const manifestPath of new Glob(manifestPattern).scan({ cwd: rootDir, onlyFiles: true })) {
			discovered.add(normalizedRelativePath(manifestPath));
		}
	}
	return [...discovered].sort();
}

function workspacePackagePatterns(rootPackage: JsonObject): string[] {
	const workspaces = rootPackage.workspaces;
	const patterns = Array.isArray(workspaces) ? workspaces : asObject(workspaces, "package.json workspaces").packages;
	if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== "string")) {
		throw new Error("package.json workspaces must enumerate package path patterns.");
	}
	return patterns as string[];
}

function workspaceCatalog(rootPackage: JsonObject): JsonObject {
	const workspaces = rootPackage.workspaces;
	if (Array.isArray(workspaces)) return {};
	const catalog = asObject(workspaces, "package.json workspaces").catalog;
	return catalog === undefined ? {} : asObject(catalog, "package.json workspace catalog");
}

/**
 * Enumerate every release-version authority in a prepared tree and require one
 * immutable version tuple before the cutter is allowed to push it.
 */
export async function validateReleaseVersionAuthorities(
	rootDir: string,
	version: string,
	expectedTag: string,
): Promise<void> {
	const errors: string[] = [];
	const strictVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
	if (!strictVersion.test(version)) errors.push(`release version "${version}" is not strict semver`);
	if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expectedTag)) {
		errors.push(`expected tag "${expectedTag}" is not a strict v-prefixed semver tag`);
	}
	if (expectedTag !== `v${version}`)
		errors.push(`expected tag "${expectedTag}" does not identify version "${version}"`);

	const rootPackagePath = path.join(rootDir, "package.json");
	const rootPackage = asObject(JSON.parse(await Bun.file(rootPackagePath).text()), "package.json");
	const manifestPaths = await discoverManifestPaths(rootDir, workspacePackagePatterns(rootPackage), "package.json");
	const publicPackages = new Map<string, { path: string; name: string }>();
	const publicNames = new Map<string, string>();
	for (const manifestPath of manifestPaths) {
		const manifest = asObject(JSON.parse(await Bun.file(path.join(rootDir, manifestPath)).text()), manifestPath);
		if (manifest.private === true) continue;
		if (typeof manifest.name !== "string" || manifest.name.length === 0) {
			errors.push(`public workspace ${manifestPath} has no package name`);
			continue;
		}
		const workspacePath = normalizedRelativePath(path.posix.dirname(manifestPath));
		if (publicNames.has(manifest.name)) {
			errors.push(
				`public package name ${manifest.name} is duplicated by ${publicNames.get(manifest.name)} and ${manifestPath}`,
			);
			continue;
		}
		publicNames.set(manifest.name, manifestPath);
		publicPackages.set(workspacePath, { path: manifestPath, name: manifest.name });
		if (manifest.version !== version) {
			errors.push(
				`public package ${manifest.name} at ${manifestPath} has version "${String(manifest.version)}", expected "${version}"`,
			);
		}
	}

	for (const [name, pin] of Object.entries(workspaceCatalog(rootPackage))) {
		if (publicNames.has(name) && pin !== version) {
			errors.push(`workspace catalog pin ${name} has version "${String(pin)}", expected "${version}"`);
		}
	}

	const bunLockPath = path.join(rootDir, "bun.lock");
	const bunLock = asObject(JSONC.parse(await Bun.file(bunLockPath).text()), "bun.lock");
	const lockedWorkspaces = asObject(bunLock.workspaces, "bun.lock workspaces");
	for (const [workspacePath, pkg] of publicPackages) {
		const locked = lockedWorkspaces[workspacePath];
		if (locked === undefined) {
			errors.push(`bun.lock is missing public workspace ${workspacePath} (${pkg.name})`);
			continue;
		}
		const lockedPackage = asObject(locked, `bun.lock workspace ${workspacePath}`);
		if (lockedPackage.name !== pkg.name) {
			errors.push(
				`bun.lock workspace ${workspacePath} names "${String(lockedPackage.name)}", expected "${pkg.name}"`,
			);
		}
		if (lockedPackage.version !== version) {
			errors.push(
				`bun.lock workspace ${workspacePath} (${pkg.name}) has version "${String(lockedPackage.version)}", expected "${version}"`,
			);
		}
	}

	const cargoToml = asObject(Bun.TOML.parse(await Bun.file(path.join(rootDir, "Cargo.toml")).text()), "Cargo.toml");
	const cargoWorkspace = asObject(cargoToml.workspace, "Cargo.toml workspace");
	const cargoWorkspacePackage = asObject(cargoWorkspace.package, "Cargo.toml workspace.package");
	if (cargoWorkspacePackage.version !== version) {
		errors.push(`Cargo workspace has version "${String(cargoWorkspacePackage.version)}", expected "${version}"`);
	}
	if (
		!Array.isArray(cargoWorkspace.members) ||
		cargoWorkspace.members.some(member => typeof member !== "string") ||
		(cargoWorkspace.exclude !== undefined &&
			(!Array.isArray(cargoWorkspace.exclude) ||
				cargoWorkspace.exclude.some(excluded => typeof excluded !== "string")))
	) {
		throw new Error("Cargo.toml workspace members/exclude must enumerate path patterns.");
	}
	const cargoManifestPaths = await discoverManifestPaths(rootDir, cargoWorkspace.members as string[], "Cargo.toml");
	const cargoExcludes = ((cargoWorkspace.exclude as string[] | undefined) ?? []).map(
		excluded => new Glob(normalizedRelativePath(excluded)),
	);
	const inheritedCargoPackages = new Map<string, string>();
	for (const manifestPath of cargoManifestPaths) {
		const cratePath = normalizedRelativePath(path.posix.dirname(manifestPath));
		if (cargoExcludes.some(excluded => excluded.match(cratePath))) continue;
		const manifest = asObject(Bun.TOML.parse(await Bun.file(path.join(rootDir, manifestPath)).text()), manifestPath);
		const cargoPackage = asObject(manifest.package, `${manifestPath} package`);
		const cargoVersion = cargoPackage.version;
		if (
			typeof cargoVersion !== "object" ||
			cargoVersion === null ||
			Array.isArray(cargoVersion) ||
			(cargoVersion as JsonObject).workspace !== true
		) {
			continue;
		}
		if (typeof cargoPackage.name !== "string" || cargoPackage.name.length === 0) {
			errors.push(`Cargo workspace package ${manifestPath} has no name`);
			continue;
		}
		if (inheritedCargoPackages.has(cargoPackage.name)) {
			errors.push(`Cargo workspace package name ${cargoPackage.name} is duplicated`);
			continue;
		}
		inheritedCargoPackages.set(cargoPackage.name, manifestPath);
	}

	const cargoLock = asObject(Bun.TOML.parse(await Bun.file(path.join(rootDir, "Cargo.lock")).text()), "Cargo.lock");
	if (!Array.isArray(cargoLock.package)) throw new Error("Cargo.lock must contain package entries.");
	for (const [name, manifestPath] of inheritedCargoPackages) {
		const locked = cargoLock.package.filter(
			entry =>
				typeof entry === "object" &&
				entry !== null &&
				!Array.isArray(entry) &&
				(entry as JsonObject).name === name &&
				(entry as JsonObject).source === undefined,
		) as JsonObject[];
		if (locked.length !== 1) {
			errors.push(
				`Cargo.lock has ${locked.length} local entries for workspace package ${name} (${manifestPath}), expected 1`,
			);
			continue;
		}
		if (locked[0].version !== version) {
			errors.push(`Cargo.lock package ${name} has version "${String(locked[0].version)}", expected "${version}"`);
		}
	}

	const sentinelName = sentinelExportName(version);
	const sentinelGlob = new Glob("{crates,packages}/**/*.{rs,ts,mts,cts,js,mjs,cjs}");
	let sentinelAuthorities = 0;
	for await (const sourcePath of sentinelGlob.scan({ cwd: rootDir, onlyFiles: true })) {
		const normalizedPath = normalizedRelativePath(sourcePath);
		if (isSentinelRewriteExcluded(normalizedPath)) continue;
		const source = await Bun.file(path.join(rootDir, normalizedPath)).text();
		for (const match of source.matchAll(/__veyyonNativesV[0-9][A-Za-z0-9_]*/g)) {
			sentinelAuthorities++;
			if (match[0] !== sentinelName) {
				errors.push(`native sentinel ${match[0]} in ${normalizedPath} disagrees with expected ${sentinelName}`);
			}
		}
	}
	if (sentinelAuthorities === 0) errors.push(`prepared tree has no native sentinel authority for ${sentinelName}`);

	if (errors.length > 0) {
		throw new Error(`Release version authority validation failed:\n- ${errors.join("\n- ")}`);
	}
}

async function prepareReleaseTree(version: string, latestTag: string): Promise<void> {
	console.log(`Updating package versions to ${version}…`);
	const pkgJsonPaths = await Array.fromAsync(packageJsonGlob.scan("."));
	const publicPkgPaths: string[] = [];
	for (const pkgPath of pkgJsonPaths) {
		const pkgJson = await Bun.file(pkgPath).json();
		if (pkgJson.private) {
			console.log(`  Skipping ${pkgJson.name} (private)`);
			continue;
		}
		publicPkgPaths.push(pkgPath);
	}
	for (const pkgPath of publicPkgPaths) {
		const file = Bun.file(pkgPath);
		const content = await file.text();
		await Bun.write(pkgPath, rewritePackageVersion(content, version));
	}
	console.log("  Verifying versions:");
	for (const pkgPath of publicPkgPaths) {
		const pkgJson = await Bun.file(pkgPath).json();
		console.log(`    ${pkgJson.name}: ${pkgJson.version}`);
	}
	console.log();

	console.log("Updating root catalog versions...");
	let rootPkgRaw = await Bun.file("package.json").text();
	rootPkgRaw = rootPkgRaw.replace(/("@veyyon\/[^"]+":\s*)"[^"]+"/g, `$1"${version}"`);
	await Bun.write("package.json", rootPkgRaw);
	console.log("  Updated root catalog @veyyon/* entries");

	console.log(`Updating Rust workspace version to ${version}…`);
	const cargoFile = Bun.file("Cargo.toml");
	const cargoBefore = await cargoFile.text();
	await Bun.write("Cargo.toml", rewriteCargoWorkspaceVersion(cargoBefore, version));
	const cargoToml = await Bun.file("Cargo.toml").text();
	const versionMatch = cargoToml.match(/^\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m);
	if (versionMatch) console.log(`  workspace: ${versionMatch[1]}`);
	for await (const cargoPath of cargoTomlGlob.scan(".")) {
		const content = await Bun.file(cargoPath).text();
		if (!content.includes("version.workspace = true")) continue;
		const nameMatch = content.match(/^name = "([^"]+)"/m);
		if (nameMatch) console.log(`  ${nameMatch[1]}: ${version} (workspace)`);
	}
	console.log();

	console.log(`Bumping veyyon-natives version sentinel to v${version}…`);
	const { from: prevSentinelName, to: sentinelName } = planSentinelRewrite(latestTag, version);
	if (prevSentinelName === sentinelName) {
		throw new Error(
			`previous sentinel ${prevSentinelName} equals the new one — version ${version} is not ahead of ${latestTag}.`,
		);
	}
	const sentinelGlob = new Bun.Glob("{crates,packages}/**/*.{rs,ts,mts,cts,js,mjs,cjs}");
	const sentinelFiles: Array<{ path: string; content: string }> = [];
	for await (const path of sentinelGlob.scan(".")) {
		if (isSentinelRewriteExcluded(path)) continue;
		const content = await Bun.file(path).text();
		if (content.includes(prevSentinelName)) sentinelFiles.push({ path, content });
	}
	const libRsBefore = await Bun.file("crates/veyyon-natives/src/lib.rs").text();
	const sentinelState = classifySentinelBumpState(libRsBefore, prevSentinelName, sentinelName);
	if (sentinelState === "missing") {
		throw new Error(
			`could not locate the previous veyyon-natives sentinel ${prevSentinelName} or target ${sentinelName} in ` +
				"crates/veyyon-natives/src/lib.rs; reconcile lib.rs (or the latest tag) before releasing.",
		);
	}
	if (sentinelFiles.length > 0) {
		await Promise.all(
			sentinelFiles.map(file => Bun.write(file.path, file.content.replaceAll(prevSentinelName, sentinelName))),
		);
	}
	const libRs = await Bun.file("crates/veyyon-natives/src/lib.rs").text();
	if (!libRs.includes(`js_name = "${sentinelName}"`)) {
		throw new Error(
			`veyyon-natives version sentinel did not move to ${sentinelName} in crates/veyyon-natives/src/lib.rs.`,
		);
	}
	console.log(`  sentinel: ${sentinelName}${sentinelState === "alreadyBumped" ? " (already bumped)" : ""}\n`);

	// Preserve the reviewed dependency graph; refresh only workspace versions.
	console.log("Refreshing lockfiles...");
	await $`bun install`;
	await $`cargo generate-lockfile`;
	console.log();

	console.log("Updating CHANGELOGs...");
	const fixResult = await runChangelogFixer({});
	for (const fixed of fixResult.changedFiles) {
		console.log(
			`  Fixed ${fixed.path}: ${fixed.promotedItems} promoted, ` +
				`${fixed.mergedDuplicateHeadings} duplicate heading(s) merged, ` +
				`${fixed.mergedDuplicateVersions} duplicate version(s) merged, ` +
				`${fixed.removedEmptyHeadings} empty heading(s) removed`,
		);
	}
	await updateChangelogsForRelease(version);
	await Bun.write(ROOT_PATH, buildRootChangelog());
	console.log("  Updated CHANGELOG.md (repo root)\n");

	console.log("Running checks...");
	await $`bun run check`;
	console.log();
}

export interface ReleasePushOperations {
	currentSha(): Promise<string>;
	forceLocalTag(tag: string): Promise<void>;
	atomicPush(tag: string, sha: string): Promise<void>;
}

/**
 * Push the exact tree whose CI and Checks runs the release gate approved.
 *
 * One attempt only. If main advanced while preparation ran, the atomic push
 * fails without moving either main or the tag. The newer main SHA gets its own
 * CI and Checks runs, and their workflow completion starts a fresh release cut.
 * Rebasing here would publish a tree the exact-SHA gate never approved.
 */
export async function pushPreparedRelease(tag: string, operations: ReleasePushOperations): Promise<void> {
	const sha = await operations.currentSha();
	await operations.forceLocalTag(tag);
	await operations.atomicPush(tag, sha);
}

export interface WorkflowRunEvidence {
	path: string;
	event: string;
	headBranch: string;
	headSha: string;
	displayTitle: string;
	actor: string;
}

export interface WorkflowDispatchRequest {
	workflow: string;
	label: string;
	tag: string;
	sha: string;
	inputs?: Readonly<Record<string, string>>;
	expectedTitle?: string;
}

export interface ReleaseWorkflowOperations {
	listRunIds(workflow: string, sha: string): Promise<readonly number[]>;
	dispatch(workflow: string, ref: string, inputs: Readonly<Record<string, string>>): Promise<void>;
	runEvidence(id: number): Promise<WorkflowRunEvidence>;
	watch(id: number): Promise<void>;
	sleep(milliseconds: number): Promise<void>;
	verifyPublished(tag: string): Promise<string>;
}

export interface ReleasePublicationResult {
	checksRunId: number;
	ciRunId: number;
	url: string;
}

async function runGh(args: readonly string[]): Promise<string> {
	const child = Bun.spawn(["gh", ...args], {
		cwd: REPO_ROOT,
		env: Bun.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`gh ${args.join(" ")} failed with exit ${exitCode}: ${stderr.trim()}`);
	}
	return stdout.trim();
}

function workflowRunsUrl(workflow: string, sha: string): string {
	const repository = Bun.env.GITHUB_REPOSITORY ?? RELEASE_REPOSITORY;
	return `repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${sha}&event=workflow_dispatch&per_page=100`;
}

const releaseWorkflowOperations: ReleaseWorkflowOperations = {
	listRunIds: async (workflow, sha) => {
		const output = await runGh(["api", workflowRunsUrl(workflow, sha), "--paginate", "--jq", ".workflow_runs[].id"]);
		if (!output) return [];
		return output.split("\n").map(value => {
			const id = Number(value);
			if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${workflow} returned invalid run id ${value}`);
			return id;
		});
	},
	dispatch: async (workflow, ref, inputs) => {
		const args = ["workflow", "run", workflow, "--ref", ref];
		for (const [key, value] of Object.entries(inputs)) args.push("-f", `${key}=${value}`);
		await runGh(args);
	},
	runEvidence: async id => {
		const repository = Bun.env.GITHUB_REPOSITORY ?? RELEASE_REPOSITORY;
		const output = await runGh([
			"api",
			`repos/${repository}/actions/runs/${id}`,
			"--jq",
			"{path:.path,event:.event,headBranch:.head_branch,headSha:.head_sha,displayTitle:.display_title,actor:.actor.login}",
		]);
		const parsed: unknown = JSON.parse(output);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof (parsed as Record<string, unknown>).path !== "string" ||
			typeof (parsed as Record<string, unknown>).event !== "string" ||
			typeof (parsed as Record<string, unknown>).headBranch !== "string" ||
			typeof (parsed as Record<string, unknown>).headSha !== "string" ||
			typeof (parsed as Record<string, unknown>).displayTitle !== "string" ||
			typeof (parsed as Record<string, unknown>).actor !== "string"
		) {
			throw new Error(`GitHub run ${id} returned invalid correlation evidence`);
		}
		return parsed as unknown as WorkflowRunEvidence;
	},
	watch: async id => {
		await runGh(["run", "watch", String(id), "--exit-status"]);
	},
	sleep: async milliseconds => {
		await Bun.sleep(milliseconds);
	},
	verifyPublished: async tag => {
		await verifyPublishedAssetManifest(tag);
		const output = await runGh(["release", "view", tag, "--json", "isDraft,tagName,url"]);
		const parsed: unknown = JSON.parse(output);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			(parsed as Record<string, unknown>).isDraft !== false ||
			(parsed as Record<string, unknown>).tagName !== tag ||
			typeof (parsed as Record<string, unknown>).url !== "string"
		) {
			throw new Error(`${tag} did not finish as a published GitHub release`);
		}
		const latest = await runGh(["release", "view", "--json", "tagName", "--jq", ".tagName"]);
		if (latest !== tag)
			throw new Error(`${tag} published, but releases/latest still resolves to ${latest || "nothing"}`);
		return (parsed as Record<string, unknown>).url as string;
	},
};

export async function dispatchWorkflowAndWait(
	request: WorkflowDispatchRequest,
	operations: ReleaseWorkflowOperations,
): Promise<number> {
	const baseline = new Set(await operations.listRunIds(request.workflow, request.sha));
	await operations.dispatch(request.workflow, request.tag, request.inputs ?? {});
	for (let attempt = 1; attempt <= 30; attempt++) {
		const ids = await operations.listRunIds(request.workflow, request.sha);
		for (const id of ids) {
			if (baseline.has(id)) continue;
			const evidence = await operations.runEvidence(id);
			if (
				evidence.path === `.github/workflows/${request.workflow}` &&
				evidence.event === "workflow_dispatch" &&
				evidence.headBranch === request.tag &&
				evidence.headSha === request.sha &&
				evidence.actor === RELEASE_BOT_LOGIN &&
				(request.expectedTitle === undefined || evidence.displayTitle === request.expectedTitle)
			) {
				await operations.watch(id);
				return id;
			}
		}
		await operations.sleep(Math.min(attempt, 5) * 1000);
	}
	throw new Error(`${request.label} did not start a correlated run for ${request.tag} (${request.sha})`);
}

export async function publishPreparedRelease(
	tag: string,
	sha: string,
	operations: ReleaseWorkflowOperations = releaseWorkflowOperations,
): Promise<ReleasePublicationResult> {
	const runId = Bun.env.GITHUB_RUN_ID;
	const runAttempt = Bun.env.GITHUB_RUN_ATTEMPT;
	if (!runId || !runAttempt) throw new Error("release publication requires GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT");
	const checksNonce = `${runId}-${runAttempt}-checks`;
	const checksRunId = await dispatchWorkflowAndWait(
		{
			workflow: "checks.yml",
			label: "Checks",
			tag,
			sha,
			inputs: { release_nonce: checksNonce },
			expectedTitle: `Checks release gate ${checksNonce}`,
		},
		operations,
	);
	const ciNonce = `${runId}-${runAttempt}-ci`;
	const ciRunId = await dispatchWorkflowAndWait(
		{
			workflow: "ci.yml",
			label: "CI",
			tag,
			sha,
			inputs: { release_nonce: ciNonce },
			expectedTitle: `CI release gate ${ciNonce}`,
		},
		operations,
	);
	const url = await operations.verifyPublished(tag);
	return { checksRunId, ciRunId, url };
}

export interface WorkflowGateInput {
	eventName: string;
	dispatchVersion?: string;
	expectedSha?: string;
	headCommitMessage?: string;
	triggerHeadSha?: string;
	triggerWorkflowName?: string;
	triggerWorkflowConclusion?: string;
}

export interface WorkflowGateResult {
	shouldRelease: boolean;
	version: string;
	sourceSha: string;
	reason: string;
}

export interface WorkflowGateOperations {
	currentSha(): Promise<string | undefined>;
	gatherFacts(): Promise<ReleaseGateFacts | undefined>;
}

const workflowGateOperations: WorkflowGateOperations = {
	currentSha: checkedOutHeadSha,
	gatherFacts: gatherReleaseGateFacts,
};

function includeTriggerWorkflowEvidence(
	facts: ReleaseGateFacts,
	input: WorkflowGateInput,
	sourceSha: string,
): ReleaseGateFacts {
	const name = input.triggerWorkflowName;
	if (
		!name ||
		input.triggerWorkflowConclusion !== "success" ||
		!REQUIRED_SOURCE_WORKFLOWS.some(required => required === name) ||
		facts.sourceWorkflowRuns.some(run => run.name === name && run.headSha === sourceSha)
	) {
		return facts;
	}
	return {
		...facts,
		sourceWorkflowRuns: [
			{ name, headSha: sourceSha, status: "completed", conclusion: "success" },
			...facts.sourceWorkflowRuns,
		],
	};
}

export async function decideWorkflowRelease(
	input: WorkflowGateInput,
	operations: WorkflowGateOperations = workflowGateOperations,
): Promise<WorkflowGateResult> {
	const sourceSha = await operations.currentSha();
	if (!sourceSha) throw new Error("could not resolve the checked-out main SHA");
	if (input.eventName !== "workflow_dispatch" && input.triggerHeadSha !== sourceSha) {
		return {
			shouldRelease: false,
			version: "",
			sourceSha,
			reason: `trigger SHA ${input.triggerHeadSha ?? "unknown"} is stale; main is ${sourceSha}`,
		};
	}
	if (input.eventName === "workflow_dispatch") {
		if (!input.expectedSha) throw new Error("manual release requires the exact validated main SHA");
		if (input.expectedSha !== sourceSha) {
			throw new Error(`main is at ${sourceSha}, but the operator validated ${input.expectedSha}`);
		}
		const facts = await operations.gatherFacts();
		if (!facts) throw new Error("could not establish exact-SHA CI/Checks or GitHub publication state");
		const gate = requiredSourceGate(facts);
		if (gate) throw new Error(`release source gate failed: ${gate.reason}`);
		return {
			shouldRelease: true,
			version: parseReleaseRequest([input.dispatchVersion ?? "patch"]),
			sourceSha,
			reason: "manual release request passed exact-SHA CI and Checks",
		};
	}
	const subject = (input.headCommitMessage ?? "").split("\n", 1)[0] ?? "";
	if (subject.startsWith("chore: bump version to ")) {
		return { shouldRelease: false, version: "", sourceSha, reason: "release bump commits never trigger another cut" };
	}
	if ((input.headCommitMessage ?? "").includes("[skip release]")) {
		return { shouldRelease: false, version: "", sourceSha, reason: "[skip release] marker present" };
	}
	const gatheredFacts = await operations.gatherFacts();
	if (!gatheredFacts) throw new Error("could not establish exact-SHA CI/Checks or GitHub publication state");
	const facts = includeTriggerWorkflowEvidence(gatheredFacts, input, sourceSha);
	const sourceGate = requiredSourceGate(facts);
	if (sourceGate) {
		return {
			shouldRelease: false,
			version: "",
			sourceSha,
			reason: sourceGate.reason,
		};
	}
	const decision = decideReleaseGate(facts);
	if (decision.needsAttention) throw new Error(decision.reason);
	return {
		shouldRelease: decision.cut,
		version: decision.cut ? "patch" : "",
		sourceSha,
		reason: decision.reason,
	};
}

async function writeWorkflowGateOutputs(result: WorkflowGateResult): Promise<void> {
	const outputPath = Bun.env.GITHUB_OUTPUT;
	if (!outputPath) throw new Error("workflow gate requires GITHUB_OUTPUT");
	await fs.appendFile(
		outputPath,
		`should-release=${result.shouldRelease}\nversion=${result.version}\nsource-sha=${result.sourceSha}\n`,
	);
	console.log(result.reason);
}
export interface PreparedRelease {
	tag: string;
	sha: string;
	version: string;
}

export async function cmdRelease(versionOrBump: string): Promise<PreparedRelease> {
	console.log("\n=== Release Script ===\n");

	// 1. Pre-flight checks
	console.log("Pre-flight checks...");

	const branch = await git(["branch", "--show-current"]).text();
	if (branch.trim() !== "main") {
		console.error(`Error: Must be on main branch (currently on '${branch.trim()}')`);
		process.exit(1);
	}
	console.log("  On main branch");

	const status = await git(["status", "--porcelain"]).text();
	if (status.trim()) {
		console.error("Error: Uncommitted changes detected. Commit or stash first.");
		console.error(status);
		process.exit(1);
	}
	console.log("  Working directory clean");

	// No `v*` tag yet is the expected state for veyyon's first release — it forked
	// oh-my-pi's source (and its inherited changelog history) but carried over none
	// of its git tags, and cuts its own release line starting at 1.0.0. Treat the
	// empty result as a 0.0.0 baseline so `release major` yields 1.0.0 and an
	// explicit `1.0.0` passes the monotonicity check below, instead of `git
	// describe` exiting 128 and aborting the whole release.
	const describe = await git(["describe", "--tags", "--abbrev=0", "--match", "v*"]).nothrow().text();
	const latestTag = describe.trim() || "0.0.0";
	let version = versionOrBump;
	if (version === "major" || version === "minor" || version === "patch") {
		version = bumpVersion(latestTag, version);
		console.log(`Bumping ${versionOrBump} version from ${latestTag} -> ${version}`);
	}

	if (!isNewerVersion(version, latestTag)) {
		console.error(`Error: Version ${version} must be greater than latest tag ${latestTag}`);
		process.exit(1);
	}
	console.log(`  Version ${version} > ${latestTag}\n`);

	// Prepare the exact tree that will be tagged. The preparation is idempotent
	// so an explicit recovery cut can rebuild every version, changelog, lockfile,
	// and check from the approved tree without preserving partial state.
	await prepareReleaseTree(version, latestTag);

	// 7. Commit. A re-cut of a version whose bump commit already landed (dead
	// tag deleted after a failed publish) can produce a zero diff here — every
	// version/sentinel/changelog write above was an idempotent no-op. `git
	// commit` on an empty tree fails and would wedge the train on a state that
	// is already correct, so tag the existing HEAD instead.
	console.log("Committing...");
	await git(["add", "."]);
	const staged = (await git(["status", "--porcelain"]).text()).trim();
	const hasReleaseCommit = staged.length > 0;
	if (!hasReleaseCommit) {
		console.log(`  nothing to commit (a prior cut of v${version} already landed the bump); tagging HEAD`);
	} else {
		await git(["commit", "-m", releaseBumpSubject(version)]);
	}
	console.log();

	// 8. Tag, then push branch + tag atomically — pushing the tag by object id.
	//
	// This repo is in the global `[maintenance] repo = …` list, so a scheduled
	// `git maintenance run` fetches origin with `fetch.pruneTags=true` (set
	// globally) and deletes any local tag not yet on the remote — i.e. the
	// brand-new release tag. The `-c fetch.pruneTags=false` on our git wrapper
	// only governs our own git calls, not the concurrent maintenance process, so
	// a local tag ref may vanish before or while the push resolves it.
	//
	// A bare push refspec (`refs/tags/v…` with no `:dst`) re-resolves the tag on
	// disk during refspec matching (git's remote.c:match_explicit); if the prune
	// lands in that window git dies with
	// "refs/tags/v… cannot be resolved to branch", and if it lands before the
	// push it dies with "src refspec … does not match any". We sidestep both by
	// pushing the HEAD commit object id straight into the remote tag ref
	// (`<sha>:refs/tags/v…`): the push has no dependency on a local tag, and the
	// commit is reachable from main so maintenance cannot prune it. The local
	// tag we still create is only for `git describe`; losing it is harmless. The
	// default Git LFS pre-push hook uploads the branch's LFS objects as part of
	// this same atomic push — no separate `git lfs push` is needed.
	console.log("Tagging and pushing to remote...");
	const tagRef = `v${version}`;
	// Main can advance during preparation. Do not rebase or retry here: the gate
	// approved this exact SHA, not whatever arrived later. A rejected atomic push
	// leaves both remote refs untouched; the newer main workflow starts a fresh
	// cut after its own CI and Checks runs are green.
	await validateReleaseVersionAuthorities(".", version, tagRef);
	const releaseSha = (await git(["rev-parse", "HEAD"]).text()).trim();
	await pushPreparedRelease(tagRef, {
		currentSha: async () => releaseSha,
		forceLocalTag: async tag => {
			await git(["tag", "-f", tag]);
		},
		atomicPush: async (tag, sha) => {
			await git(["push", "--atomic", "origin", "refs/heads/main:refs/heads/main", `${sha}:refs/tags/${tag}`]);
		},
	});
	console.log();

	console.log(`Pushed ${tagRef}. Waiting for exact-tag Checks and the complete tagged CI release.`);
	return { tag: tagRef, sha: releaseSha, version };
}

async function runWorkflowGateCommand(): Promise<void> {
	const result = await decideWorkflowRelease({
		eventName: Bun.env.GITHUB_EVENT_NAME ?? "",
		dispatchVersion: Bun.env.RELEASE_DISPATCH_VERSION,
		expectedSha: Bun.env.RELEASE_EXPECTED_SHA,
		headCommitMessage: Bun.env.RELEASE_HEAD_COMMIT_MESSAGE,
		triggerHeadSha: Bun.env.RELEASE_TRIGGER_HEAD_SHA,
		triggerWorkflowName: Bun.env.RELEASE_TRIGGER_WORKFLOW_NAME,
		triggerWorkflowConclusion: Bun.env.RELEASE_TRIGGER_WORKFLOW_CONCLUSION,
	});
	await writeWorkflowGateOutputs(result);
}

export interface GatedReleaseSourceOperations {
	currentSha(): Promise<string>;
	switchMain(sha: string): Promise<void>;
	configureGitIdentity(): Promise<void>;
}

const gatedReleaseSourceOperations: GatedReleaseSourceOperations = {
	currentSha: async () => (await git(["rev-parse", "HEAD"]).text()).trim(),
	switchMain: async sha => {
		await git(["switch", "-C", "main", sha]);
	},
	configureGitIdentity: async () => {
		await git(["config", "user.name", "github-actions[bot]"]);
		await git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
	},
};

export async function materializeGatedReleaseSource(
	expectedSha: string,
	operations: GatedReleaseSourceOperations = gatedReleaseSourceOperations,
): Promise<void> {
	const checkedOutSha = await operations.currentSha();
	if (checkedOutSha !== expectedSha) {
		throw new Error(`release checkout is ${checkedOutSha}, expected gated SHA ${expectedSha}`);
	}
	await operations.switchMain(expectedSha);
	await operations.configureGitIdentity();
}

export interface ReleaseTrainOperations {
	materialize(sourceSha: string): Promise<void>;
	cut(version: string): Promise<PreparedRelease>;
	publish(tag: string, sha: string): Promise<ReleasePublicationResult>;
}

export interface CompletedRelease {
	tag: string;
	sha: string;
	version: string;
	checksRunId: number;
	ciRunId: number;
	url: string;
}

const releaseTrainOperations: ReleaseTrainOperations = {
	materialize: materializeGatedReleaseSource,
	cut: cmdRelease,
	publish: publishPreparedRelease,
};

export async function runReleaseTrain(
	version: string,
	sourceSha: string,
	operations: ReleaseTrainOperations = releaseTrainOperations,
): Promise<CompletedRelease> {
	await operations.materialize(sourceSha);
	const prepared = await operations.cut(version);
	const publication = await operations.publish(prepared.tag, prepared.sha);
	return { ...prepared, ...publication };
}

async function runWorkflowReleaseCommand(version: string): Promise<void> {
	if (Bun.env.VEYYON_RELEASE_IN_CI !== "1") throw new Error("workflow-release may run only inside Release CI");
	const expectedSha = Bun.env.RELEASE_SOURCE_SHA;
	if (!expectedSha) throw new Error("workflow-release requires RELEASE_SOURCE_SHA");
	const completed = await runReleaseTrain(version, expectedSha);
	const summaryPath = Bun.env.GITHUB_STEP_SUMMARY;
	if (summaryPath) {
		await fs.appendFile(
			summaryPath,
			`### Release \`${completed.tag}\` published\n\n` +
				`Checks run: ${completed.checksRunId}\n\n` +
				`CI run: ${completed.ciRunId}\n\n` +
				`${completed.url}\n`,
		);
	}
	console.log(`Published ${completed.tag}: ${completed.url}`);
}

async function runReleaseController(args: readonly string[]): Promise<void> {
	const [command, ...rest] = args;
	switch (command) {
		case "workflow-gate":
			if (rest.length > 0) throw new Error("Usage: release.ts workflow-gate");
			await runWorkflowGateCommand();
			return;
		case "workflow-release": {
			const version = parseReleaseRequest(rest);
			await runWorkflowReleaseCommand(version);
			return;
		}
		case "verify-tag": {
			const [tag, sha, ciNonce, dispatchActor, ...extra] = rest;
			if (!tag || !sha || !ciNonce || !dispatchActor || extra.length > 0) {
				throw new Error("Usage: release.ts verify-tag <tag> <sha> <ci-nonce> <dispatch-actor>");
			}
			await verifyReleaseTagGates(tag, sha, ciNonce, dispatchActor);
			return;
		}
		case "verify-assets": {
			const [tag, ...extra] = rest;
			if (!tag || extra.length > 0) throw new Error("Usage: release.ts verify-assets <tag>");
			await verifyPublishedAssetManifest(tag);
			return;
		}
		default:
			throw new Error(
				"Usage: release.ts workflow-gate | workflow-release <version> | verify-tag <tag> <sha> <ci-nonce> <dispatch-actor> | verify-assets <tag>",
			);
	}
}

if (import.meta.main) {
	try {
		await runReleaseController(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
