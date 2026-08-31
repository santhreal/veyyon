export const MINIMUM_PIER_VERSION = "0.3.1";
export const MINIMUM_DEEPSWE_PIER_VERSION = MINIMUM_PIER_VERSION;

/** Whether Pier supports DeepSWE v1.1 separate-verifier collect hooks. */
export function pierSupportsSeparateVerifierCollect(versionOutput: string): boolean {
	const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)\b/.exec(versionOutput);
	if (!match) return false;

	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	return major > 0 || (major === 0 && (minor > 3 || (minor === 3 && patch >= 1)));
}
