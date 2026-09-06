/**
 * The `irc` card draws what main's renderer drew, including the message cards it embeds.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import {
	createIrcMessageCard,
	type IrcMessageCard,
} from "@veyyon/coding-agent/modes/terminal/components/transcript/irc-message";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import type { IrcMessage } from "@veyyon/coding-agent/task/irc-bus";
import type { ThemeColor } from "@veyyon/coding-agent/theme/color";
import type { SymbolKey } from "@veyyon/coding-agent/theme/symbols";
import { theme } from "@veyyon/coding-agent/theme/theme";
import type { IrcDetails } from "@veyyon/coding-agent/tools/agent/irc";
import { type IrcViewArgs, type IrcViewResult, ircToolView } from "@veyyon/coding-agent/tools/agent/irc-view";
import { formatExpandHint, PREVIEW_LIMITS } from "@veyyon/coding-agent/tools/core/render-utils";
import type { ToolViewContext, ViewStatus } from "@veyyon/view";
import * as ircOracle from "../oracles/irc-main-renderer";
import {
	COLLAPSED,
	EXPANDED,
	framedView,
	HOST_COLLAPSED,
	HOST_EXPANDED,
	renderCompLines,
	useDifferentialTheme,
	WIDTH,
} from "./harness";

useDifferentialTheme();

describe("irc tool differential", () => {
	/** The rail glyph, read when a cell runs rather than when the file loads: the theme starts empty. */
	const rail = (): string => theme.symbol("block.rail");
	const TS_NOW = Date.now() - 30_000;

	/**
	 * A card with the block's own width padding removed.
	 *
	 * Every irc card states its direction in a word where main drew an arrow, so the longest row of
	 * the two arms differs by a column or two and the block pads every other row to match it. The
	 * padding sits between the content and the background reset, so `trimEnd` never reaches it. It is
	 * the host's layout rather than either renderer's bytes, so both arms are compared without it.
	 */
	function fitted(lines: readonly string[]): string[] {
		return lines.map(line => line.replace(/ +(\x1b\[49m)$/, "$1"));
	}

	/** Main coloured the rail from the block's state; a view takes the settled edge on every card but a failure. */
	function railAs(color: ThemeColor, lines: readonly string[]): string[] {
		return lines.map(line => line.replace(theme.fg("borderMuted", rail()), theme.fg(color, rail())));
	}

	/** Main drew the direction as an arrow inside the title's colour run; a view states it in words. */
	function arrows(lines: readonly string[]): string[] {
		return lines.map(line =>
			line.replace("IRC to ", `IRC ${theme.nav.selected} `).replace("IRC from ", `IRC ${theme.nav.back} `),
		);
	}

	/** The four marks a roster row opens with, each with the tone both arms draw it in. */
	const PEER_MARKS: ReadonlyArray<readonly [SymbolKey, ThemeColor]> = [
		["status.running", "accent"],
		["status.enabled", "success"],
		["status.shadowed", "muted"],
		["status.aborted", "error"],
	];

	/**
	 * A roster row whose mark and status word share one colour run again.
	 *
	 * The host draws the mark from its own symbol table and the word from the tool's span, so the
	 * terminal closes the run after the glyph and opens an identical one for the word. Main wrote both
	 * into a single `theme.fg`, so undoing the split is dropping the reset that meets the reopen.
	 */
	function marks(lines: readonly string[]): string[] {
		return lines.map(line => {
			let out = line;
			for (const [key, color] of PEER_MARKS) {
				const glyph = theme.symbol(key);
				const styled = theme.styledSymbol(key, color);
				const open = styled.slice(0, styled.indexOf(glyph));
				const close = styled.slice(styled.indexOf(glyph) + glyph.length);
				out = out.split(`${glyph}${close}${open}`).join(glyph);
			}
			return out;
		});
	}

	/** Main joined a peer's kind to its parent with the terminal's own separator glyph; a view states two words. */
	function dots(lines: readonly string[]): string[] {
		return lines.map(line => line.replace(" of ", `${theme.sep.dot}of `));
	}

	/** The view's bytes with the two host decisions above undone, which is what main drew. */
	function asMain(color: ThemeColor, lines: readonly string[]): string[] {
		return fitted(arrows(railAs(color, lines)));
	}

	function viewLines(value: IrcViewResult, context: ToolViewContext, args?: IrcViewArgs, width = WIDTH): string[] {
		return renderCompLines(drawToolView(ircToolView.renderResult(value, context, args), theme), width);
	}

	function oracleLines(
		value: IrcViewResult,
		options: RenderResultOptions,
		args?: IrcViewArgs,
		width = WIDTH,
	): string[] {
		return renderCompLines(ircOracle.ircToolRenderer.renderResult(value, options, theme, args), width);
	}

	function message(overrides: Partial<IrcMessage> = {}): IrcMessage {
		return {
			id: "7181122334455667789",
			from: "AuthLoader",
			to: "Main",
			body: "session-store rename is merged.",
			ts: TS_NOW,
			...overrides,
		};
	}

	/** A roster row, read off the tool's own details rather than restated here. */
	type IrcPeer = NonNullable<IrcDetails["peers"]>[number];

	function peer(overrides: Partial<IrcPeer> = {}): IrcPeer {
		return {
			id: "AuthLoader",
			displayName: "task",
			kind: "sub",
			status: "running",
			parentId: "Main",
			unread: 0,
			lastActivity: TS_NOW,
			...overrides,
		};
	}

	function result(details: IrcDetails, overrides: Partial<IrcViewResult> = {}): IrcViewResult {
		return { content: [{ type: "text", text: "" }], details, ...overrides };
	}

	const SEND_ARGS: IrcViewArgs = {
		op: "send",
		to: "AuthLoader",
		message: "Are you done with auth.ts?",
		await: true,
	};

	it("draws the pending call row with the direction in words and the settled edge", () => {
		const calls: IrcViewArgs[] = [
			SEND_ARGS,
			{ op: "send", to: "all", message: "a\nb\nc", replyTo: "7181122334455667791" },
			{ op: "send" },
			{ op: "wait", from: "AuthLoader", timeoutMs: 120_000 },
			{ op: "wait" },
			{ op: "inbox", peek: true },
			{ op: "list" },
			{},
		];
		for (const args of calls) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					const drawn = renderCompLines(drawToolView(ircToolView.renderCall(args, context), theme), width);
					const oracle = renderCompLines(ircOracle.ircToolRenderer.renderCall(args, options, theme), width);
					// A pending call keeps main's accent rail once the host's settled edge is undone,
					// and every other byte of the row is main's, held-back note aside.
					const held = drawn.some(line => stripVTControlCharacters(line).includes("more line"));
					if (!held) expect(asMain("accent", drawn)).toEqual(fitted(oracle));
				}
			}
		}
		// Anti-vacuity: the row carries the peer, the direction and the call's own metadata, and a
		// send's message preview rides under it.
		const row = stripVTControlCharacters(
			renderCompLines(drawToolView(ircToolView.renderCall(SEND_ARGS, COLLAPSED), theme), 200).join("\n"),
		);
		expect(row).toContain("IRC to AuthLoader");
		expect(row).toContain("await reply");
		expect(row).toContain("Are you done with auth.ts?");
		const wait = stripVTControlCharacters(
			renderCompLines(
				drawToolView(ircToolView.renderCall({ op: "wait", timeoutMs: 120_000 }, COLLAPSED), theme),
				200,
			).join("\n"),
		);
		expect(wait).toContain("IRC from anyone");
		expect(wait).toContain("timeout 2m");
	});

	it("draws a settled send card byte for byte, rail and direction aside", () => {
		const value = result({
			op: "send",
			from: "Main",
			to: "AuthLoader",
			receipts: [{ to: "AuthLoader", outcome: "revived" }],
			waited: message({ body: "go ahead, auth.ts is yours." }),
		});
		for (const [context, options] of [
			[COLLAPSED, HOST_COLLAPSED],
			[EXPANDED, HOST_EXPANDED],
		] as const) {
			for (const width of [200, WIDTH, 40]) {
				expect(asMain("dim", viewLines(value, context, SEND_ARGS, width))).toEqual(
					fitted(oracleLines(value, options, SEND_ARGS, width)),
				);
			}
		}
		// Anti-vacuity: the card carries the outcome on the row, the message that was sent, the peer
		// that answered and the answer itself.
		const drawn = stripVTControlCharacters(viewLines(value, COLLAPSED, SEND_ARGS, 200).join("\n"));
		expect(drawn).toContain("IRC to AuthLoader");
		expect(drawn).toContain("revived");
		expect(drawn).toContain("Are you done with auth.ts?");
		expect(drawn).toContain(`${theme.nav.back} AuthLoader`);
		expect(drawn).toContain("go ahead, auth.ts is yours.");
	});

	it("draws an awaited send that timed out the way main drew it, on the settled edge", () => {
		const value = result({
			op: "send",
			from: "Main",
			to: "AuthLoader",
			receipts: [{ to: "AuthLoader", outcome: "injected" }],
			waited: null,
		});
		for (const width of [200, WIDTH, 40]) {
			// Main coloured the rail with the warning the plate already carries; the view leaves the
			// edge settled and states the outcome once, on the plate.
			expect(asMain("warning", viewLines(value, COLLAPSED, SEND_ARGS, width))).toEqual(
				fitted(oracleLines(value, HOST_COLLAPSED, SEND_ARGS, width)),
			);
		}
		const drawn = stripVTControlCharacters(viewLines(value, COLLAPSED, SEND_ARGS, 200).join("\n"));
		expect(drawn).toContain("no reply");
		expect(drawn).toContain("No reply yet");
		// The warning is on the plate in both arms, and only main also put it on the rail.
		expect(viewLines(value, COLLAPSED, SEND_ARGS, 200)[0]).toContain(theme.fg("borderMuted", rail()));
		expect(oracleLines(value, HOST_COLLAPSED, SEND_ARGS, 200)[0]).toContain(theme.fg("warning", rail()));
	});

	it("draws a send that delivered nothing the way main drew it", () => {
		const failed = result(
			{ op: "send", from: "Main" },
			{ content: [{ type: "text", text: '`to` is required for op="send".' }], isError: true },
		);
		for (const width of [200, WIDTH, 40]) {
			// A failure keeps main's rail as well as its text: the error edge is the one the host
			// draws too, so these rows are identical without any normalisation but the direction.
			expect(fitted(arrows(viewLines(failed, COLLAPSED, { op: "send" }, width)))).toEqual(
				fitted(oracleLines(failed, HOST_COLLAPSED, { op: "send" }, width)),
			);
		}
		const empty = result(
			{ op: "send", from: "Main", to: "all" },
			{ content: [{ type: "text", text: "No peers to broadcast to." }] },
		);
		for (const width of [200, WIDTH, 40]) {
			expect(asMain("warning", viewLines(empty, COLLAPSED, { op: "send", to: "all" }, width))).toEqual(
				fitted(oracleLines(empty, HOST_COLLAPSED, { op: "send", to: "all" }, width)),
			);
		}
		expect(stripVTControlCharacters(viewLines(failed, COLLAPSED, { op: "send" }, 200).join("\n"))).toContain(
			'`to` is required for op="send".',
		);
		expect(
			stripVTControlCharacters(viewLines(empty, COLLAPSED, { op: "send", to: "all" }, 200).join("\n")),
		).toContain("No peers to broadcast to.");
	});

	it("draws every wait card the way main drew it, rail and direction aside", () => {
		const cases: Array<[IrcDetails, ThemeColor, ViewStatus, Partial<IrcViewResult>]> = [
			[{ op: "wait", from: "Main", waited: message() }, "dim", "success", {}],
			[{ op: "wait", from: "Main", waited: message({ replyTo: "7181122334455667791" }) }, "dim", "success", {}],
			[
				{ op: "wait", from: "Main", waited: null },
				"warning",
				"warning",
				{ content: [{ type: "text", text: "No message from AuthLoader within 2m." }] },
			],
		];
		for (const [details, rail, state, overrides] of cases) {
			// The outcome the card REPORTS is pinned on the view: a settled plate and a warning plate
			// draw the same rows here, so a card that reported the wrong one would say nothing to the
			// terminal and the wrong thing to every other host.
			expect(framedView(ircToolView.renderResult(result(details, overrides), COLLAPSED)).state).toBe(state);
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					const value = result(details, overrides);
					expect(asMain(rail, viewLines(value, context, { op: "wait", from: "AuthLoader" }, width))).toEqual(
						fitted(oracleLines(value, options, { op: "wait", from: "AuthLoader" }, width)),
					);
				}
			}
		}
		const drawn = stripVTControlCharacters(
			viewLines(
				result({ op: "wait", from: "Main", waited: message({ replyTo: "1" }) }),
				COLLAPSED,
				{ op: "wait" },
				200,
			).join("\n"),
		);
		expect(drawn).toContain("IRC from AuthLoader");
		expect(drawn).toContain("reply");
		expect(drawn).toContain("session-store rename is merged.");
	});

	it("draws every inbox and peer card the way main drew it, rail and badges aside", () => {
		const inbox = result({
			op: "inbox",
			from: "Main",
			inbox: [
				message({ from: "AuthLoader", body: "bus landed." }),
				message({ from: "RateLimiter", body: "receipts carry outcome." }),
			],
		});
		const empty = result(
			{ op: "inbox", from: "Main", inbox: [] },
			{ content: [{ type: "text", text: "Inbox empty." }] },
		);
		// Peers with no parent, so the row carries no separator and the two arms are the same length at
		// every width.
		const peers = result({
			op: "list",
			from: "Main",
			peers: [
				peer({ id: "AuthLoader", parentId: undefined, activity: "auditing the token refresh path" }),
				peer({ id: "Solo", status: "idle", parentId: undefined }),
			],
		});
		const noPeers = result({ op: "list", from: "Main", peers: [] });
		for (const [value, args] of [
			[inbox, { op: "inbox", peek: true } as IrcViewArgs],
			[empty, { op: "inbox" } as IrcViewArgs],
			[peers, { op: "list" } as IrcViewArgs],
			[noPeers, { op: "list" } as IrcViewArgs],
		] as const) {
			for (const [context, options] of [
				[COLLAPSED, HOST_COLLAPSED],
				[EXPANDED, HOST_EXPANDED],
			] as const) {
				for (const width of [200, WIDTH, 40]) {
					expect(asMain("dim", marks(viewLines(value, context, args, width)))).toEqual(
						fitted(oracleLines(value, options, args, width)),
					);
				}
			}
		}
		// A peer WITH a parent is compared where neither arm wraps: the separator the host dropped
		// shortens the row by two columns, so a narrow terminal breaks the two arms at different words
		// and no normalisation of the drawn rows can undo that. The separator itself is the exception
		// cell below.
		const parented = result({
			op: "list",
			from: "Main",
			peers: [peer({ id: "AuthLoader", activity: "auditing the token refresh path" })],
		});
		expect(asMain("dim", marks(dots(viewLines(parented, COLLAPSED, { op: "list" }, 200))))).toEqual(
			fitted(oracleLines(parented, HOST_COLLAPSED, { op: "list" }, 200)),
		);
		// Anti-vacuity: the inbox lists each sender over its body, and a roster row carries the peer's
		// mark, its id, its role and what it is doing.
		const drawn = stripVTControlCharacters(viewLines(inbox, COLLAPSED, { op: "inbox", peek: true }, 200).join("\n"));
		expect(drawn).toContain("2 messages");
		expect(drawn).toContain("AuthLoader");
		expect(drawn).toContain("bus landed.");
		const roster = stripVTControlCharacters(viewLines(peers, COLLAPSED, { op: "list" }, 200).join("\n"));
		expect(roster).toContain(`${theme.status.running} running`);
		expect(roster).toContain("auditing the token refresh path");
		// The tool's own emblem and the outcome the card reports are pinned on the VIEW rather than on
		// its bytes: the terminal draws `tool.irc` as an empty run in a build without the glyph, and a
		// settled card's plate and its rail read the same as a warning's here, so a card that lost
		// either would draw the same rows and say something else to every other host.
		for (const [value, args] of [
			[inbox, { op: "inbox", peek: true } as IrcViewArgs],
			[empty, { op: "inbox" } as IrcViewArgs],
			[peers, { op: "list" } as IrcViewArgs],
		] as const) {
			const view = framedView(ircToolView.renderResult(value, COLLAPSED, args));
			expect(view.header.emblem).toBe("tool.irc");
			expect(view.state).toBe("success");
		}
		// A roster with no peers reports itself with the info mark instead, which is main's icon too.
		const none = framedView(ircToolView.renderResult(noPeers, COLLAPSED, { op: "list" }));
		expect(none.header.status).toBe("info");
		expect(none.header.emblem).toBeUndefined();
	});

	it("exception cell: a peer's kind and its parent are two words where main joined them with a dot", () => {
		const value = result({ op: "list", from: "Main", peers: [peer()] });
		const drawn = stripVTControlCharacters(viewLines(value, COLLAPSED, { op: "list" }, 200).join("\n"));
		const oracle = stripVTControlCharacters(oracleLines(value, HOST_COLLAPSED, { op: "list" }, 200).join("\n"));
		// The dot is the terminal's own separator glyph, which a tool cannot name: the row states the
		// two facts and the host spaces them.
		expect(drawn).toContain("sub of Main");
		expect(oracle).toContain(`sub${theme.sep.dot}of Main`);
		// A peer with no parent reads the same in both arms, so the difference is the separator alone.
		const solo = result({ op: "list", from: "Main", peers: [peer({ parentId: undefined })] });
		expect(asMain("dim", marks(viewLines(solo, COLLAPSED, { op: "list" }, 200)))).toEqual(
			fitted(oracleLines(solo, HOST_COLLAPSED, { op: "list" }, 200)),
		);
	});

	it("exception cell: a badge is the word in its tone, without the brackets main drew", () => {
		const value = result({
			op: "send",
			from: "Main",
			to: "all",
			receipts: [
				{ to: "AuthLoader", outcome: "woken" },
				{ to: "RateLimiter", outcome: "failed", error: 'unknown agent "RateLimiter"' },
			],
		});
		const args: IrcViewArgs = { op: "send", to: "all", message: "heads up" };
		const drawn = viewLines(value, COLLAPSED, args, 200);
		const oracle = oracleLines(value, HOST_COLLAPSED, args, 200);
		expect(drawn).toHaveLength(oracle.length);
		// Same rows in the same order, and the same words in the same tones: the bracket pair and the
		// dash before a failure's reason are chrome the tool wrote and the host now owns.
		expect(stripVTControlCharacters(drawn[2] ?? "")).toContain("AuthLoader woken");
		expect(stripVTControlCharacters(oracle[2] ?? "")).toContain(
			`AuthLoader ${theme.format.bracketLeft}woken${theme.format.bracketRight}`,
		);
		expect(drawn[2]).toContain(theme.fg("success", "woken"));
		expect(drawn[3]).toContain(theme.fg("error", "failed"));
		expect(stripVTControlCharacters(drawn[3] ?? "")).toContain('failed unknown agent "RateLimiter"');
		expect(stripVTControlCharacters(oracle[3] ?? "")).toContain(
			`${theme.format.bracketRight} ${theme.format.dash} unknown agent "RateLimiter"`,
		);
		// The reason a delivery failed keeps the failure tone main gave it; only the dash is gone.
		expect(drawn[3]).toContain(theme.fg("error", 'unknown agent "RateLimiter"'));
		expect(oracle[3]).toContain(theme.fg("error", `${theme.format.dash} unknown agent "RateLimiter"`));
		// The unread badge on a roster row is the same decision.
		const unread = result({ op: "list", from: "Main", peers: [peer({ unread: 2, status: "parked" })] });
		const roster = viewLines(unread, COLLAPSED, { op: "list" }, 200);
		expect(roster.join("")).toContain(theme.fg("warning", "2 unread"));
		expect(stripVTControlCharacters(oracleLines(unread, HOST_COLLAPSED, { op: "list" }, 200).join(""))).toContain(
			`${theme.format.bracketLeft}2 unread${theme.format.bracketRight}`,
		);
	});

	it("exception cell: a peer's mark and its word are two runs where main painted one", () => {
		const value = result({ op: "list", from: "Main", peers: [peer({ status: "wedged", parentId: undefined })] });
		const drawn = viewLines(value, COLLAPSED, { op: "list" }, 200);
		const oracle = oracleLines(value, HOST_COLLAPSED, { op: "list" }, 200);
		// The mark comes from the host's symbol table and the word from the tool, so the terminal
		// restates the same colour on each; main wrote both into one run. An unknown status still
		// draws the aborted mark in the error tone in both arms.
		expect(drawn[1]).toContain(theme.styledSymbol("status.aborted", "error"));
		expect(drawn[1]).toContain(theme.fg("error", " wedged"));
		expect(oracle[1]).toContain(theme.fg("error", `${theme.status.aborted} wedged`));
		expect(stripVTControlCharacters(drawn[1] ?? "")).toEqual(stripVTControlCharacters(oracle[1] ?? ""));
	});

	it("exception cell: every hold-back is the host's sentence with the host's gesture", () => {
		// A body longer than the collapsed budget, in the card that shows one.
		const long = result({
			op: "wait",
			from: "Main",
			waited: message({ body: Array.from({ length: 6 }, (_unused, i) => `reply line ${i + 1}`).join("\n") }),
		});
		const drawnBody = viewLines(long, COLLAPSED, { op: "wait" }, 200);
		const oracleBody = oracleLines(long, HOST_COLLAPSED, { op: "wait" }, 200);
		expect(drawnBody).toHaveLength(oracleBody.length);
		expect(drawnBody.at(-1)).toContain(theme.fg("dim", "… 4 more lines"));
		expect(drawnBody.at(-1)).toContain(formatExpandHint(theme, false, true));
		expect(oracleBody.at(-1)).toContain(theme.fg("dim", "… +4 more lines"));
		expect(stripVTControlCharacters(oracleBody.at(-1) ?? "")).not.toContain("expand");
		// A body longer than the EXPANDED budget still holds lines back, and there the host offers no
		// gesture, because there is nothing further to disclose: the sentence stands alone.
		const huge = result({
			op: "wait",
			from: "Main",
			waited: message({ body: Array.from({ length: 20 }, (_unused, i) => `reply line ${i + 1}`).join("\n") }),
		});
		const drawnHuge = viewLines(huge, EXPANDED, { op: "wait" }, 200);
		expect(drawnHuge.at(-1)).toContain(theme.fg("dim", "… 8 more lines"));
		expect(stripVTControlCharacters(drawnHuge.at(-1) ?? "")).not.toContain("expand");
		expect(oracleLines(huge, HOST_EXPANDED, { op: "wait" }, 200).at(-1)).toContain(
			theme.fg("dim", "… +8 more lines"),
		);
		// Expanded, the same body fits and neither arm says anything about it.
		expect(stripVTControlCharacters(viewLines(long, EXPANDED, { op: "wait" }, 200).join("\n"))).not.toContain(
			"more lines",
		);
		// A roster longer than the collapsed item budget.
		const roster = result({
			op: "list",
			from: "Main",
			peers: Array.from({ length: PREVIEW_LIMITS.COLLAPSED_ITEMS + 4 }, (_unused, i) =>
				peer({ id: `Agent_${i + 1}`, status: "idle" }),
			),
		});
		const drawnRoster = viewLines(roster, COLLAPSED, { op: "list" }, 200);
		expect(drawnRoster).toHaveLength(PREVIEW_LIMITS.COLLAPSED_ITEMS + 2);
		expect(drawnRoster.at(-1)).toContain(theme.fg("dim", "… 4 more peers"));
		expect(drawnRoster.at(-1)).toContain(formatExpandHint(theme, false, true));
		expect(oracleLines(roster, HOST_COLLAPSED, { op: "list" }, 200).at(-1)).toContain(
			theme.fg("dim", "… 4 more peers"),
		);
		// Expanded, every peer is drawn and both arms agree byte for byte again.
		expect(asMain("dim", marks(dots(viewLines(roster, EXPANDED, { op: "list" }, 200))))).toEqual(
			fitted(oracleLines(roster, HOST_EXPANDED, { op: "list" }, 200)),
		);
		// The recipients of a broadcast are the third hold-back, worded by the same host sentence.
		const broadcast = result({
			op: "send",
			from: "Main",
			to: "all",
			receipts: Array.from({ length: PREVIEW_LIMITS.COLLAPSED_ITEMS + 4 }, (_unused, i) => ({
				to: `Agent_${i + 1}`,
				outcome: "woken" as const,
			})),
		});
		const drawnBroadcast = viewLines(broadcast, COLLAPSED, { op: "send", to: "all", message: "heads up" }, 200);
		expect(drawnBroadcast.at(-1)).toContain(theme.fg("dim", "… 4 more recipients"));
		expect(drawnBroadcast.at(-1)).toContain(formatExpandHint(theme, false, true));
		// A single held-back item is worded singular, which is the host's plural rule rather than the
		// tool's.
		const one = result({
			op: "list",
			from: "Main",
			peers: Array.from({ length: PREVIEW_LIMITS.COLLAPSED_ITEMS + 1 }, (_unused, i) =>
				peer({ id: `Agent_${i + 1}`, status: "idle" }),
			),
		});
		expect(stripVTControlCharacters(viewLines(one, COLLAPSED, { op: "list" }, 200).at(-1) ?? "")).toContain(
			"… 1 more peer ",
		);
	});

	it("draws an error card with byte parity, for single-line and multi-line errors", () => {
		// A failure is byte-identical, rail included: the error edge is the host's too.
		for (const width of [200, WIDTH, 40]) {
			const single: IrcViewResult = { content: [{ type: "text", text: "bus unavailable" }], isError: true };
			expect(fitted(viewLines(single, COLLAPSED, { op: "inbox" }, width))).toEqual(
				fitted(oracleLines(single, HOST_COLLAPSED, { op: "inbox" }, width)),
			);
			const listing: IrcViewResult = {
				content: [{ type: "text", text: "registry unavailable" }],
				details: { op: "list", from: "Main" },
				isError: true,
			};
			expect(fitted(viewLines(listing, COLLAPSED, { op: "list" }, width))).toEqual(
				fitted(oracleLines(listing, HOST_COLLAPSED, { op: "list" }, width)),
			);
			const many: IrcViewResult = { content: [{ type: "text", text: "boom\nsecond line" }], isError: true };
			expect(fitted(viewLines(many, COLLAPSED, undefined, width))).toEqual(
				fitted(oracleLines(many, HOST_COLLAPSED, undefined, width)),
			);
		}
		// A result with neither details nor an op reports the same settled row in both arms.
		const done: IrcViewResult = { content: [{ type: "text", text: "Done." }] };
		expect(asMain("dim", viewLines(done, COLLAPSED, undefined, 200))).toEqual(
			fitted(oracleLines(done, HOST_COLLAPSED, undefined, 200)),
		);
	});

	it("draws a partial result as the pending card, where main framed it pending too", () => {
		const value = result({
			op: "send",
			from: "Main",
			to: "AuthLoader",
			receipts: [{ to: "AuthLoader", outcome: "woken" }],
		});
		const drawn = renderCompLines(
			drawToolView(ircToolView.renderResult(value, { expanded: false, partial: true }, SEND_ARGS), theme),
			200,
		);
		const oracle = renderCompLines(
			ircOracle.ircToolRenderer.renderResult(value, { expanded: false, isPartial: true }, theme, SEND_ARGS),
			200,
		);
		expect(asMain("accent", drawn)).toEqual(fitted(oracle));
	});

	it("draws the transcript card for live traffic exactly as main drew it", () => {
		const cards: IrcMessageCard[] = [
			{ kind: "incoming", from: "AuthLoader", body: "bus landed.", timestamp: TS_NOW },
			{ kind: "autoreply", to: "AuthLoader", body: "on it.", replyTo: "1", timestamp: TS_NOW },
			{ kind: "relay", from: "AuthLoader", to: "RateLimiter", body: "receipts carry outcome." },
			{ kind: "incoming", body: "" },
			{
				kind: "incoming",
				from: "AuthLoader",
				body: Array.from({ length: 6 }, (_unused, i) => `line ${i + 1}`).join("\n"),
				timestamp: TS_NOW,
			},
		];
		for (const card of cards) {
			for (const expanded of [false, true]) {
				for (const width of [200, WIDTH, 40]) {
					const moved = renderCompLines(
						createIrcMessageCard(card, () => expanded, theme),
						width,
					);
					const oracle = renderCompLines(
						ircOracle.createIrcMessageCard(card, () => expanded, theme),
						width,
					);
					expect(moved).toEqual(oracle);
				}
			}
		}
		// Anti-vacuity: the card the move is compared on carries the direction, the peer and the body.
		const drawn = stripVTControlCharacters(
			renderCompLines(
				createIrcMessageCard(cards[0]!, () => false, theme),
				200,
			).join("\n"),
		);
		expect(drawn).toContain(`IRC ${theme.nav.back} AuthLoader`);
		expect(drawn).toContain("bus landed.");
	});
});
