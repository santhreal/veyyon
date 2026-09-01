import { describe, expect, it } from "bun:test";

const html = await Bun.file(`${import.meta.dir}/blog/secrets.html`).text();

describe("secrets blog walkthrough", () => {
	/** A reader with a credential in hand must reach the verbless terminal fast path before learning optional policy controls. */
	it("starts with the shortest interactive path and then adds granular controls", () => {
		const fastPath = html.indexOf("<h2>Store one now</h2>");
		const namedPath = html.indexOf("<h2>Give it a useful name</h2>");
		const scopePath = html.indexOf("<h2>Choose where it is available</h2>");
		const settingsPath = html.indexOf("<h2>Settings</h2>");

		expect(fastPath).toBeGreaterThan(-1);
		expect(html.slice(fastPath, namedPath)).toContain('<code class="language-text">/secret</code>');
		expect(namedPath).toBeGreaterThan(fastPath);
		expect(scopePath).toBeGreaterThan(namedPath);
		expect(settingsPath).toBeGreaterThan(scopePath);
	});

	/** The published example must use a credential the agent genuinely spends instead of duplicating a CLI-owned login flow. */
	it("uses a direct API credential rather than a GitHub CLI token", () => {
		expect(html).toContain("Stripe test-mode API key");
		expect(html).toContain("#STRIPE_TEST_KEY#");
		expect(html).not.toContain("GITHUB_TOKEN");
	});

	/** The renderer does not support Markdown tables, so scope guidance must publish as real headings instead of raw pipe rows. */
	it("renders each scope as a walkthrough section without table artifacts", () => {
		expect(html).toContain("<h3>Keep it with one repository</h3>");
		expect(html).toContain("<h3>Keep it with your line of work</h3>");
		expect(html).toContain("<h3>Make it available to every profile</h3>");
		expect(html).not.toContain("| Scope |");
		expect(html).not.toContain("| project |");
	});
});
