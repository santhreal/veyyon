import { describe, expect, it } from "bun:test";
import { getBinaryName } from "../../src/cli/update-cli";

/**
 * The updater's asset names must be a subset of the release workflow's matrix.
 * Inventing a plausible filename turns an unsupported machine into a misleading
 * GitHub 404 instead of an actionable platform error.
 */
describe("update release asset names", () => {
	/** Every binary the release train publishes resolves to its exact asset name. */
	it("maps the five published platform and architecture pairs", () => {
		expect([
			getBinaryName("linux", "x64"),
			getBinaryName("linux", "arm64"),
			getBinaryName("darwin", "x64"),
			getBinaryName("darwin", "arm64"),
			getBinaryName("win32", "x64"),
		]).toEqual([
			"veyyon-linux-x64",
			"veyyon-linux-arm64",
			"veyyon-darwin-x64",
			"veyyon-darwin-arm64",
			"veyyon-windows-x64.exe",
		]);
	});

	/** Windows arm64 has no published binary, so fail before any network request. */
	it("rejects Windows arm64 instead of requesting a nonexistent asset", () => {
		expect(() => getBinaryName("win32", "arm64")).toThrow("Windows arm64 releases are not published");
	});

	/** Unknown operating systems cannot silently borrow another platform's asset. */
	it("rejects an operating system outside the release matrix", () => {
		expect(() => getBinaryName("freebsd", "x64")).toThrow("Unsupported platform: freebsd");
	});

	/** Unknown CPU architectures cannot be normalized to x64 by accident. */
	it("rejects an architecture outside the release matrix", () => {
		expect(() => getBinaryName("linux", "ia32")).toThrow("Unsupported architecture: ia32");
	});
});
