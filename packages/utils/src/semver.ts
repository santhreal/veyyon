/**
 * The one repo-wide owner of semantic-version comparison.
 *
 * Import this instead of hand-rolling `a.split(".").map(Number)`. That idiom
 * looks right and is wrong in ways that matter: `Number("3-beta")` is `NaN`,
 * `NaN || 0` is `0`, and the whole prerelease tail collapses into a single
 * zero. The copies it produced disagreed with each other on real inputs, and
 * because the update path compared versions one way while the startup notice
 * compared them another, the two could reach opposite conclusions about
 * whether an update existed.
 *
 * Concretely, the hand-rolled form gets these wrong:
 *
 * - `1.2.3-alpha.5` vs `1.2.3-beta.1`: it reports alpha as the newer of the
 *   two, because it compares `5` against `1` and never sees `alpha`/`beta`.
 * - `1.2.3+build.7` vs `1.2.3`: it reports them as different, but build
 *   metadata is not part of precedence, so they rank equal.
 */

/**
 * Compare two semantic versions.
 *
 * Returns a negative number when `a` precedes `b`, a positive number when `a`
 * follows `b`, and `0` when they rank equal. That is the ordering
 * `Array.prototype.sort` expects, so you can sort versions ascending with
 * `versions.sort(compareSemver)`.
 *
 * A leading `v` is accepted on either side, so a git tag (`v1.2.3`) compares
 * directly against a package version (`1.2.3`) with no stripping at the call
 * site.
 *
 * ```ts
 * compareSemver("1.10.0", "1.9.0"); // positive: 1.10.0 is newer
 * compareSemver("v2.0.0", "2.0.0"); // 0: the tag prefix is ignored
 * compareSemver("1.2.3-rc.1", "1.2.3"); // negative: a prerelease precedes its release
 * ```
 */
export function compareSemver(a: string, b: string): number {
	return Bun.semver.order(a, b);
}

/**
 * A version with its git-tag `v` prefix removed.
 *
 * Releases carry the same version in two spellings: the tag is `v1.2.3` and the
 * package version is `1.2.3`. Everything that turns one into the other — a
 * download URL, a changelog anchor, an equality check against `VERSION` — needs
 * the bare form, and the conversion was written inline at five call sites
 * across three packages.
 *
 * Byte-identical copies still drift, and this one drifts in a way nothing
 * catches: the release lister, the changelog link builder and the rollback
 * argument parser each independently decide what "the version part" means, and
 * a mismatch shows up as a 404 or a link to the top of a page rather than as an
 * error. One owner, so they cannot disagree.
 *
 * Only a LEADING `v` is removed, and only one, because that is the tag
 * convention and nothing else. A version does not otherwise begin with a
 * letter, so a broader strip would quietly mangle input it was handed by
 * mistake instead of leaving it recognizably wrong.
 *
 * ```ts
 * bareVersion("v1.2.3"); // "1.2.3"
 * bareVersion("1.2.3"); // "1.2.3": already bare
 * ```
 */
export function bareVersion(version: string): string {
	return version.startsWith("v") ? version.slice(1) : version;
}

/**
 * Whether `candidate` is strictly newer than `current`.
 *
 * This is the update question ("is there something to install?") stated once,
 * so no caller has to remember which side of the comparison goes first or
 * whether the boundary is `>` or `>=`. Equal versions are not newer, so a
 * caller polling a registry does not reinstall what it already has.
 *
 * ```ts
 * isNewerVersion("1.2.4", "1.2.3"); // true
 * isNewerVersion("1.2.3", "1.2.3"); // false: same version, nothing to do
 * isNewerVersion("1.2.3-rc.1", "1.2.3"); // false: a prerelease is not an upgrade
 * ```
 */
export function isNewerVersion(candidate: string, current: string): boolean {
	return compareSemver(candidate, current) > 0;
}

/**
 * The semver 2.0.0 grammar, anchored: three numeric components without leading
 * zeroes, then an optional prerelease and an optional build metadata section.
 *
 * This is the published specification's own recommended expression rather than a
 * hand-loosened variant, because the whole value of this check is that it agrees
 * with what every other tool in the chain (npm, the release tagger, the
 * installer) considers a version.
 */
const SEMVER_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Whether `value` is a complete, well-formed semantic version.
 *
 * Use this when the string came from somewhere you do not control, such as a
 * directory name on disk or a tag in a registry response.
 *
 * ```ts
 * isValidSemver("1.2.3"); // true
 * isValidSemver("1.2.3-rc.1"); // true
 * isValidSemver("latest"); // false
 * isValidSemver("1.2"); // false: a partial version is a RANGE, not a version
 * ```
 *
 * It deliberately does NOT delegate to `Bun.semver`, which is lenient in the
 * direction that hurts here: it accepts `"1"`, `"1.2"`, `"v1.2.3"`, `"01.2.3"`
 * and `" 1.2.3 "`. The one production caller validates a release tag before
 * handing it to an installer, and every one of those inputs is a real hazard
 * there. `"1.2"` is an npm RANGE, so pinning to it installs whatever 1.2.x
 * happens to be newest rather than the release that was verified; a leading `v`
 * or surrounding whitespace builds a download URL that does not exist. A
 * predicate that answers "yes, that is a version" has to mean it, because the
 * caller's next move is to trust it.
 */
export function isValidSemver(value: string): boolean {
	return SEMVER_PATTERN.test(value);
}

/** Exactly `X.Y.Z`, no prerelease, no build metadata, no leading zeros. */
const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Whether `value` is a version this project is willing to RELEASE.
 *
 * Stricter than {@link isValidSemver}, which accepts `1.2.3-rc.1` and
 * `1.2.3+build`. A release here cuts a git tag, publishes npm packages and
 * creates a GitHub release, and none of those paths handle a prerelease or
 * build suffix, so accepting one produces artifacts that do not match the tag.
 *
 * ```ts
 * isReleaseVersion("1.2.3"); // true
 * isReleaseVersion("1.2.3-rc.1"); // false: a prerelease is not a release
 * isReleaseVersion("01.2.3"); // false: a leading zero is not the same version
 * ```
 *
 * This replaces four hand-written regexes that had already drifted. Two of them
 * sat on the same release path and disagreed: the CLI's front door accepted
 * `01.2.3` and a later gate rejected it as "not strict semver", and a third
 * announced itself as checking "strict vX.Y.Z semver" while accepting
 * `v01.2.3`. When two checks share a name and not a definition, the one you read
 * is not the one that runs.
 */
export function isReleaseVersion(value: string): boolean {
	return RELEASE_VERSION_PATTERN.test(value);
}

/**
 * Whether `tag` is a release tag: a `v` followed by a {@link isReleaseVersion}.
 *
 * The tag and the version are checked by the same rule on purpose, because a tag
 * that means something different from the version it names is how a release ends
 * up published under a name nothing else resolves.
 */
export function isReleaseTag(tag: string): boolean {
	return tag.startsWith("v") && isReleaseVersion(tag.slice(1));
}

/**
 * Compare two versions, returning `undefined` when either one is not a version.
 *
 * {@link compareSemver} throws on input like `"latest"` or a stray directory
 * name, which is the right behavior when a malformed version means something is
 * broken and you want to hear about it. This is for the other case: input read
 * from the filesystem or a third party, where "not a version" is a state you
 * have to handle rather than a failure.
 *
 * It returns `undefined` instead of guessing an order precisely so that
 * handling stays visible at the call site. Do not paper over it with
 * `?? 0`: that reintroduces the bug this exists to prevent, where an
 * unorderable value silently compares equal to everything and whichever entry
 * happened to come first wins.
 *
 * ```ts
 * const order = tryCompareSemver(dirName, newest);
 * if (order === undefined) continue; // not a version; leave it alone
 * if (order > 0) newest = dirName;
 * ```
 */
export function tryCompareSemver(a: string, b: string): number | undefined {
	try {
		return Bun.semver.order(a, b);
	} catch {
		// Undefined means "these are not both versions", which is the question this function exists to
		// answer. See the doc above: the caller must skip the entry rather than treat it as equal, which is
		// the bug that made a comparison returning 0 here dangerous.
		return undefined;
	}
}

/**
 * Compare two dot-separated numeric versions, such as a Haskell PVP version
 * (`1.2.3.4`) or a bare changelog heading.
 *
 * {@link compareSemver} is the right function for anything that claims to be
 * semver, and it throws on a version with four components or a non-numeric part.
 * This is for the versions that are not semver and never were: any number of
 * components, no prerelease grammar, no build metadata.
 *
 * A missing component reads as zero, so `1.2` and `1.2.0` rank equal. A
 * component that is not a pure run of digits is compared as text against the
 * other side rather than being turned into a number. That distinction is the
 * whole point: the hand-rolled copies this replaces wrote
 * `Number.parseInt(part, 10) || 0`, which silently ranks `1.x.3` equal to
 * `1.0.3`, or omitted the guard entirely and returned `NaN` from a sort
 * comparator, which leaves the order up to the engine.
 *
 * "Pure run of digits" is checked directly, not via `Number.parseInt`, because
 * `parseInt` is lenient: it reads `"0rc1"` as `0`, which would rank `1.0rc1`
 * equal to `1.0`. A suffixed component is text, so it text-compares.
 *
 * ```ts
 * compareDottedNumeric("1.2.10", "1.2.9"); // positive
 * compareDottedNumeric("1.2", "1.2.0"); // 0
 * compareDottedNumeric("1.2.3.4", "1.2.3"); // positive: extra components count
 * compareDottedNumeric("1.0rc1", "1.0"); // non-zero: a suffixed part is not 0
 * ```
 */
const INTEGER_COMPONENT_RE = /^\d+$/;

export function compareDottedNumeric(a: string, b: string): number {
	const left = a.split(".");
	const right = b.split(".");
	const limit = Math.max(left.length, right.length);
	for (let index = 0; index < limit; index++) {
		const lp = left[index] ?? "0";
		const rp = right[index] ?? "0";
		if (lp === rp) continue;
		if (!INTEGER_COMPONENT_RE.test(lp) || !INTEGER_COMPONENT_RE.test(rp)) {
			// At least one side is not a pure integer. Compare as text so the result
			// is deterministic and a suffixed part like "0rc1" never silently reads
			// as its leading number (which would rank "1.0rc1" equal to "1.0").
			return lp < rp ? -1 : 1;
		}
		const ln = Number.parseInt(lp, 10);
		const rn = Number.parseInt(rp, 10);
		if (ln !== rn) return ln - rn;
	}
	return 0;
}
