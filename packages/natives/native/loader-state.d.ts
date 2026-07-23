export interface EmbeddedAddonFile {
	variant: "modern" | "baseline" | "default";
	filename: string;
	size?: number;
	filePath?: string;
}

export interface EmbeddedAddonArchive {
	format: "tar.gz";
	filename: string;
	filePath: string;
}

export interface EmbeddedAddon {
	platformTag: string;
	version: string;
	files: EmbeddedAddonFile[];
	archive?: EmbeddedAddonArchive;
}

export interface DetectCompiledBinaryInput {
	embeddedAddon: EmbeddedAddon | null | undefined;
	env: Record<string, string | undefined>;
	importMetaUrl: string | null | undefined;
}

export function detectCompiledBinary(input: DetectCompiledBinaryInput): boolean;

export interface GetAddonFilenamesInput {
	tag: string;
	arch: string;
	variant: "modern" | "baseline" | null | undefined;
}

export function getAddonFilenames(input: GetAddonFilenamesInput): string[];

export interface ShouldStageNodeModulesAddonInput {
	platform: NodeJS.Platform | string;
	isCompiledBinary: boolean;
	nativeDir: string;
}

export function shouldStageNodeModulesAddon(input: ShouldStageNodeModulesAddonInput): boolean;

export interface ResolveLoaderCandidatesInput {
	addonFilenames: string[];
	isCompiledBinary: boolean;
	stageFromNodeModules?: boolean;
	nativeDir: string;
	leafPackageDir?: string | null;
	execDir: string;
	versionedDir: string;
	userDataDir: string;
}

export function resolveLoaderCandidates(input: ResolveLoaderCandidatesInput): string[];

export interface CleanupStaleNativeVersionsInput {
	nativesDir: string;
	currentVersion: string;
}

export function cleanupStaleNativeVersions(input: CleanupStaleNativeVersionsInput): string[];

export interface ExtractEmbeddedAddonArchiveInput {
	archivePath: string;
	files: EmbeddedAddonFile[];
	targetDir: string;
}

export function extractEmbeddedAddonArchive(input: ExtractEmbeddedAddonArchiveInput): string[];

export interface SelectCpuVariantInput {
	arch: string;
	override: "modern" | "baseline" | null | undefined;
	env: Record<string, string | undefined>;
	detectAvx2: () => boolean;
}

export interface SelectCpuVariantResult {
	variant: "modern" | "baseline" | null;
	source: "non-x64" | "override" | "cache" | "detect";
	cacheEnvKey?: string;
	cacheEnvValue?: string;
}

export function selectCpuVariant(input: SelectCpuVariantInput): SelectCpuVariantResult;

export function loadNative(): Record<string, unknown>;

/** The exported symbol name the Rust addon emits for a version, e.g. `1.0.14` -> `__veyyonNativesV1_0_18`. */
export function versionSentinelExportFor(version: string): string;

/** The version a loaded addon was built for, read back from its sentinel export, or `"unknown"`. */
export function detectBuiltNativeVersion(bindings: Record<string, unknown>): string;

/** Every `__veyyonNativesV<major>_<minor>_<patch>` sentinel physically present in a built `.node`'s bytes, deduplicated. */
export function nativeSentinelsInBuffer(buffer: Uint8Array): string[];

export interface StaleAddon {
	filename: string;
	expected: string;
	builtFor: string[];
}

/** The first variant whose bytes do not carry `__veyyonNativesV<version>`, or `null` when every variant is fresh. The ship-path (embed-native.ts) fails closed on a non-null result. */
export function findStaleAddon(addons: Array<{ filename: string; bytes: Uint8Array }>, version: string): StaleAddon | null;

/** The loud, actionable build-time refusal message for a stale variant found by `findStaleAddon`. */
export function staleAddonMessage(stale: StaleAddon, version: string): string;

/** `owner/repo` for a package.json `repository.url`; fails closed to `santhreal/veyyon` when missing or unparseable. */
export function repoSlugFromRepositoryUrl(raw: string | null | undefined): string;
