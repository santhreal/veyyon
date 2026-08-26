#!/usr/bin/env bun
/**
 * Measures which channel a real agent emits its LINE STRUCTURE into.
 *
 * WHY THIS INSTRUMENT EXISTS. argot's `emittedTokenCost` prices line structure
 * as it goes over the wire inside a tool-call argument, where JSON escaping turns
 * one newline into the two characters `\` and `n`. That choice is the only reason
 * structure handles pay at all: measured on a 39-file TypeScript tree the whole
 * generated dictionary is line structure, every row is net-positive under the
 * escaped model, and every row is net-NEGATIVE under the raw model that applies to
 * a plain assistant message. So the sign of the dictionary's value flips with the
 * channel, and the dictionary rides the system prompt every turn either way.
 *
 * Nobody had measured the split. This measures it, from the only honest source:
 * real recorded sessions. `transcript-corpus.ts` supplies the emissions, tagged
 * with the channel they went out on, and this file does the pricing.
 *
 * The two channels, and why the line falls where it does:
 *
 *   - TOOL-CALL ARGUMENTS. A tool call's arguments are serialized to JSON, so a
 *     newline inside one is emitted as an escape sequence. This is the channel
 *     `emittedTokenCost` assumes.
 *   - PLAIN MESSAGE TEXT, which is `text` and `thinking` parts. Both are ordinary
 *     model output carrying real control characters, and both are billed output
 *     tokens, so a handle emitted there is priced by the raw model.
 *
 * Usage:
 *   bun measure-channel-split.ts                       # every session in the profile
 *   bun measure-channel-split.ts --sessions <dir>      # a specific transcript tree
 *   bun measure-channel-split.ts --json                # machine-readable totals
 */

import * as fs from "node:fs";
import { errorMessage } from "@veyyon/utils";
import { estimateTokens } from "argot";
import { type FlagGrammar, flagText, parseFlags } from "../../core/flags";
import {
	defaultSessionsDir,
	type Emission,
	type EmissionCounts,
	emissionsOf,
	emptyCounts,
	readEmissions,
} from "./transcript-corpus";

/** Every newline together with the indentation run that follows it. */
const STRUCTURE_RUN = /\n[ \t]*/g;

/** What one channel emitted, priced both ways so the gap is visible rather than asserted. */
export interface ChannelTotals {
	/** How many newline-plus-indentation runs were emitted into this channel. */
	occurrences: number;
	/** What those runs cost priced as real control characters. */
	rawTokens: number;
	/** What they cost priced as JSON escape sequences. */
	escapedTokens: number;
}

/** The measurement. Shares are the number `emittedTokenCost` needs. */
export interface ChannelSplit {
	toolCallArguments: ChannelTotals;
	plainMessage: ChannelTotals;
	/** Assistant turns read, so a zero result can be told apart from an empty corpus. */
	assistantMessages: number;
	toolCallParts: number;
	textParts: number;
	thinkingParts: number;
	/**
	 * The share of structure runs emitted inside tool-call arguments, from 0 to 1.
	 * This is the mix weight: 1 means the escaped pricing is exactly right, 0 means
	 * it is exactly wrong.
	 */
	shareInToolCallArguments: number;
	/** The same share weighted by raw token mass rather than by occurrence count. */
	tokenShareInToolCallArguments: number;
}

function emptyTotals(): ChannelTotals {
	return { occurrences: 0, rawTokens: 0, escapedTokens: 0 };
}

export function emptySplit(): ChannelSplit {
	return {
		toolCallArguments: emptyTotals(),
		plainMessage: emptyTotals(),
		assistantMessages: 0,
		toolCallParts: 0,
		textParts: 0,
		thinkingParts: 0,
		shareInToolCallArguments: 0,
		tokenShareInToolCallArguments: 0,
	};
}

/** Add every structure run in `text` to `totals`, priced both ways. */
function accumulate(totals: ChannelTotals, text: string): void {
	STRUCTURE_RUN.lastIndex = 0;
	for (const match of text.matchAll(STRUCTURE_RUN)) {
		const run = match[0];
		totals.occurrences += 1;
		totals.rawTokens += estimateTokens(run);
		// `JSON.stringify` then strip the quotes: the exact bytes the run becomes
		// inside a tool-call argument, from the same encoder the wire uses. This
		// mirrors `emittedTokenCost` deliberately, so the instrument and the thing
		// it measures cannot drift apart on what "escaped" means.
		totals.escapedTokens += estimateTokens(JSON.stringify(run).slice(1, -1));
	}
}

/** Fold one emission into the running split. */
export function foldEmission(split: ChannelSplit, emission: Emission): void {
	accumulate(emission.channel === "toolCall" ? split.toolCallArguments : split.plainMessage, emission.text);
}

/** Copy the corpus counts onto the split, so one object carries the whole result. */
export function applyCounts(split: ChannelSplit, counts: EmissionCounts): void {
	split.assistantMessages = counts.assistantMessages;
	split.toolCallParts = counts.toolCallParts;
	split.textParts = counts.textParts;
	split.thinkingParts = counts.thinkingParts;
}

/** Recompute the shares. Call once the last emission is folded. */
export function finalizeSplit(split: ChannelSplit): ChannelSplit {
	const runs = split.toolCallArguments.occurrences + split.plainMessage.occurrences;
	const tokens = split.toolCallArguments.rawTokens + split.plainMessage.rawTokens;
	split.shareInToolCallArguments = runs === 0 ? 0 : split.toolCallArguments.occurrences / runs;
	split.tokenShareInToolCallArguments = tokens === 0 ? 0 : split.toolCallArguments.rawTokens / tokens;
	return split;
}

/** Measure a sequence of raw transcript events. The form the tests drive. */
export function measureEvents(events: Iterable<unknown>): ChannelSplit {
	const split = emptySplit();
	const counts = emptyCounts();
	for (const event of events) {
		for (const emission of emissionsOf(event, counts)) foldEmission(split, emission);
	}
	applyCounts(split, counts);
	return finalizeSplit(split);
}

/** Measure every transcript under `root`. */
export function measureSessionsDir(root: string): { split: ChannelSplit; files: number } {
	const split = emptySplit();
	const corpus = readEmissions(root, emission => foldEmission(split, emission));
	applyCounts(split, corpus.counts);
	return { split: finalizeSplit(split), files: corpus.files };
}

function percent(value: number): string {
	return `${(value * 100).toFixed(2)}%`;
}

/** What this instrument accepts. A misspelled flag used to be dropped, so it measured the default tree. */
export const CHANNEL_SPLIT_FLAGS = {
	valued: { sessions: true },
	valueless: { json: true, help: true },
} as const satisfies FlagGrammar;

const CHANNEL_SPLIT_USAGE = "usage: bun measure-channel-split.ts [--sessions <dir>] [--json]\n";

export function main(argv: string[]): void {
	let flags: Record<string, string>;
	try {
		flags = parseFlags(argv, CHANNEL_SPLIT_FLAGS);
	} catch (error) {
		console.error(errorMessage(error));
		console.error(CHANNEL_SPLIT_USAGE);
		process.exit(2);
	}
	if (flags.help !== undefined) {
		console.log(CHANNEL_SPLIT_USAGE);
		return;
	}
	let root: string;
	try {
		root = flagText(flags, "sessions") ?? defaultSessionsDir();
	} catch (error) {
		console.error(errorMessage(error));
		process.exit(2);
	}
	if (!fs.existsSync(root)) {
		// Nothing was measured, so this is the same class of exit as a wrong flag.
		console.error(`measure-channel-split: no transcript tree at ${root}`);
		process.exit(2);
	}

	const { split, files } = measureSessionsDir(root);
	if (flags.json !== undefined) {
		console.log(JSON.stringify({ root, files, ...split }, null, 2));
		return;
	}

	const tool = split.toolCallArguments;
	const plain = split.plainMessage;
	console.log(`transcripts:        ${files} files under ${root}`);
	console.log(`assistant turns:    ${split.assistantMessages}`);
	console.log(
		`parts:              ${split.toolCallParts} tool calls, ${split.textParts} text, ${split.thinkingParts} thinking`,
	);
	console.log("");
	console.log("structure runs      occurrences        raw tokens     escaped tokens");
	console.log(
		`  tool-call args    ${String(tool.occurrences).padStart(11)}    ${String(tool.rawTokens).padStart(11)}    ${String(tool.escapedTokens).padStart(11)}`,
	);
	console.log(
		`  plain message     ${String(plain.occurrences).padStart(11)}    ${String(plain.rawTokens).padStart(11)}    ${String(plain.escapedTokens).padStart(11)}`,
	);
	console.log("");
	console.log(`share in tool-call arguments, by occurrence: ${percent(split.shareInToolCallArguments)}`);
	console.log(`share in tool-call arguments, by raw tokens: ${percent(split.tokenShareInToolCallArguments)}`);
}

if (import.meta.main) {
	main(process.argv.slice(2));
}
