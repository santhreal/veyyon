/**
 * Recording what the terminal actually did.
 *
 * THE RULE THIS FILE ENFORCES: a scenario that did not run is NOT a pass. Every scenario must
 * end in exactly one of PASS, FAIL or NOT RUN, and NOT RUN carries a reason. A harness that
 * silently skips a scenario when a precondition is missing is worse than no harness, because it
 * reports green over an untested path -- which is how the defect this run is chasing shipped.
 *
 * WHAT A FAILURE IS ALLOWED TO SAY. Scenarios store real generated credential values in a real
 * vault. A failure message may name the SECRET NAME, the placeholder, the expected phrase and
 * the capture path, and may never contain a stored value. {@link Recorder.record} sweeps every
 * message and detail string for every seeded value and replaces it, so a scenario author cannot
 * accidentally turn a detected leak into a printed one.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type Verdict = "PASS" | "FAIL" | "NOT RUN";

/** One recorded scenario. */
export interface ScenarioResult {
	group: string;
	name: string;
	verdict: Verdict;
	/** What the terminal did, in one line. */
	observed: string;
	/** Reason, for FAIL and NOT RUN. */
	detail?: string;
	/** Relative path of the raw terminal capture, when the scenario produced one. */
	capture?: string;
}

/** Collects results, writes captures, and prints each verdict the moment it is known. */
export class Recorder {
	readonly results: ScenarioResult[] = [];
	readonly #captureDir: string;
	readonly #redactions: string[] = [];
	#captureSeq = 0;
	#group = "ungrouped";

	constructor(captureDir: string) {
		this.#captureDir = captureDir;
		fs.mkdirSync(captureDir, { recursive: true });
	}

	/** Register a generated value that must never appear in a report line. */
	protect(...values: string[]): void {
		for (const value of values) if (value.length >= 8) this.#redactions.push(value);
	}

	/** Replace any protected value with a marker, so a leak is reported without being reprinted. */
	redact(text: string): string {
		let out = text;
		for (const value of this.#redactions) out = out.split(value).join("<REDACTED-SEEDED-VALUE>");
		return out;
	}

	/** Scenarios recorded from here on belong to `group`. */
	group(name: string): void {
		this.#group = name;
		process.stdout.write(`\n-- ${name} --\n`);
	}

	/** Write a raw terminal capture next to the report and return its relative path. */
	writeCapture(name: string, raw: string): string {
		this.#captureSeq += 1;
		const file = `${String(this.#captureSeq).padStart(3, "0")}-${name.replace(/[^a-z0-9._-]+/gi, "_")}.ansi`;
		fs.writeFileSync(path.join(this.#captureDir, file), raw, { mode: 0o600 });
		return path.join(path.basename(this.#captureDir), file);
	}

	/** Record one verdict and print it immediately, so a long run streams its failures. */
	record(result: Omit<ScenarioResult, "group">): void {
		const entry: ScenarioResult = {
			group: this.#group,
			...result,
			observed: this.redact(result.observed),
			detail: result.detail === undefined ? undefined : this.redact(result.detail),
		};
		this.results.push(entry);
		const marker = entry.verdict === "PASS" ? "PASS   " : entry.verdict === "FAIL" ? "FAIL   " : "NOT RUN";
		process.stdout.write(`${marker} ${entry.name}\n`);
		process.stdout.write(`        observed: ${entry.observed}\n`);
		if (entry.detail)
			process.stdout.write(`        ${entry.verdict === "FAIL" ? "why" : "reason"}: ${entry.detail}\n`);
		if (entry.capture) process.stdout.write(`        capture: ${entry.capture}\n`);
	}

	/** Convenience: PASS when `ok`, FAIL otherwise, with the observation either way. */
	check(name: string, ok: boolean, observed: string, detail?: string, capture?: string): void {
		this.record({ name, verdict: ok ? "PASS" : "FAIL", observed, detail: ok ? undefined : detail, capture });
	}

	get failures(): ScenarioResult[] {
		return this.results.filter(r => r.verdict === "FAIL");
	}

	get notRun(): ScenarioResult[] {
		return this.results.filter(r => r.verdict === "NOT RUN");
	}

	/** Markdown report: every scenario, what the terminal did, and the verdict. */
	renderMarkdown(meta: { startedAt: string; model: string; durationMs: number; root: string }): string {
		const lines: string[] = [];
		const passes = this.results.filter(r => r.verdict === "PASS").length;
		lines.push("# veyyon `/secret` real-terminal stress report", "");
		lines.push(`- run started: ${meta.startedAt}`);
		lines.push(`- duration: ${(meta.durationMs / 1000).toFixed(1)}s`);
		lines.push(`- session model: ${meta.model}`);
		lines.push(`- isolated root: \`${meta.root}\``);
		lines.push(
			`- **${passes} PASS, ${this.failures.length} FAIL, ${this.notRun.length} NOT RUN** across ${this.results.length} scenarios`,
			"",
		);
		if (this.failures.length > 0) {
			lines.push("## Failures", "");
			for (const failure of this.failures) {
				lines.push(`### ${failure.name}`, "");
				lines.push(`- group: ${failure.group}`);
				lines.push(`- terminal did: ${failure.observed}`);
				lines.push(`- why it is a failure: ${failure.detail ?? "(none recorded)"}`);
				if (failure.capture) lines.push(`- raw capture: \`${failure.capture}\``);
				lines.push("");
			}
		}
		lines.push("## Every scenario", "");
		let current = "";
		for (const result of this.results) {
			if (result.group !== current) {
				current = result.group;
				lines.push(
					"",
					`### ${current}`,
					"",
					"| scenario | verdict | what the terminal did |",
					"| --- | --- | --- |",
				);
			}
			const observed = result.observed.replace(/\|/g, "\\|");
			const detail = result.detail ? ` <br> _${result.detail.replace(/\|/g, "\\|")}_` : "";
			lines.push(`| ${result.name} | ${result.verdict} | ${observed}${detail} |`);
		}
		lines.push("");
		return lines.join("\n");
	}
}
