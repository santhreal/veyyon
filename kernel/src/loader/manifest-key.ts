/**
 * One owner for the package.json manifest key lookup shared by the plugin
 * manager and the extension loader. Veyyon plugins declare their manifest
 * under `veyyon`; `omp` and `pi` remain accepted as legacy keys from the
 * oh-my-pi lineage. First defined key wins, in that order.
 */

/** Accepted package.json manifest keys, highest priority first. */
export const MANIFEST_KEYS = ["veyyon", "omp", "pi"] as const;

export type ManifestKey = (typeof MANIFEST_KEYS)[number];

export type ManifestHolder<T> = { [K in ManifestKey]?: T };

/** Read the plugin/extension manifest from a parsed package.json. */
export function manifestFromPackageJson<T>(pkg: ManifestHolder<T>): T | undefined {
	for (const key of MANIFEST_KEYS) {
		const manifest = pkg[key];
		if (manifest !== undefined) return manifest;
	}
	return undefined;
}
