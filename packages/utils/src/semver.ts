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
 * Whether `value` is a version {@link compareSemver} can order.
 *
 * Use this when the string came from somewhere you do not control, such as a
 * directory name on disk or a field in a registry response.
 *
 * ```ts
 * isValidSemver("1.2.3"); // true
 * isValidSemver("latest"); // false
 * ```
 */
export function isValidSemver(value: string): boolean {
	try {
		Bun.semver.order(value, "0.0.0");
		return true;
	} catch {
		return false;
	}
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
 * component that is not a number is compared as text against the other side
 * rather than being turned into zero. That distinction is the whole point: the
 * hand-rolled copies this replaces wrote `Number.parseInt(part, 10) || 0`, which
 * silently ranks `1.x.3` equal to `1.0.3`, or omitted the guard entirely and
 * returned `NaN` from a sort comparator, which leaves the order up to the engine.
 *
 * ```ts
 * compareDottedNumeric("1.2.10", "1.2.9"); // positive
 * compareDottedNumeric("1.2", "1.2.0"); // 0
 * compareDottedNumeric("1.2.3.4", "1.2.3"); // positive: extra components count
 * ```
 */
export function compareDottedNumeric(a: string, b: string): number {
	const left = a.split(".");
	const right = b.split(".");
	const limit = Math.max(left.length, right.length);
	for (let index = 0; index < limit; index++) {
		const lp = left[index] ?? "0";
		const rp = right[index] ?? "0";
		if (lp === rp) continue;
		const ln = Number.parseInt(lp, 10);
		const rn = Number.parseInt(rp, 10);
		if (Number.isNaN(ln) || Number.isNaN(rn)) {
			// At least one side is not a number. Compare as text so the result is
			// deterministic and a non-numeric part never silently reads as zero.
			return lp < rp ? -1 : 1;
		}
		if (ln !== rn) return ln - rn;
	}
	return 0;
}
