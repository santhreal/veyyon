/**
 * Verify a capture scene without recording it.
 *
 * A scene under `proof/scenes/` waits for strings to appear on a real screen. When one of those
 * strings no longer exists — a header that dropped its count, a status line that moved into a
 * details panel — the scene does not fail fast: it burns its whole timeout, marks the shot missed,
 * and publishes a take with the previous run's frame under that name. A twenty-five minute take is
 * the wrong place to discover a renamed label, so every needle is checked against the sources that
 * can legitimately produce it before anything is recorded.
 *
 * Run it:
 *
 *   bun scripts/verify-scene.ts demo-hd
 *   bun scripts/verify-scene.ts --all
 *
 * `scripts/demos/record-hd-demo.sh` runs it as a preflight, so a real take cannot start against a
 * scene whose guards no longer match the product.
 *
 * A needle is accepted when it appears in the prompt the scene submits, in the coding agent's own
 * source, in the sandbox seed (`proof/docker/seed-demo.sh`, whose seeded tests pin what the built
 * program prints), or in the scene itself — the scene types some of its own strings. Anything else
 * needs a line in the scene saying where it comes from:
 *
 *   # needle-source: SOME LABEL -- printed by the compiled binary's banner
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCENES_DIR = path.join(REPO_ROOT, "proof", "scenes");
const AGENT_SRC = path.join(REPO_ROOT, "packages", "coding-agent", "src");
const DOCKER_DIR = path.join(REPO_ROOT, "proof", "docker");

/** Scene files that are shared helpers or probes rather than a recorded scene. */
export const SCENE_HELPERS = ["backend-wayland.sh", "backend-x11.sh", "lib.sh"] as const;
const NOT_A_SCENE = new Set<string>(SCENE_HELPERS);

export interface Finding {
	scene: string;
	problem: string;
}

async function readIfPresent(file: string): Promise<string> {
	try {
		return await fs.readFile(file, "utf8");
	} catch {
		return "";
	}
}

/**
 * Every seeder under `proof/docker`, concatenated.
 *
 * A scene reads what a seeder wrote, so a needle naming seeded content — a
 * skill's own name, a heading in a seeded context file — resolves here. It was
 * `seed-demo.sh` alone while that was the only seeder; a scene whose fixture came
 * from any of the others had to carry a `needle-source` line for content this
 * repository writes two directories away.
 */
async function seedText(): Promise<string> {
	const entries = await fs.readdir(DOCKER_DIR).catch(() => []);
	const seeds = entries.filter(entry => entry.startsWith("seed-")).sort();
	const parts = await Promise.all(seeds.map(entry => readIfPresent(path.join(DOCKER_DIR, entry))));
	return parts.join("\n");
}

/** Every `.ts`, `.tsx` and `.md` byte under the coding agent's source, concatenated once. */
export async function agentSourceText(): Promise<string> {
	const parts: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			if (!/\.(ts|tsx|md)$/.test(entry.name)) continue;
			parts.push(await fs.readFile(full, "utf8"));
		}
	};
	await walk(AGENT_SRC);
	return parts.join("\n");
}

/** Prompt files the scene reads, resolved to repo paths. */
function promptFiles(scene: string): string[] {
	const found = new Set<string>();
	for (const match of scene.matchAll(/(?:\/repo\/)?(proof\/prompts\/[\w.-]+\.md)/g)) {
		found.add(path.join(REPO_ROOT, match[1]));
	}
	return [...found];
}

/** Needles the scene declares a source for in a comment. */
function declaredNeedles(scene: string): Set<string> {
	const declared = new Set<string>();
	for (const match of scene.matchAll(/^#\s*needle-source:\s*(.+?)\s*--\s*.+$/gm)) {
		declared.add(match[1]);
	}
	return declared;
}

/** Every guard form a scene may wait on, and the one it may not. */
const GUARD_FORMS = ["expect_screen", "expect_model_screen", "wait_for_screen"] as const;

function verifyTimeouts(scene: string, findings: Finding[], name: string): void {
	for (const form of GUARD_FORMS) {
		for (const match of scene.matchAll(new RegExp(`${form}\\s+("[^"]*"|\\S+)(\\s+\\S+)?`, "g"))) {
			const timeout = match[2]?.trim();
			if (timeout && /^\d+$/.test(timeout)) continue;
			if (timeout && /^"?\$\{?\w/.test(timeout)) continue;
			findings.push({
				scene: name,
				problem: `${form} ${match[1]} has no numeric timeout, so a missing string waits forever`,
			});
		}
	}
}

/**
 * A scene classifies every guard it waits on.
 *
 * `wait_for_screen` returns and lets the scene walk on to the next guard, so a miss used
 * to cost a ceiling and then hand the next guard its own: one take waited out 1200s on a
 * subagent name and 1800s on an edit block, ran past an hour, and published two
 * byte-identical frames under two names. `expect_screen` is for output the product prints
 * for what the scene already did, `expect_model_screen` for output only a model choice
 * produces, and both abandon the take at the first miss with the reason. A bare
 * `wait_for_screen` in a scene says which of the two it is nowhere, so it is a finding —
 * `lib.sh` is a helper and is where the two wrappers call it.
 */
function verifyGuardKinds(scene: string, findings: Finding[], name: string): void {
	for (const match of scene.matchAll(/^[^#\n]*\bwait_for_screen\s+("[^"]*"|\S+)/gm)) {
		findings.push({
			scene: name,
			problem: `waits on ${match[1]} with a bare wait_for_screen, which runs its ceiling out and continues — use expect_screen for product output or expect_model_screen for a model choice`,
		});
	}
}

function verifyShotNames(scene: string, findings: Finding[], name: string): void {
	const seen = new Set<string>();
	for (const match of scene.matchAll(/^\s*shot\s+([\w.-]+)/gm)) {
		const shot = match[1];
		if (seen.has(shot)) {
			findings.push({ scene: name, problem: `two shots are named "${shot}", so one overwrites the other` });
		}
		seen.add(shot);
	}
}

function verifyMissedIsFatal(scene: string, findings: Finding[], name: string): void {
	if (!scene.includes("MISSED")) return;
	if (/if\s+\[\s+-n\s+"\$\{MISSED:-\}"\s+\]/.test(scene)) return;
	findings.push({
		scene: name,
		problem: "the scene collects MISSED but never fails on it, so a take publishes with shots it never got",
	});
}

/**
 * The text the scene itself puts on screen. Only what it TYPES counts: the whole file cannot be a
 * source, or every guard would prove itself by being written down.
 */
function typedByScene(scene: string): string {
	const typed: string[] = [];
	for (const match of scene.matchAll(/(?:submit|slash|type|type_line|type_visible|type_human)\s+"([^"]*)"/g)) {
		typed.push(match[1]);
	}
	return typed.join("\n");
}

/** Everything a scene is checked against, so the check itself reads no files. */
export interface SceneSources {
	/** Scene file name, used in findings. */
	name: string;
	/** The scene's own text. */
	scene: string;
	/** Prompt texts the scene submits, keyed by the path it named. An absent file is `null`. */
	prompts: Array<{ path: string; text: string | null }>;
	/** The coding agent's own source, concatenated. */
	agentText: string;
	/** The sandbox seed script, whose seeded tests pin what the built program prints. */
	seed: string;
}

function verifyNeedles(sources: SceneSources, findings: Finding[]): void {
	const { name, scene } = sources;
	for (const prompt of sources.prompts) {
		if (prompt.text === null) {
			findings.push({ scene: name, problem: `submits ${prompt.path}, which does not exist` });
		}
	}
	const declared = declaredNeedles(scene);
	const haystacks = [
		...sources.prompts.map(prompt => prompt.text ?? ""),
		sources.agentText,
		sources.seed,
		typedByScene(scene),
	];
	const needles = new Set<string>();
	for (const match of scene.matchAll(
		/(?:expect_screen|expect_model_screen|wait_for_screen|screen_has)\s+(?:"([^"]*)"|'([^']*)')/g,
	)) {
		const needle = match[1] ?? match[2] ?? "";
		// A needle built from a shell variable is checked at run time, not here.
		if (needle === "" || needle.includes("$")) continue;
		needles.add(needle);
	}
	for (const needle of [...needles].sort()) {
		if (declared.has(needle)) continue;
		const trimmed = needle.replace(/[:\s]+$/, "");
		if (haystacks.some(text => text.includes(needle) || (trimmed !== "" && text.includes(trimmed)))) continue;
		findings.push({
			scene: name,
			problem: `waits for "${needle}", which no prompt, source file, seed or scene line produces — rename the guard or declare it with "# needle-source: ${needle} -- <where it comes from>"`,
		});
	}
}

/** Every finding for one scene, from text alone. The CLI below supplies the text. */
export function verifySceneSources(sources: SceneSources): Finding[] {
	const findings: Finding[] = [];
	verifyTimeouts(sources.scene, findings, sources.name);
	verifyShotNames(sources.scene, findings, sources.name);
	verifyMissedIsFatal(sources.scene, findings, sources.name);
	verifyGuardKinds(sources.scene, findings, sources.name);
	verifyNeedles(sources, findings);
	return findings;
}

async function verifyScene(file: string, agentText: string, seed: string): Promise<Finding[]> {
	const name = path.basename(file);
	const scene = await readIfPresent(file);
	if (scene === "") return [{ scene: name, problem: "scene file is missing or empty" }];
	try {
		await run("bash", ["-n", file]);
	} catch (error) {
		return [{ scene: name, problem: `does not parse: ${error instanceof Error ? error.message : error}` }];
	}
	const prompts = await Promise.all(
		promptFiles(scene).map(async promptPath => {
			const text = await readIfPresent(promptPath);
			return { path: path.relative(REPO_ROOT, promptPath), text: text === "" ? null : text };
		}),
	);
	return verifySceneSources({ name, scene, prompts, agentText, seed });
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const all = args.includes("--all");
	const named = args.filter(arg => !arg.startsWith("--"));
	if (!all && named.length === 0) {
		process.stderr.write("usage: bun scripts/verify-scene.ts <scene>... | --all\n");
		return 2;
	}
	let files: string[];
	if (all) {
		const entries = await fs.readdir(SCENES_DIR);
		files = entries
			.filter(entry => entry.endsWith(".sh") && !NOT_A_SCENE.has(entry))
			.sort()
			.map(entry => path.join(SCENES_DIR, entry));
	} else {
		files = named.map(arg => path.join(SCENES_DIR, arg.endsWith(".sh") ? arg : `${arg}.sh`));
	}
	const agentText = await agentSourceText();
	const seed = await seedText();
	const findings: Finding[] = [];
	for (const file of files) findings.push(...(await verifyScene(file, agentText, seed)));
	for (const finding of findings) process.stdout.write(`${finding.scene}: ${finding.problem}\n`);
	process.stdout.write(
		findings.length === 0
			? `${files.length} scene(s) verified: every guard resolves to something that produces it\n`
			: `${findings.length} finding(s) across ${files.length} scene(s)\n`,
	);
	return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) {
	process.exit(await main());
}
