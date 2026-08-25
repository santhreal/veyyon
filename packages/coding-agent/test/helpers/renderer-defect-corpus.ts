/**
 * Auto-promoting corpus manager and replay harness for renderer defect oracle.
 *
 * When the sweep or test encounters a failing input, it promotes that case into a
 * deterministic, committed JSON artifact in the corpus directory. A separate always-on
 * test replays the corpus on every pull request.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ComposerOracleGuarantee, OracleFailure } from "../../src/modes/components/composer-defect-oracle";

export interface CorpusCaseState {
	width: number;
	height: number;
	modeState: {
		bypass?: boolean;
		bashMode?: boolean;
		pythonMode?: boolean;
		planMode?: boolean;
		focusedSubagent?: boolean;
		sessionAccentAnsi?: string;
		thinkingLevel?: string;
	};
	editorText: string;
	transcriptLines: number;
	scrollIsolation: boolean;
	scrollOffset: number; // 0 for live tail, >0 for scroll back
	focused: boolean;
}

export interface CorpusCase {
	schemaVersion: 1;
	id: string;
	status: "recorded" | "resolved" | "exempted";
	reason?: string;
	recordedAt: string;
	template: string;
	seed: number;
	state: CorpusCaseState;
	failingOracle: ComposerOracleGuarantee;
	errorMessage: string;
	observedGrid: string[];
}

export const CORPUS_DIR = path.resolve(import.meta.dirname, "../corpus/renderer-defect-oracle");

/** Ensure corpus directory exists */
export function ensureCorpusDir(): void {
	if (!fs.existsSync(CORPUS_DIR)) {
		fs.mkdirSync(CORPUS_DIR, { recursive: true });
	}
}

/** Compute deterministic SHA-256 hash for a corpus case */
export function computeCaseHash(state: CorpusCaseState, failingOracle: string): string {
	const normalized = JSON.stringify({
		state,
		failingOracle,
	});
	return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Promote a failing scenario to the committed corpus.
 * Returns the written file path.
 */
export function promoteFailingCaseToCorpus(
	state: CorpusCaseState,
	failure: OracleFailure,
	observedGrid: string[],
	options?: { template?: string; seed?: number; status?: "recorded" | "resolved" | "exempted"; reason?: string },
): string {
	ensureCorpusDir();
	const id = computeCaseHash(state, failure.oracle);
	const filePath = path.join(CORPUS_DIR, `${id}.json`);

	// If file already exists and is marked resolved/exempted, keep its status unless overwritten
	let existingStatus: "recorded" | "resolved" | "exempted" = options?.status ?? "recorded";
	let existingReason = options?.reason;

	if (fs.existsSync(filePath)) {
		try {
			const existing: CorpusCase = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			if (!options?.status) {
				existingStatus = existing.status;
				existingReason = existing.reason;
			}
		} catch {
			// rewrite corrupted file
		}
	}

	const corpusCase: CorpusCase = {
		schemaVersion: 1,
		id,
		status: existingStatus,
		reason: existingReason,
		recordedAt: new Date().toISOString(),
		template: options?.template ?? "composer-sweep",
		seed: options?.seed ?? 0,
		state,
		failingOracle: failure.oracle,
		errorMessage: failure.message,
		observedGrid,
	};

	fs.writeFileSync(filePath, `${JSON.stringify(corpusCase, null, "\t")}\n`, "utf-8");
	return filePath;
}

/**
 * Load all cases currently stored in the committed corpus.
 */
export function loadAllCorpusCases(): CorpusCase[] {
	ensureCorpusDir();
	const files = fs.readdirSync(CORPUS_DIR).filter(f => f.endsWith(".json"));
	const cases: CorpusCase[] = [];
	for (const file of files) {
		const fullPath = path.join(CORPUS_DIR, file);
		try {
			const data = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
			if (data.schemaVersion === 1 && data.id && data.failingOracle) {
				cases.push(data);
			}
		} catch (error) {
			throw new Error(`Corrupted corpus case file at ${fullPath}: ${error}`);
		}
	}
	return cases;
}
