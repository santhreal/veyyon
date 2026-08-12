#!/usr/bin/env bun
import * as path from "node:path";
/**
 * Release-tree preparation and the two checks CI runs at a tag.
 *
 * The version cut itself happens on the operator's machine: `scripts/release-cut.ts`
 * calls {@link prepareReleaseTree} to roll every version authority, changelog,
 * lockfile and the natives sentinel, then commits. That commit reaches main
 * through an ordinary push, so main's CI tests it before any tag exists, and
 * tagging the green commit is the whole release.
 *
 * What remains here for Actions is verification: `verify-tag` proves the tag
 * sits on a commit that landed on main and that the tree's versions agree with
 * it, and `verify-assets` proves the publication produced the complete manifest.
 */
import { isReleaseTag, isReleaseVersion, RELEASE_VERSION_BODY } from "@veyyon/utils/semver";
import { $, Glob, JSONC } from "bun";
import { hasVersionHeading, unreleasedEntries } from "./changelog-unreleased.ts";
import { runChangelogFixer } from "./fix-changelogs";
import {
	assertPreparedReleaseChangelogs,
	type PackageChangelog,
	RELEASE_NOTES_CHANGELOG,
	verifyPublishedAssetManifest,
	verifyReleaseTagIsOnMain,
} from "./release-policy";
import { orphanRefusalLines, writeRootChangelog } from "./sync-root-changelog";

const changelogGlob = new Glob("packages/*/CHANGELOG.md");
const packageJsonGlob = new Glob("packages/*/package.json");
const cargoTomlGlob = new Glob("crates/*/Cargo.toml");
export function parseReleaseRequest(args: readonly string[]): string {
	if (args.length > 1) {
		throw new Error("Release accepts one version: major, minor, patch, or an explicit x.y.z.");
	}
	const version = args[0] ?? "patch";
	if (version === "major" || version === "minor" || version === "patch" || isReleaseVersion(version)) {
		return version;
	}
	throw new Error(`Invalid release version ${JSON.stringify(version)}. Use major, minor, patch, or x.y.z.`);
}

/**
 * What to tell an operator whose requested version is not newer than the latest tag.
 *
 * Two very different situations reach this point and they need opposite advice.
 * Asking for a version OLDER than the tag is a mistake, and "pick a higher one"
 * is right. Asking for the version that is already tagged is usually not a
 * mistake: it is the documented recovery from a publish that died after the tag
 * was pushed. `prepareReleaseTree` is idempotent for exactly that reason, and the
 * commit step tags the existing HEAD when the bump commit already landed.
 *
 * That recovery was unreachable. The only message here was "must be greater than
 * latest tag", which reads as "pick a higher version", and cutting a fresh
 * version is the one thing an operator recovering a failed publish must not do:
 * it burns a version number and leaves the dead tag behind. The recovery is named
 * here rather than left to be rediscovered from a comment further down the file.
 */
export function versionNotNewerFailure(version: string, latestTag: string): string[] {
	if (`v${version}` !== latestTag) {
		return [`Error: Version ${version} must be greater than latest tag ${latestTag}`];
	}
	return [
		`Error: ${latestTag} is already tagged.`,
		"",
		"  If that release published, cut the next version instead.",
		"  If it failed after tagging, delete the dead tag and re-cut this same version:",
		`    git push origin :refs/tags/${latestTag}`,
		`    git tag -d ${latestTag}`,
		"  Re-cutting is safe: the tree preparation is idempotent, and a bump commit that",
		"  already landed is tagged in place rather than committed twice.",
	];
}

/**
 * Drop version sections that carry nothing, so a package with no changes does
 * not publish a hollow heading.
 *
 * The date is optional. It used to be required, which split the difference with
 * `hasVersionHeading`, the gate that decides whether a version is documented:
 * that one accepts a dateless `## [1.2.3]`, so an undated empty section both
 * survived this cleanup and satisfied the gate, and the release shipped a
 * heading with no content under it.
 */
function removeEmptyVersionEntries(content: string): string {
	return content.replace(
		new RegExp(String.raw`## \[${RELEASE_VERSION_BODY}\](?: - \d{4}-\d{2}-\d{2})?\s*\n(?=## \[|\s*$)`, "g"),
		"",
	);
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
 * `[Unreleased]` has no bullets, no version entry is created: a stray `### Fixed`
 * header with no bullets must not mint a hollow version section for a package
 * that had nothing to ship in this release. Any pre-existing empty dated section
 * is dropped either way. Pure so the ordering contract is pinned by a test rather
 * than only observed after a real release runs.
 */
export function applyReleaseToChangelog(content: string, version: string, date: string): string {
	if (unreleasedEntries(content).length > 0) {
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

/**
 * Read every `packages/<name>/CHANGELOG.md` with the name of the package that owns it, so the
 * gate can name the offender rather than a path the operator has to map back to a package.
 */
export async function loadPackageChangelogs(): Promise<PackageChangelog[]> {
	const changelogs: PackageChangelog[] = [];
	for await (const changelog of changelogGlob.scan(".")) {
		const posixPath = changelog.replaceAll(path.sep, "/");
		const dir = path.dirname(changelog);
		const manifest = Bun.file(path.join(dir, "package.json"));
		const name = (await manifest.exists()) ? ((await manifest.json()).name ?? dir) : dir;
		changelogs.push({ path: posixPath, name, content: await Bun.file(changelog).text() });
	}
	return changelogs;
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
 * subject: `checks.yml` exempts the bump commit from the changelog gate, because
 * the bump drains every `## [Unreleased]` section by design. It matches the
 * PREFIX `chore: bump version to `, so the version that follows must never be
 * allowed to drift into a form the prefix stops covering.
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
	if (!isReleaseVersion(version)) errors.push(`release version "${version}" is not strict semver`);
	if (!isReleaseTag(expectedTag)) {
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

	// The changelog is an authority in the same sense as the manifests: it is the tree's own
	// statement of what this version is, and the published surfaces read it. The website
	// generator refuses to build when a PUBLISHED GitHub release has no `## [x.y.z]` section
	// (website/tools/gen-changelog.mjs, reportUndocumentedReleases), and until this check
	// existed that refusal was the FIRST thing to notice: v1.0.38 through v1.0.46 were each
	// tagged at a tree with no section, so each one built binaries, published a release, and
	// only then went red in `release_site_finalize` with the release already public and the
	// site still describing the previous version. Read at the tag, the same fact costs one
	// file read and refuses before anything ships.
	const releaseNotesPath = path.join(rootDir, RELEASE_NOTES_CHANGELOG);
	const releaseNotesFile = Bun.file(releaseNotesPath);
	if (!(await releaseNotesFile.exists())) {
		errors.push(`${RELEASE_NOTES_CHANGELOG} is missing; the release notes and the changelog page are built from it`);
	} else if (!hasVersionHeading(await releaseNotesFile.text(), version)) {
		errors.push(
			`${RELEASE_NOTES_CHANGELOG} has no "## [${version}]" section, so a published v${version} would be a ` +
				`release the website cannot describe`,
		);
	}

	if (errors.length > 0) {
		throw new Error(`Release version authority validation failed:\n- ${errors.join("\n- ")}`);
	}
}

export async function prepareReleaseTree(version: string, latestTag: string): Promise<void> {
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
	assertPreparedReleaseChangelogs(version, await loadPackageChangelogs());
	const rootChangelog = writeRootChangelog();
	if (!rootChangelog.wrote) {
		throw new Error(
			[
				`Refusing to cut ${version}: writing the root CHANGELOG.md would delete unreleased entries.`,
				...orphanRefusalLines(rootChangelog.orphans),
				"There is no --force here. A release that deletes an entry has already published the tag,",
				"the npm packages and the GitHub release under a changelog that never mentioned it.",
			].join("\n"),
		);
	}
	console.log("  Updated CHANGELOG.md (repo root)\n");

	console.log("Running checks...");
	await $`bun run check`;
	console.log();
}

/**
 * The two questions CI asks at a tag: may this tag publish, and did the
 * publication actually produce every asset the installer resolves?
 *
 * Cutting a release is no longer a subcommand here. The version bump is
 * prepared and committed on the operator's machine by `scripts/release-cut.ts`,
 * pushed to main like any other commit, and tagged once main's CI is green — so
 * there is no controller to gate, dispatch, correlate, or recover.
 */
async function runReleaseController(args: readonly string[]): Promise<void> {
	const [command, ...rest] = args;
	switch (command) {
		case "verify-tag": {
			const [tag, sha, ...extra] = rest;
			if (!tag || !sha || extra.length > 0) throw new Error("Usage: release.ts verify-tag <tag> <sha>");
			await verifyReleaseTagIsOnMain(tag, sha);
			// The tree carries its own claim about which version it is. A tag on a
			// commit whose manifests say something else would ship binaries that
			// report the wrong version, so the tag and the tree must agree.
			await validateReleaseVersionAuthorities(".", tag.replace(/^v/, ""), tag);
			// The changelog is a version authority too, and it is the one that has actually
			// broken releases: v1.0.38 through v1.0.46 were each tagged at a tree with no
			// `## [x.y.z]` section, so each one built binaries, published a GitHub release,
			// and only then went red in `release_site_finalize`, where the website generator
			// refuses to build a published release it cannot describe. The call above reads
			// that section as one more authority, here in the first job of the release path,
			// where nothing has been published yet.
			return;
		}
		case "verify-assets": {
			const [tag, ...extra] = rest;
			if (!tag || extra.length > 0) throw new Error("Usage: release.ts verify-assets <tag>");
			await verifyPublishedAssetManifest(tag);
			return;
		}
		default:
			throw new Error("Usage: release.ts verify-tag <tag> <sha> | verify-assets <tag>");
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
