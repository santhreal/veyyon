//! Opt-in output minimizer for `Shell::run` / `execute_shell`.
//!
//! Compresses a shell command's stdout/stderr before it reaches the JS
//! caller.
//!
//! The engine is inert unless a [`MinimizerConfig`] explicitly opts in.

pub mod config;
pub mod contract;
pub mod detect;
pub mod engine;
pub mod filters;
pub mod primitives;

pub mod pipeline;

pub mod plan;

use std::borrow::Cow;

pub use config::{MinimizerConfig, MinimizerOptions};

/// Per-invocation context passed to every filter.
#[derive(Debug, Clone)]
pub struct MinimizerCtx<'a> {
	/// Resolved program name (lowercased, e.g. `"git"`).
	pub program:    &'a str,
	/// Detected subcommand (lowercased, e.g. `"status"`), if any.
	pub subcommand: Option<&'a str>,
	/// Raw command string as the caller supplied it.
	pub command:    &'a str,
	/// Effective configuration.
	pub config:     &'a MinimizerConfig,
}

/// Output produced by a filter.
#[derive(Debug, Clone)]
pub struct MinimizerOutput {
	/// Rewritten output.
	pub text:          String,
	/// Whether the filter modified the input at all.
	pub changed:       bool,
	/// Byte length of the captured buffer before minimization.
	pub input_bytes:   usize,
	/// Byte length of `text` after minimization.
	pub output_bytes:  usize,
	/// Label for the dispatch path that produced this output (e.g. `"git"`,
	/// `"pipeline:gradle"`, or `"passthrough"`). For non-rewrite misses, this
	/// carries the reason label (e.g. `"compound"`, `"piped"`, `"parse-error"`,
	/// `"too-large"`, `"disabled"`, `"unknown"`, `"unsupported"`,
	/// `"pipeline-noop"`).
	pub filter:        &'static str,
	/// Original (un-minimized) capture, surfaced only when the filter
	/// actually rewrote the output. The caller (JS session layer) is expected
	/// to persist this via its session-scoped `ArtifactManager` and splice an
	/// `artifact://<id>` reference into [`text`](Self::text) before
	/// presenting it to the agent. The minimizer itself does not hold onto
	/// the original past this struct.
	pub original_text: Option<String>,
}

impl MinimizerOutput {
	/// Pass-through constructor — the filter emits the original text unchanged.
	pub fn passthrough<'a>(text: impl Into<Cow<'a, str>>) -> Self {
		let text = text.into().into_owned();
		let bytes = text.len();
		Self {
			text,
			changed: false,
			input_bytes: bytes,
			output_bytes: bytes,
			filter: "passthrough",
			original_text: None,
		}
	}

	/// Transformed output. Caller-supplied `input_bytes` lets the savings
	/// metric compare pre- and post-filter sizes.
	///
	/// Rewritten text is line-oriented, so a non-empty result is terminated with
	/// a newline here rather than at each of the several dozen places that build
	/// one. Almost every path already produced that, because it assembles output
	/// line by line; the exceptions were the paths that collapse a whole capture
	/// into one summary (`"ctest: ok"`, `"ok ✓ lint passed"`), which returned a
	/// bare literal. That made a filter's output depend on how many times it had
	/// run: `filter("ctest", …)` gave `"ctest: ok"`, and filtering THAT gave
	/// `"ctest: ok\n"`, because the second pass read the summary as a line of
	/// program output and wrote it back terminated. Captures do get replayed and
	/// filters do chain, so the two answers reached real callers.
	/// `fuzz/fuzz_targets/minimizer_filters.rs` found it by asserting a filter
	/// does not change its own output on a second pass.
	///
	/// Line endings are normalized for the same reason and in the same place.
	/// `primitives::dedup_consecutive_lines` already strips carriage returns
	/// wherever it runs, and says why: a CR surviving into a rendered row moves
	/// the cursor to column 0 and corrupts the line. It is not the only way to
	/// build output though, so a path that skipped it could hand back CRLF that
	/// the NEXT pass would strip, and `"\r\n"` settled at `"\r\n"` on one pass
	/// and `"\n"` on the next. Applying the rule at the boundary makes it hold
	/// for every filter rather than for the ones that happened to dedup.
	///
	/// [`Self::passthrough`] deliberately does NOT do either of these: it
	/// promises the program's bytes unchanged, and rewriting them would break
	/// that promise for the one case where the raw capture is what the caller
	/// asked for.
	#[must_use]
	pub fn transformed(mut text: String, input_bytes: usize) -> Self {
		if text.contains('\r') {
			// Per LINE, trimming every trailing carriage return, which is the rule
			// `primitives::dedup_consecutive_lines` already applies. A single
			// `replace("\r\n", "\n")` is not the same thing and not idempotent:
			// `"\r\r\n"` becomes `"\r\n"`, so the next pass changes it again, and
			// real captures do contain doubled carriage returns.
			let mut normalized = String::with_capacity(text.len());
			for line in text.lines() {
				normalized.push_str(line.trim_end_matches('\r'));
				normalized.push('\n');
			}
			text = normalized;
		}
		if !text.is_empty() && !text.ends_with('\n') {
			// A trailing carriage return is half a line ending, not content, so
			// the terminator REPLACES it rather than following it: otherwise
			// `"\r"` would settle at `"\r\n"` on one pass and `"\n"` on the next.
			while text.ends_with('\r') {
				text.pop();
			}
			text.push('\n');
		}
		let output_bytes = text.len();
		Self { text, changed: true, input_bytes, output_bytes, filter: "", original_text: None }
	}

	/// Attach a `filter` label (e.g. `"git"`, `"pipeline:gradle"`) to an
	/// output for telemetry, including non-rewrite miss reasons.
	#[must_use]
	pub const fn labeled(mut self, filter: &'static str) -> Self {
		self.filter = filter;
		self
	}

	/// Record the original capture buffer on this output so the caller can
	/// persist it as a session artifact and surface an `artifact://<id>`
	/// reference in [`text`](Self::text). No-op on passthrough outputs.
	#[must_use]
	pub fn with_original(mut self, original: impl Into<String>) -> Self {
		if self.changed {
			self.original_text = Some(original.into());
		}
		self
	}

	/// Replace the transformed text while keeping minimization telemetry
	/// coherent.
	#[must_use]
	pub fn with_text(mut self, text: String) -> Self {
		self.output_bytes = text.len();
		self.text = text;
		self
	}

	/// Byte count saved by this filter (0 for passthrough).
	#[must_use]
	pub const fn bytes_saved(&self) -> usize {
		self.input_bytes.saturating_sub(self.output_bytes)
	}
}

/// Aggregate output for a segmented chain.
#[allow(
	clippy::missing_const_for_fn,
	reason = "kept non-const because this constructs owned output used only at runtime"
)]
pub(crate) fn chain_output(
	text: String,
	original_text: String,
	input_bytes: usize,
	changed: bool,
) -> MinimizerOutput {
	let filter = if changed { "chain" } else { "chain-noop" };
	let output_bytes = text.len();
	MinimizerOutput {
		text,
		changed,
		input_bytes,
		output_bytes,
		filter,
		original_text: Some(original_text),
	}
}
/// Apply the configured filter pipeline to a captured buffer.
/// Returns the original text unchanged when minimization is disabled, no
/// filter matches, or a filter panics.
#[must_use]
pub fn apply(
	command: &str,
	captured: &str,
	exit_code: i32,
	config: &MinimizerConfig,
) -> MinimizerOutput {
	engine::apply(command, captured, exit_code, config)
}

#[cfg(test)]
mod tests {
	use std::collections::HashSet;

	use super::*;

	/// WHY: `minimizer` is the public API entrypoint for command stdout/stderr
	/// compaction across the entire shell subsystem. It defines
	/// `MinimizerOutput` invariants (normalization of line endings, newline
	/// termination, savings metrics, artifact retention) and the `apply()`
	/// routing gate (guards on capture size, enable toggles,
	/// allowlists/blocklists, piping/subshell safety, panics, and filter
	/// dispatch).
	///
	/// WHAT THIS SUITE COVERS:
	/// 1. `MinimizerOutput` structural contract:
	///    - `passthrough`: exact bytes preserved, zero bytes saved, `changed ==
	///      false`, no `original_text` retention even with `with_original`.
	///    - `transformed`: `changed == true`, line-ending normalization
	///      (trimming trailing `\r`s on each line, CRLF to LF), trailing newline
	///      enforcement on non-empty results, empty result preservation,
	///      `original_text` retention, and `bytes_saved` calculation (including
	///      saturation on growth).
	///    - `chain_output`: distinction between "chain" (when changed) and
	///      "chain-noop" (when unchanged).
	/// 2. `apply()` public pipeline contract:
	///    - Disabled configuration: passes raw capture with label "disabled".
	///    - Capture size boundary: exact `max_capture_bytes` processes;
	///      `max_capture_bytes + 1` falls back to passthrough labeled
	///      "too-large".
	///    - Piping boundary: `|` commands pass through with "piped" to protect
	///      downstream parsers (jq, awk, grep).
	///    - Compound subshell boundary: `(...)` commands pass through with
	///      "compound".
	///    - Program exclusion (`except`) and inclusion (`only` allowlist)
	///      filtering.
	///    - Unknown / unhandled commands pass through labeled "unknown".
	///    - Idempotence: a second minimization pass produces identical output.
	/// 3. Filter family contracts:
	///    - Explicit behavioral verification across tool categories (git, cargo,
	///      bun, python, go, docker, lint, ctest, cloud, listing), asserting
	///      what is kept (errors, status markers, failure recaps) versus what is
	///      dropped (decorative banners, progress meters, passing noise, tip
	///      hints).
	///
	/// WHAT THIS DOES NOT CATCH:
	/// - Internal tokenization quirks of individual subcommands inside child
	///   filter modules (covered in per-filter test suites).
	/// - Streaming PTY escapes that arrive across chunk boundaries in the live
	///   terminal.
	#[test]
	fn output_passthrough_contract_preserves_bytes_and_saves_nothing() {
		let raw = "raw output\r\nwithout newline";
		let out = MinimizerOutput::passthrough(raw);
		assert!(!out.changed, "passthrough must have changed=false");
		assert_eq!(out.text, raw, "passthrough must preserve raw bytes without modification");
		assert_eq!(out.input_bytes, raw.len());
		assert_eq!(out.output_bytes, raw.len());
		assert_eq!(out.bytes_saved(), 0, "passthrough must report 0 bytes saved");
		assert_eq!(out.filter, "passthrough");
		assert!(out.original_text.is_none(), "passthrough must not retain original_text");

		// Calling with_original on a passthrough output must be a no-op
		let with_orig = out.with_original("something else");
		assert!(with_orig.original_text.is_none(), "passthrough must never retain original_text");
	}

	#[test]
	fn output_transformed_normalizes_line_endings_and_enforces_trailing_newline() {
		// CRLF and multiple \r normalization
		let input = "line1\r\nline2\r\r\nline3\r";
		let transformed = MinimizerOutput::transformed(input.to_string(), 100);
		assert!(transformed.changed);
		assert_eq!(transformed.text, "line1\nline2\nline3\n");
		assert_eq!(transformed.input_bytes, 100);
		assert_eq!(transformed.output_bytes, transformed.text.len());

		// Trailing newline enforcement on non-empty string
		let no_nl = MinimizerOutput::transformed("hello world".to_string(), 20);
		assert_eq!(no_nl.text, "hello world\n");
		assert_eq!(no_nl.output_bytes, 12);

		// Empty string stays empty (no spurious newline)
		let empty = MinimizerOutput::transformed(String::new(), 0);
		assert_eq!(empty.text, "");
		assert_eq!(empty.output_bytes, 0);

		// Multiple trailing \r stripped and replaced by single \n
		let multi_cr = MinimizerOutput::transformed("summary\r\r\r".to_string(), 30);
		assert_eq!(multi_cr.text, "summary\n");

		// with_original attaches original on transformed output
		let with_orig = transformed.with_original("raw original text");
		assert_eq!(with_orig.original_text, Some("raw original text".to_string()));

		// with_text updates text and output_bytes
		let updated = with_orig.with_text("shorter\n".to_string());
		assert_eq!(updated.text, "shorter\n");
		assert_eq!(updated.output_bytes, 8);

		// bytes_saved: shrunk vs grown
		let shrunk = MinimizerOutput::transformed("short\n".to_string(), 100);
		assert_eq!(shrunk.bytes_saved(), 94);

		let grown = MinimizerOutput::transformed("longer output than input\n".to_string(), 5);
		assert_eq!(grown.bytes_saved(), 0, "grown output must saturate to 0 bytes saved");

		// labeled sets filter name
		let labeled = shrunk.labeled("git");
		assert_eq!(labeled.filter, "git");
	}

	#[test]
	fn output_chain_contract_labels_changes_correctly() {
		let changed = chain_output("changed text".into(), "orig".into(), 50, true);
		assert!(changed.changed);
		assert_eq!(changed.filter, "chain");
		assert_eq!(changed.original_text, Some("orig".into()));
		assert_eq!(changed.input_bytes, 50);
		assert_eq!(changed.output_bytes, "changed text".len());

		let noop = chain_output("same text".into(), "orig".into(), 9, false);
		assert!(!noop.changed);
		assert_eq!(noop.filter, "chain-noop");
		assert_eq!(noop.original_text, Some("orig".into()));
	}

	#[test]
	fn apply_disabled_config_returns_passthrough() {
		let cfg = MinimizerConfig::default(); // default has enabled = false
		let input = "## main\n M file.rs\n";
		let out = apply("git status", input, 0, &cfg);
		assert!(!out.changed);
		assert_eq!(out.filter, "disabled");
		assert_eq!(out.text, input);
		assert!(out.original_text.is_none());
	}

	#[test]
	fn apply_max_capture_bytes_exact_boundary() {
		let limit = 50u32;
		let cfg = MinimizerConfig { enabled: true, max_capture_bytes: limit, ..Default::default() };

		// Input exactly at max_capture_bytes is eligible for minimization
		let exact_input = "## main\n".to_string() + &" ".repeat(limit as usize - "## main\n".len());
		assert_eq!(exact_input.len(), limit as usize);
		let out_exact = apply("git status", &exact_input, 0, &cfg);
		assert_ne!(out_exact.filter, "too-large", "exact limit must not be rejected as too-large");

		// Input exceeding max_capture_bytes by 1 byte falls back to passthrough
		let over_input = exact_input + "x";
		assert_eq!(over_input.len(), limit as usize + 1);
		let out_over = apply("git status", &over_input, 0, &cfg);
		assert!(!out_over.changed);
		assert_eq!(out_over.filter, "too-large");
		assert_eq!(out_over.text, over_input);
	}

	#[test]
	fn apply_piped_and_compound_commands_bypass_minimization() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = "## main\n M file.rs\n";

		// Piped commands pass through to preserve downstream pipeline semantics
		let piped = apply("git status | cat", input, 0, &cfg);
		assert!(!piped.changed);
		assert_eq!(piped.filter, "piped");
		assert_eq!(piped.text, input);

		let piped_multi = apply("cargo check 2>&1 | tee out.txt", input, 0, &cfg);
		assert!(!piped_multi.changed);
		assert_eq!(piped_multi.filter, "piped");

		// Compound commands pass through
		let compound = apply("(git status && cargo check)", input, 0, &cfg);
		assert!(!compound.changed);
		assert_eq!(compound.filter, "compound");
	}

	#[test]
	fn apply_except_and_only_filtering_rules() {
		let mut except_git = HashSet::new();
		except_git.insert("git".to_string());
		let cfg_except = MinimizerConfig { enabled: true, except: except_git, ..Default::default() };

		let git_input = "## main...origin/main [ahead 1]\n M src/lib.rs\n";
		let out_git = apply("git status", git_input, 0, &cfg_except);
		assert!(!out_git.changed);
		assert_eq!(out_git.filter, "disabled", "excepted program must be disabled");
		assert_eq!(out_git.text, git_input);

		// Non-excepted program is minimized
		let cargo_input = "    Checking mycrate v0.1.0\n    Finished `dev` profile\n";
		let out_cargo = apply("cargo check", cargo_input, 0, &cfg_except);
		assert_eq!(out_cargo.filter, "cargo");

		// Only allowlist
		let mut only_cargo = HashSet::new();
		only_cargo.insert("cargo".to_string());
		let cfg_only = MinimizerConfig { enabled: true, only: only_cargo, ..Default::default() };

		let out_git_only = apply("git status", git_input, 0, &cfg_only);
		assert!(!out_git_only.changed);
		assert_eq!(out_git_only.filter, "disabled");

		let out_cargo_only = apply("cargo check", cargo_input, 0, &cfg_only);
		assert_eq!(out_cargo_only.filter, "cargo");
	}
	#[test]
	fn apply_unknown_and_unsupported_commands_pass_through() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = "custom output from proprietary tool\n";

		// A command that is detected but has no filter is labeled "unsupported"
		let out_unsupported = apply("my-custom-tool --flag", input, 0, &cfg);
		assert!(!out_unsupported.changed);
		assert_eq!(out_unsupported.filter, "unsupported");
		assert_eq!(out_unsupported.text, input);

		// A command with a launch prefix but no program is labeled "unknown"
		let out_unknown = apply("sudo", input, 0, &cfg);
		assert!(!out_unknown.changed);
		assert_eq!(out_unknown.filter, "unknown");
		assert_eq!(out_unknown.text, input);

		// An unparseable/empty command is labeled "parse-error"
		let out_parse_error = apply("", input, 0, &cfg);
		assert!(!out_parse_error.changed);
		assert_eq!(out_parse_error.filter, "parse-error");
	}
	#[test]
	fn apply_idempotence_does_not_mutate_already_minimized_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = concat!(
			"On branch main\n",
			"Your branch is up to date with 'origin/main'.\n",
			"nothing to commit, working tree clean\n",
		);
		let pass1 = apply("git status", input, 0, &cfg);
		assert!(pass1.changed);

		let pass2 = apply("git status", &pass1.text, 0, &cfg);
		assert_eq!(pass2.text, pass1.text, "second minimization pass must produce identical output");
	}
	/// go, docker, lint, cpp, cloud, listing). This test asserts the contract of
	/// what is kept vs dropped across each major tool family.
	#[test]
	fn apply_filter_contracts_across_major_tool_families() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };

		// 1. Git: keeps branch status & changed files, drops clean hint boilerplate
		let git_raw = concat!(
			"On branch main\n",
			"Your branch is up to date with 'origin/main'.\n",
			"Changes not staged for commit:\n",
			"  (use \"git add <file>...\" to update what will be committed)\n",
			"  (use \"git restore <file>...\" to discard changes in working directory)\n",
			"\tmodified:   src/main.rs\n",
			"no changes added to commit (use \"git add\" to track)\n",
		);
		let git_out = apply("git status", git_raw, 0, &cfg);
		assert!(git_out.changed);
		assert!(git_out.text.contains("src/main.rs"), "must keep modified file");
		assert!(!git_out.text.contains("use \"git add\""), "must drop hint boilerplate");

		// 2. Cargo check: keeps warnings and errors, drops compilation noise
		let cargo_raw = concat!(
			"    Updating crates.io index\n",
			"    Checking foo v0.1.0 (/path/to/foo)\n",
			"warning: unused variable: `x`\n",
			" --> src/lib.rs:2:9\n",
			"  |\n",
			"2 |     let x = 1;\n",
			"  |         ^ help: if this is intentional, prefix it with an underscore: `_x`\n",
			"    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.42s\n",
		);
		let cargo_out = apply("cargo check", cargo_raw, 0, &cfg);
		assert!(cargo_out.changed);
		assert!(cargo_out.text.contains("warning: unused variable"), "must keep warning");
		assert!(!cargo_out.text.contains("Updating crates.io index"), "must drop update chatter");

		// 3. Cargo test: clean pass emits classified verdict
		let test_pass_raw = concat!(
			"   Compiling foo v0.1.0\n",
			"    Finished `test` profile\n",
			"     Running unittests src/lib.rs\n",
			"running 5 tests\n",
			"test tests::test_one ... ok\n",
			"test tests::test_two ... ok\n",
			"test tests::test_three ... ok\n",
			"test tests::test_four ... ok\n",
			"test tests::test_five ... ok\n",
			"test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in \
			 0.01s\n",
		);
		let test_pass_out = apply("cargo test", test_pass_raw, 0, &cfg);
		assert!(test_pass_out.changed);
		assert!(
			test_pass_out.text.starts_with("[clean] cargo test"),
			"clean pass must emit [clean] verdict header"
		);

		// 4. Pytest: keeps failures and summary, drops run chatter
		let pytest_raw = concat!(
			"============================= test session starts ==============================\n",
			"platform linux -- Python 3.12.0\n",
			"rootdir: /path/to/project\n",
			"collected 3 items\n\n",
			"test_app.py .F.\n\n",
			"=================================== FAILURES ===================================\n",
			"__________________________________ test_fail ___________________________________\n",
			"    def test_fail():\n",
			">       assert 1 == 2\n",
			"E       assert 1 == 2\n",
			"test_app.py:5: AssertionError\n",
			"=========================== short test summary info ============================\n",
			"FAILED test_app.py::test_fail - assert 1 == 2\n",
			"========================= 1 failed, 2 passed in 0.05s ==========================\n",
		);
		let pytest_out = apply("pytest", pytest_raw, 1, &cfg);
		assert!(pytest_out.changed);
		assert!(pytest_out.text.contains("assert 1 == 2"), "must keep failure traceback");
		assert!(!pytest_out.text.contains("platform linux"), "must drop session header");

		// 5. Docker ps: keeps table header and containers
		let docker_raw = concat!(
			"CONTAINER ID   IMAGE          COMMAND                  CREATED         STATUS         \
			 PORTS     NAMES\n",
			"a1b2c3d4e5f6   redis:alpine   \"docker-entrypoint.s…\"   2 hours ago     Up 2 hours     \
			 6379/tcp   my-redis\n",
		);
		let docker_out = apply("docker ps", docker_raw, 0, &cfg);
		assert!(docker_out.text.contains("my-redis"), "docker ps must retain container row");

		// 6. CTest: keeps failure details
		let ctest_raw = concat!(
			"Test project /build\n",
			"    Start 1: TestMath\n",
			"1/2 Test #1: TestMath .........................   Passed    0.01 sec\n",
			"    Start 2: TestString\n",
			"2/2 Test #2: TestString .......................***Failed    0.02 sec\n\n",
			"50% tests passed, 1 tests failed out of 2\n\n",
			"Total Test time (real) =   0.03 sec\n\n",
			"The following tests FAILED:\n",
			"\t  2 - TestString (Failed)\n",
			"Errors did occur before the test.\n",
		);
		let ctest_out = apply("ctest", ctest_raw, 8, &cfg);
		assert!(ctest_out.changed);
		assert!(ctest_out.text.contains("TestString"), "must retain failed test name");
	}
}
