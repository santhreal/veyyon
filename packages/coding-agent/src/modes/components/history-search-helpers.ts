import { NON_ALNUM_RUN_RE } from "@veyyon/utils";
import { theme } from "../theme/theme";

export const MAX_VISIBLE = 10;

export function queryTokens(query: string): string[] {
	const raw = query.toLowerCase().split(NON_ALNUM_RUN_RE);
	const out: string[] = [];
	for (let ti = 0; ti < raw.length; ti++) {
		if (raw[ti]!.length > 0) out.push(raw[ti]!);
	}
	return out;
}

export function highlightTokens(text: string, tokens: string[]): string {
	if (tokens.length === 0) return text;

	const lower = text.toLowerCase();
	const ranges: Array<[number, number]> = [];
	for (let ti = 0; ti < tokens.length; ti++) {
		const tok = tokens[ti]!;
		let from = lower.indexOf(tok);
		while (from !== -1) {
			ranges.push([from, from + tok.length]);
			from = lower.indexOf(tok, from + tok.length);
		}
	}
	if (ranges.length === 0) return text;

	ranges.sort((a, b) => a[0] - b[0]);
	let out = "";
	let pos = 0;
	for (let ri = 0; ri < ranges.length; ri++) {
		const start = ranges[ri]![0];
		const end = ranges[ri]![1];
		if (end <= pos) continue;
		const from = Math.max(start, pos);
		if (from > pos) out += text.slice(pos, from);
		out += theme.fg("accent", text.slice(from, end));
		pos = end;
	}
	if (pos < text.length) out += text.slice(pos);
	return out;
}

export function relativeTime(epochSeconds: number): string {
	const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}
