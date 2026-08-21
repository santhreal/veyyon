//! `JUnit` XML, which is what a CI runner turns into a per-case tree.
//!
//! The format is old, under-specified and read by tools nobody here controls,
//! so this renderer takes the narrow path: one `testsuites` root, one
//! `testsuite` per subsystem, one `testcase` per case, counts computed from the
//! results, and every attribute value escaped. No `system-out`, no properties,
//! no stack traces — a conformance failure is a list of mismatches, and a
//! runner that shows the failure message shows all of it.
//!
//! Escaping is the part that has actually broken reports elsewhere: a mismatch
//! message carries contract ids, fixture digests and quoted values, and one
//! unescaped `&` makes the whole file unparseable, which a runner reports as
//! "no tests ran" rather than as a bad report.

use std::{collections::BTreeMap, fmt::Write as _};

use super::{CaseResult, RunReport, TOOL_NAME, seconds};

/// The report as `JUnit` XML.
#[must_use]
pub fn render(report: &RunReport) -> String {
	let mut by_subsystem: BTreeMap<&str, Vec<&CaseResult>> = BTreeMap::new();
	for result in report.ordered() {
		by_subsystem
			.entry(result.subsystem.as_str())
			.or_default()
			.push(result);
	}

	let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
	let _ = writeln!(
		out,
		"<testsuites name=\"{}\" tests=\"{}\" failures=\"{}\" time=\"{}\">",
		escape(TOOL_NAME),
		report.total(),
		report.failures(),
		seconds(report.elapsed_ms())
	);
	for (subsystem, results) in &by_subsystem {
		let failures = results.iter().filter(|result| !result.passed()).count();
		let elapsed: u64 = results.iter().map(|result| result.elapsed_ms).sum();
		let _ = writeln!(
			out,
			"\t<testsuite name=\"{}\" tests=\"{}\" failures=\"{}\" time=\"{}\">",
			escape(subsystem),
			results.len(),
			failures,
			seconds(elapsed)
		);
		for result in results {
			render_case(&mut out, result);
		}
		out.push_str("\t</testsuite>\n");
	}
	out.push_str("</testsuites>\n");
	out
}

fn render_case(out: &mut String, result: &CaseResult) {
	// The case id is in the name because a contract has thousands of cases and
	// a runner's tree is the only place a reader sees which one failed.
	let _ = write!(
		out,
		"\t\t<testcase name=\"{} {}\" classname=\"{}\" time=\"{}\"",
		escape(&result.contract_id),
		escape(&result.case_id),
		escape(result.subsystem.as_str()),
		seconds(result.elapsed_ms)
	);
	if result.passed() {
		out.push_str(" />\n");
		return;
	}
	let text = result.failure_text();
	let _ =
		writeln!(out, ">\n\t\t\t<failure message=\"{}\">{}</failure>", escape(&text), escape(&text));
	out.push_str("\t\t</testcase>\n");
}

/// XML-escape a value for use in either an attribute or element text.
///
/// One function for both positions on purpose: two functions means a caller
/// eventually uses the element one inside an attribute, and the difference is
/// invisible until a quote appears in a fixture digest. Control characters
/// other than tab, newline and carriage return are not legal in XML 1.0 at all,
/// so they are dropped rather than encoded — an encoded illegal character is
/// still an unparseable file.
#[must_use]
pub fn escape(value: &str) -> String {
	let mut out = String::with_capacity(value.len());
	for character in value.chars() {
		match character {
			'&' => out.push_str("&amp;"),
			'<' => out.push_str("&lt;"),
			'>' => out.push_str("&gt;"),
			'"' => out.push_str("&quot;"),
			'\'' => out.push_str("&apos;"),
			'\n' => out.push_str("&#10;"),
			'\r' => out.push_str("&#13;"),
			'\t' => out.push_str("&#9;"),
			control if control.is_control() => {},
			other => out.push(other),
		}
	}
	out
}
