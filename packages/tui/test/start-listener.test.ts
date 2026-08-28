import { describe, expect, it } from "bun:test";
import { VirtualTerminal } from "@veyyon/render-oracle";
import { TUI } from "@veyyon/tui";

describe("TUI start listeners", () => {
	it("fires registered hooks on initial start and restart", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		let starts = 0;
		tui.addStartListener(() => {
			starts++;
		});

		try {
			tui.start();
			expect(starts).toBe(1);

			tui.stop();
			tui.start();
			expect(starts).toBe(2);
		} finally {
			tui.stop();
		}
	});
});
