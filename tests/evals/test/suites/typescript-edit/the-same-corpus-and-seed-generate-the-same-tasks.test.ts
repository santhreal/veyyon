/**
 * WHY:
 * Tests that task generation for the TypeScript edit benchmark is strictly reproducible
 * given the same random seed, producing byte-identical case selection and content, and
 * that generated metadata faithfully records the seed, source repo URL, and pinned commit SHA.
 *
 * This prevents regressions where unpinned HEAD clones or unrecorded seeds cause silent
 * benchmark drift over time.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import {
	buildCaseEntries,
	DEFAULT_SOURCE_COMMIT_SHA,
	DEFAULT_SOURCE_REPO_URL,
	filterFiles,
	generateCases,
} from "../../../suites/typescript-edit/generate";
import { allMutations } from "../../../suites/typescript-edit/mutations/registry";
import { loadTasksFromDir } from "../../../suites/typescript-edit/tasks";

const FIXTURE_FILE_1 = `
export function add(a: number, b: number): number {
	const result = a + b;
	if (result > 100) {
		return 100;
	}
	return result;
}

export function subtract(a: number, b: number): number {
	if (a === b) {
		return 0;
	}
	return a - b;
}

export function multiply(a: number, b: number): number {
	let total = 0;
	for (let i = 0; i < b; i++) {
		total += a;
	}
	return total;
}

export function divide(a: number, b: number): number {
	if (b === 0) {
		throw new Error("Division by zero");
	}
	return a / b;
}
`;

const FIXTURE_FILE_2 = `
import { add, subtract } from "./math";

export interface UserConfig {
	name: string;
	retries: number;
	enabled: boolean;
	timeoutMs: number;
}

export class ConfigManager {
	#config: UserConfig;

	constructor(initial: UserConfig) {
		this.#config = initial;
	}

	isEnabled(): boolean {
		return this.#config.enabled === true;
	}

	getRetryCount(): number {
		if (this.#config.retries <= 0) {
			return 1;
		}
		return this.#config.retries;
	}

	updateTimeout(factor: number): number {
		const newTimeout = add(this.#config.timeoutMs, factor);
		if (newTimeout > 5000) {
			return 5000;
		}
		return newTimeout;
	}
}
`;

/**
 * Each case below generates and formats real TypeScript twice, and the bucket runs four
 * files at a time under `--smol`. That work took a contended runner past the 5s default and
 * reported determinism as a timeout, so the bound is stated: still an upper bound that fails
 * a hang, just one the work fits inside.
 */
const GENERATION_TIMEOUT_MS = 30_000;

describe("generation reproducibility and metadata recording", () => {
	it("pins source repo URL and a valid 40-character commit SHA constant", () => {
		expect(DEFAULT_SOURCE_REPO_URL).toBe("https://github.com/badlogic/pi-mono.git");
		expect(DEFAULT_SOURCE_COMMIT_SHA).toMatch(/^[0-9a-f]{40}$/);
		expect(DEFAULT_SOURCE_COMMIT_SHA).toBe("8fa7eebd235355522c8104166b4f1f959b4e2f10");
	});

	it(
		"produces byte-identical case selection and content twice with the same seed",
		async () => {
			const tempDir = await TempDir.create("@evals-reproduce-");
			try {
				const file1Path = path.join(tempDir.path(), "math.ts");
				const file2Path = path.join(tempDir.path(), "config.ts");
				await fs.writeFile(file1Path, FIXTURE_FILE_1);
				await fs.writeFile(file2Path, FIXTURE_FILE_2);

				const fileEntries = await filterFiles([file1Path, file2Path], 10, 500);
				expect(fileEntries.length).toBe(2);

				const seed = 4242;
				const runA = await generateCases({
					files: fileEntries,
					mutations: allMutations().slice(0, 5),
					seed,
					countPerType: 2,
					difficulties: ["easy", "medium"],
					sourceRepoUrl: DEFAULT_SOURCE_REPO_URL,
					sourceCommitSha: DEFAULT_SOURCE_COMMIT_SHA,
				});

				const runB = await generateCases({
					files: fileEntries,
					mutations: allMutations().slice(0, 5),
					seed,
					countPerType: 2,
					difficulties: ["easy", "medium"],
					sourceRepoUrl: DEFAULT_SOURCE_REPO_URL,
					sourceCommitSha: DEFAULT_SOURCE_COMMIT_SHA,
				});

				expect(runA.length).toBeGreaterThan(0);
				expect(runA.length).toBe(runB.length);

				for (let i = 0; i < runA.length; i++) {
					const caseA = runA[i];
					const caseB = runB[i];
					expect(caseA.caseId).toBe(caseB.caseId);
					expect(caseA.filePath).toBe(caseB.filePath);
					expect(caseA.difficulty).toBe(caseB.difficulty);
					expect(caseA.difficultyScore).toBe(caseB.difficultyScore);
					expect(caseA.formattedMutatedContent).toBe(caseB.formattedMutatedContent);
					expect(caseA.formattedOriginalContent).toBe(caseB.formattedOriginalContent);
					expect(caseA.finalInfo).toEqual(caseB.finalInfo);
					expect(caseA.seed).toBe(seed);
					expect(caseB.seed).toBe(seed);
				}
			} finally {
				await tempDir.remove();
			}
		},
		GENERATION_TIMEOUT_MS,
	);

	it(
		"produces a different case selection when given a different seed",
		async () => {
			const tempDir = await TempDir.create("@evals-diff-seed-");
			try {
				const file1Path = path.join(tempDir.path(), "math.ts");
				const file2Path = path.join(tempDir.path(), "config.ts");
				await fs.writeFile(file1Path, FIXTURE_FILE_1);
				await fs.writeFile(file2Path, FIXTURE_FILE_2);

				const fileEntries = await filterFiles([file1Path, file2Path], 10, 500);
				expect(fileEntries.length).toBe(2);

				const run1 = await generateCases({
					files: fileEntries,
					mutations: allMutations(),
					seed: 100,
					countPerType: 2,
				});

				const run2 = await generateCases({
					files: fileEntries,
					mutations: allMutations(),
					seed: 99999,
					countPerType: 2,
				});

				// At least one case should differ in chosen file or mutated content due to different RNG trajectory
				const identicalCases = run1.filter((c1, i) => {
					const c2 = run2[i];
					return c2 && c1.filePath === c2.filePath && c1.formattedMutatedContent === c2.formattedMutatedContent;
				});
				expect(identicalCases.length).toBeLessThan(run1.length);
			} finally {
				await tempDir.remove();
			}
		},
		GENERATION_TIMEOUT_MS,
	);

	it(
		"records seed, sourceRepoUrl, and sourceCommitSha in generated metadata and loadTasksFromDir recovers them",
		async () => {
			const tempDir = await TempDir.create("@evals-meta-");
			try {
				const filePath = path.join(tempDir.path(), "math.ts");
				await fs.writeFile(filePath, FIXTURE_FILE_1);
				const fileEntries = await filterFiles([filePath], 10, 500);

				const testSeed = 777;
				const cases = await generateCases({
					files: fileEntries,
					mutations: allMutations().slice(0, 1),
					seed: testSeed,
					countPerType: 1,
					difficulties: ["easy"],
					sourceRepoUrl: DEFAULT_SOURCE_REPO_URL,
					sourceCommitSha: DEFAULT_SOURCE_COMMIT_SHA,
				});

				expect(cases.length).toBe(1);
				const caseResult = cases[0];
				const tarEntries = await buildCaseEntries(caseResult, tempDir.path());

				// Write entries to a fixtures directory and load with loadTasksFromDir
				const fixturesDir = tempDir.join("fixtures");
				for (const entry of tarEntries) {
					const relativePath = entry.name.replace(/^fixtures\//, "");
					const fullPath = path.join(fixturesDir, relativePath);
					await fs.mkdir(path.dirname(fullPath), { recursive: true });
					await fs.writeFile(fullPath, entry.content);
				}

				// Check metadata.json content directly
				const metadataRaw = tarEntries.find(e => e.name.endsWith("metadata.json"));
				expect(metadataRaw).toBeDefined();
				const parsedJson = JSON.parse(metadataRaw!.content);
				expect(parsedJson.seed).toBe(testSeed);
				expect(parsedJson.source_repo_url).toBe(DEFAULT_SOURCE_REPO_URL);
				expect(parsedJson.source_commit_sha).toBe(DEFAULT_SOURCE_COMMIT_SHA);
				expect(parsedJson.sourceRepoUrl).toBe(DEFAULT_SOURCE_REPO_URL);
				expect(parsedJson.sourceCommitSha).toBe(DEFAULT_SOURCE_COMMIT_SHA);

				// Check loadTasksFromDir recovers them into TaskMetadata
				const loadedTasks = await loadTasksFromDir(fixturesDir);
				expect(loadedTasks.length).toBe(1);
				const loadedMetadata = loadedTasks[0].metadata;
				expect(loadedMetadata).toBeDefined();
				expect(loadedMetadata?.seed).toBe(testSeed);
				expect(loadedMetadata?.sourceRepoUrl).toBe(DEFAULT_SOURCE_REPO_URL);
				expect(loadedMetadata?.sourceCommitSha).toBe(DEFAULT_SOURCE_COMMIT_SHA);
			} finally {
				await tempDir.remove();
			}
		},
		GENERATION_TIMEOUT_MS,
	);
});
