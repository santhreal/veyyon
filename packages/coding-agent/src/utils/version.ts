/**
 * Compare dotted, semver-like version strings (numeric core, optional
 * `-prerelease` and `+build` suffixes). Returns negative/zero/positive like a
 * sort comparator. A release outranks its own prereleases.
 */
function compareSemverIdentifier(a: string, b: string): number {
	const aNumber = /^\d+$/.test(a);
	const bNumber = /^\d+$/.test(b);
	if (aNumber && bNumber) return Number(a) - Number(b);
	if (aNumber) return -1;
	if (bNumber) return 1;
	return a.localeCompare(b);
}

export function compareSemverLikeVersions(a: string, b: string): number {
	const [aCoreWithPrerelease] = a.split("+", 1);
	const [bCoreWithPrerelease] = b.split("+", 1);
	const [aCore, aPrerelease] = aCoreWithPrerelease.split("-", 2);
	const [bCore, bPrerelease] = bCoreWithPrerelease.split("-", 2);
	const aParts = aCore.split(".");
	const bParts = bCore.split(".");
	for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
		const diff = Number(aParts[i] ?? 0) - Number(bParts[i] ?? 0);
		if (diff !== 0 && Number.isFinite(diff)) return diff;
	}
	if (!aPrerelease && !bPrerelease) return 0;
	if (!aPrerelease) return 1;
	if (!bPrerelease) return -1;
	const aPrereleaseParts = aPrerelease.split(".");
	const bPrereleaseParts = bPrerelease.split(".");
	for (let i = 0; i < Math.max(aPrereleaseParts.length, bPrereleaseParts.length); i++) {
		const aPart = aPrereleaseParts[i];
		const bPart = bPrereleaseParts[i];
		if (aPart === undefined) return -1;
		if (bPart === undefined) return 1;
		const diff = compareSemverIdentifier(aPart, bPart);
		if (diff !== 0) return diff;
	}
	return 0;
}
