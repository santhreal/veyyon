/**
 * WHY: the browser tool rewrote a Linux user agent to Windows while `navigator.platform`, the workers,
 * the fonts and the GPU still said Linux, and detectors flagged the contradiction. The identity is now
 * the host's own, derived by `resolveHostIdentity` from what the host and the browser binary report.
 *
 * The class closed: every supported host (from `SUPPORTED_HOSTS`, so a new one turns this red until
 * its strings are recorded here) gets exactly the strings real Chrome sends on it (reduced user agent,
 * `navigator.platform`, client-hints platform, platform version, architecture, bitness, brands), and no
 * string names another OS or `Headless`. Windows platform versions follow the UniversalApiContract of
 * the build, so Windows 10 and 11 differ.
 *
 * What it does not catch: a Chrome release that changes its own derivation (a new GREASE rule, a
 * different frozen platform token). The real-browser suite compares against a live binary for that.
 */
import { describe, expect, it } from "bun:test";
import {
	parseVersionOutput,
	parseWindowsVersionResource,
} from "@veyyon/coding-agent/tools/web/browser/browser-product";
import {
	type HostIdentity,
	resolveHostIdentity,
	resolveScreenSize,
	resolveStealthProfile,
	resolveSupportedHost,
	resolveWindowPosition,
	SUPPORTED_HOSTS,
} from "@veyyon/coding-agent/tools/web/browser/host-identity";

const CHROME = { name: "Google Chrome", version: "152.0.7977.82" };
const BRANDS = [
	{ brand: "Chromium", version: "152" },
	{ brand: "Not?A_Brand", version: "24" },
	{ brand: "Google Chrome", version: "152" },
];
const FULL_VERSION_LIST = [
	{ brand: "Chromium", version: "152.0.7977.82" },
	{ brand: "Not?A_Brand", version: "24.0.0.0" },
	{ brand: "Google Chrome", version: "152.0.7977.82" },
];

interface Case {
	machine: string;
	osRelease: string;
	macProductVersion?: string;
	userAgentPlatform: string;
	navigatorPlatform: string;
	clientHintsPlatform: string;
	platformVersion: string;
	architecture: string;
	/** A word no string of this identity may contain. */
	foreign: RegExp;
}

const WINDOWS = {
	userAgentPlatform: "Windows NT 10.0; Win64; x64",
	navigatorPlatform: "Win32",
	clientHintsPlatform: "Windows",
	foreign: /mac|linux|x11|headless/i,
};
const MAC = {
	userAgentPlatform: "Macintosh; Intel Mac OS X 10_15_7",
	navigatorPlatform: "MacIntel",
	clientHintsPlatform: "macOS",
	foreign: /windows|win32|win64|linux|x11|headless/i,
};
const LINUX = {
	userAgentPlatform: "X11; Linux x86_64",
	navigatorPlatform: "Linux x86_64",
	clientHintsPlatform: "Linux",
	foreign: /windows|win32|win64|mac|headless/i,
};

/** Every supported host, keyed `platform-arch`. Windows is swept on a Windows 10 and a Windows 11 build. */
const EXPECTED: Record<string, readonly Case[]> = {
	"win32-x64": [
		{ ...WINDOWS, machine: "x86_64", osRelease: "10.0.19045", platformVersion: "10.0.0", architecture: "x86" },
		{ ...WINDOWS, machine: "x86_64", osRelease: "10.0.22000", platformVersion: "14.0.0", architecture: "x86" },
		{ ...WINDOWS, machine: "x86_64", osRelease: "10.0.22631", platformVersion: "15.0.0", architecture: "x86" },
		{ ...WINDOWS, machine: "x86_64", osRelease: "10.0.26200", platformVersion: "19.0.0", architecture: "x86" },
	],
	"win32-arm64": [
		{ ...WINDOWS, machine: "arm64", osRelease: "10.0.19045", platformVersion: "10.0.0", architecture: "arm" },
		{ ...WINDOWS, machine: "arm64", osRelease: "10.0.26100", platformVersion: "19.0.0", architecture: "arm" },
	],
	"darwin-x64": [
		{
			...MAC,
			machine: "x86_64",
			osRelease: "24.3.0",
			macProductVersion: "15.3",
			platformVersion: "15.3.0",
			architecture: "x86",
		},
	],
	"darwin-arm64": [
		{
			...MAC,
			machine: "arm64",
			osRelease: "25.0.0",
			macProductVersion: "26.0.1",
			platformVersion: "26.0.1",
			architecture: "arm",
		},
		{ ...MAC, machine: "arm64", osRelease: "24.3.0", platformVersion: "15.3.0", architecture: "arm" },
	],
	"linux-x64": [
		{ ...LINUX, machine: "x86_64", osRelease: "6.17.0-19-generic", platformVersion: "", architecture: "x86" },
	],
	"linux-arm64": [{ ...LINUX, machine: "aarch64", osRelease: "6.8.0-rpi", platformVersion: "", architecture: "arm" }],
};

function strings(identity: HostIdentity): string[] {
	const metadata = identity.userAgentMetadata;
	return [
		identity.userAgent,
		identity.navigatorPlatform,
		metadata.platform,
		metadata.platformVersion,
		metadata.architecture,
		...metadata.brands.map(entry => entry.brand),
		...metadata.fullVersionList.map(entry => entry.brand),
	];
}

describe("the identity a headless browser presents", () => {
	it("records every supported host, and nothing else", () => {
		expect(Object.keys(EXPECTED).sort()).toEqual(SUPPORTED_HOSTS.map(host => `${host.platform}-${host.arch}`).sort());
	});

	for (const host of SUPPORTED_HOSTS) {
		for (const expected of EXPECTED[`${host.platform}-${host.arch}`] ?? []) {
			it(`is what Chrome sends on ${host.platform} ${host.arch} ${expected.osRelease}`, () => {
				const identity = resolveHostIdentity({
					platform: host.platform,
					machine: expected.machine,
					osRelease: expected.osRelease,
					macProductVersion: expected.macProductVersion,
					product: CHROME,
				});
				expect(identity).toEqual({
					os: host.os,
					arch: host.arch,
					userAgent: `Mozilla/5.0 (${expected.userAgentPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`,
					navigatorPlatform: expected.navigatorPlatform,
					userAgentMetadata: {
						brands: BRANDS,
						fullVersionList: FULL_VERSION_LIST,
						fullVersion: "152.0.7977.82",
						platform: expected.clientHintsPlatform,
						platformVersion: expected.platformVersion,
						architecture: expected.architecture,
						bitness: "64",
						model: "",
						mobile: false,
						wow64: false,
						formFactors: ["Desktop"],
					},
				});
				expect(strings(identity!).filter(value => expected.foreign.test(value))).toEqual([]);
			});
		}
	}

	it("lists Chromium's build with two brands and Edge's with its own product token", () => {
		const chromium = resolveHostIdentity({
			platform: "linux",
			machine: "x86_64",
			osRelease: "6.1.0",
			product: { name: "Chromium", version: "154.0.8037.57" },
		});
		// 154: GREASE characters 154 % 11 = 0 and 155 % 11 = 1, version 154 % 3 = 1, order 154 % 2 = 0.
		expect(chromium?.userAgentMetadata.brands).toEqual([
			{ brand: "Not A(Brand", version: "99" },
			{ brand: "Chromium", version: "154" },
		]);
		const edge = resolveHostIdentity({
			platform: "win32",
			machine: "x86_64",
			osRelease: "10.0.26200",
			product: { name: "Microsoft Edge", version: "154.0.4258.37" },
		});
		expect(edge?.userAgent.endsWith("Safari/537.36 Edg/154.0.0.0")).toBe(true);
		expect(edge?.userAgentMetadata.brands.map(entry => entry.brand)).toContain("Microsoft Edge");
	});

	it("names no identity for a host outside the table or a version that does not parse", () => {
		expect(resolveSupportedHost("freebsd", "amd64")).toBeUndefined();
		expect(resolveSupportedHost("linux", "riscv64")).toBeUndefined();
		expect(
			resolveHostIdentity({
				platform: "linux",
				machine: "x86_64",
				osRelease: "6.1.0",
				product: { name: "Google Chrome", version: "152" },
			}),
		).toBeUndefined();
	});
});

/**
 * A desktop screen keeps a taskbar, a dock or a menu bar out of its work area, and a window sits inside
 * that work area: CreepJS reads `availHeight` equal to `height` as headless, and a window reaching past
 * the work area is one no desktop places. Swept over every supported host and viewports from small to
 * larger than the largest screen, at the scales a tab may set.
 */
describe("the screen a headless window sits on", () => {
	const viewports = [
		{ width: 800, height: 600, deviceScaleFactor: 1 },
		{ width: 1111, height: 777, deviceScaleFactor: 1.25 },
		{ width: 1365, height: 768, deviceScaleFactor: 1.25 },
		{ width: 1280, height: 1100, deviceScaleFactor: 1.25 },
		{ width: 1280, height: 940, deviceScaleFactor: 1 },
		{ width: 1920, height: 1080, deviceScaleFactor: 1 },
		{ width: 2560, height: 1440, deviceScaleFactor: 2 },
		{ width: 4000, height: 2400, deviceScaleFactor: 1 },
	];
	for (const host of SUPPORTED_HOSTS) {
		it(`keeps a bar out of the work area and the window inside it on ${host.platform} ${host.arch}`, () => {
			const profile = resolveStealthProfile(host, 16);
			const { workArea, windowChrome } = profile;
			expect(workArea.top + workArea.bottom).toBeGreaterThan(0);
			const position = resolveWindowPosition(profile);
			for (const viewport of viewports) {
				const screen = resolveScreenSize(profile, viewport);
				expect(position.x).toBeGreaterThanOrEqual(0);
				expect(position.y).toBeGreaterThanOrEqual(workArea.top);
				expect(position.x + viewport.width + 2 * windowChrome.frame).toBeLessThanOrEqual(screen.width);
				expect(position.y + viewport.height + windowChrome.top + windowChrome.frame).toBeLessThanOrEqual(
					screen.height - workArea.bottom,
				);
			}
		});
	}
});

/** A PE version resource: some bytes, `VS_FIXEDFILEINFO`, then the `ProductName` `String` entry. */
function versionResource(productName: string, [major, minor, build, patch]: readonly number[]): Buffer {
	const fixed = Buffer.alloc(52);
	fixed.writeUInt32LE(0xfeef04bd, 0);
	fixed.writeUInt32LE(0x00010000, 4);
	fixed.writeUInt32LE(((major! << 16) | minor!) >>> 0, 16);
	fixed.writeUInt32LE(((build! << 16) | patch!) >>> 0, 20);
	const key = Buffer.from("ProductName\0", "utf16le");
	const value = Buffer.from(`${productName}\0`, "utf16le");
	// `wLength`, `wValueLength` in characters, `wType` 1 (text); the key starts 2 bytes past a 32-bit
	// boundary, as in a real resource, so 2 bytes of padding bring the value onto one.
	const header = Buffer.alloc(6);
	header.writeUInt16LE(6 + key.length + 2 + value.length, 0);
	header.writeUInt16LE(value.length / 2, 2);
	header.writeUInt16LE(1, 4);
	return Buffer.concat([Buffer.alloc(64, 0x41), fixed, header, key, Buffer.alloc(2), value, Buffer.alloc(16, 0x42)]);
}

describe("reading a browser binary's product before it starts", () => {
	it("reads the product name and version a `--version` probe prints", () => {
		expect(parseVersionOutput("Google Chrome 152.0.7977.82 \n")).toEqual({
			name: "Google Chrome",
			version: "152.0.7977.82",
		});
		expect(parseVersionOutput("Chromium 154.0.8037.57 built on Debian GNU/Linux 13 (trixie)\n")).toEqual({
			name: "Chromium",
			version: "154.0.8037.57",
		});
		expect(parseVersionOutput("Google Chrome for Testing 131.0.6778.85")).toEqual({
			name: "Google Chrome for Testing",
			version: "131.0.6778.85",
		});
		expect(parseVersionOutput("")).toBeUndefined();
		expect(parseVersionOutput("chrome: command failed")).toBeUndefined();
	});

	it("reads the product name and version from a Windows version resource", () => {
		expect(parseWindowsVersionResource(versionResource("Google Chrome", [152, 0, 7977, 82]))).toEqual({
			name: "Google Chrome",
			version: "152.0.7977.82",
		});
		expect(parseWindowsVersionResource(versionResource("Microsoft Edge", [154, 0, 4258, 37]))).toEqual({
			name: "Microsoft Edge",
			version: "154.0.4258.37",
		});
	});

	it("reads nothing from a malformed version resource", () => {
		const whole = versionResource("Google Chrome", [152, 0, 7977, 82]);
		// No fixed-info signature at all.
		expect(parseWindowsVersionResource(Buffer.alloc(256, 0x41))).toBeUndefined();
		// The signature with the file cut short before the product version.
		expect(parseWindowsVersionResource(whole.subarray(0, 64 + 12))).toBeUndefined();
		// The fixed info without a `ProductName` entry after it.
		expect(parseWindowsVersionResource(whole.subarray(0, 64 + 52))).toBeUndefined();
		// A `ProductName` key with an empty value.
		expect(parseWindowsVersionResource(versionResource("", [152, 0, 7977, 82]))).toBeUndefined();
	});
});
