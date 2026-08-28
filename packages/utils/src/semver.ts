export function compareSemver(a: string, b: string): number {
	return Bun.semver.order(a, b);
}

export function bareVersion(version: string): string {
	return version.startsWith("v") ? version.slice(1) : version;
}

export function isNewerVersion(candidate: string, current: string): boolean {
	return compareSemver(candidate, current) > 0;
}

const SEMVER_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isValidSemver(value: string): boolean {
	return SEMVER_PATTERN.test(value);
}

export const RELEASE_VERSION_BODY = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)`;

const RELEASE_VERSION_PATTERN = new RegExp(`^${RELEASE_VERSION_BODY}$`);

export function isReleaseVersion(value: string): boolean {
	return RELEASE_VERSION_PATTERN.test(value);
}

export function isReleaseTag(tag: string): boolean {
	return tag.startsWith("v") && isReleaseVersion(tag.slice(1));
}

export function tryCompareSemver(a: string, b: string): number | undefined {
	try {
		return Bun.semver.order(a, b);
	} catch {
		return undefined;
	}
}

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
			return lp < rp ? -1 : 1;
		}
		const ln = Number.parseInt(lp, 10);
		const rn = Number.parseInt(rp, 10);
		if (ln !== rn) return ln - rn;
	}
	return 0;
}
