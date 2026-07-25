/**
 * A broken custom message renderer must be visible, not swallowed.
 *
 * Extensions and hooks may supply their own renderer for an injected transcript
 * card. `renderFramedMessage` falls back to the built-in card when that renderer
 * fails, and for a long time the failure path was a bare `catch {}`: the operator
 * saw a card that looked deliberate, their renderer never ran, and nothing said
 * so anywhere — not on screen, not in the log. That is the silent-fallback bug
 * (Law 10) on the one surface a third party controls.
 *
 * This suite pins the distinction the fix rests on: DECLINING to render (return
 * undefined) is a supported choice and stays quiet, while THROWING is a defect
 * and gets a loud, actionable notice on the card itself. It also pins that the
 * notice survives a monochrome terminal, since color alone cannot carry an
 * outcome under the no-background-paint default.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import {
	type FramedMessage,
	framedRendererSubject,
	renderFramedMessage,
} from "@veyyon/coding-agent/modes/components/message-frame";
import { rendererFailureNotice } from "@veyyon/coding-agent/modes/components/renderer-failure";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { Box } from "@veyyon/tui";

/** The notice the framed-message path produces, as one line. */
function notice(customType: string, error: unknown): string {
	return rendererFailureNotice(framedRendererSubject(customType), error, "showing the default card");
}

const WIDTH = 140;

beforeAll(async () => {
	// Symbol/color lookups need a resolved theme; the default is enough here
	// since every assertion strips styling before reading the text.
	await initTheme();
});

/**
 * Strip SGR sequences and the card's own outline so an assertion can speak about
 * the glyphs and words inside the card, not about styling or frame geometry.
 */
function plain(lines: readonly string[]): string {
	return lines
		.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))
		.filter(line => !/^[┌└][─┐┘]*[┐┘]$/.test(line.trim()))
		.map(line => line.replace(/^│ ?/, "").replace(/ *│$/, "").trimEnd())
		.join("\n");
}

function render(opts: {
	customType?: string;
	content?: string;
	renderer?: (message: FramedMessage) => never | undefined;
}): { lines: readonly string[]; text: string; flat: string; mounted: boolean } {
	const box = new Box(1, 1);
	const message: FramedMessage = {
		customType: opts.customType ?? "deploy-status",
		content: opts.content ?? "shipped to staging",
	};
	const mounted = renderFramedMessage({
		message,
		box,
		expanded: true,
		customRenderer: opts.renderer ? () => opts.renderer!(message) : undefined,
	});
	const lines = box.render(WIDTH);
	const text = plain(lines);
	// `flat` re-joins wrapped rows so a substring assertion is about the words the
	// operator reads, not about where the card happened to break the line.
	return { lines, text, flat: text.replace(/\s+/g, " ").trim(), mounted: mounted !== undefined };
}

describe("a custom renderer that throws", () => {
	it("names the message type, the failure, and the fix", () => {
		const { flat } = render({
			customType: "deploy-status",
			renderer: () => {
				throw new Error("cannot read properties of undefined (reading 'rows')");
			},
		});

		expect(flat).toContain('custom message "deploy-status" renderer threw');
		expect(flat).toContain("cannot read properties of undefined (reading 'rows')");
		expect(flat).toContain("showing the default card");
		expect(flat).toContain("fix or remove the renderer");
	});

	it("still renders the default card, so the message content is not lost", () => {
		const { text, mounted } = render({
			content: "shipped to staging",
			renderer: () => {
				throw new Error("boom");
			},
		});

		expect(mounted).toBe(false); // the caller mounts the default box, not a custom component
		expect(text).toContain("deploy-status");
		expect(text).toContain("shipped to staging");
	});

	/** Color cannot be the only channel: the inline TUI paints no backgrounds and
	 * a monochrome terminal drops the foreground too, so the notice carries a
	 * glyph that reads with every SGR sequence removed. */
	it("marks the notice with a glyph that survives with all styling stripped", () => {
		const { text } = render({
			renderer: () => {
				throw new Error("boom");
			},
		});

		const notice = text
			.split("\n")
			.find(line => line.includes("threw"))
			?.trim();
		expect(notice).toBeDefined();
		// One of the three symbol sets' error glyphs: unicode, nerd font, ascii.
		expect(notice).toMatch(/^(?:\u2717|\uf00d|\[!!\])\s/);
	});

	it("reports a thrown non-Error by its string form rather than [object Object]", () => {
		const { text } = render({
			renderer: () => {
				// Throwing a bare string is exactly the case under test.
				throw "renderer disabled by config";
			},
		});

		expect(text).toContain("renderer disabled by config");
		expect(text).not.toContain("[object Object]");
	});

	/** An Error with an empty message would otherwise produce a notice that
	 * trails off after "threw:", which tells the operator nothing. */
	it("falls back to the error name when the message is empty", () => {
		expect(notice("x", new TypeError(""))).toContain("threw: TypeError");
	});
});

describe("a custom renderer that declines", () => {
	/** Returning undefined is the documented way to say "use the default card for
	 * this one". It is not a failure and must not be reported as one. */
	it("renders the default card with no notice", () => {
		const { text } = render({ renderer: () => undefined });

		expect(text).toContain("deploy-status");
		expect(text).toContain("shipped to staging");
		expect(text).not.toContain("threw");
		expect(text).not.toContain("renderer");
	});

	it("renders the same card as no renderer at all", () => {
		const withDeclining = render({ renderer: () => undefined });
		const withNone = render({});

		expect(withDeclining.lines).toEqual(withNone.lines);
	});
});

describe("the notice text itself", () => {
	/** `errorMessage` keeps a whitespace-only message (it is a real message, and
	 * substituting the class name would hide that the throw site produced junk),
	 * but collapsing it leaves nothing, and a notice ending at the colon reads as
	 * a truncation bug in veyyon rather than a defect in the renderer. */
	it('says "no message" rather than trailing off when the message is only whitespace', () => {
		expect(notice("x", new Error("   "))).toContain("threw: no message —");
	});

	it("is one line, so it cannot push the card open", () => {
		expect(notice("deploy-status", new Error("a\nb"))).not.toContain("\n");
	});

	it("quotes the message type so an empty or spaced type is still legible", () => {
		expect(notice("", new Error("boom"))).toContain('custom message ""');
		expect(notice("two words", new Error("boom"))).toContain('"two words"');
	});
});
