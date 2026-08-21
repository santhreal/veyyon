//! WHY: a report is read by machines, so every defect in one is silent. An
//! unescaped ampersand makes a `JUnit` file unparseable, which a runner reports
//! as "no tests ran" — green. A misspelled SARIF key is ignored, which a
//! scanner reports as no findings — green. A count restated instead of computed
//! drifts from the results beside it, and the report still parses.
//!
//! So the checks below parse or index what was rendered rather than eyeballing
//! it: the counts come from the results, the escaping is asserted per character
//! class, and the SARIF keys are read out of the serialized document.
//!
//! The class it closes: a report that claims a different outcome than the
//! verdicts it was built from, in either format, and a message payload that
//! breaks the file that carries it.
//!
//! WHAT IT DOES NOT CATCH: whether a real CI runner and a real code scanner
//! accept these documents. Both formats are under-specified and their consumers
//! disagree at the edges; that is proved by a run against the actual services,
//! not here.

use std::collections::BTreeMap;

use super::{CaseResult, RunReport, bundle::FailureBundle, junit, sarif, seconds};
use crate::{
	corpus::{
		ClockMode, ConformanceCase, Contract, Coverage, Environment, FixtureRef, GeneratorInfo,
		Oracle, Platform, Provenance, SCHEMA_VERSION, Stimulus, Subsystem, Target, TargetKind,
	},
	oracle::{Mismatch, Verdict},
	shrink::{Budget, ddmin},
};

fn passed(contract: &str, case: &str, subsystem: Subsystem, elapsed_ms: u64) -> CaseResult {
	CaseResult {
		case_id: case.to_owned(),
		contract_id: contract.to_owned(),
		subsystem,
		elapsed_ms,
		verdict: Verdict::Pass,
	}
}

fn failed(
	contract: &str,
	case: &str,
	subsystem: Subsystem,
	mismatches: Vec<Mismatch>,
) -> CaseResult {
	CaseResult {
		case_id: case.to_owned(),
		contract_id: contract.to_owned(),
		subsystem,
		elapsed_ms: 7,
		verdict: Verdict::Fail(mismatches),
	}
}

fn mixed() -> RunReport {
	RunReport::new("linux-x64-03", "blake3:aaaa", vec![
		passed("edit.swap.one", "blake3:c1", Subsystem::EditingHashlineEngine, 1),
		failed(
			"provider.clean-eof.complete-tool-batch",
			"blake3:c2",
			Subsystem::AiProvidersStreaming,
			vec![Mismatch::ExitCode { expected: 0, actual: Some(3) }],
		),
		failed(
			"provider.clean-eof.complete-tool-batch",
			"blake3:c3",
			Subsystem::AiProvidersStreaming,
			vec![Mismatch::DidNotTerminate { waited_ms: 2_500 }],
		),
	])
}

#[test]
fn the_counts_are_the_results() {
	let report = mixed();
	assert_eq!((report.total(), report.failures()), (3, 2));
	assert_eq!(report.elapsed_ms(), 1 + 7 + 7);
	assert!(!report.is_success());
}

#[test]
fn a_shard_that_executed_nothing_is_not_a_success() {
	// WHY: the router hands each runner a slice of the corpus. A slice that came
	// back empty means the cases were lost, and "all zero of them passed" is
	// exactly how that ships green.
	let empty = RunReport::new("linux-x64-99", "blake3:aaaa", Vec::new());
	assert!(!empty.is_success());
	let document: serde_json::Value =
		serde_json::from_str(&sarif::render(&empty)).expect("valid SARIF");
	assert_eq!(document["runs"][0]["invocations"][0]["executionSuccessful"], false);
}

#[test]
fn a_clean_shard_reports_success_with_no_findings() {
	let report = RunReport::new("linux-x64-01", "blake3:aaaa", vec![passed(
		"edit.swap.one",
		"blake3:c1",
		Subsystem::EditingHashlineEngine,
		2,
	)]);
	assert!(report.is_success());
	let document: serde_json::Value =
		serde_json::from_str(&sarif::render(&report)).expect("valid SARIF");
	assert_eq!(document["runs"][0]["invocations"][0]["executionSuccessful"], true);
	// A passing case is not a SARIF result. A scanner that received one would
	// annotate the code as if it had found something.
	assert_eq!(document["runs"][0]["results"].as_array().map(Vec::len), Some(0));
	assert_eq!(
		document["runs"][0]["tool"]["driver"]["rules"]
			.as_array()
			.map(Vec::len),
		Some(0)
	);
}

#[test]
fn two_runs_of_one_shard_render_the_same_bytes() {
	// Report order is subsystem, contract, case — not execution order — so a
	// diff of two runs shows behaviour changes and not scheduling.
	let mut shuffled = mixed();
	shuffled.results.reverse();
	assert_eq!(junit::render(&mixed()), junit::render(&shuffled));
	assert_eq!(sarif::render(&mixed()), sarif::render(&shuffled));
}

#[test]
fn junit_counts_every_level_from_the_results_below_it() {
	let xml = junit::render(&mixed());
	assert!(
		xml.contains(
			"<testsuites name=\"veyyon-conformance\" tests=\"3\" failures=\"2\" time=\"0.015\">"
		),
		"{xml}"
	);
	// Per suite, so a runner's tree adds up to the root rather than disagreeing
	// with it.
	assert!(
		xml.contains(
			"<testsuite name=\"ai-providers-streaming\" tests=\"2\" failures=\"2\" time=\"0.014\">"
		),
		"{xml}"
	);
	assert!(
		xml.contains(
			"<testsuite name=\"editing-hashline-engine\" tests=\"1\" failures=\"0\" time=\"0.001\">"
		),
		"{xml}"
	);
	// A passing case is a self-closing element: a `<failure>` with an empty
	// message is a failure to most runners.
	assert!(xml.contains("classname=\"editing-hashline-engine\" time=\"0.001\" />"), "{xml}");
	assert_eq!(xml.matches("<failure").count(), 2, "{xml}");
	assert!(xml.contains("exit code 3, expected 0"), "{xml}");
	assert!(xml.contains("did not terminate within 2500ms"), "{xml}");
}

#[test]
fn junit_escapes_every_character_that_would_break_the_file() {
	// The message is the one field carrying arbitrary text, and it lands in both
	// an attribute and element content, so one escaping table has to serve both
	// positions.
	let report = RunReport::new("shard", "blake3:aaaa", vec![failed(
		"contract & <id>",
		"blake3:c1",
		Subsystem::SecuritySandbox,
		vec![Mismatch::UnexpectedError {
			actual: "a \"quoted\" & <angled> 'value'\nwith a newline\tand a tab\u{7}".to_owned(),
		}],
	)]);
	let xml = junit::render(&report);
	assert!(!xml.contains("<angled>"), "{xml}");
	assert!(xml.contains("&amp; &lt;angled&gt;"), "{xml}");
	assert!(xml.contains("&quot;quoted&quot;"), "{xml}");
	assert!(xml.contains("&apos;value&apos;"), "{xml}");
	assert!(xml.contains("&#10;with a newline&#9;and a tab"), "{xml}");
	// A bell is not a legal XML 1.0 character in any encoded form, so it is
	// dropped rather than turned into an entity that still fails to parse.
	assert!(!xml.contains('\u{7}'), "{xml}");
	assert!(!xml.contains("&#7;"), "{xml}");
	// The contract id reaches the name attribute through the same table.
	assert!(xml.contains("name=\"contract &amp; &lt;id&gt; blake3:c1\""), "{xml}");
}

#[test]
fn sarif_names_a_rule_per_contract_and_a_result_per_failure() {
	let document: serde_json::Value =
		serde_json::from_str(&sarif::render(&mixed())).expect("valid SARIF");
	let run = &document["runs"][0];
	assert_eq!(document["version"], "2.1.0");
	assert_eq!(run["tool"]["driver"]["name"], "veyyon-conformance");
	// Two failures share one contract, so one rule and two results. A rule per
	// case would publish a quarter of a million rules for the full corpus.
	let rules = run["tool"]["driver"]["rules"].as_array().expect("rules");
	assert_eq!(rules.len(), 1);
	assert_eq!(rules[0]["id"], "provider.clean-eof.complete-tool-batch");
	let results = run["results"].as_array().expect("results");
	assert_eq!(results.len(), 2);
	for result in results {
		assert_eq!(result["ruleId"], "provider.clean-eof.complete-tool-batch");
		assert_eq!(result["level"], "error");
		assert_eq!(result["properties"]["subsystem"], "ai-providers-streaming");
	}
	// The fingerprint is what lets a scanner track one failing case across runs
	// without matching on message text.
	let fingerprints: Vec<&str> = results
		.iter()
		.map(|result| {
			result["partialFingerprints"]["caseId"]
				.as_str()
				.expect("a case id fingerprint")
		})
		.collect();
	assert_eq!(fingerprints, ["blake3:c2", "blake3:c3"]);
}

#[test]
fn sarif_carries_the_run_identity_the_corpus_refuses_to_hold() {
	// The artifact digest belongs to the run: committing it into a case would
	// invalidate the corpus on every version bump. Absent when the shard
	// launched no binary, so a direct-Rust shard does not claim one.
	let plain: serde_json::Value =
		serde_json::from_str(&sarif::render(&mixed())).expect("valid SARIF");
	let properties = &plain["runs"][0]["properties"];
	assert_eq!(properties["shard"], "linux-x64-03");
	assert_eq!(properties["corpusDigest"], "blake3:aaaa");
	assert_eq!(properties["total"], 3);
	assert_eq!(properties["failures"], 2);
	assert!(properties.get("artifactDigest").is_none(), "{properties}");

	let compiled: serde_json::Value =
		serde_json::from_str(&sarif::render(&mixed().with_artifact_digest("blake3:bin")))
			.expect("valid SARIF");
	assert_eq!(compiled["runs"][0]["properties"]["artifactDigest"], "blake3:bin");
}

#[test]
fn both_formats_report_the_same_failure_text() {
	// One `failure_text`, so a reader cannot be told two stories about one case.
	let report = mixed();
	let xml = junit::render(&report);
	let document: serde_json::Value =
		serde_json::from_str(&sarif::render(&report)).expect("valid SARIF");
	for result in report.results.iter().filter(|result| !result.passed()) {
		let text = result.failure_text();
		assert!(xml.contains(&junit::escape(&text)), "{xml}");
		let found = document["runs"][0]["results"]
			.as_array()
			.expect("results")
			.iter()
			.any(|entry| entry["message"]["text"] == text.as_str());
		assert!(found, "{text} is missing from the SARIF results");
	}
}

#[test]
fn seconds_are_fixed_width_so_a_report_is_byte_stable() {
	let cases: BTreeMap<u64, &str> = BTreeMap::from([
		(0, "0.000"),
		(1, "0.001"),
		(999, "0.999"),
		(1_000, "1.000"),
		(61_500, "61.500"),
	]);
	for (millis, expected) in cases {
		assert_eq!(seconds(millis), expected);
	}
}

#[test]
fn every_subsystem_renders_as_its_own_token() {
	// Swept from the manifest rather than listed here, so a new subsystem cannot
	// reach a report as `Debug` output or share another one's id.
	let mut seen: BTreeMap<&str, Subsystem> = BTreeMap::new();
	for subsystem in crate::corpus::manifest::subsystems() {
		let token = subsystem.as_str();
		// The id serde writes into a corpus row and the id a report groups by
		// have to be the same string; two spellings of one subsystem is how a
		// report stops joining against the corpus.
		let serialized = serde_json::to_string(&subsystem).expect("a subsystem serializes");
		assert_eq!(serialized, format!("\"{token}\""));
		assert!(seen.insert(token, subsystem).is_none(), "{token} is claimed twice");
	}
	assert_eq!(seen.len(), 16);
}

fn provider_case() -> ConformanceCase {
	ConformanceCase {
		schema_version: SCHEMA_VERSION,
		case_id:        String::new(),
		generator:      GeneratorInfo {
			family: "provider-terminal-matrix".to_owned(),
			seed:   1_592_639_215,
		},
		subsystem:      Subsystem::AiProvidersStreaming,
		contract:       Contract {
			id:                "provider.clean-eof.complete-tool-batch".to_owned(),
			expected_error_id: None,
		},
		target:         Target { kind: TargetKind::CompiledProduct, entry: "veyyon".to_owned() },
		dimensions:     BTreeMap::from([("output".to_owned(), "truncated".to_owned())]),
		environment:    Environment {
			platform:           Platform::LinuxX64,
			clock:              ClockMode::RealBounded,
			filesystem_fixture: Some(FixtureRef("blake3:fs".to_owned())),
			provider_fixture:   Some(FixtureRef("blake3:sse".to_owned())),
		},
		stimulus:       vec![Stimulus {
			kind:  "prompt".to_owned(),
			value: "fixture:provider/basic-tool-turn".to_owned(),
		}],
		oracle:         Oracle { exit_code: Some(0), max_ms: Some(2_500), ..Oracle::default() },
		coverage:       Coverage::default(),
		provenance:     Provenance::Generated,
	}
	.seal()
}

#[test]
fn a_bundle_names_the_row_it_came_from_and_not_a_reconstruction() {
	// WHY: the family and seed are the whole point of the bundle. A report that
	// says "this contract failed" without them sends the reader to regenerate a
	// quarter of a million rows to find the one that did.
	let case = provider_case();
	let result =
		failed(&case.contract.id, &case.case_id, case.subsystem, vec![Mismatch::Deadline {
			bound_ms:   2_500,
			elapsed_ms: 4_100,
		}]);
	let json: serde_json::Value = serde_json::from_str(&FailureBundle::of(&case, &result).to_json())
		.expect("valid bundle JSON");
	assert_eq!(json["caseId"], case.case_id.as_str());
	assert_eq!(json["generatorFamily"], "provider-terminal-matrix");
	assert_eq!(json["seed"], 1_592_639_215_u64);
	assert_eq!(json["targetKind"], "compiled-product");
	assert_eq!(json["targetEntry"], "veyyon");
	assert_eq!(json["platform"], "linux-x64");
	assert_eq!(json["mismatches"][0], "took 4100ms, bound is 2500ms");
	// Digests, never bytes: a bundle is committed by CI and a fixture body in it
	// is a fixture published.
	assert_eq!(json["filesystemFixture"], "blake3:fs");
	assert_eq!(json["providerFixture"], "blake3:sse");
}

#[test]
fn a_bundle_omits_what_the_run_did_not_produce() {
	// An absent field says "no reduction ran" and "no terminal was driven". A
	// null, or a zeroed shrink summary, would claim a reduction that reduced
	// nothing — which is a real and different outcome.
	let case = provider_case();
	let result = failed(&case.contract.id, &case.case_id, case.subsystem, Vec::new());
	let json: serde_json::Value = serde_json::from_str(&FailureBundle::of(&case, &result).to_json())
		.expect("valid bundle JSON");
	assert!(json.get("shrink").is_none(), "{json}");
	assert!(json.get("ptyLog").is_none(), "{json}");
	assert!(json.get("vfsState").is_none(), "{json}");
}

#[test]
fn a_bundle_carries_the_reduction_that_actually_ran() {
	// Built from a real `ddmin` run rather than a hand-written summary, so the
	// outcome token and the counts cannot drift from what the reducer reports.
	let input: Vec<u32> = (0..32).collect();
	let shrunk = ddmin(&input, Budget::DEFAULT, |candidate: &[u32]| candidate.contains(&9));
	let case = provider_case();
	let result = failed(&case.contract.id, &case.case_id, case.subsystem, Vec::new());
	let json: serde_json::Value = serde_json::from_str(
		&FailureBundle::of(&case, &result)
			.with_shrink(&shrunk.trace)
			.with_pty_log(&FixtureRef("blake3:pty".to_owned()))
			.with_vfs_state(&FixtureRef("blake3:tree".to_owned()))
			.to_json(),
	)
	.expect("valid bundle JSON");
	assert_eq!(json["shrink"]["outcome"], "minimal");
	assert_eq!(json["shrink"]["original"], 32);
	assert_eq!(json["shrink"]["minimized"], 1);
	assert_eq!(json["shrink"]["candidates"], shrunk.trace.candidates);
	assert_eq!(json["ptyLog"], "blake3:pty");
	assert_eq!(json["vfsState"], "blake3:tree");
}
