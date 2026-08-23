//! The one result header a classified command writes.
//!
//! Filters decide a [`Verdict`]. This module writes the header and is the one
//! place that recognizes it again. A later pass that cannot tell our header
//! from program output will reclassify the capture, stack a second header, or
//! treat `[errors]` as a rustc diagnostic. Those are the same class of bug
//! `primitives::is_minimizer_annotation` already closes for every other
//! marker we write.
//!
//! Grammar, one line, always first:
//!
//! ```text
//! [clean] <subject>
//! [clean] <subject>: <detail>
//! [errors] <subject>
//! [errors] <subject>: <detail>
//! [errors N] <subject>
//! [errors N] <subject>: <detail>
//! ```
//!
//! `<subject>` is the command the filter classified (`cargo test`, `bun test`,
//! `ctest`). `<detail>` is optional and owns counts the filter already had
//! (`262 passed (1 suite)`). Unknown error counts use the bare `[errors]`
//! form rather than inventing a number.
//!
//! A command with no adapter does not go through this module. Unclassified
//! output stays a transcript.

use std::fmt::Write as _;

/// Whether the classified command is clean or produced errors.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
	/// No errors. Warnings, if any, belong in [`Verdict::detail`].
	Clean,
	/// At least one error, failure, or non-zero diagnostic the caller must act
	/// on.
	Errors,
}

/// A classified result. Filters construct one; [`render`] / [`apply`] write it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Verdict {
	pub status:  Status,
	pub subject: String,
	/// Count of errors when the filter knew one. `None` means unknown.
	/// Meaningless on [`Status::Clean`].
	pub errors:  Option<u64>,
	pub detail:  Option<String>,
}

/// A header line parsed back from text we wrote.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedHeader {
	pub status:  Status,
	pub subject: String,
	pub errors:  Option<u64>,
	pub detail:  Option<String>,
}

/// A clean result for `subject`, with no detail.
#[must_use]
pub fn clean(subject: impl Into<String>) -> Verdict {
	Verdict { status: Status::Clean, subject: subject.into(), errors: None, detail: None }
}

/// A clean result whose detail carries the filter's existing summary counts.
#[must_use]
pub fn clean_with(subject: impl Into<String>, detail: impl Into<String>) -> Verdict {
	Verdict {
		status:  Status::Clean,
		subject: subject.into(),
		errors:  None,
		detail:  Some(detail.into()),
	}
}

/// An error result whose filter counted the failures.
#[must_use]
pub fn errors(subject: impl Into<String>, count: u64) -> Verdict {
	Verdict { status: Status::Errors, subject: subject.into(), errors: Some(count), detail: None }
}

/// An error result whose filter could not count the failures.
#[must_use]
pub fn errors_unknown(subject: impl Into<String>) -> Verdict {
	Verdict { status: Status::Errors, subject: subject.into(), errors: None, detail: None }
}

/// An error result with both a count and a retained summary detail.
#[must_use]
pub fn errors_with(subject: impl Into<String>, count: u64, detail: impl Into<String>) -> Verdict {
	Verdict {
		status:  Status::Errors,
		subject: subject.into(),
		errors:  Some(count),
		detail:  Some(detail.into()),
	}
}

/// Write the header line, including the trailing newline.
#[must_use]
pub fn render(verdict: &Verdict) -> String {
	let mut out = String::new();
	match (verdict.status, verdict.errors) {
		(Status::Clean, _) => out.push_str("[clean]"),
		(Status::Errors, Some(count)) => {
			let _ = write!(out, "[errors {count}]");
		},
		(Status::Errors, None) => out.push_str("[errors]"),
	}
	out.push(' ');
	out.push_str(verdict.subject.trim());
	if let Some(detail) = verdict
		.detail
		.as_deref()
		.map(str::trim)
		.filter(|d| !d.is_empty())
	{
		out.push_str(": ");
		out.push_str(detail);
	}
	out.push('\n');
	out
}

/// Parse a line as a header we wrote, or `None` for any other line.
#[must_use]
pub fn parse(line: &str) -> Option<ParsedHeader> {
	let trimmed = line.trim();
	let (status, errors, after_tag) = if let Some(rest) = trimmed.strip_prefix("[clean]") {
		(Status::Clean, None, rest)
	} else if let Some(rest) = trimmed.strip_prefix("[errors]") {
		(Status::Errors, None, rest)
	} else if let Some(rest) = trimmed.strip_prefix("[errors ") {
		let (count_text, after_bracket) = rest.split_once(']')?;
		if count_text.is_empty() || !count_text.bytes().all(|b| b.is_ascii_digit()) {
			return None;
		}
		let count = count_text.parse().ok()?;
		(Status::Errors, Some(count), after_bracket)
	} else {
		return None;
	};

	let rest = after_tag.strip_prefix(' ')?.trim();
	if rest.is_empty() {
		return None;
	}
	let (subject, detail) = match rest.split_once(": ") {
		Some((subject, detail)) if !subject.is_empty() => {
			(subject.to_string(), Some(detail.to_string()))
		},
		_ => (rest.to_string(), None),
	};
	Some(ParsedHeader { status, subject, errors, detail })
}

/// True when this line is a result header this module wrote.
#[must_use]
pub fn is_result_header(line: &str) -> bool {
	parse(line).is_some()
}

/// True when the first non-empty line of `text` is a result header.
///
/// Filters that opt in call [`apply`], which uses this so a replayed capture
/// is not classified a second time.
#[must_use]
pub fn already_classified(text: &str) -> bool {
	text
		.lines()
		.map(str::trim)
		.find(|line| !line.is_empty())
		.is_some_and(is_result_header)
}

/// Classify by process exit: zero is clean, anything else is unknown-count
/// errors.
///
/// Filters that already counted failures should call [`errors`] / [`apply`]
/// themselves. This is the shared path for "the process told us, we did not
/// count" so cargo/check/fmt/install and the C++/dotnet cousins do not each
/// re-open the same if/else.
#[must_use]
pub fn from_exit(subject: impl Into<String>, exit_code: i32, body: &str) -> String {
	let subject = subject.into();
	let verdict = if exit_code == 0 {
		clean(subject)
	} else {
		errors_unknown(subject)
	};
	apply(&verdict, body)
}

/// Prepend the header unless `body` is already classified.
///
/// An empty body becomes the header alone. A classified body is returned
/// unchanged (plus a trailing newline if it was missing one).
#[must_use]
pub fn apply(verdict: &Verdict, body: &str) -> String {
	if already_classified(body) {
		let mut out = body.to_string();
		if !out.is_empty() && !out.ends_with('\n') {
			out.push('\n');
		}
		return out;
	}
	let mut out = render(verdict);
	let body = body.trim_start_matches('\n');
	if body.is_empty() {
		return out;
	}
	out.push_str(body);
	if !out.ends_with('\n') {
		out.push('\n');
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn render_clean_with_and_without_detail() {
		assert_eq!(render(&clean("ctest")), "[clean] ctest\n");
		assert_eq!(
			render(&clean_with("cargo test", "262 passed (1 suite)")),
			"[clean] cargo test: 262 passed (1 suite)\n"
		);
	}

	#[test]
	fn render_errors_known_and_unknown() {
		assert_eq!(render(&errors("bun test", 3)), "[errors 3] bun test\n");
		assert_eq!(render(&errors_unknown("cargo check")), "[errors] cargo check\n");
		assert_eq!(render(&errors_with("go test", 1, "1 failed")), "[errors 1] go test: 1 failed\n");
	}

	#[test]
	fn parse_round_trips_every_form() {
		for verdict in [
			clean("ctest"),
			clean_with("cargo test", "262 passed (1 suite, 17 warnings)"),
			errors("bun test", 3),
			errors_unknown("cargo check"),
			errors_with("go test", 1, "1 failed"),
		] {
			let line = render(&verdict);
			let parsed = parse(&line).unwrap_or_else(|| panic!("did not parse {line:?}"));
			assert_eq!(parsed.status, verdict.status, "{line}");
			assert_eq!(parsed.subject, verdict.subject, "{line}");
			assert_eq!(parsed.errors, verdict.errors, "{line}");
			assert_eq!(parsed.detail, verdict.detail, "{line}");
		}
	}

	#[test]
	fn parse_rejects_program_output() {
		for line in [
			"error[E0277]: the trait bound is not satisfied",
			"error: could not compile `foo`",
			"failures:",
			"---- bad stdout ----",
			"test result: FAILED. 0 passed; 1 failed",
			"[clean]",
			"[errors]",
			"[errors x] cargo test",
			"[errors ] cargo test",
			"note: see [clean] docs",
			"cargo test: 262 passed (1 suite)",
		] {
			assert!(parse(line).is_none(), "{line:?} is not a header");
		}
	}

	#[test]
	fn apply_is_idempotent() {
		let verdict = clean_with("cargo test", "2 passed (1 suite)");
		let first = apply(&verdict, "");
		assert_eq!(first, "[clean] cargo test: 2 passed (1 suite)\n");
		assert_eq!(apply(&verdict, &first), first);
		assert_eq!(apply(&errors("cargo test", 1), &first), first);
	}

	#[test]
	fn apply_keeps_a_failure_body() {
		let body = "failures:\n    bad_parse\n";
		let out = apply(&errors("cargo test", 1), body);
		assert_eq!(out, "[errors 1] cargo test\nfailures:\n    bad_parse\n");
		assert_eq!(apply(&errors("cargo test", 1), &out), out);
	}

	#[test]
	fn already_classified_reads_the_first_non_empty_line() {
		assert!(already_classified("\n[clean] ctest\n"));
		assert!(!already_classified("failures:\n[clean] ctest\n"));
		assert!(!already_classified(""));
	}

	#[test]
	fn from_exit_classifies_zero_and_nonzero() {
		assert_eq!(from_exit("cargo check", 0, ""), "[clean] cargo check\n");
		assert_eq!(
			from_exit("cargo check", 101, "error: nope\n"),
			"[errors] cargo check\nerror: nope\n"
		);
		let classified = from_exit("cargo check", 0, "");
		assert_eq!(from_exit("cargo check", 1, &classified), classified);
	}
}
