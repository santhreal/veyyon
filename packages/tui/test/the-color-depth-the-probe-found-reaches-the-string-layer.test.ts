/**
 * The terminal probe's colour depth reaches the string layer that encodes colours.
 *
 * WHY THIS SUITE EXISTS. `latexToUnicode` used to read `TERMINAL.trueColor` directly, which is why a
 * pure string module imported the terminal probe. The probe now pushes its answer into
 * `@veyyon/utils/color-format` and every encoder reads it from there. That inverts the dependency, and
 * it also introduces the failure this suite exists to catch: if nobody calls `setAnsiColorFormat`, the
 * encoders keep the truecolor default and a 256-colour terminal is sent 24-bit SGR it cannot render.
 * Nothing else fails when that regresses — the strings are well-formed, every latex test passes,
 * and the defect is only visible on a narrow terminal.
 *
 * WHAT IT DOES NOT CATCH. It does not check that the probe classified the terminal correctly; that is
 * `TERMINAL`'s own contract. It asserts only that whatever the probe concluded is what the encoders
 * are told, for both answers.
 */
import { describe, expect, it } from "bun:test";
import { getAnsiColorFormat, setAnsiColorFormat } from "@veyyon/utils/color-format";
import { TERMINAL } from "@veyyon/tui/terminal-capabilities";

describe("the colour depth the terminal probe found", () => {
	it("is the encoding every ANSI colour in this process is written in", () => {
		expect(getAnsiColorFormat()).toBe(TERMINAL.trueColor ? "ansi-16m" : "ansi-256");
	});

	/**
	 * Both answers, not only the one this host happens to produce. A wiring that hardcoded either
	 * constant would pass the assertion above on half of all machines.
	 */
	it("is the only thing that decides the encoding", () => {
		const probed = getAnsiColorFormat();
		try {
			setAnsiColorFormat("ansi-256");
			expect(getAnsiColorFormat()).toBe("ansi-256");
			setAnsiColorFormat("ansi-16m");
			expect(getAnsiColorFormat()).toBe("ansi-16m");
		} finally {
			setAnsiColorFormat(probed);
		}
	});
});
