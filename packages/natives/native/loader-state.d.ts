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

/** Tri-state AVX2 detection: the probe ran and found it, ran and didn't, or could not run. */
export type Avx2Support = "supported" | "unsupported" | "unknown";

export interface SelectCpuVariantInput {
	arch: string;
	override: "modern" | "baseline" | null | undefined;
	env: Record<string, string | undefined>;
	detectAvx2: () => Avx2Support;
}

export interface SelectCpuVariantResult {
	variant: "modern" | "baseline" | null;
	source: "non-x64" | "override" | "cache" | "detect" | "detect-unknown";
	cacheEnvKey?: string;
	cacheEnvValue?: string;
	/** True only when detection could not run (`detect-unknown`): baseline was chosen for ABI safety but the verdict is a guess and is NOT cached. */
	detectionFailed?: boolean;
}

export function selectCpuVariant(input: SelectCpuVariantInput): SelectCpuVariantResult;

/** Accept / warn / throw decision for a loaded native addon, keyed on its version sentinel. */
export type LoadedBindingsDecision =
	| { action: "accept" }
	| { action: "warn"; builtVersion: string; message: string }
	| { action: "throw"; builtVersion: string; message: string };

/** Pure, side-effect-free version-sentinel gate for a loaded addon (the runtime load-failure decision). */
export function evaluateLoadedBindings(
	ctx: { versionSentinelExport: string; isWorkspaceLoad: boolean; packageVersion: string },
	bindings: Record<string, unknown>,
	candidate: string,
): LoadedBindingsDecision;

export function loadNative(): Record<string, unknown>;

/** The exported symbol name the Rust addon emits for a version, mapping `x.y.z` -> `__veyyonNativesVx_y_z`. */
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
