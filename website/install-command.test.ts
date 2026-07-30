import { describe, expect, it } from "bun:test";
import { copyInstallCommand, installCommandFor } from "./install-command.js";

describe("website install command selector", () => {
	/** macOS and Linux share the checksum-verifying shell installer served at the canonical endpoint. */
	it("returns the shell installer for both Unix platforms", () => {
		expect(installCommandFor("macos")).toEqual({
			prompt: "$",
			command: "curl -fsSL https://get.veyyon.dev | sh",
		});
		expect(installCommandFor("linux")).toEqual({
			prompt: "$",
			command: "curl -fsSL https://get.veyyon.dev | sh",
		});
	});

	/** Windows users need the PowerShell installer instead of a shell command that cannot run on stock Windows. */
	it("returns the published PowerShell installer for Windows", () => {
		expect(installCommandFor("windows")).toEqual({
			prompt: "PS>",
			command: "irm https://veyyon.dev/install.ps1 | iex",
		});
	});

	/** Unknown browser platform strings must retain the existing safe macOS/Linux command rather than render nothing. */
	it("falls back to the shell installer for an unknown platform", () => {
		expect(installCommandFor("plan9")).toEqual({
			prompt: "$",
			command: "curl -fsSL https://get.veyyon.dev | sh",
		});
	});

	/** Copying must preserve the rendered command byte-for-byte rather than normalize or reconstruct it. */
	it("copies the exact command bytes and reports success", async () => {
		const writes: string[] = [];
		const outcome = await copyInstallCommand("printf 'a  b\\n' | sh\n", {
			writeText(value: string) {
				writes.push(value);
				return Promise.resolve();
			},
		});

		expect(outcome).toBe("copied");
		expect(writes).toEqual(["printf 'a  b\\n' | sh\n"]);
	});

	/** Browsers without the Clipboard API must produce visible feedback without attempting a write. */
	it("reports an unavailable Clipboard API", async () => {
		expect(await copyInstallCommand("curl example.test", undefined)).toBe("unavailable");
	});

	/** A denied or otherwise rejected clipboard write must become feedback instead of an unhandled rejection. */
	it("reports a rejected clipboard write", async () => {
		const clipboard = {
			writeText() {
				return Promise.reject(new Error("permission denied"));
			},
		};

		await expect(copyInstallCommand("curl example.test", clipboard)).resolves.toBe("failed");
	});
});
