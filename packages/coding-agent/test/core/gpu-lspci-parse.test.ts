import { describe, expect, it } from "bun:test";
import { selectGpuFromLspci } from "../../src/system-prompt";

/**
 * GPU name extraction from `lspci` output feeds the `GPU:` line of the system
 * prompt on Linux hosts. It must return the DEVICE name only.
 *
 * Regression: an earlier version split each line on a bare ":", but the lspci
 * slot ID (e.g. `01:00.0`) also contains colons, so `parts.slice(1).join(":")`
 * kept the slot tail and the class description. The prompt then showed
 * `00.0 VGA compatible controller: NVIDIA ...` instead of `NVIDIA ...`. The fix
 * splits on the first colon-SPACE, which only ever separates class from device.
 * These tests assert the clean name and explicitly forbid the polluted prefix.
 */
describe("selectGpuFromLspci", () => {
	it("extracts the device name without the slot tail or class description", () => {
		const line = "01:00.0 VGA compatible controller: NVIDIA Corporation Device 2b85 (rev a1)";
		const name = selectGpuFromLspci(line);
		expect(name).toBe("NVIDIA Corporation Device 2b85 (rev a1)");
		// Guard the exact regression: the class prefix must never leak in.
		expect(name).not.toContain("VGA compatible controller");
		expect(name?.startsWith("00.0")).toBe(false);
	});

	it("handles a domain-qualified slot id (0000:bb:dd.f) with multiple colons", () => {
		const line = "0000:65:00.0 VGA compatible controller: NVIDIA Corporation GA102 [GeForce RTX 3090]";
		expect(selectGpuFromLspci(line)).toBe("NVIDIA Corporation GA102 [GeForce RTX 3090]");
	});

	it("parses an AMD device name cleanly, brackets and all", () => {
		const line = "7a:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Device 13c0 (rev c1)";
		expect(selectGpuFromLspci(line)).toBe("Advanced Micro Devices, Inc. [AMD/ATI] Device 13c0 (rev c1)");
	});

	it("prefers a discrete NVIDIA/AMD GPU over Intel integrated graphics", () => {
		const output = [
			"00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 630",
			"01:00.0 3D controller: NVIDIA Corporation TU117M [GeForce GTX 1650 Mobile]",
		].join("\n");
		expect(selectGpuFromLspci(output)).toBe("NVIDIA Corporation TU117M [GeForce GTX 1650 Mobile]");
	});

	it("prefers an unknown adapter over Intel integrated graphics", () => {
		const output = [
			"00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 630",
			"05:00.0 Display controller: Some Vendor Accelerator XYZ",
		].join("\n");
		expect(selectGpuFromLspci(output)).toBe("Some Vendor Accelerator XYZ");
	});

	it("keeps lspci enumeration order among equal-priority discrete GPUs (stable sort)", () => {
		const output = [
			"01:00.0 VGA compatible controller: NVIDIA Corporation Device 2b85 (rev a1)",
			"7a:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Device 13c0 (rev c1)",
		].join("\n");
		expect(selectGpuFromLspci(output)).toBe("NVIDIA Corporation Device 2b85 (rev a1)");
	});

	it("skips BMC / server management display adapters", () => {
		const output = [
			"03:00.0 VGA compatible controller: ASPEED Technology, Inc. ASPEED Graphics Family (rev 41)",
			"04:00.0 VGA compatible controller: Matrox Electronics Systems Ltd. MGA G200e",
		].join("\n");
		expect(selectGpuFromLspci(output)).toBeNull();
	});

	it("skips a Matrox G200 BMC adapter whose model token has a space (MGA G200e/EH)", () => {
		// Regression: the skip pattern used to be `matrox g200|mgag200`, neither of
		// which matches the real `Matrox ... MGA G200e` string (space between MGA
		// and G200), so the BMC adapter was reported as the GPU. It must be skipped.
		expect(
			selectGpuFromLspci("07:00.0 VGA compatible controller: Matrox Electronics Systems Ltd. MGA G200e [Pilot] ServerEngines"),
		).toBeNull();
		expect(
			selectGpuFromLspci("07:00.0 VGA compatible controller: Matrox Electronics Systems Ltd. MGA G200EH"),
		).toBeNull();
	});

	it("still selects a discrete GPU that is present alongside a Matrox BMC adapter", () => {
		const output = [
			"04:00.0 VGA compatible controller: Matrox Electronics Systems Ltd. MGA G200e",
			"65:00.0 VGA compatible controller: NVIDIA Corporation GA102 [GeForce RTX 3090]",
		].join("\n");
		expect(selectGpuFromLspci(output)).toBe("NVIDIA Corporation GA102 [GeForce RTX 3090]");
	});

	it("returns null when no display/VGA/3D controller line is present", () => {
		expect(selectGpuFromLspci("00:1f.0 ISA bridge: Intel Corporation Device 7a06")).toBeNull();
		expect(selectGpuFromLspci("")).toBeNull();
	});

	it("matches 3D and Display controller classes, not only VGA", () => {
		expect(selectGpuFromLspci("01:00.0 3D controller: NVIDIA Corporation GA100")).toBe("NVIDIA Corporation GA100");
		expect(selectGpuFromLspci("05:00.0 Display controller: NVIDIA Corporation Device abcd")).toBe(
			"NVIDIA Corporation Device abcd",
		);
	});

	it("falls back to the whole trimmed line when a matching line unexpectedly lacks a colon-space", () => {
		// Defensive: a malformed VGA line with no ": " should not crash; the whole
		// line (trimmed) is used rather than dropping the candidate.
		expect(selectGpuFromLspci("VGA compatible controller NVIDIA weird line")).toBe(
			"VGA compatible controller NVIDIA weird line",
		);
	});
});
