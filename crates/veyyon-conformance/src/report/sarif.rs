//! SARIF 2.1.0, which is what code scanning turns into annotations.
//!
//! A SARIF run says which tool produced it, which rules it knows about, and
//! which results it found. The mapping this crate uses:
//!
//! - **A rule is a contract**, not a case. A contract has thousands of cases
//!   and a scanner that declared one rule per case would publish a quarter of a
//!   million rules nobody can read.
//! - **A result is a failure.** A passing case produces nothing, which is what
//!   SARIF means by a result: a passing run is an empty `results` array with
//!   `executionSuccessful` true, not a list of successes.
//! - **The fingerprint is the case id.** That is what lets a scanner recognize
//!   the same failing case across runs without matching on message text, which
//!   moves whenever a mismatch is reworded.
//!
//! The structs are typed rather than built as free-form JSON so a field cannot
//! be misspelled into invisibility: a scanner ignores what it does not
//! recognize, and a typo in `partialFingerprints` is silently accepted and
//! silently useless.

use std::collections::BTreeMap;

use serde::Serialize;

use super::{RunReport, TOOL_NAME};

const SCHEMA: &str = "https://json.schemastore.org/sarif-2.1.0.json";
const SARIF_VERSION: &str = "2.1.0";
const INFORMATION_URI: &str = "https://github.com/santhreal/veyyon";

#[derive(Debug, Serialize)]
struct Sarif<'a> {
	#[serde(rename = "$schema")]
	schema:  &'static str,
	version: &'static str,
	runs:    [Run<'a>; 1],
}

#[derive(Debug, Serialize)]
struct Run<'a> {
	tool:        Tool<'a>,
	invocations: [Invocation; 1],
	results:     Vec<SarifResult<'a>>,
	properties:  RunProperties<'a>,
}

#[derive(Debug, Serialize)]
struct Tool<'a> {
	driver: Driver<'a>,
}

#[derive(Debug, Serialize)]
struct Driver<'a> {
	name:            &'static str,
	version:         &'static str,
	#[serde(rename = "informationUri")]
	information_uri: &'static str,
	rules:           Vec<Rule<'a>>,
}

#[derive(Debug, Serialize)]
struct Rule<'a> {
	id:                &'a str,
	#[serde(rename = "shortDescription")]
	short_description: Text<'a>,
}

#[derive(Debug, Serialize)]
struct Invocation {
	#[serde(rename = "executionSuccessful")]
	execution_successful: bool,
}

#[derive(Debug, Serialize)]
struct SarifResult<'a> {
	#[serde(rename = "ruleId")]
	rule_id:              &'a str,
	level:                &'static str,
	message:              Text<'a>,
	#[serde(rename = "partialFingerprints")]
	partial_fingerprints: BTreeMap<&'static str, &'a str>,
	properties:           ResultProperties<'a>,
}

#[derive(Debug, Serialize)]
struct ResultProperties<'a> {
	subsystem:  &'a str,
	#[serde(rename = "elapsedMs")]
	elapsed_ms: u64,
}

#[derive(Debug, Serialize)]
struct RunProperties<'a> {
	shard:           &'a str,
	#[serde(rename = "corpusDigest")]
	corpus_digest:   &'a str,
	#[serde(rename = "artifactDigest", skip_serializing_if = "Option::is_none")]
	artifact_digest: Option<&'a str>,
	total:           usize,
	failures:        usize,
}

/// The report as pretty-printed SARIF.
///
/// Pretty rather than compact because the file is committed by CI and read in a
/// diff; a single-line SARIF document is a diff nobody can review.
#[must_use]
pub fn render(report: &RunReport) -> String {
	let ordered = report.ordered();
	let failures: Vec<_> = ordered
		.iter()
		.copied()
		.filter(|result| !result.passed())
		.collect();

	// Rules are the contracts that actually failed, deduplicated and in report
	// order. Declaring every contract in the corpus would publish rules for
	// behaviour this shard never executed.
	let mut rules: Vec<Rule<'_>> = Vec::new();
	for result in &failures {
		if rules.iter().any(|rule| rule.id == result.contract_id) {
			continue;
		}
		rules.push(Rule {
			id:                &result.contract_id,
			short_description: Text { text: &result.contract_id },
		});
	}

	let messages: Vec<String> = failures
		.iter()
		.map(|result| result.failure_text())
		.collect();
	let results: Vec<SarifResult<'_>> = failures
		.iter()
		.zip(&messages)
		.map(|(result, message)| SarifResult {
			rule_id:              &result.contract_id,
			level:                "error",
			message:              Text { text: message },
			partial_fingerprints: BTreeMap::from([("caseId", result.case_id.as_str())]),
			properties:           ResultProperties {
				subsystem:  result.subsystem.as_str(),
				elapsed_ms: result.elapsed_ms,
			},
		})
		.collect();

	let document = Sarif {
		schema:  SCHEMA,
		version: SARIF_VERSION,
		runs:    [Run {
			tool: Tool {
				driver: Driver {
					name: TOOL_NAME,
					version: env!("CARGO_PKG_VERSION"),
					information_uri: INFORMATION_URI,
					rules,
				},
			},
			// SARIF's `executionSuccessful` is about the ANALYSIS, not the
			// findings: a scanner that read it as pass/fail would treat every
			// shard with a finding as a broken tool run. Findings live in
			// `results`. A shard that executed no case did not analyse
			// anything, and that is the one case where this is false.
			invocations: [Invocation { execution_successful: !report.results.is_empty() }],
			results,
			properties: RunProperties {
				shard:           &report.shard,
				corpus_digest:   &report.corpus_digest,
				artifact_digest: report.artifact_digest.as_deref(),
				total:           report.total(),
				failures:        report.failures(),
			},
		}],
	};
	serde_json::to_string_pretty(&document).expect("a report is plain data and always serializes")
}

#[derive(Debug, Serialize)]
struct Text<'a> {
	text: &'a str,
}
