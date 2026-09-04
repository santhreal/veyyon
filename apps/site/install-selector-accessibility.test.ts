import { describe, expect, it } from "bun:test";

const pages = ["index.html", "install.html"] as const;

describe("install selector accessibility", () => {
	/** Copy feedback must replace the button's accessible name and be announced after keyboard activation. */
	it.each(pages)("%s exposes copied and failure states through a live button label", async page => {
		const html = await Bun.file(`${import.meta.dir}/${page}`).text();
		const button = html.match(/<button type="button" data-install-copy[^>]*>copy<\/button>/)?.[0];

		expect(button).toBeDefined();
		expect(button).toContain('aria-live="polite"');
		expect(button).toContain('aria-atomic="true"');
		expect(button).not.toContain("aria-label=");
	});
});
