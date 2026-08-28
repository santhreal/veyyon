import type { PageContent } from "./types";

const MIN_PAGES = 5;
const TOP_ZONE_MIN_Y = 700;
const BOTTOM_ZONE_MAX_Y = 80;
const MIN_CONSECUTIVE_PAGES = 8;

export function stripHeadersFooters(pages: PageContent[]): void {
	if (pages.length < MIN_PAGES) return;
	const pageZoneTexts: Set<string>[] = [];
	for (const page of pages) {
		const zoneTexts = new Set<string>();
		for (const tb of page.textBoxes) {
			const midY = (tb.bounds.top + tb.bounds.bottom) / 2;
			if (midY >= TOP_ZONE_MIN_Y || midY <= BOTTOM_ZONE_MAX_Y) {
				const key = tb.text.trim().replace(/\s+/g, " ");
				if (key.length > 0) zoneTexts.add(key);
			}
		}
		pageZoneTexts.push(zoneTexts);
	}
	const globalCount = new Map<string, number>();
	const maxConsecutive = new Map<string, number>();
	const allTexts = new Set<string>();
	for (const zts of pageZoneTexts) {
		for (const t of zts) allTexts.add(t);
	}
	for (const text of allTexts) {
		let total = 0;
		let consecutive = 0;
		let maxRun = 0;
		for (const zts of pageZoneTexts) {
			if (zts.has(text)) {
				total++;
				consecutive++;
				if (consecutive > maxRun) maxRun = consecutive;
			} else {
				consecutive = 0;
			}
		}
		globalCount.set(text, total);
		maxConsecutive.set(text, maxRun);
	}
	const globalThreshold = Math.max(3, Math.floor(pages.length * 0.2));
	const repeatedTexts = new Set<string>();
	for (const text of allTexts) {
		const gc = globalCount.get(text) ?? 0;
		const mc = maxConsecutive.get(text) ?? 0;
		if (gc >= globalThreshold) {
			repeatedTexts.add(text);
			continue;
		}
		if (mc >= MIN_CONSECUTIVE_PAGES) {
			repeatedTexts.add(text);
		}
	}
	if (repeatedTexts.size === 0) return;
	for (const page of pages) {
		page.textBoxes = page.textBoxes.filter(tb => {
			const midY = (tb.bounds.top + tb.bounds.bottom) / 2;
			if (midY < TOP_ZONE_MIN_Y && midY > BOTTOM_ZONE_MAX_Y) return true;
			const normalized = tb.text.trim().replace(/\s+/g, " ");
			return !repeatedTexts.has(normalized);
		});
	}
}
