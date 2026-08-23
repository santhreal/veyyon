//! Cargo build/test output filters.

use std::{collections::BTreeMap, fmt::Write as _};

use crate::minimizer::{MinimizerCtx, MinimizerOutput, contract, primitives};

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"build"
				| "check"
				| "test" | "clippy"
				| "nextest"
				| "fmt" | "doc"
				| "bench"
				| "run" | "metadata"
				| "tree" | "update"
				| "install"
				| "publish"
		)
	)
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let subject = cargo_subject(ctx.subcommand);
	let text = if looks_like_cargo_json(&cleaned)
		&& !matches!(ctx.subcommand, Some("metadata" | "test" | "bench" | "nextest"))
	{
		classify_json(subject, &cleaned, exit_code)
	} else {
		match ctx.subcommand {
			Some("metadata") => input.to_string(),
			Some("test" | "bench") if looks_like_libtest_json(&cleaned) => {
				classify_libtest_json(subject, &cleaned, exit_code)
			},
			Some("test" | "bench") => failures_only(&cleaned, exit_code, subject),
			Some("nextest") => filter_nextest(&cleaned, exit_code, subject),
			Some("clippy") => filter_clippy(&cleaned, exit_code, subject),
			Some("build" | "check" | "doc" | "run") => {
				classify_exit(subject, exit_code, &condense_build(&cleaned))
			},
			Some("fmt") => classify_exit(subject, exit_code, &condense_fmt(&cleaned)),
			Some("install") => filter_install(&cleaned, exit_code, subject),
			Some("tree" | "update" | "publish") => {
				classify_exit(subject, exit_code, &compact_general(&cleaned))
			},
			_ => cleaned,
		}
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn cargo_subject(subcommand: Option<&str>) -> &'static str {
	match subcommand {
		Some("test") => "cargo test",
		Some("bench") => "cargo bench",
		Some("nextest") => "cargo nextest",
		Some("clippy") => "cargo clippy",
		Some("build") => "cargo build",
		Some("check") => "cargo check",
		Some("doc") => "cargo doc",
		Some("run") => "cargo run",
		Some("fmt") => "cargo fmt",
		Some("install") => "cargo install",
		Some("tree") => "cargo tree",
		Some("update") => "cargo update",
		Some("publish") => "cargo publish",
		_ => "cargo",
	}
}

fn looks_like_cargo_json(input: &str) -> bool {
	input
		.lines()
		.map(str::trim_start)
		.filter(|line| !line.is_empty())
		.take(40)
		.any(is_cargo_json_reason_line)
}

fn is_cargo_json_reason_line(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with("{\"reason\":") || trimmed.starts_with("{ \"reason\":")
}

fn json_line_is_compiler_error(line: &str) -> bool {
	let trimmed = line.trim();
	if !trimmed.starts_with('{') {
		return false;
	}
	let has_error_level =
		trimmed.contains("\"level\":\"error\"") || trimmed.contains("\"level\": \"error\"");
	if !has_error_level {
		return false;
	}
	trimmed.contains("\"reason\":\"compiler-message\"")
		|| trimmed.contains("\"reason\": \"compiler-message\"")
		|| trimmed.contains("\"$message_type\":\"diagnostic\"")
}

fn json_error_count(input: &str) -> u64 {
	input
		.lines()
		.filter(|line| json_line_is_compiler_error(line))
		.count() as u64
}

fn classify_json(subject: &str, input: &str, exit_code: i32) -> String {
	let error_lines: Vec<&str> = input
		.lines()
		.filter(|line| json_line_is_compiler_error(line))
		.take(20)
		.collect();
	let count = json_error_count(input);
	let body = if error_lines.is_empty() {
		String::new()
	} else {
		let mut body = error_lines.join("\n");
		body.push('\n');
		body
	};
	let verdict = if exit_code == 0 && count == 0 {
		contract::clean(subject)
	} else if count > 0 {
		contract::errors(subject, count)
	} else {
		contract::errors_unknown(subject)
	};
	contract::apply(&verdict, &body)
}

fn looks_like_libtest_json(input: &str) -> bool {
	input
		.lines()
		.map(str::trim_start)
		.filter(|line| !line.is_empty())
		.take(40)
		.any(|line| {
			line.starts_with('{')
				&& (line.contains("\"type\":\"suite\"")
					|| line.contains("\"type\": \"suite\"")
					|| line.contains("\"type\":\"test\"")
					|| line.contains("\"type\": \"test\""))
		})
}

fn json_u64_field(line: &str, field: &str) -> Option<u64> {
	let key = format!("\"{field}\":");
	let after = line.split(&key).nth(1)?;
	let digits: String = after
		.chars()
		.skip_while(|c| c.is_whitespace())
		.take_while(|c| c.is_ascii_digit())
		.collect();
	if digits.is_empty() {
		None
	} else {
		digits.parse().ok()
	}
}

fn classify_libtest_json(subject: &str, input: &str, exit_code: i32) -> String {
	let mut passed = 0u64;
	let mut failed = 0u64;
	let mut saw_suite = false;
	for line in input.lines() {
		let trimmed = line.trim_start();
		if !(trimmed.contains("\"type\":\"suite\"") || trimmed.contains("\"type\": \"suite\"")) {
			continue;
		}
		if !(trimmed.contains("\"event\":\"ok\"")
			|| trimmed.contains("\"event\":\"failed\"")
			|| trimmed.contains("\"event\": \"ok\"")
			|| trimmed.contains("\"event\": \"failed\""))
		{
			continue;
		}
		saw_suite = true;
		if let Some(value) = json_u64_field(trimmed, "passed") {
			passed += value;
		}
		if let Some(value) = json_u64_field(trimmed, "failed") {
			failed += value;
		}
	}
	if exit_code == 0 && failed == 0 {
		let detail = if saw_suite {
			format!("{passed} passed")
		} else {
			"ok".to_string()
		};
		return contract::apply(&contract::clean_with(subject, detail), "");
	}
	let mut body = String::new();
	for line in input.lines().filter(|line| {
		let trimmed = line.trim_start();
		trimmed.contains("\"event\":\"failed\"") || trimmed.contains("\"event\": \"failed\"")
	}) {
		body.push_str(line);
		body.push('\n');
	}
	let verdict = if failed > 0 {
		contract::errors(subject, failed)
	} else {
		contract::errors_unknown(subject)
	};
	contract::apply(&verdict, &body)
}

fn rustc_error_count(body: &str) -> u64 {
	body
		.lines()
		.filter(|line| {
			let trimmed = line.trim_start();
			if primitives::is_minimizer_annotation(trimmed) {
				return false;
			}
			if trimmed.starts_with("error[") {
				return true;
			}
			if trimmed.starts_with("error: could not compile")
				|| trimmed.starts_with("error: aborting")
			{
				return false;
			}
			trimmed.starts_with("error: ")
		})
		.count() as u64
}

fn classify_exit(subject: &str, exit_code: i32, body: &str) -> String {
	if exit_code == 0 {
		return contract::from_exit(subject, 0, body);
	}
	let count = rustc_error_count(body);
	if count > 0 {
		contract::apply(&contract::errors(subject, count), body)
	} else {
		contract::from_exit(subject, exit_code, body)
	}
}

fn condense_build(input: &str) -> String {
	let stripped = primitives::strip_lines(input, &[is_compiling_noise]);
	let grouped = primitives::group_by_file(&stripped, 20);
	let deduped = primitives::dedup_consecutive_lines(&grouped);
	primitives::head_tail_lines(&deduped, 120, 60)
}

fn is_compiling_noise(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with("Compiling ")
		|| trimmed.starts_with("Checking ")
		|| trimmed.starts_with("Fresh ")
		|| trimmed.starts_with("Finished ")
		|| trimmed.starts_with("Documenting ")
		|| trimmed.starts_with("Running ")
		|| trimmed.starts_with("Downloading ")
		|| trimmed.starts_with("Downloaded ")
		|| trimmed.starts_with("Locking ")
		|| trimmed.starts_with("Updating ")
		// `Blocking waiting for file lock on ...` is pure progress noise when a
		// concurrent cargo holds the lock (snip strips it in cargo-build/clippy).
		|| trimmed.starts_with("Blocking ")
		|| is_generated_warnings_rollup(trimmed)
}

/// The per-crate rollup line warning: `crate` (lib) generated N warnings.
/// The individual `warning: ...` diagnostic blocks are kept; this redundant
/// tally is dropped.  Clippy/install paths already skip it explicitly, so
/// stripping it here only affects build/check/doc/run condensing.
fn is_generated_warnings_rollup(trimmed: &str) -> bool {
	let Some(rest) = trimmed.strip_prefix("warning: ") else {
		return false;
	};
	rest.contains(" generated ") && (rest.ends_with(" warnings") || rest.ends_with(" warning"))
}

fn failures_only(input: &str, exit_code: i32, subject: &str) -> String {
	if exit_code == 0 {
		return summarize_successful_test_run(input, subject);
	}
	let mut out = String::new();
	let mut keep = false;
	let mut failed_count = 0u64;
	let mut found_failed_summary = false;
	for line in input.lines() {
		let trimmed = line.trim_start();
		let trimmed_all = line.trim();
		if let Some(summary) = trimmed_all
			.strip_prefix("test result: FAILED.")
			.or_else(|| trimmed_all.strip_prefix("test result: FAILED"))
		{
			found_failed_summary = true;
			for part in summary.split(';') {
				let trimmed_part = part.trim().trim_end_matches('.');
				if let Some(value) = parse_count_prefix(trimmed_part, "failed") {
					failed_count += value;
				}
			}
		}
		// A line the minimizer WROTE never opens a failure block. `---- ` is the
		// Rust failure header prefix, and a capture holding a bare `----` twice
		// deduplicates to `---- (×2)`, which starts with that prefix without being
		// a header at all. The latch then fired on the second pass and threw away
		// everything before it, so a capture that had been minimized once came
		// back shorter every time it was minimized again. A real header repeating
		// consecutively would have to name the same test twice in a row, which
		// cargo does not do. Found by `fuzz/fuzz_targets/minimizer_filters.rs`.
		if !primitives::is_minimizer_annotation(trimmed)
			&& (trimmed.starts_with("failures:")
				|| trimmed.starts_with("---- ")
				|| trimmed.starts_with("error:")
				|| trimmed.starts_with("error[")
				|| trimmed.starts_with("thread '")
				|| trimmed.starts_with("test result: FAILED")
				|| trimmed.starts_with("test result: FAILED."))
		{
			keep = true;
		}
		// Passing test lines carry no failure signal — drop them unconditionally,
		// even after the keep flag latches, so a later passing suite in a
		// multi-suite run does not re-emit its `test <name> ... ok` lines.
		if is_passing_test_line(trimmed) {
			continue;
		}
		if keep || trimmed.starts_with("running ") {
			out.push_str(line);
			out.push('\n');
		}
	}
	let body = if out.is_empty() {
		condense_build(input)
	} else {
		out
	};
	let verdict = if found_failed_summary && failed_count > 0 {
		contract::errors(subject, failed_count)
	} else {
		contract::errors_unknown(subject)
	};
	contract::apply(&verdict, &body)
}

#[derive(Default)]
struct CargoTestTotals {
	suites:   usize,
	passed:   u64,
	failed:   u64,
	ignored:  u64,
	measured: u64,
	filtered: u64,
	warnings: u64,
	duration: Option<String>,
}

fn summarize_successful_test_run(input: &str, subject: &str) -> String {
	let mut totals = CargoTestTotals::default();

	for line in input.lines() {
		let trimmed = line.trim();
		if let Some(summary) = trimmed
			.strip_prefix("test result: ok.")
			.or_else(|| trimmed.strip_prefix("test result: ok"))
		{
			totals.suites += 1;
			collect_cargo_test_summary(summary, &mut totals);
			continue;
		}
		if let Some(warnings) = parse_generated_warning_count(trimmed) {
			totals.warnings += warnings;
		}
	}

	if totals.suites == 0 {
		let stripped = strip_passing_tests(input);
		if leftover_is_progress_only(&stripped) {
			return contract::apply(&contract::clean(subject), "");
		}
		return classify_exit(subject, 0, &stripped);
	}

	let mut detail = String::new();
	if totals.passed > 0 {
		detail.push_str(&totals.passed.to_string());
		detail.push_str(" passed");
	} else {
		detail.push_str("ok");
	}

	let mut details = Vec::new();
	details.push(format_suite_count(totals.suites));
	if totals.failed > 0 {
		details.push(format!("{} failed", totals.failed));
	}
	if totals.ignored > 0 {
		details.push(format!("{} ignored", totals.ignored));
	}
	if totals.measured > 0 {
		details.push(format!("{} measured", totals.measured));
	}
	if totals.filtered > 0 {
		details.push(format!("{} filtered", totals.filtered));
	}
	if totals.warnings > 0 {
		details.push(if totals.warnings == 1 {
			"1 warning".to_string()
		} else {
			format!("{} warnings", totals.warnings)
		});
	}
	if let Some(duration) = totals.duration {
		details.push(duration);
	}
	if !details.is_empty() {
		detail.push_str(" (");
		detail.push_str(&details.join(", "));
		detail.push(')');
	}
	let verdict = contract::clean_with(subject, detail);
	contract::apply(&verdict, "")
}

fn collect_cargo_test_summary(summary: &str, totals: &mut CargoTestTotals) {
	for part in summary.split(';') {
		let trimmed = part.trim().trim_end_matches('.');
		if let Some(value) = parse_count_prefix(trimmed, "passed") {
			totals.passed += value;
		} else if let Some(value) = parse_count_prefix(trimmed, "failed") {
			totals.failed += value;
		} else if let Some(value) = parse_count_prefix(trimmed, "ignored") {
			totals.ignored += value;
		} else if let Some(value) = parse_count_prefix(trimmed, "measured") {
			totals.measured += value;
		} else if let Some(value) = parse_count_prefix(trimmed, "filtered out") {
			totals.filtered += value;
		} else if let Some(duration) = trimmed.strip_prefix("finished in ") {
			totals.duration = Some(duration.to_string());
		}
	}
}

fn parse_generated_warning_count(line: &str) -> Option<u64> {
	let suffix = if line.ends_with(" warnings") {
		" warnings"
	} else if line.ends_with(" warning") {
		" warning"
	} else {
		return None;
	};
	if !line.contains(" generated ") {
		return None;
	}
	let before = line.strip_suffix(suffix)?;
	let count_text = before.rsplit_once(' ')?.1;
	count_text.parse().ok()
}

fn parse_count_prefix(text: &str, label: &str) -> Option<u64> {
	let (count, rest) = text.split_once(' ')?;
	if rest != label {
		return None;
	}
	count.parse().ok()
}

fn format_suite_count(suites: usize) -> String {
	if suites == 1 {
		"1 suite".to_string()
	} else {
		format!("{suites} suites")
	}
}

fn strip_passing_tests(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim_start();
		if is_passing_test_line(trimmed) {
			continue;
		}
		out.push_str(line);
		out.push('\n');
	}
	out
}

fn is_passing_test_line(trimmed: &str) -> bool {
	trimmed.starts_with("test ") && (trimmed.ends_with(" ... ok") || trimmed.ends_with("... ok"))
}

fn leftover_is_progress_only(body: &str) -> bool {
	body.lines().all(|line| {
		let trimmed = line.trim();
		trimmed.is_empty()
			|| trimmed.starts_with("running ")
			|| (!trimmed.is_empty() && trimmed.chars().all(|c| matches!(c, '.' | 'F' | 'i' | 'o')))
	})
}

fn filter_nextest(input: &str, exit_code: i32, subject: &str) -> String {
	let mut out = String::new();
	let mut in_failure = false;
	let mut summary = None;
	let mut canceled = false;
	let mut past_summary = false;

	for line in input.lines() {
		let trimmed = line.trim();
		// Once the Summary line is seen, nextest re-lists the failing tests as a
		// recap (duplicate `FAIL [...]` rows + trailing noise).  Drop everything
		// after it; the captured Summary line is re-emitted verbatim at the end.
		if past_summary {
			continue;
		}
		if is_compiling_noise(trimmed)
			|| trimmed.starts_with("PASS ")
			|| trimmed.starts_with("────")
			|| trimmed.starts_with("Starting ")
		{
			continue;
		}
		if trimmed.starts_with("Summary [") {
			summary = Some(trimmed.to_string());
			in_failure = false;
			past_summary = true;
			continue;
		}
		if trimmed.starts_with("Cancelling") {
			canceled = true;
			continue;
		}
		if trimmed.starts_with("FAIL ") {
			in_failure = true;
			out.push_str(trimmed);
			out.push('\n');
			continue;
		}
		if in_failure && !trimmed.starts_with("error: test run failed") {
			out.push_str(line);
			out.push('\n');
		}
	}
	if canceled {
		out.push_str("Cancelling due to test failure\n");
	}
	let failed = summary
		.as_deref()
		.and_then(parse_nextest_count("failed"))
		.unwrap_or(0);
	let passed = summary.as_deref().and_then(parse_nextest_count("passed"));
	if let Some(line) = summary {
		out.push_str(&line);
		out.push('\n');
	}
	let body = if out.is_empty() {
		compact_general(input)
	} else {
		out
	};
	if exit_code == 0 && failed == 0 {
		let detail = match passed {
			Some(n) => format!("{n} passed"),
			None => "ok".to_string(),
		};
		let verdict = contract::clean_with(subject, detail);
		contract::apply(&verdict, "")
	} else if failed > 0 {
		let verdict = contract::errors(subject, failed);
		contract::apply(&verdict, &body)
	} else {
		let verdict = contract::errors_unknown(subject);
		contract::apply(&verdict, &body)
	}
}
fn parse_nextest_count(label: &'static str) -> impl Fn(&str) -> Option<u64> {
	move |summary: &str| {
		for chunk in summary.split([',', ':']) {
			let trimmed = chunk.trim();
			if let Some(num) = trimmed.strip_suffix(label).map(str::trim)
				&& let Ok(value) = num.parse()
			{
				return Some(value);
			}
			let suffix = format!(" {label}");
			if let Some(num) = trimmed.strip_suffix(suffix.as_str())
				&& let Ok(value) = num.parse()
			{
				return Some(value);
			}
		}
		None
	}
}

fn condense_fmt(input: &str) -> String {
	let deduped = primitives::dedup_consecutive_lines(input);
	let grouped = primitives::group_by_file(&deduped, 20);
	primitives::head_tail_lines(&grouped, 80, 40)
}

fn compact_general(input: &str) -> String {
	primitives::strip_dedup_head_tail(input, &[is_general_cargo_noise], 80, 40)
}

fn is_general_cargo_noise(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with("Downloaded ")
		|| trimmed.starts_with("Downloading ")
		|| trimmed.starts_with("Compiling ")
		|| trimmed.starts_with("Checking ")
		|| trimmed.starts_with("Fresh ")
}
/// Filter `cargo install` output: strip compilation/download noise, keep
/// install/error summaries.
fn filter_install(input: &str, exit_code: i32, subject: &str) -> String {
	let stripped = primitives::strip_lines(input, &[is_compiling_noise]);

	let body = if exit_code != 0 {
		primitives::head_tail_lines(&stripped, 100, 40)
	} else {
		let mut summaries = String::new();
		for line in stripped.lines() {
			let trimmed = line.trim_start();
			if is_install_summary(trimmed) || trimmed.starts_with("WARNING:") {
				summaries.push_str(line);
				summaries.push('\n');
			}
		}
		if summaries.is_empty() {
			let deduped = primitives::dedup_consecutive_lines(&stripped);
			primitives::head_tail_lines(&deduped, 60, 20)
		} else {
			primitives::dedup_consecutive_lines(&summaries)
		}
	};
	classify_exit(subject, exit_code, &body)
}

fn is_install_summary(line: &str) -> bool {
	line.starts_with("Installed ")
		|| line.starts_with("Replaced ")
		|| line.starts_with("Replacing ")
		|| line.starts_with("Ignored ")
}

#[derive(Debug)]
struct ClippyWarning {
	location:  String,
	message:   String,
	lint_rule: Option<String>,
}

/// Filter `cargo clippy`: group warnings by lint rule; keep errors verbatim.
fn filter_clippy(input: &str, exit_code: i32, subject: &str) -> String {
	let no_noise = primitives::strip_lines(input, &[is_compiling_noise]);

	let has_compile_error = no_noise.lines().any(|l| {
		let t = l.trim_start();
		(t.starts_with("error:")
			&& !t.starts_with("error: could not compile")
			&& !t.starts_with("error: aborting"))
			|| t.starts_with("error[")
	});

	if has_compile_error {
		let grouped = primitives::group_by_file(&no_noise, 20);
		let body = primitives::head_tail_lines(&grouped, 120, 60);
		return classify_exit(subject, exit_code, &body);
	}

	let warnings = parse_clippy_warnings(&no_noise);
	if warnings.is_empty() {
		let deduped = primitives::dedup_consecutive_lines(&no_noise);
		let body = primitives::head_tail_lines(&deduped, 80, 40);
		return classify_exit(subject, exit_code, &body);
	}

	format_clippy_grouped(&warnings, exit_code, subject)
}

fn parse_clippy_warnings(input: &str) -> Vec<ClippyWarning> {
	let mut warnings = Vec::new();
	let lines: Vec<&str> = input.lines().collect();
	let mut i = 0;

	while i < lines.len() {
		let trimmed = lines[i].trim();
		if !trimmed.starts_with("warning: ") {
			i += 1;
			continue;
		}

		let msg = trimmed.strip_prefix("warning: ").unwrap_or("");
		// Skip summary lines like "warning: `crate` (lib) generated N warning(s)"
		if msg.contains(" generated ") && (msg.ends_with(" warnings") || msg.ends_with(" warning")) {
			i += 1;
			continue;
		}

		let message = msg.to_string();
		let mut location = String::new();
		let mut lint_rule = None;

		i += 1;
		while i < lines.len() {
			let t = lines[i].trim();
			if t.starts_with("--> ") {
				location = t.strip_prefix("--> ").unwrap_or("").to_string();
			}
			if let Some(rule) = extract_lint_rule(t) {
				lint_rule = Some(rule);
			}
			i += 1;
			if i >= lines.len() {
				break;
			}
			let next = lines[i].trim();
			if next.starts_with("warning: ")
				|| next.starts_with("error:")
				|| next.starts_with("error[")
			{
				break;
			}
		}

		if !message.is_empty() {
			warnings.push(ClippyWarning { location, message, lint_rule });
		}
	}

	warnings
}

fn extract_lint_rule(line: &str) -> Option<String> {
	let line = line.trim();
	if !line.starts_with("= note:") {
		return None;
	}
	let after_note = line.strip_prefix("= note:")?.trim();
	// Attribute form: `#[warn(rule)]` / `#[deny(rule)]` / `#[allow(rule)]`.
	if let Some(rest) = after_note
		.strip_prefix("`#[warn(")
		.or_else(|| after_note.strip_prefix("`#[deny("))
		.or_else(|| after_note.strip_prefix("`#[allow("))
	{
		return Some(rest.split(")]`").next()?.to_string());
	}
	// CLI form: `requested on the command line with `-W <rule>`` (also -D).
	// Lints enabled this way carry no `#[warn(...)]` note, so without this
	// branch they fall into the ungrouped bucket instead of grouping by rule.
	let cli = after_note.strip_prefix("requested on the command line with ")?;
	let flag = cli.strip_prefix('`')?.split('`').next()?.trim();
	let rule = flag
		.strip_prefix("-W ")
		.or_else(|| flag.strip_prefix("-D "))
		.or_else(|| flag.strip_prefix("-A "))?
		.trim();
	if rule.is_empty() {
		return None;
	}
	Some(rule.to_string())
}

fn format_clippy_grouped(warnings: &[ClippyWarning], exit_code: i32, subject: &str) -> String {
	let mut groups: BTreeMap<String, Vec<&ClippyWarning>> = BTreeMap::new();
	let mut ungrouped = Vec::new();

	for w in warnings {
		if let Some(ref rule) = w.lint_rule {
			groups.entry(rule.clone()).or_default().push(w);
		} else {
			ungrouped.push(w);
		}
	}

	let mut out = String::new();

	for (rule, warns) in &groups {
		if warns.len() == 1 {
			let loc = if warns[0].location.is_empty() {
				String::new()
			} else {
				format!("{}  ", warns[0].location)
			};
			let _ = writeln!(out, "clippy: {} — {}{}", rule, loc, warns[0].message);
		} else {
			let _ = writeln!(out, "clippy: {} ({} warnings)", rule, warns.len());
			for w in warns {
				let _ = writeln!(out, "  {}  {}", w.location, w.message);
			}
		}
	}

	for w in &ungrouped {
		let _ = writeln!(out, "clippy warning: {}  {}", w.location, w.message);
	}

	if exit_code != 0 {
		out.push_str("(clippy found issues)\n");
	}

	if out.is_empty() {
		return contract::apply(&contract::clean(subject), "");
	}
	if exit_code == 0 {
		let detail = if warnings.len() == 1 {
			"1 warning".to_string()
		} else {
			format!("{} warnings", warnings.len())
		};
		contract::apply(&contract::clean_with(subject, detail), &out)
	} else {
		contract::apply(&contract::errors(subject, warnings.len() as u64), &out)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	#[test]
	fn strips_compiling_noise() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "cargo",
			subcommand: Some("build"),
			command:    "cargo build",
			config:     &cfg,
		};
		let out = filter(&ctx, "   Compiling foo v0.1.0\nerror: nope\nsrc/lib.rs:1:1 bad\n", 1);
		assert!(!out.text.contains("Compiling"));
		assert!(out.text.contains("error: nope"));
	}

	#[test]
	fn build_strips_blocking_lock_and_warning_rollup() {
		// `Blocking waiting for file lock` is concurrent-cargo progress noise;
		// the `warning: \`crate\` (lib) generated N warnings` rollup is a
		// redundant tally of the per-warning blocks, which are kept.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "cargo",
			subcommand: Some("build"),
			command:    "cargo build",
			config:     &cfg,
		};
		let input = concat!(
			"    Blocking waiting for file lock on build directory\n",
			"   Compiling foo v0.1.0\n",
			"warning: unused variable: `x`\n",
			" --> src/lib.rs:2:9\n",
			"warning: `foo` (lib) generated 1 warning\n",
			"    Finished dev [unoptimized + debuginfo] target(s) in 1.2s\n",
		);
		let out = filter(&ctx, input, 0);
		assert!(
			!out.text.contains("Blocking"),
			"blocking lock noise must be stripped: {:?}",
			out.text
		);
		assert!(
			!out.text.contains("generated 1 warning"),
			"warning rollup must be stripped: {:?}",
			out.text
		);
		// Per-warning diagnostic block is kept.
		assert!(
			out.text.contains("unused variable: `x`"),
			"warning block must survive: {:?}",
			out.text
		);
		assert!(out.text.contains("src/lib.rs:2:9"), "warning location must survive: {:?}", out.text);
	}

	#[test]
	fn drops_passing_test_lines_on_success() {
		let out =
			strip_passing_tests("running 2 tests\ntest a ... ok\ntest b ... ok\ntest result: ok\n");
		assert_eq!(out, "running 2 tests\ntest result: ok\n");
	}

	#[test]
	fn summarizes_successful_cargo_test_run() {
		let input = "warning: unused variable: `start`\nwarning: `rtk` (bin \"rtk\" test) generated \
		             17 warnings\nrunning 262 tests\ntest a ... ok\ntest b ... ok\ntest result: ok. \
		             262 passed; 0 failed; 0 ignored; 0 measured\n";
		let out = summarize_successful_test_run(input, "cargo test");
		assert_eq!(out, "[clean] cargo test: 262 passed (1 suite, 17 warnings)\n");
	}

	#[test]
	fn supports_nextest_and_keeps_failures_with_summary() {
		assert!(supports(Some("nextest")));
		// nextest re-lists failing tests as a recap AFTER the Summary line.  The
		// recap `FAIL [...]` row and `error: test run failed` trailer must be
		// dropped (past_summary), while the in-run FAIL block + verbatim Summary
		// line survive.
		let out = filter_nextest(
			"Starting 3 tests across 1 binary\nPASS crate::ok\nFAIL crate::bad\nstdout text\nSummary \
			 [0.2s] 2 tests run: 1 passed, 1 failed\nFAIL [   0.011s] crate::bad\nerror: test run \
			 failed\n",
			1,
			"cargo nextest",
		);
		assert!(!out.contains("PASS crate::ok"));
		assert!(out.contains("FAIL crate::bad"));
		assert!(out.contains("stdout text"));
		assert!(out.contains("Summary [0.2s] 2 tests run: 1 passed, 1 failed"));
		// Post-Summary recap row and trailing noise are dropped.
		assert!(!out.contains("FAIL [   0.011s]"), "post-Summary recap must be dropped: {out:?}");
		assert!(
			!out.contains("error: test run failed"),
			"post-Summary trailer must be dropped: {out:?}"
		);
		assert!(
			out.starts_with("[errors 1] cargo nextest"),
			"nextest failures must be classified: {out:?}"
		);
	}
	#[test]
	fn install_strips_noise_keeps_summary() {
		assert!(supports(Some("install")));
		let input = concat!(
			"    Updating crates.io index\n",
			"  Downloaded foo v1.0.0\n",
			"   Compiling bar v0.1.0\n",
			"   Compiling tool v3.0.0\n",
			"    Finished release [optimized] target(s) in 45.2s\n",
			"  Installing /home/user/.cargo/bin/tool\n",
			"   Installed package `tool v3.0.0` (executable `tool`)\n",
		);
		let out = filter_install(input, 0, "cargo install");
		assert!(!out.contains("Compiling"));
		assert!(!out.contains("Downloaded"));
		assert!(!out.contains("Updating"));
		assert!(!out.contains("Finished"));
		assert!(out.contains("Installed package `tool v3.0.0`"));
	}

	#[test]
	fn install_already_installed() {
		let input = concat!(
			"    Updating crates.io index\n",
			"     Ignored package `tool v1.0.0` is already installed, use --force to override\n",
		);
		let out = filter_install(input, 0, "cargo install");
		assert!(!out.contains("Updating"));
		assert!(out.contains("Ignored package `tool v1.0.0`"));
	}

	#[test]
	fn install_error_preserves_context() {
		let input = concat!(
			"    Updating crates.io index\n",
			"   Compiling foo v0.1.0\n",
			"error[E0425]: cannot find value `x` in this scope\n",
			" --> src/main.rs:5:9\n",
			"  |\n",
			"5 |     let y = x;\n",
			"  |             ^ not found in this scope\n",
			"error: could not compile `foo` due to 1 previous error\n",
		);
		let out = filter_install(input, 1, "cargo install");
		assert!(!out.contains("Compiling"));
		assert!(!out.contains("Updating"));
		assert!(out.contains("error[E0425]"));
		assert!(out.contains("cannot find value `x`"));
	}

	#[test]
	fn clippy_groups_warnings_by_lint_rule() {
		assert!(supports(Some("clippy")));
		let input = concat!(
			"    Checking foo v0.1.0\n",
			"warning: unused variable: `x`\n",
			" --> src/lib.rs:2:9\n",
			"  |\n",
			"2 |     let x = 1;\n",
			"  |         ^ help: if this is intentional, prefix with an underscore: `_x`\n",
			"  |\n",
			"  = note: `#[warn(unused_variables)]` on by default\n",
			"\n",
			"warning: unused variable: `y`\n",
			" --> src/lib.rs:5:9\n",
			"  |\n",
			"5 |     let y = 2;\n",
			"  |         ^ help: if this is intentional, prefix with an underscore: `_y`\n",
			"  |\n",
			"  = note: `#[warn(unused_variables)]` on by default\n",
			"\n",
			"warning: `foo` (lib) generated 2 warnings\n",
		);
		let out = filter_clippy(input, 0, "cargo clippy");
		assert!(!out.contains("Checking"));
		assert!(!out.contains("generated"));
		assert!(out.contains("unused_variables"));
		assert!(out.contains("2 warnings"));
		assert!(out.contains("src/lib.rs:2:9"));
		assert!(out.contains("src/lib.rs:5:9"));
	}

	#[test]
	fn clippy_single_warning_compact() {
		let input = concat!(
			"warning: redundant clone\n",
			" --> src/main.rs:10:3\n",
			"  |\n",
			"10|     foo.clone()\n",
			"  |     ^^^^^^^^^^^^ help: remove this\n",
			"  |\n",
			"  = note: `#[warn(clippy::redundant_clone)]` on by default\n",
			"\n",
			"warning: `foo` (bin \"foo\") generated 1 warning\n",
		);
		let out = filter_clippy(input, 0, "cargo clippy");
		assert!(!out.contains("generated"));
		assert!(out.contains("clippy::redundant_clone"));
		assert!(out.contains("src/main.rs:10:3"));
		assert!(out.contains("redundant clone"));
	}

	#[test]
	fn clippy_multiple_rules_grouped_separately() {
		let input = concat!(
			"warning: unused variable: `x`\n",
			" --> src/lib.rs:2:9\n",
			"  |\n",
			"2 |     let x = 1;\n",
			"  |         ^\n",
			"  |\n",
			"  = note: `#[warn(unused_variables)]` on by default\n",
			"\n",
			"warning: redundant clone\n",
			" --> src/main.rs:10:3\n",
			"  |\n",
			"10|     foo.clone()\n",
			"  |     ^^^^^^^^^^^^ help: remove this\n",
			"  |\n",
			"  = note: `#[warn(clippy::redundant_clone)]` on by default\n",
			"\n",
			"warning: `foo` (lib) generated 2 warnings\n",
		);
		let out = filter_clippy(input, 0, "cargo clippy");
		assert!(out.contains("unused_variables"));
		assert!(out.contains("clippy::redundant_clone"));
		// Two separate groups, not merged
		let unused_pos = out.find("unused_variables").unwrap();
		let clone_pos = out.find("clippy::redundant_clone").unwrap();
		assert!(unused_pos != clone_pos);
	}

	#[test]
	fn clippy_groups_cli_enabled_lint_via_command_line_note() {
		// A lint enabled on the command line (`-W clippy::needless_return`) emits
		// a `requested on the command line with` note instead of `#[warn(...)]`.
		// It must still GROUP under its rule, not fall into the ungrouped bucket.
		let input = concat!(
			"warning: unneeded `return` statement\n",
			" --> src/lib.rs:3:5\n",
			"  |\n",
			"3 |     return x;\n",
			"  |     ^^^^^^^^^\n",
			"  |\n",
			"  = note: requested on the command line with `-W clippy::needless_return`\n",
			"\n",
			"warning: `foo` (lib) generated 1 warning\n",
		);
		let out = filter_clippy(input, 0, "cargo clippy");
		// Grouped renderer prefixes rule-grouped lines with `clippy: <rule>`.
		assert!(
			out.contains("clippy: clippy::needless_return"),
			"CLI-enabled lint must group by rule: {out:?}"
		);
		// Not emitted via the ungrouped `clippy warning:` path.
		assert!(!out.contains("clippy warning:"), "CLI-enabled lint must not be ungrouped: {out:?}");
		assert!(out.contains("src/lib.rs:3:5"), "location must survive: {out:?}");
	}

	#[test]
	fn extract_lint_rule_parses_note_forms() {
		assert_eq!(
			extract_lint_rule("  = note: `#[warn(unused_variables)]` on by default"),
			Some("unused_variables".to_string())
		);
		assert_eq!(
			extract_lint_rule(
				"= note: requested on the command line with `-W clippy::needless_return`"
			),
			Some("clippy::needless_return".to_string())
		);
		assert_eq!(
			extract_lint_rule("= note: requested on the command line with `-D warnings`"),
			Some("warnings".to_string())
		);
		assert_eq!(
			extract_lint_rule("= note: requested on the command line with `-W dead_code`"),
			Some("dead_code".to_string())
		);
		assert_eq!(extract_lint_rule("= note: some other note"), None);
	}

	#[test]
	fn clippy_compile_error_falls_back_to_build_style() {
		let input = concat!(
			"   Compiling foo v0.1.0\n",
			"error[E0425]: cannot find value `x` in this scope\n",
			" --> src/lib.rs:5:9\n",
			"  |\n",
			"5 |     let y = x;\n",
			"  |             ^ not found in this scope\n",
			"error: could not compile `foo` due to 1 previous error\n",
		);
		let out = filter_clippy(input, 1, "cargo clippy");
		assert!(!out.contains("Compiling"));
		assert!(out.contains("error[E0425]"));
		assert!(out.contains("cannot find value `x`"));
		// Should NOT have clippy: prefix since it fell back to build style
		assert!(!out.contains("clippy:"));
	}

	#[test]
	fn clippy_exit_code_signals_issues() {
		let input = concat!(
			"warning: unused variable: `x`\n",
			" --> src/lib.rs:2:9\n",
			"  |\n",
			"2 |     let x = 1;\n",
			"  |         ^\n",
			"  |\n",
			"  = note: `#[deny(unused_variables)]` on by default\n",
		);
		let out = filter_clippy(input, 1, "cargo clippy");
		assert!(out.contains("(clippy found issues)"));
	}

	#[test]
	fn metadata_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "cargo",
			subcommand: Some("metadata"),
			command:    "cargo metadata --format-version 1",
			config:     &cfg,
		};
		let input = r#"{"packages":[{"name":"app","targets":[{"kind":["bin"]}]}],"resolve":null}"#;
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, input);
		assert!(!out.changed);
	}

	// --- cargo test failure — failure block and panic line survive ---

	#[test]
	fn cargo_test_failure_keeps_thread_panic_and_failures_block() {
		// `cargo test` with exit 101 must surface the thread panic message,
		// the `failures:` block listing the failing test names, and the
		// `test result: FAILED` summary line.  Passing test lines and
		// `Compiling` noise must not appear.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "cargo",
			subcommand: Some("test"),
			command:    "cargo test",
			config:     &cfg,
		};
		let input = concat!(
			"   Compiling veyyon-shell v0.1.0\n",
			"running 3 tests\n",
			"test ok_one ... ok\n",
			"test ok_two ... ok\n",
			"test bad_parse ... FAILED\n",
			"\n",
			"---- bad_parse stdout ----\n",
			"thread 'bad_parse' panicked at 'assertion failed: result.is_ok()', src/lib.rs:42:5\n",
			"note: run with RUST_BACKTRACE=1 for a backtrace.\n",
			"\n",
			"failures:\n",
			"    bad_parse\n",
			"\n",
			"test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured\n",
		);

		let out = filter(&ctx, input, 101);

		// Failure evidence must survive.
		assert!(
			out.text.contains("thread 'bad_parse' panicked"),
			"panic line must survive: {:?}",
			out.text
		);
		assert!(out.text.contains("failures:\n"), "failures block must survive: {:?}", out.text);
		assert!(out.text.contains("bad_parse"), "failing test name must survive: {:?}", out.text);
		assert!(out.text.contains("test result: FAILED"), "result line must survive: {:?}", out.text);
		// Noise must be stripped.
		assert!(!out.text.contains("Compiling"), "Compiling noise must be stripped");
		assert!(!out.text.contains("test ok_one"), "passing test lines must be stripped");
		assert!(!out.text.contains("test ok_two"), "passing test lines must be stripped");
	}

	#[test]
	fn cargo_test_multi_suite_drops_passing_lines_after_keep_latches() {
		// Suite 1 fails, latching the keep flag.  Suite 2 passes — its
		// `test <name> ... ok` lines must NOT leak through just because keep
		// is set.  Only failure evidence survives.
		let input = concat!(
			"running 1 tests\n",
			"test suite1_bad ... FAILED\n",
			"\n",
			"failures:\n",
			"    suite1_bad\n",
			"\n",
			"test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured\n",
			"running 2 tests\n",
			"test suite2_ok_a ... ok\n",
			"test suite2_ok_b ... ok\n",
			"test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured\n",
		);

		let out = failures_only(input, 101, "cargo test");

		// Failure evidence from suite 1 survives.
		assert!(out.contains("suite1_bad"), "failing test name must survive: {out:?}");
		assert!(out.contains("test result: FAILED"), "failed summary must survive: {out:?}");
		// Suite 2's passing lines must be dropped even though keep is latched.
		assert!(
			!out.contains("test suite2_ok_a"),
			"passing line after keep latch must be dropped: {out:?}"
		);
		assert!(
			!out.contains("test suite2_ok_b"),
			"passing line after keep latch must be dropped: {out:?}"
		);
		assert!(
			out.starts_with("[errors 1] cargo test"),
			"failed libtest run must be classified: {out:?}"
		);
	}

	#[test]
	fn cargo_test_success_via_filter_produces_one_line_summary() {
		// The token-savings contract: a full passing run must collapse to a
		// single `cargo test: N passed (M suite[s])` line through filter(),
		// not through the helper directly.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "cargo",
			subcommand: Some("test"),
			command:    "cargo test --workspace",
			config:     &cfg,
		};
		let input = concat!(
			"   Compiling veyyon-shell v0.1.0\n",
			"running 42 tests\n",
			"test a ... ok\n",
			"test b ... ok\n",
			"test result: ok. 42 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n",
			"running 18 tests\n",
			"test c ... ok\n",
			"test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n",
			"warning: `veyyon-shell` (test \"integration\") generated 2 warnings\n",
		);

		let out = filter(&ctx, input, 0);

		assert!(out.changed, "successful run must be compacted");
		// One-line summary: total passed, suite count, warnings.
		assert!(out.text.contains("60 passed"), "total across suites must be summed: {:?}", out.text);
		assert!(out.text.contains("2 suites"), "suite count must appear: {:?}", out.text);
		assert!(out.text.contains("2 warnings"), "warning count must appear: {:?}", out.text);
		// No per-test lines.
		assert!(!out.text.contains("test a"), "individual test lines must be stripped");
		assert!(!out.text.contains("Compiling"), "Compiling noise must be stripped");
	}

	#[test]
	fn cargo_test_failure_exit_code_non_zero_is_not_summarized() {
		// A run that reports `test result: ok` but then exits non-zero
		// (e.g. a post-test hook failing) must not be falsely summarized
		// as a clean pass — failures_only should fall through to condense_build
		// rather than fabricating a `cargo test: N passed` line.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "cargo",
			subcommand: Some("test"),
			command:    "cargo test",
			config:     &cfg,
		};
		// The test suite itself says ok, but a subsequent build step failed.
		let input = concat!(
			"running 1 tests\n",
			"test it_works ... ok\n",
			"test result: ok. 1 passed; 0 failed\n",
			"error: could not compile `veyyon-shell` due to 1 previous error\n",
		);

		let out = filter(&ctx, input, 1);

		// Must not emit a clean "cargo test: N passed" summary because exit was
		// non-zero.
		assert!(
			out.text.starts_with("[errors] cargo test")
				|| out.text.starts_with("[errors 1] cargo test"),
			"must not fabricate a pass summary on non-zero exit: {:?}",
			out.text
		);
	}

	fn filter_cargo(
		subcommand: &'static str,
		command: &'static str,
		input: &str,
		exit: i32,
	) -> String {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx =
			MinimizerCtx { program: "cargo", subcommand: Some(subcommand), command, config: &cfg };
		filter(&ctx, input, exit).text
	}

	#[test]
	fn cargo_test_quiet_success_still_classifies() {
		// `cargo test --quiet` / `CARGO_TERM_QUIET=true`: no per-test lines.
		let input = "running 4 tests\n....\ntest result: ok. 4 passed; 0 failed; 0 ignored; 0 \
		             measured; 0 filtered out; finished in 0.01s\n";
		let out = filter_cargo("test", "cargo test --quiet", input, 0);
		assert_eq!(out, "[clean] cargo test: 4 passed (1 suite, 0.01s)\n");
	}

	#[test]
	fn cargo_test_color_always_strips_ansi_and_classifies() {
		// `CARGO_TERM_COLOR=always` / `--color always`
		let input = "\x1b[1m\x1b[32m   Compiling\x1b[0m foo v0.1.0\nrunning 1 tests\n\x1b[32mtest \
		             it_works ... ok\x1b[0m\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 \
		             measured\n";
		let out = filter_cargo("test", "cargo test --color always", input, 0);
		assert_eq!(out, "[clean] cargo test: 1 passed (1 suite)\n");
		assert!(!out.contains('\u{1b}'));
	}

	#[test]
	fn cargo_test_singular_generated_warning() {
		let input = "warning: unused variable: `x`\nwarning: `foo` (lib) generated 1 \
		             warning\nrunning 1 tests\ntest it ... ok\ntest result: ok. 1 passed; 0 failed; \
		             0 ignored; 0 measured\n";
		let out = filter_cargo("test", "cargo test", input, 0);
		assert_eq!(out, "[clean] cargo test: 1 passed (1 suite, 1 warning)\n");
	}

	#[test]
	fn cargo_test_workspace_sums_suites() {
		let input = concat!(
			"running 2 tests\n",
			"test a ... ok\n",
			"test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n",
			"running 1 tests\n",
			"test b ... ok\n",
			"test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n",
		);
		let out = filter_cargo("test", "cargo test --workspace", input, 0);
		assert_eq!(out, "[clean] cargo test: 3 passed (2 suites)\n");
	}

	#[test]
	fn cargo_test_doctests_count_as_a_suite() {
		let input = concat!(
			"running 1 tests\n",
			"test src/lib.rs - Foo (line 1) ... ok\n",
			"test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n",
		);
		let out = filter_cargo("test", "cargo test --doc", input, 0);
		assert_eq!(out, "[clean] cargo test: 1 passed (1 suite)\n");
	}

	#[test]
	fn cargo_test_failure_header_includes_count() {
		let input = concat!(
			"running 2 tests\n",
			"test ok ... ok\n",
			"test bad ... FAILED\n",
			"\n",
			"---- bad stdout ----\n",
			"thread 'bad' panicked at src/lib.rs:1:1:\nbom\n",
			"\n",
			"failures:\n",
			"    bad\n",
			"\n",
			"test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured\n",
		);
		let out = filter_cargo("test", "cargo test", input, 101);
		assert!(out.starts_with("[errors 1] cargo test\n"), "{out:?}");
		assert!(out.contains("thread 'bad' panicked"));
	}

	#[test]
	fn cargo_bench_uses_bench_subject() {
		let input = "running 1 tests\ntest benches::foo ... bench: 12 ns/iter (+/- 1)\ntest result: \
		             ok. 0 passed; 0 failed; 0 ignored; 1 measured\n";
		let out = filter_cargo("bench", "cargo bench", input, 0);
		assert_eq!(out, "[clean] cargo bench: ok (1 suite, 1 measured)\n");
	}

	#[test]
	fn cargo_check_success_and_failure_are_classified() {
		let ok = "    Checking foo v0.1.0\n    Finished `dev` profile [unoptimized + debuginfo] \
		          target(s) in 0.40s\n";
		assert_eq!(filter_cargo("check", "cargo check", ok, 0), "[clean] cargo check\n");
		let err = concat!(
			"    Checking foo v0.1.0\n",
			"error[E0425]: cannot find value `x` in this scope\n",
			" --> src/lib.rs:1:1\n",
			"error: could not compile `foo` due to 1 previous error\n",
		);
		let out = filter_cargo("check", "cargo check", err, 101);
		assert!(out.starts_with("[errors 1] cargo check\n"), "{out:?}");
		assert!(out.contains("error[E0425]"));
		assert!(!out.contains("Checking"));
	}

	#[test]
	fn cargo_message_format_json_classifies_without_transcript_search() {
		let ok = "{\"reason\":\"compiler-artifact\",\"package_id\":\"foo\",\"fresh\":true}\n{\"\
		          reason\":\"build-finished\",\"success\":true}\n";
		assert_eq!(
			filter_cargo("check", "cargo check --message-format=json", ok, 0),
			"[clean] cargo check\n"
		);
		let err = concat!(
			"{\"reason\":\"compiler-message\",\"message\":{\"level\":\"error\",\"message\":\"nope\"\
			 }}\n",
			"{\"reason\":\"build-finished\",\"success\":false}\n",
		);
		let out = filter_cargo("check", "cargo check --message-format=json", err, 101);
		assert!(out.starts_with("[errors 1] cargo check\n"), "{out:?}");
		assert!(out.contains("\"level\":\"error\""));
	}

	#[test]
	fn cargo_nextest_success_collapses_to_header() {
		let input = "Starting 2 tests across 1 binary\nPASS crate::a\nPASS crate::b\nSummary [0.1s] \
		             2 tests run: 2 passed, 0 failed\n";
		let out = filter_cargo("nextest", "cargo nextest run", input, 0);
		assert_eq!(out, "[clean] cargo nextest: 2 passed\n");
	}

	#[test]
	fn cargo_clippy_compile_error_is_classified() {
		let input = concat!(
			"    Checking foo v0.1.0\n",
			"error[E0425]: cannot find value `x` in this scope\n",
			" --> src/lib.rs:5:9\n",
			"error: could not compile `foo` due to 1 previous error\n",
		);
		let out = filter_cargo("clippy", "cargo clippy", input, 101);
		assert!(out.starts_with("[errors 1] cargo clippy\n"), "{out:?}");
		assert!(out.contains("error[E0425]"));
	}

	#[test]
	fn cargo_fmt_check_failure_is_classified() {
		let input = "Diff in /tmp/foo/src/lib.rs:\n-fn x(){}\n+fn x() {}\n";
		let out = filter_cargo("fmt", "cargo fmt --check", input, 1);
		assert!(out.starts_with("[errors] cargo fmt\n"), "{out:?}");
		assert!(out.contains("Diff in"));
	}

	#[test]
	fn classified_output_is_idempotent_across_a_second_pass() {
		let input = concat!(
			"running 1 tests\n",
			"test it ... ok\n",
			"test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured\n",
		);
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "cargo",
			subcommand: Some("test"),
			command:    "cargo test",
			config:     &cfg,
		};
		let first = filter(&ctx, input, 0);
		let second = filter(&ctx, &first.text, 0);
		assert_eq!(first.text, "[clean] cargo test: 1 passed (1 suite)\n");
		assert_eq!(second.text, first.text);
	}

	#[test]
	fn clippy_warnings_on_zero_exit_are_clean() {
		let input = concat!(
			"warning: unused variable: `x`\n",
			" --> src/lib.rs:2:9\n",
			"  |\n",
			"2 |     let x = 1;\n",
			"  |         ^\n",
			"  |\n",
			"  = note: `#[warn(unused_variables)]` on by default\n",
			"\n",
			"warning: `foo` (lib) generated 1 warning\n",
		);
		let out = filter_clippy(input, 0, "cargo clippy");
		assert!(
			out.starts_with("[clean] cargo clippy: 1 warning\n"),
			"default-warn clippy must be clean: {out:?}"
		);
		assert!(!out.contains("[errors"), "{out:?}");
	}

	#[test]
	fn cargo_json_after_compiling_banner_still_classifies() {
		let input = concat!(
			"   Compiling foo v0.1.0\n",
			"{\"reason\":\"compiler-artifact\",\"package_id\":\"foo\",\"fresh\":true}\n",
			"{\"reason\":\"build-finished\",\"success\":true}\n",
		);
		let out = filter_cargo("check", "cargo check --message-format=json", input, 0);
		assert_eq!(out, "[clean] cargo check\n");
	}

	#[test]
	fn cargo_test_libtest_json_classifies() {
		let input = concat!(
			r#"{"type":"suite","event":"started","test_count":2}"#,
			"\n",
			r#"{"type":"test","event":"ok","name":"a"}"#,
			"\n",
			r#"{"type":"suite","event":"ok","passed":2,"failed":0,"ignored":0,"measured":0,"filtered_out":0}"#,
			"\n",
		);
		let out = filter_cargo("test", "cargo test -- -Zunstable-options --format json", input, 0);
		assert_eq!(out, "[clean] cargo test: 2 passed\n");
	}

	#[test]
	fn cargo_test_libtest_json_failure_keeps_failed_events() {
		let input = concat!(
			r#"{"type":"suite","event":"started","test_count":1}"#,
			"\n",
			r#"{"type":"test","name":"bad","event":"failed"}"#,
			"\n",
			r#"{"type":"suite","event":"failed","passed":0,"failed":1,"ignored":0,"measured":0,"filtered_out":0}"#,
			"\n",
		);
		let out = filter_cargo("test", "cargo test -- -Zunstable-options --format json", input, 101);
		assert!(out.starts_with("[errors 1] cargo test\n"), "{out:?}");
		assert!(out.contains("\"name\":\"bad\""));
	}

	#[test]
	fn cargo_test_quiet_without_summary_is_still_clean() {
		let out = filter_cargo("test", "cargo test --quiet", "running 4 tests\n....\n", 0);
		assert_eq!(out, "[clean] cargo test\n");
	}
}
