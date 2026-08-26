/**
 * Semantic version comparison and parsing utilities conforming to SemVer 2.0.0.
 */

/**
 * Compares two semantic versions. Returns negative if `a < b`, positive if `a > b`, or 0 if equal.
 * Accepts an optional leading `v` tag prefix on either version.
 */
export function compareSemver(a: string, b: string): number {
	return Bun.semver.order(a, b);
}

/**
 * Strips a single leading `v` prefix from a version string if present.
 */
export function bareVersion(version: string): string {
	return version.startsWith("v") ? version.slice(1) : version;
}

/**
 * Returns `true` if `candidate` is strictly newer than `current` according to semver precedence.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
	return compareSemver(candidate, current) > 0;
}

/**
 * SemVer 2.0.0 regex pattern matching complete numeric versions with optional prerelease/build metadata.
 */
const SEMVER_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Validates that `value` is a complete, well-formed semantic version string.
 */
export function isValidSemver(value: string): boolean {
	return SEMVER_PATTERN.test(value);
}

/**
 * Unanchored `X.Y.Z` version regex pattern source text without prerelease or build metadata.
 */
export const RELEASE_VERSION_BODY = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)`;

/** Exactly `X.Y.Z`, no prerelease, no build metadata, no leading zeros. */
const RELEASE_VERSION_PATTERN = new RegExp(`^${RELEASE_VERSION_BODY}$`);

/**
 * Validates that `value` is an exact `X.Y.Z` release version with no prerelease or build metadata.
 */
export function isReleaseVersion(value: string): boolean {
	return RELEASE_VERSION_PATTERN.test(value);
}

/**
 * Validates that `tag` is a release tag (`vX.Y.Z`).
 */
export function isReleaseTag(tag: string): boolean {
	return tag.startsWith("v") && isReleaseVersion(tag.slice(1));
}

/**
 * Safely compares two semver strings, returning `undefined` if either is invalid.
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
 * Compares two dot-separated numeric version strings with arbitrary component counts.
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
