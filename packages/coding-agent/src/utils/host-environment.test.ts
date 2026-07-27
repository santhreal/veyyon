/**
 * The host rows the model is told about, and the rule that keeps them honest.
 *
 * WHY THIS SUITE EXISTS. `getEnvironmentInfo` builds the workstation block the model
 * reads to decide what platform it is on, and it was a private function inside a
 * 1200-line prompt builder, so nothing tested it directly. Its one rule — a row with
 * no value is DROPPED, never rendered blank — is the whole reason the block can be
 * trusted: `Kernel:` with nothing after it does not read as "unknown", it reads as a
 * kernel whose name is empty, and issue #4141 is exactly a model misidentifying the
 * host from a bad value in this block (Bun on macOS 15+ returns the literal string
 * "unknown" from `os.version()`, which surfaced as `Kernel: unknown` and had the model
 * treating a Mac as Windows).
 *
 * So both directions are pinned: every row that HAS a value appears with it, and every
 * row that does not is absent rather than empty.
 */
import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { getEnvironmentInfo, selectGpuFromLspci } from "./host-environment";

const labels = (rows: ReadonlyArray<{ label: string }>): string[] => rows.map(row => row.label);
const rowValue = (rows: ReadonlyArray<{ label: string; value: string }>, label: string): string | undefined =>
	rows.find(row => row.label === label)?.value;

describe("the workstation rows", () => {
	/**
	 * The rows that come from `os` are always available, so they must always be there.
	 * A block missing `OS` or `Arch` would leave the model guessing at the platform it
	 * is being asked to write commands for.
	 */
	it("always reports the platform facts that cannot be missing", () => {
		const rows = getEnvironmentInfo("Some CPU", "Some GPU");

		expect(labels(rows)).toContain("OS");
		expect(labels(rows)).toContain("Distro");
		expect(labels(rows)).toContain("Kernel");
		expect(labels(rows)).toContain("Arch");
		expect(rowValue(rows, "Arch")).toBe(os.arch());
	});

	/** A supplied CPU and GPU are reported verbatim, not reformatted. */
	it("reports the CPU and GPU it is given", () => {
		const rows = getEnvironmentInfo("AMD Ryzen 9 7950X", "NVIDIA GeForce RTX 5090");

		expect(rowValue(rows, "CPU")).toBe("AMD Ryzen 9 7950X");
		expect(rowValue(rows, "GPU")).toBe("NVIDIA GeForce RTX 5090");
	});

	/**
	 * THE RULE. A probe that found nothing yields no row at all. Rendering `GPU:` with
	 * an empty value states something false — that the machine has a GPU whose name is
	 * blank — where absence correctly states nothing.
	 */
	it("drops a row whose value could not be determined", () => {
		const rows = getEnvironmentInfo(undefined, undefined);

		expect(labels(rows)).not.toContain("CPU");
		expect(labels(rows)).not.toContain("GPU");
		// And the rest of the block survives: dropping one row must not drop the others.
		expect(labels(rows)).toContain("OS");
	});

	/** An empty string is missing, not present-and-blank — the same fact, spelled differently. */
	it("drops a row whose value is an empty string", () => {
		const rows = getEnvironmentInfo("", "");

		expect(labels(rows)).not.toContain("CPU");
		expect(labels(rows)).not.toContain("GPU");
	});

	/**
	 * No row ever carries an empty value, whatever the inputs. Stated over the whole
	 * block rather than per row, so a row added later is covered without this test
	 * being updated — which is how the rule stops applying to new rows in practice.
	 */
	it("never emits a row with an empty value", () => {
		for (const rows of [getEnvironmentInfo(undefined, undefined), getEnvironmentInfo("cpu", "gpu")]) {
			for (const row of rows) {
				expect(row.value.length, `${row.label} rendered an empty value`).toBeGreaterThan(0);
			}
		}
	});

	/**
	 * `Kernel` never says "unknown". Bun on macOS 15+ returns that literal from
	 * `os.version()` when `uv_os_uname()` leaves the version empty, and the block then
	 * told the model `Kernel: unknown` — which it read as a Windows host (#4141). The
	 * fallback is `<type> <release>`, so a Mac is always tagged `Darwin <release>`.
	 */
	it("never reports the kernel as literally unknown", () => {
		const kernel = rowValue(getEnvironmentInfo("cpu", "gpu"), "Kernel");

		expect(kernel).toBeDefined();
		expect(kernel?.toLowerCase()).not.toBe("unknown");
		expect(kernel?.trim()).toBe(kernel);
	});
});

describe("the lspci line the GPU name comes from", () => {
	/**
	 * Kept here beside the rest of the host probe now that it has a module of its own.
	 * The parser's own cases live in `test/core/gpu-lspci-parse.test.ts`; this is the
	 * one that ties it to the block above — whatever it returns is what the model is
	 * told, so a leading slot/class prefix left on would ship into the prompt.
	 */
	it("returns the device name without the slot and class prefix", () => {
		const name = selectGpuFromLspci("01:00.0 VGA compatible controller: NVIDIA Corporation GA102 [GeForce RTX 3090]");

		expect(name).toBe("NVIDIA Corporation GA102 [GeForce RTX 3090]");
		expect(rowValue(getEnvironmentInfo(undefined, name ?? undefined), "GPU")).toBe(
			"NVIDIA Corporation GA102 [GeForce RTX 3090]",
		);
	});
});
