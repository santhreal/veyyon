/**
 * WHY: `/collab` presented the QR code as two blocks — a `Spacer(1)` from the
 * terminal engine, then the code — which is the only reason
 * `slash-commands/builtin-registry.ts` imported the engine at runtime. The blank
 * row is part of how the block reads, so the block draws it, and the caller
 * presents one thing.
 *
 * The class this closes is a caller supplying a neighbour's spacing: a reader
 * who deletes the leading `""` as noise, or who degrades the narrow arm without
 * it, shifts the transcript by a row in one arm only. Both arms are pinned here.
 *
 * It does not catch the row count of the symbol itself, which is the QR encoder's
 * and is covered by the encoder's own suite.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { CollabQrCodeComponent } from "@veyyon/coding-agent/slash-commands/helpers/collab-qrcode";
import { initTheme } from "@veyyon/coding-agent/theme/theme";

const LINK = "https://collab.example.test/s/abcdef123456";

describe("the collab QR block opens with its own blank row", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	it("draws a blank row above the symbol on a terminal wide enough for it", () => {
		const lines = new CollabQrCodeComponent(LINK).render(200);

		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]).toBe("");
		expect(lines.slice(1).every(line => line.trim().length > 0)).toBe(true);
	});

	it("keeps the blank row when the terminal is too narrow and the block degrades to a hint", () => {
		const lines = new CollabQrCodeComponent(LINK).render(10);

		expect(lines[0]).toBe("");
		expect(lines.length).toBe(2);
		expect(lines[1]).toContain("QR code hidden");
		expect(lines[1]).toContain("need");
	});
});
