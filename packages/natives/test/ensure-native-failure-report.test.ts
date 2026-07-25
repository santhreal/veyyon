/**
 * When the native addon cannot be provisioned, the message has to say what
 * actually went wrong.
 *
 * `downloadAsset` collapsed every failure into `return false` — a 404 for a
 * platform with no prebuilt, a 500 from GitHub, a missing `.sha256` sidecar, an
 * interrupted body, a full disk — and the closing paragraph then GUESSED:
 * "no prebuilt asset for this platform (or the network is unreachable)". That
 * sentence covers two of those five and names neither, so a user on a full disk
 * was told to install Rust, and a user hitting a missing sidecar (the one case
 * where refusing is a security decision) was told nothing about it at all.
 *
 * This is the fail-closed path, which is the hardest to reach naturally and the
 * easiest to let rot out of sync with the code that prints it, so it is
 * asserted directly.
 */
import { describe, expect, it } from "bun:test";
import { type AssetFailure, formatProvisioningFailure } from "../scripts/ensure-native";

const HOST = `${process.platform}-${process.arch}`;

describe("formatProvisioningFailure", () => {
	it("names the host, so a wrong-platform asset list is obvious", () => {
		const message = formatProvisioningFailure([], true);
		expect(message).toContain(HOST);
	});

	it("lists every asset it tried and why each one failed", () => {
		const failures: AssetFailure[] = [
			{ filename: "veyyon_natives.linux-x64.node", reason: "the v1.0.0 release publishes no such asset (HTTP 404)" },
			{ filename: "veyyon_natives.linux-x64-baseline.node", reason: "HTTP 503 Service Unavailable fetching the asset" },
		];
		const message = formatProvisioningFailure(failures, true);
		expect(message).toContain("veyyon_natives.linux-x64.node: the v1.0.0 release publishes no such asset (HTTP 404)");
		expect(message).toContain(
			"veyyon_natives.linux-x64-baseline.node: HTTP 503 Service Unavailable fetching the asset",
		);
	});

	it("distinguishes no toolchain from a build that ran and failed", () => {
		// "install Rust" is the wrong advice for someone who has Rust and whose
		// build just failed; their fix is in the build output above.
		const withoutCargo = formatProvisioningFailure([], true);
		expect(withoutCargo).toContain("No Rust toolchain is available");
		expect(withoutCargo).not.toContain("its output is above");

		const withCargo = formatProvisioningFailure([], false);
		expect(withCargo).toContain("did not produce a loadable addon; its output is above");
		expect(withCargo).not.toContain("No Rust toolchain is available");
	});

	it("still gives both fixes, whatever the cause was", () => {
		// Diagnosis without a next move is not an improvement.
		for (const cargoMissing of [true, false]) {
			const message = formatProvisioningFailure([], cargoMissing);
			expect(message).toContain("https://rustup.rs");
			expect(message).toContain("bun --cwd=packages/natives run build");
			expect(message).toContain("curl -fsSL https://get.veyyon.dev | sh");
		}
	});

	it("says so explicitly when there were no candidate assets at all", () => {
		// An empty list rendered as a blank line under "Tried the release:",
		// which reads as a display bug rather than as information.
		const message = formatProvisioningFailure([], true);
		expect(message).toContain("no candidate asset names for this host");
	});

	it("never claims the network was unreachable unless a failure said so", () => {
		// The old sentence asserted it unconditionally, which is how a checksum
		// mismatch got reported as a connectivity problem.
		const message = formatProvisioningFailure(
			[{ filename: "a.node", reason: "checksum mismatch (expected aa, got bb); refusing it" }],
			true,
		);
		expect(message).toContain("checksum mismatch");
		expect(message).not.toContain("network is unreachable");
	});
});
