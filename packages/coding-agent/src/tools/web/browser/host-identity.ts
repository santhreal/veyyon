/**
 * The identity a headless browser presents: the strings real Chrome sends on the host it runs on, so
 * the page, every worker, the HTTP headers and the client hints all name the same OS, architecture
 * and browser, and none of them names `Headless`.
 *
 * Every string below reproduces Chromium's own derivation (chromium/src, main):
 * - `components/embedder_support/user_agent_utils.cc`: `GetUnifiedPlatform` (the frozen platform
 *   token of the reduced user agent), `BuildUserAgentFromOSAndProduct` (the user-agent template),
 *   `GetUserAgentInternal` (which prefixes `Headless` to the product under `--headless`),
 *   `GetPlatformForUAMetadata`, `GetPlatformVersion`, `GetCpuArchitecture`, `GetCpuBitness`,
 *   `IsWoW64`, `GetUniversalApiContractVersion` (Windows `platformVersion`), and
 *   `GenerateBrandVersionList` / `GetGreasedUserAgentBrandVersion` / `GetRandomOrder` (the brand list).
 * - `third_party/blink/renderer/core/execution_context/navigator_base.cc`:
 *   `GetReducedNavigatorPlatform` (`navigator.platform` in the page and in every worker).
 *
 * Nothing here reads the host: the caller passes what it read, so every supported host can be swept
 * in a unit test.
 */

import { clampLow } from "@veyyon/utils/math";

export type HostOs = "windows" | "mac" | "linux";
export type HostArch = "x64" | "arm64";

/** A host the browser tool presents a host-true identity on. */
export interface SupportedHost {
	/** `process.platform`. */
	readonly platform: "win32" | "darwin" | "linux";
	readonly arch: HostArch;
	readonly os: HostOs;
}

/** Every host the identity covers. A host outside this table launches with the browser's own identity. */
export const SUPPORTED_HOSTS: readonly SupportedHost[] = [
	{ platform: "win32", arch: "x64", os: "windows" },
	{ platform: "win32", arch: "arm64", os: "windows" },
	{ platform: "darwin", arch: "x64", os: "mac" },
	{ platform: "darwin", arch: "arm64", os: "mac" },
	{ platform: "linux", arch: "x64", os: "linux" },
	{ platform: "linux", arch: "arm64", os: "linux" },
];

interface OsStrings {
	/** `GetUnifiedPlatform`: frozen per OS, whatever the CPU. */
	readonly userAgentPlatform: string;
	/** `GetReducedNavigatorPlatform`: frozen per OS, whatever the CPU. */
	readonly navigatorPlatform: string;
	/** `GetPlatformForUAMetadata`: `version_info::GetOSType()`, or `macOS`. */
	readonly clientHintsPlatform: string;
}

const OS_STRINGS: Record<HostOs, OsStrings> = {
	windows: {
		userAgentPlatform: "Windows NT 10.0; Win64; x64",
		navigatorPlatform: "Win32",
		clientHintsPlatform: "Windows",
	},
	mac: {
		userAgentPlatform: "Macintosh; Intel Mac OS X 10_15_7",
		navigatorPlatform: "MacIntel",
		clientHintsPlatform: "macOS",
	},
	linux: {
		userAgentPlatform: "X11; Linux x86_64",
		navigatorPlatform: "Linux x86_64",
		clientHintsPlatform: "Linux",
	},
};

/** The browser binary as it names itself: `chrome --version` prints `<name> <version>`. */
export interface BrowserProduct {
	/** `version_info::GetProductName()`, e.g. `Google Chrome`, `Chromium`, `Microsoft Edge`. */
	readonly name: string;
	/** The full four-part version, e.g. `152.0.7977.82`. */
	readonly version: string;
}

export interface HostIdentityInput {
	/** `process.platform`. */
	readonly platform: string;
	/** `os.machine()`: the CPU the host runs, not the one the runtime was built for. */
	readonly machine: string;
	/** `os.release()`: the Windows build (`10.0.26200`) or the Darwin kernel version. */
	readonly osRelease: string;
	/** macOS `ProductVersion` from `SystemVersion.plist`, when it could be read. */
	readonly macProductVersion?: string;
	readonly product: BrowserProduct;
}

export interface UserAgentBrand {
	brand: string;
	version: string;
}

/** The client-hints metadata, in the shape `Emulation.setUserAgentOverride` takes it. */
export interface UserAgentMetadata {
	brands: UserAgentBrand[];
	fullVersionList: UserAgentBrand[];
	fullVersion: string;
	platform: string;
	platformVersion: string;
	architecture: string;
	bitness: string;
	model: string;
	mobile: boolean;
	wow64: boolean;
	formFactors: string[];
}

export interface HostIdentity {
	readonly os: HostOs;
	readonly arch: HostArch;
	/** The reduced user agent, sent by the page, every worker and every request. */
	readonly userAgent: string;
	/** What `navigator.platform` reports in the page and every worker. */
	readonly navigatorPlatform: string;
	readonly userAgentMetadata: UserAgentMetadata;
}

/** The host a `process.platform` and `os.machine()` pair names, or undefined off the table. */
export function resolveSupportedHost(platform: string, machine: string): SupportedHost | undefined {
	const cpu = machine.toLowerCase();
	const arch: HostArch | undefined =
		cpu === "x86_64" || cpu === "amd64" || cpu === "x64"
			? "x64"
			: cpu === "arm64" || cpu === "aarch64"
				? "arm64"
				: undefined;
	return SUPPORTED_HOSTS.find(host => host.platform === platform && host.arch === arch);
}

/**
 * `GetUniversalApiContractVersion` reads `Windows.Foundation.UniversalApiContract` from
 * `HKLM\SOFTWARE\Microsoft\WindowsRuntime\WellKnownContracts` (major in the high word) and falls back
 * to `kHighestKnownUniversalApiContractVersion` (19). Each Windows build ships one contract version;
 * this is that table, first build of each release. Windows 11 is 13 and above.
 */
export const WINDOWS_API_CONTRACT_BY_BUILD: readonly (readonly [build: number, contract: number])[] = [
	[10240, 1], // Windows 10 1507
	[10586, 2], // 1511
	[14393, 3], // 1607
	[15063, 4], // 1703
	[16299, 5], // 1709
	[17134, 6], // 1803
	[17763, 7], // 1809
	[18362, 8], // 1903, 1909
	[19041, 10], // 2004 through 22H2
	[22000, 14], // Windows 11 21H2
	[22621, 15], // 22H2, 23H2
	[26100, 19], // 24H2, 25H2
];

function windowsPlatformVersion(osRelease: string): string {
	const build = Number.parseInt(osRelease.split(".")[2] ?? "", 10);
	if (!Number.isFinite(build) || build < WINDOWS_API_CONTRACT_BY_BUILD[0]![0]) return "0.0.0";
	let contract = 0;
	for (const [first, version] of WINDOWS_API_CONTRACT_BY_BUILD) {
		if (build >= first) contract = version;
	}
	return `${contract}.0.0`;
}

/** `base::SysInfo::OperatingSystemVersionNumbers` printed as `%d.%d.%d`. */
function macPlatformVersion(productVersion: string | undefined, osRelease: string): string {
	let parts = (productVersion ?? "").split(".").filter(part => /^\d+$/.test(part));
	if (parts.length === 0) {
		// Without the plist, the Darwin kernel names the release: Darwin 20-24 is macOS 11-15, and
		// Darwin 25 is macOS 26.
		const [darwinMajor = 0, darwinMinor = 0] = osRelease.split(".").map(part => Number.parseInt(part, 10));
		if (darwinMajor < 20) return "";
		parts = [String(darwinMajor >= 25 ? darwinMajor + 1 : darwinMajor - 9), String(darwinMinor)];
	}
	return [parts[0] ?? "0", parts[1] ?? "0", parts[2] ?? "0"].join(".");
}

/** `GetGreasedUserAgentBrandVersion`, seeded by the major version. */
const GREASE_CHARS = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
const GREASE_VERSIONS = ["8", "99", "24"];
/** `GetRandomOrder` for three brands. */
const THREE_BRAND_ORDERS = [
	[0, 1, 2],
	[0, 2, 1],
	[1, 0, 2],
	[1, 2, 0],
	[2, 0, 1],
	[2, 1, 0],
];

/**
 * `GenerateBrandVersionList`: GREASE, Chromium, then the product brand (absent on a Chromium-branded
 * build), placed by a permutation seeded by the major version. Returns the major-version list and the
 * full-version list in the same order.
 */
function brandLists(product: BrowserProduct): { brands: UserAgentBrand[]; fullVersionList: UserAgentBrand[] } {
	const major = Number.parseInt(product.version, 10);
	const greaseVersion = GREASE_VERSIONS[major % GREASE_VERSIONS.length]!;
	const entries: Array<readonly [brand: string, majorVersion: string, fullVersion: string]> = [
		[
			`Not${GREASE_CHARS[major % GREASE_CHARS.length]}A${GREASE_CHARS[(major + 1) % GREASE_CHARS.length]}Brand`,
			greaseVersion,
			`${greaseVersion}.0.0.0`,
		],
		["Chromium", String(major), product.version],
	];
	if (product.name !== "Chromium") entries.push([product.name, String(major), product.version]);
	const order =
		entries.length === 3 ? THREE_BRAND_ORDERS[major % THREE_BRAND_ORDERS.length]! : [major % 2, (major + 1) % 2];
	const brands: UserAgentBrand[] = [];
	const fullVersionList: UserAgentBrand[] = [];
	entries.forEach(([brand, majorVersion, fullVersion], index) => {
		brands[order[index]!] = { brand, version: majorVersion };
		fullVersionList[order[index]!] = { brand, version: fullVersion };
	});
	return { brands, fullVersionList };
}

/**
 * The identity real Chrome presents on this host, or undefined for a host outside
 * {@link SUPPORTED_HOSTS} or a version that does not parse.
 */
export function resolveHostIdentity(input: HostIdentityInput): HostIdentity | undefined {
	const host = resolveSupportedHost(input.platform, input.machine);
	if (!host || !/^\d+\.\d+\.\d+\.\d+$/.test(input.product.version)) return undefined;
	const strings = OS_STRINGS[host.os];
	const major = Number.parseInt(input.product.version, 10);
	// Edge appends its own product token to Chromium's template.
	const edgeToken = input.product.name === "Microsoft Edge" ? ` Edg/${major}.0.0.0` : "";
	const { brands, fullVersionList } = brandLists(input.product);
	return {
		os: host.os,
		arch: host.arch,
		userAgent: `Mozilla/5.0 (${strings.userAgentPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${edgeToken}`,
		navigatorPlatform: strings.navigatorPlatform,
		userAgentMetadata: {
			brands,
			fullVersionList,
			fullVersion: input.product.version,
			platform: strings.clientHintsPlatform,
			platformVersion:
				host.os === "windows"
					? windowsPlatformVersion(input.osRelease)
					: host.os === "mac"
						? macPlatformVersion(input.macProductVersion, input.osRelease)
						: "",
			architecture: host.arch === "arm64" ? "arm" : "x86",
			bitness: "64",
			model: "",
			mobile: false,
			wow64: false,
			formFactors: ["Desktop"],
		},
	};
}

// =====================================================================
// Stealth profile: what the page scripts present where headless has nothing true to show
// =====================================================================

/** A WebGL vendor and renderer pair, matched to the native backend so shader translation agrees. */
export interface WebglProfile {
	/** Lower-case keyword the native renderer string names its ANGLE backend with. */
	readonly backend: "direct3d" | "vulkan" | "metal" | "opengl";
	readonly vendor: string;
	readonly renderer: string;
}

/** Browser window chrome around the viewport, in CSS pixels. */
export interface WindowChrome {
	/** Left and right frame each, and the bottom frame. */
	readonly frame: number;
	/** Tab strip and toolbar above the viewport, frame included. */
	readonly top: number;
}

export interface StealthProfile {
	readonly os: HostOs;
	/** First entry is the backend the OS runs Chrome on by default. */
	readonly webgl: readonly WebglProfile[];
	readonly windowChrome: WindowChrome;
	/** Physical screen sizes common on the OS, smallest first. */
	readonly screens: readonly (readonly [width: number, height: number])[];
	/** `navigator.hardwareConcurrency` in the page and every worker. */
	readonly hardwareConcurrency: number;
}

/** A host core count above this is unusual on a desktop and is reported as this, everywhere alike. */
export const HARDWARE_CONCURRENCY_CAP = 8;

const INTEL_UHD_620 = "Intel(R) UHD Graphics 620";

const WEBGL_PROFILES: Record<`${HostOs}-${HostArch}`, readonly WebglProfile[]> = {
	"windows-x64": [
		{
			backend: "direct3d",
			vendor: "Google Inc. (Intel)",
			renderer: `ANGLE (Intel, ${INTEL_UHD_620} (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)`,
		},
		{
			backend: "vulkan",
			vendor: "Google Inc. (Intel)",
			renderer: `ANGLE (Intel, Vulkan 1.3.215 (${INTEL_UHD_620} (0x00005917)), Intel Corporation)`,
		},
	],
	"windows-arm64": [
		{
			backend: "direct3d",
			vendor: "Google Inc. (Qualcomm)",
			renderer: "ANGLE (Qualcomm, Qualcomm(R) Adreno(TM) X1-85 GPU Direct3D11 vs_5_0 ps_5_0, D3D11)",
		},
		{
			backend: "vulkan",
			vendor: "Google Inc. (Qualcomm)",
			renderer:
				"ANGLE (Qualcomm, Vulkan 1.3.274 (Qualcomm(R) Adreno(TM) X1-85 GPU (0x36334330)), Qualcomm Technologies Inc. Adreno Vulkan Driver)",
		},
	],
	"mac-x64": [
		{
			backend: "metal",
			vendor: "Google Inc. (Intel)",
			renderer: "ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics, Unspecified Version)",
		},
	],
	"mac-arm64": [
		{
			backend: "metal",
			vendor: "Google Inc. (Apple)",
			renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)",
		},
	],
	"linux-x64": [
		{
			backend: "opengl",
			vendor: "Google Inc. (Intel)",
			renderer: `ANGLE (Intel, Mesa ${INTEL_UHD_620} (KBL GT2), OpenGL 4.6)`,
		},
		{
			backend: "vulkan",
			vendor: "Google Inc. (Intel)",
			renderer: `ANGLE (Intel, Vulkan 1.3.255 (${INTEL_UHD_620} (KBL GT2) (0x00005917)), Intel open-source Mesa driver)`,
		},
	],
	"linux-arm64": [
		{
			backend: "opengl",
			vendor: "Google Inc. (Broadcom)",
			renderer: "ANGLE (Broadcom, V3D 7.1, OpenGL ES 3.1 Mesa 24.2.8)",
		},
		{
			backend: "vulkan",
			vendor: "Google Inc. (Broadcom)",
			renderer: "ANGLE (Broadcom, Vulkan 1.3.278 (V3D 7.1.7.0 (0x55701C33)), V3DV Mesa)",
		},
	],
};

/**
 * Window chrome of a non-maximized Chrome window: Windows draws an 8 px resize frame on the sides and
 * bottom; macOS and Linux draw none. The Linux top matches what new-headless Chrome's own window
 * places mouse events at (the viewport starts 87 px below the window's top edge).
 */
const WINDOW_CHROME: Record<HostOs, WindowChrome> = {
	windows: { frame: 8, top: 87 },
	mac: { frame: 0, top: 79 },
	linux: { frame: 0, top: 87 },
};

const SCREENS: Record<HostOs, readonly (readonly [number, number])[]> = {
	windows: [
		[1920, 1080],
		[2560, 1440],
		[3840, 2160],
	],
	mac: [
		[2560, 1600],
		[2880, 1800],
		[3024, 1964],
		[3456, 2234],
		[5120, 2880],
	],
	linux: [
		[1920, 1080],
		[2560, 1440],
		[3840, 2160],
	],
};

export function resolveStealthProfile(host: SupportedHost, hostCores: number): StealthProfile {
	return {
		os: host.os,
		webgl: WEBGL_PROFILES[`${host.os}-${host.arch}`],
		windowChrome: WINDOW_CHROME[host.os],
		screens: SCREENS[host.os],
		hardwareConcurrency: clampLow(Math.floor(hostCores), 1, HARDWARE_CONCURRENCY_CAP),
	};
}

/**
 * The screen, in CSS pixels at `deviceScaleFactor`, a headless window of `viewport` sits on: the
 * smallest common physical screen of the OS that holds the window with its chrome, room for a taskbar
 * or menu bar, and its offset from the screen corner.
 */
export function resolveScreenSize(
	profile: StealthProfile,
	viewport: { width: number; height: number; deviceScaleFactor: number },
): { width: number; height: number } {
	const scale = viewport.deviceScaleFactor > 0 ? viewport.deviceScaleFactor : 1;
	const needWidth = viewport.width + 2 * profile.windowChrome.frame + 20;
	const needHeight = viewport.height + profile.windowChrome.top + profile.windowChrome.frame + 60;
	const fits = profile.screens.find(([width, height]) => width / scale >= needWidth && height / scale >= needHeight);
	if (fits) return { width: Math.round(fits[0] / scale), height: Math.round(fits[1] / scale) };
	return { width: Math.ceil(needWidth), height: Math.ceil(needHeight) };
}
