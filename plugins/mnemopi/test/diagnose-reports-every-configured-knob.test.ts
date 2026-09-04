/**
 * `mnemopi diagnose` reports every `MNEMOPI_*` variable the operator has set, and never
 * prints a credential.
 *
 * WHY THIS EXISTS. mnemopi reads around sixty environment variables. `diagnose` reported
 * two of them, `MNEMOPI_DATA_DIR` and `MNEMOPI_VEC_TYPE`, and reported those only as "set"
 * or "unset" with no value. That is the wrong shape for the job diagnose exists to do. An
 * operator who set `MNEMOPI_SHMR_SIMILARITY_THRESHOLD` and saw no change in clustering had
 * nowhere to look: the variable did not appear, so they could not tell a knob that does
 * nothing from a knob they spelled wrong from a knob whose value failed to parse and fell
 * back to the default.
 *
 * That last case is the one that matters most. `MNEMOPI_TIER2_DAYS=thirty` parses to
 * nothing and falls back to 30, correctly and by design, but silently from where the
 * operator is standing. Printing the raw value next to the name is what makes it visible.
 *
 * WHY THE LIST IS NOT A LIST. The names are enumerated from the environment rather than
 * declared here, because a declared list would be a second copy of every name `config.ts`
 * already spells, and it would report only the variables someone remembered to add. It also
 * means a misspelled name shows up, which is exactly the case that otherwise looks
 * identical to a broken feature.
 *
 * WHY REDACTION IS PATTERN-BASED. `MNEMOPI_LLM_API_KEY` is a real variable and diagnose
 * output gets pasted into bug reports. Matching a pattern rather than that one name means a
 * credential added later is redacted by default instead of by someone remembering to come
 * back and add it.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { inspectDatabase } from "@veyyon/mnemopi/diagnose";

/** Diagnose against an in-memory database, with a controlled environment. */
function diagnoseWith(env: Record<string, string | undefined>): ReturnType<typeof inspectDatabase> {
	const db = new Database(":memory:");
	try {
		return inspectDatabase({ db, env, dbPath: ":memory:" });
	} finally {
		db.close();
	}
}

/**
 * The variable rows of the `env` category, as name to detail. The category also carries
 * `bun_version` and `platform`, which are runtime facts rather than variables, so the
 * `MNEMOPI_` prefix is what separates what this suite is about from what it is not.
 */
function envRows(env: Record<string, string | undefined>): Record<string, string> {
	const rows: Record<string, string> = {};
	for (const entry of diagnoseWith(env).entries) {
		if (entry.category === "env" && entry.check.startsWith("MNEMOPI_")) rows[entry.check] = entry.detail ?? "";
	}
	return rows;
}

describe("the env report", () => {
	/**
	 * NON-VACUITY. Every assertion below is about which rows appear, which an empty report
	 * would satisfy for the negative cases. The two always-reported rows are present even
	 * with nothing set, so the report is known to be running.
	 */
	it("always reports the two headline knobs, set or not", () => {
		const rows = envRows({});

		expect(Object.keys(rows)).toContain("MNEMOPI_DATA_DIR");
		expect(Object.keys(rows)).toContain("MNEMOPI_VEC_TYPE");
	});

	/**
	 * "unset" is the answer an operator is usually looking for when the database turned up
	 * somewhere unexpected, so those two rows carry a status rather than vanishing.
	 */
	it("marks an absent headline knob unset", () => {
		const statuses = Object.fromEntries(
			diagnoseWith({})
				.entries.filter(entry => entry.category === "env" && entry.check.startsWith("MNEMOPI_"))
				.map(entry => [entry.check, entry.status]),
		);

		expect(statuses.MNEMOPI_DATA_DIR).toBe("unset");
		expect(statuses.MNEMOPI_VEC_TYPE).toBe("unset");
	});

	/**
	 * THE regression. A knob outside the two hard-coded names used to be invisible. It now
	 * appears with the value the operator actually set, which is what turns "this setting
	 * does nothing" into a five-second diagnosis.
	 */
	it("reports a knob that is set, with its value", () => {
		const rows = envRows({ MNEMOPI_TIER2_DAYS: "7" });

		expect(rows.MNEMOPI_TIER2_DAYS).toBe("7");
	});

	/**
	 * The value is reported RAW, not as the parsed result. A value that fails to parse
	 * falls back to the default by design, and printing the fallback would hide exactly the
	 * mistake the operator needs to see.
	 */
	it("reports an unparseable value as written rather than as its fallback", () => {
		const rows = envRows({ MNEMOPI_TIER2_DAYS: "thirty" });

		expect(rows.MNEMOPI_TIER2_DAYS).toBe("thirty");
		expect(rows.MNEMOPI_TIER2_DAYS).not.toBe("30");
	});

	/** Several knobs at once, so the report is a sweep and not a single lucky lookup. */
	it("reports every knob that is set", () => {
		const rows = envRows({
			MNEMOPI_SHMR_SIMILARITY_THRESHOLD: "0.42",
			MNEMOPI_SP_MAX: "250",
			MNEMOPI_VEC_WEIGHT: "0.8",
		});

		expect(rows.MNEMOPI_SHMR_SIMILARITY_THRESHOLD).toBe("0.42");
		expect(rows.MNEMOPI_SP_MAX).toBe("250");
		expect(rows.MNEMOPI_VEC_WEIGHT).toBe("0.8");
	});

	/**
	 * A misspelled name is reported too. This is deliberate: `MNEMOPI_TIER2_DAY` set to 7
	 * and `MNEMOPI_TIER2_DAYS` unset look identical from the outside, and seeing the typo
	 * in the report is the whole diagnosis.
	 */
	it("reports a name mnemopi does not read, so a typo is visible", () => {
		const rows = envRows({ MNEMOPI_TIER2_DAY: "7" });

		expect(rows.MNEMOPI_TIER2_DAY).toBe("7");
	});

	/** A variable belonging to something else is not mnemopi's to report. */
	it("ignores variables outside the MNEMOPI_ prefix", () => {
		const rows = envRows({ PATH: "/usr/bin", HOME: "/home/someone", OPENAI_API_KEY: "sk-real" });

		expect(Object.keys(rows)).toEqual(["MNEMOPI_DATA_DIR", "MNEMOPI_VEC_TYPE"]);
	});

	/** An empty string is not a setting. Reporting it would be noise on every row. */
	it("does not report a knob set to an empty string", () => {
		const rows = envRows({ MNEMOPI_TIER2_DAYS: "" });

		expect(Object.keys(rows)).not.toContain("MNEMOPI_TIER2_DAYS");
	});

	/** Rows come back in a stable order, so two diagnose runs diff cleanly. */
	it("reports the knobs in name order", () => {
		const names = Object.keys(
			envRows({ MNEMOPI_VEC_WEIGHT: "1", MNEMOPI_SP_MAX: "2", MNEMOPI_FTS_WEIGHT: "3" }),
		).filter(name => name !== "MNEMOPI_DATA_DIR" && name !== "MNEMOPI_VEC_TYPE");

		expect(names).toEqual(["MNEMOPI_FTS_WEIGHT", "MNEMOPI_SP_MAX", "MNEMOPI_VEC_WEIGHT"]);
	});
});

describe("a credential in the environment", () => {
	/**
	 * THE thing that must never regress. `MNEMOPI_LLM_API_KEY` is a real variable and
	 * diagnose output is what people paste into bug reports. The name is reported so the
	 * operator can confirm it is configured; the value never is.
	 */
	it("is reported by name and never by value", () => {
		const rows = envRows({ MNEMOPI_LLM_API_KEY: "sk-a-real-looking-secret" });

		expect(rows.MNEMOPI_LLM_API_KEY).toBe("(redacted)");
	});

	/** And the secret does not leak through any other field of any other row. */
	it("does not appear anywhere in the report", () => {
		const secret = "sk-a-real-looking-secret";
		const report = JSON.stringify(diagnoseWith({ MNEMOPI_LLM_API_KEY: secret }));

		expect(report).not.toInclude(secret);
		expect(report).toInclude("MNEMOPI_LLM_API_KEY");
	});

	/**
	 * Redaction is by pattern, not by that one name, so a credential variable added later
	 * is safe on the day it is added rather than on the day someone remembers this file.
	 */
	it("is redacted for any credential-shaped name", () => {
		const rows = envRows({
			MNEMOPI_SOME_TOKEN: "tok-1",
			MNEMOPI_A_SECRET: "s-1",
			MNEMOPI_DB_PASSWORD: "p-1",
			MNEMOPI_STORED_CREDENTIAL: "c-1",
		});

		expect(rows.MNEMOPI_SOME_TOKEN).toBe("(redacted)");
		expect(rows.MNEMOPI_A_SECRET).toBe("(redacted)");
		expect(rows.MNEMOPI_DB_PASSWORD).toBe("(redacted)");
		expect(rows.MNEMOPI_STORED_CREDENTIAL).toBe("(redacted)");
	});

	/**
	 * The pattern is not so eager that it hides ordinary knobs. A report that redacts
	 * everything is as useless as one that reports nothing, so the discrimination is worth
	 * pinning in both directions.
	 */
	it("does not redact an ordinary knob", () => {
		const rows = envRows({ MNEMOPI_TIER2_DAYS: "7", MNEMOPI_SHMR_BATCH_SIZE: "50" });

		expect(rows.MNEMOPI_TIER2_DAYS).toBe("7");
		expect(rows.MNEMOPI_SHMR_BATCH_SIZE).toBe("50");
	});
});
