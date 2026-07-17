import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONTENT_STOPWORDS, ENTITY_STOPWORDS } from "@veyyon/pi-mnemopi/core/stopwords";

describe("content stopwords are unified in one place", () => {
	it("is the union of the two former inline lists", () => {
		// episodic-graph.ts formerly curated short function words; patterns.ts
		// curated longer function words plus domain noise. The canonical set must
		// contain representatives of BOTH so neither path loses coverage.
		const fromEpisodic = ["the", "that", "was", "she", "onto", "new"];
		const fromPatterns = ["would", "being", "through", "mnemopi", "memory", "memories"];
		for (const w of [...fromEpisodic, ...fromPatterns]) {
			expect(CONTENT_STOPWORDS.has(w)).toBe(true);
		}
		// Exact size guard: 24 (episodic) ∪ 24 (patterns) with "about" and "their"
		// shared = 46. A drift here means the canonical list changed; update
		// intentionally, do not silently.
		expect(CONTENT_STOPWORDS.size).toBe(46);
	});

	it("has exactly one definition in the source tree", () => {
		// Fails if a consumer reintroduces its own inline CONTENT_STOPWORDS instead
		// of importing the canonical one — the exact divergence this module fixed.
		const coreDir = path.join(import.meta.dir, "..", "src", "core");
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (entry.name.endsWith(".ts") && entry.name !== "stopwords.ts") {
					const src = fs.readFileSync(full, "utf8");
					if (/\bCONTENT_STOPWORDS\s*=\s*new Set\(/.test(src)) offenders.push(full);
				}
			}
		};
		walk(coreDir);
		expect(offenders).toEqual([]);
	});

	it("is read-only content-word noise, not entity/query stopwords", () => {
		// Sanity: it filters function words and domain self-references, and does not
		// accidentally swallow ordinary topical content tokens.
		expect(CONTENT_STOPWORDS.has("database")).toBe(false);
		expect(CONTENT_STOPWORDS.has("authentication")).toBe(false);
		expect(CONTENT_STOPWORDS.has("mnemopi")).toBe(true);
	});
});

describe("entity/mention stopwords are unified in one place", () => {
	it("is the union of the entity-extraction and noisy-mention lists", () => {
		// entities.ts carried standard function words + domain noise; annotations.ts
		// carried ONLY the domain-noise subset and was missing every function word.
		const functionWords = ["the", "a", "of", "and", "with", "would", "which"];
		const domainNoise = ["assistant", "user", "agent", "task", "hermes", "mnemopi"];
		for (const w of [...functionWords, ...domainNoise]) {
			expect(ENTITY_STOPWORDS.has(w)).toBe(true);
		}
		// The former annotations.ts gap: bare function words must now be filtered so
		// mentions like "of the" are rejected as noise.
		expect(ENTITY_STOPWORDS.has("of")).toBe(true);
		expect(ENTITY_STOPWORDS.has("the")).toBe(true);
		// 116 (entities.ts superset) ∪ {"mnemopi"} = 117. Drift here is intentional-
		// only; update the canonical list, never a consumer's inline copy.
		expect(ENTITY_STOPWORDS.size).toBe(117);
	});

	it("does not swallow real named-entity tokens", () => {
		expect(ENTITY_STOPWORDS.has("postgres")).toBe(false);
		expect(ENTITY_STOPWORDS.has("kubernetes")).toBe(false);
		expect(ENTITY_STOPWORDS.has("veyyon")).toBe(false);
	});

	it("has exactly one definition in the source tree", () => {
		// Fails if annotations.ts or entities.ts (or any consumer) reintroduces its
		// own inline entity stopword Set instead of importing the canonical one.
		const coreDir = path.join(import.meta.dir, "..", "src", "core");
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (entry.name.endsWith(".ts") && entry.name !== "stopwords.ts") {
					const src = fs.readFileSync(full, "utf8");
					if (/\bENTITY_(?:EXTRACTION_)?STOP_WORD[S_]?\w*\s*=\s*(?:new Set\(|\[)/.test(src)) {
						offenders.push(full);
					}
				}
			}
		};
		walk(coreDir);
		expect(offenders).toEqual([]);
	});
});
