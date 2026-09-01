#!/usr/bin/env bun

import * as fs from "node:fs";
import { estimateTokens } from "argot";
import {
	defaultSessionsDir,
	type Emission,
	type EmissionCounts,
	emissionsOf,
	emptyCounts,
	readEmissions,
} from "./transcript-corpus";

const STRUCTURE_RUN = /\n[ \t]*/g;

export interface ChannelTotals {
	occurrences: number;
	rawTokens: number;
	escapedTokens: number;
}

export interface ChannelSplit {
	toolCallArguments: ChannelTotals;
	plainMessage: ChannelTotals;
	assistantMessages: number;
	toolCallParts: number;
	textParts: number;
	thinkingParts: number;
	shareInToolCallArguments: number;
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

function accumulate(totals: ChannelTotals, text: string): void {
	STRUCTURE_RUN.lastIndex = 0;
	for (const match of text.matchAll(STRUCTURE_RUN)) {
		const run = match[0];
		totals.occurrences += 1;
		totals.rawTokens += estimateTokens(run);
		totals.escapedTokens += estimateTokens(JSON.stringify(run).slice(1, -1));
	}
}

export function foldEmission(split: ChannelSplit, emission: Emission): void {
	accumulate(emission.channel === "toolCall" ? split.toolCallArguments : split.plainMessage, emission.text);
}

export function applyCounts(split: ChannelSplit, counts: EmissionCounts): void {
	split.assistantMessages = counts.assistantMessages;
	split.toolCallParts = counts.toolCallParts;
	split.textParts = counts.textParts;
	split.thinkingParts = counts.thinkingParts;
}

export function finalizeSplit(split: ChannelSplit): ChannelSplit {
	const runs = split.toolCallArguments.occurrences + split.plainMessage.occurrences;
	const tokens = split.toolCallArguments.rawTokens + split.plainMessage.rawTokens;
	split.shareInToolCallArguments = runs === 0 ? 0 : split.toolCallArguments.occurrences / runs;
	split.tokenShareInToolCallArguments = tokens === 0 ? 0 : split.toolCallArguments.rawTokens / tokens;
	return split;
}

export function measureEvents(events: Iterable<unknown>): ChannelSplit {
	const split = emptySplit();
	const counts = emptyCounts();
	for (const event of events) {
		for (const emission of emissionsOf(event, counts)) foldEmission(split, emission);
	}
	applyCounts(split, counts);
	return finalizeSplit(split);
}

export function measureSessionsDir(root: string): { split: ChannelSplit; files: number } {
	const split = emptySplit();
	const corpus = readEmissions(root, emission => foldEmission(split, emission));
	applyCounts(split, corpus.counts);
	return { split: finalizeSplit(split), files: corpus.files };
}

function percent(value: number): string {
	return `${(value * 100).toFixed(2)}%`;
}

function main(argv: string[]): void {
	const sessionsFlag = argv.indexOf("--sessions");
	const root = sessionsFlag === -1 ? defaultSessionsDir() : argv[sessionsFlag + 1];
	if (!root || !fs.existsSync(root)) {
		console.error(`measure-channel-split: no transcript tree at ${root}`);
		process.exit(1);
	}

	const { split, files } = measureSessionsDir(root);
	if (argv.includes("--json")) {
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
