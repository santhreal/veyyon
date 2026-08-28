import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ImageProtocol, renderImage, TERMINAL, wrapTmuxPassthrough } from "@veyyon/tui/terminal-capabilities";

/**
 * WHY: a picture drawn inside a tmux pane arrived as nothing, or as a screenful of garbage,
 * depending on the protocol. Every Kitty emitter wrapped its payload in tmux's DCS passthrough
 * envelope and the iTerm2 emitter did not, so an inline image inside tmux was swallowed by the
 * pane.
 *
 * The class this closes is one protocol's payload leaving the process by a route the active
 * multiplexer does not carry. It is not "wrap everything": tmux draws Sixel itself (Sixel is
 * selected only when the DA1 answer reported it, and inside tmux that answer is tmux's own), and
 * wrapping a Sixel payload would bypass tmux's own pane placement. So the contract is per
 * protocol, and the routing table below is pinned by exact equality: adding a member to
 * `ImageProtocol` fails this suite until someone records which route the new protocol takes.
 *
 * What it does not catch: whether the outer terminal has `allow-passthrough on`, which no bytes
 * emitted here can decide, and whether a payload tmux forwards is one the outer terminal renders.
 */

/**
 * Route each protocol's payload must take out of a tmux pane, and the bytes that open one of its
 * sequences. The `ImageProtocol` value is a nominal id (Sixel's `\x1bPq` is not the literal
 * prefix of a DCS carrying parameters), so the introducer is stated here beside the route.
 */
const ROUTE_THROUGH_TMUX: Record<ImageProtocol, { route: "passthrough" | "raw"; introducer: string }> = {
	[ImageProtocol.Kitty]: { route: "passthrough", introducer: "\x1b_G" },
	[ImageProtocol.Iterm2]: { route: "passthrough", introducer: "\x1b]1337;" },
	[ImageProtocol.Sixel]: { route: "raw", introducer: "\x1bP" },
};

const TMUX_PASSTHROUGH_START = "\x1bPtmux;";

// 1x1 white PNG: the smallest input every protocol encoder accepts.
const TINY_WHITE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Every escape sequence one image emission puts on the wire, in order. A keyed image emits two —
 * the transmit and the placement — and each crosses the multiplexer on its own, so they are kept
 * apart rather than concatenated.
 */
function emit(protocol: ImageProtocol, includeTransmit: boolean): { parts: string[]; lines: string[] } {
	TERMINAL.imageProtocol = protocol;
	const rendered = renderImage(
		TINY_WHITE_PNG_BASE64,
		{ widthPx: 32, heightPx: 32 },
		includeTransmit ? { imageId: 7, includeTransmit: true } : {},
	);
	if (!rendered) throw new Error(`${protocol} produced no image at all`);
	const parts = [rendered.transmit, rendered.sequence].filter((part): part is string => Boolean(part));
	return { parts, lines: rendered.lines ?? [] };
}

/** The emission as one string, for the checks that care about what reaches the pane in total. */
function emitted(protocol: ImageProtocol, includeTransmit: boolean): string {
	return emit(protocol, includeTransmit).parts.join("");
}

/** Protocol introducers appearing before any envelope, where tmux would drop or misdraw them. */
function unenvelopedIntroducers(payload: string): string[] {
	const outsideEnvelope = payload.split(TMUX_PASSTHROUGH_START)[0] ?? "";
	return Object.values(ROUTE_THROUGH_TMUX)
		.map(entry => entry.introducer)
		.filter(introducer => outsideEnvelope.includes(introducer));
}

describe("an image drawn inside a tmux pane", () => {
	const originalTmux = process.env.TMUX;
	const originalProtocol = TERMINAL.imageProtocol;

	beforeEach(() => {
		process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
	});

	afterEach(() => {
		if (originalTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = originalTmux;
		TERMINAL.imageProtocol = originalProtocol;
	});

	it("takes its protocol's declared route out of the pane, for every protocol that exists", () => {
		const observed: Record<string, { route: string; introducer: string }> = {};
		for (const protocol of Object.values(ImageProtocol)) {
			const sequence = emitted(protocol, false);
			observed[protocol] = {
				route: sequence.startsWith(TMUX_PASSTHROUGH_START) ? "passthrough" : "raw",
				introducer: ROUTE_THROUGH_TMUX[protocol].introducer,
			};
		}
		expect(observed).toEqual(ROUTE_THROUGH_TMUX);
	});

	it("leaves no protocol introducer outside the envelope on a route that wraps", () => {
		const leaked: Array<{ protocol: string; introducers: string[] }> = [];
		for (const protocol of Object.values(ImageProtocol)) {
			if (ROUTE_THROUGH_TMUX[protocol].route !== "passthrough") continue;
			const sequence = emitted(protocol, false);
			const introducers = unenvelopedIntroducers(sequence);
			if (introducers.length > 0) leaked.push({ protocol, introducers });
		}
		expect(leaked).toEqual([]);
	});

	it("wraps the transmit half of a keyed image as well as the placement half", () => {
		const parts = emit(ImageProtocol.Kitty, true).parts;
		expect(parts.length).toBe(2);
		for (const part of parts) {
			expect(part.startsWith(TMUX_PASSTHROUGH_START)).toBe(true);
			expect(unenvelopedIntroducers(part)).toEqual([]);
		}
	});

	it("doubles every escape it carries, so tmux ends the envelope at the payload's end", () => {
		const sequence = emitted(ImageProtocol.Iterm2, false);
		const body = sequence.slice(TMUX_PASSTHROUGH_START.length, -"\x1b\\".length);
		expect(body.includes("\x1b\x1b]1337;File=")).toBe(true);
		// A single ESC inside the body would terminate the DCS early and spill the rest as text.
		expect(body.replaceAll("\x1b\x1b", "")).not.toContain("\x1b");
		expect(sequence.endsWith("\x1b\\")).toBe(true);
	});

	it("emits placeholder cells as literal text, never as an escape to forward", () => {
		for (const protocol of Object.values(ImageProtocol)) {
			const { lines } = emit(protocol, true);
			for (const line of lines) {
				expect(unenvelopedIntroducers(line)).toEqual([]);
				expect(line).not.toContain(TMUX_PASSTHROUGH_START);
			}
		}
	});
});

describe("the same image drawn with no multiplexer in the way", () => {
	const originalTmux = process.env.TMUX;
	const originalProtocol = TERMINAL.imageProtocol;

	beforeEach(() => {
		delete process.env.TMUX;
	});

	afterEach(() => {
		if (originalTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = originalTmux;
		TERMINAL.imageProtocol = originalProtocol;
	});

	it("carries exactly the bytes its pane arm carries, envelope aside", () => {
		for (const protocol of Object.values(ImageProtocol)) {
			const direct = emit(protocol, true).parts;
			for (const part of direct) {
				expect(part).not.toContain(TMUX_PASSTHROUGH_START);
				expect(part.startsWith(ROUTE_THROUGH_TMUX[protocol].introducer)).toBe(true);
			}

			process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
			const inPane = emit(protocol, true).parts;
			delete process.env.TMUX;

			const raw = ROUTE_THROUGH_TMUX[protocol].route === "raw";
			expect(inPane).toEqual(raw ? direct : direct.map(part => wrapTmuxPassthrough(part)));
		}
	});
});
