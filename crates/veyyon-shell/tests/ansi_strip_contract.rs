//! One escape-stripping contract, read from one corpus, checked in both
//! languages.
//!
//! WHY THIS SUITE EXISTS. The repo strips ANSI escapes in two places, because
//! it has to: `strip_ansi` here runs inside the shell's output minimizer, and
//! `stripAnsi` in `packages/utils/src/strip-ansi.ts` runs in the TUI and in a
//! browser-bundled renderer that may not import Node built-ins, let alone a
//! Rust crate. Two implementations of one contract is the tolerable part. Two
//! implementations of two DIFFERENT contracts is what was actually there, and
//! every difference was a defect:
//!
//! - This half handled CSI only. An OSC hyperlink (`ESC ] 8 ; ; <url> BEL`,
//!   which `ls --hyperlink`, cargo and clang all emit) had its escape byte
//!   dropped and its body kept, so minimized shell output handed the model
//!   `8;;file:///home/you/src/lib.rs` in the middle of a line while the TUI path
//!   showed the same capture cleaned.
//! - The TypeScript half read parameter bytes as `[0-9;?]` instead of the
//!   spec's `0x30-0x3f`, so a colon-subparameter true-color SGR survived there
//!   and not here.
//! - The TypeScript half kept a stray escape as text, which is not a fixed
//!   point: removing a sequence can push that escape against a following `[`
//!   and make a sequence that was not there before. This half learned that from
//!   its fuzzer; the other half had not.
//!
//! So the cases live in `fixtures/ansi-strip-corpus.json`, outside both
//! languages, and both suites read them. A case added on one side only is the
//! failure mode this arrangement removes, and the corpus carries a `why` per
//! case so the reason a case exists travels with it rather than with one
//! language's test file.
//!
//! This suite also holds the one-owner lock. A second `fn strip_ansi` compiles
//! and passes, which is how the TypeScript side ended up with three copies
//! under one name doing three different things.

use std::{
	fs,
	path::{Path, PathBuf},
};

use veyyon_shell::minimizer::primitives;

/// One case as it appears in the corpus.
#[derive(serde::Deserialize)]
struct Case {
	name:     String,
	/// The reason the case exists. Unused by the assertions and quoted in their
	/// failure messages, which is the point: a failure should say what behavior
	/// was being protected.
	why:      String,
	input:    String,
	expected: String,
}

#[derive(serde::Deserialize)]
struct Corpus {
	cases: Vec<Case>,
}

/// The corpus path, anchored at the crate manifest so the suite does not depend
/// on the working directory.
fn corpus_path() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/ansi-strip-corpus.json")
}

fn corpus() -> Vec<Case> {
	let path = corpus_path();
	let text = fs::read_to_string(&path).unwrap_or_else(|err| {
		panic!("the shared corpus at {} should be readable: {err}", path.display())
	});
	let parsed: Corpus = serde_json::from_str(&text).unwrap_or_else(|err| {
		panic!("the shared corpus at {} should be valid JSON: {err}", path.display())
	});
	parsed.cases
}

/// The corpus is really there and really holds the cases the rules below lean
/// on.
///
/// Without this, every assertion in this file is satisfied by a corpus that
/// failed to load and yielded nothing, which is the failure mode of a
/// data-driven suite.
#[test]
fn the_shared_corpus_loads_and_covers_both_sequence_kinds() {
	let cases = corpus();

	assert!(
		cases.len() >= 18,
		"the corpus should hold at least the eighteen cases it shipped with; found {}",
		cases.len()
	);

	for expected in [
		"sgr_color",
		"csi_colon_subparameters",
		"osc_window_title_bel",
		"osc_hyperlink_st",
		"osc_unterminated_is_not_a_sequence",
		"csi_truncated_keeps_its_tail",
		"escape_run_settles_in_one_pass",
		"plain_text_is_returned_unchanged",
	] {
		assert!(
			cases.iter().any(|case| case.name == expected),
			"the corpus should still name the `{expected}` case; it is one of the defects this \
			 corpus exists for"
		);
	}

	// Every case carries its reason, and every case except the plain-text one
	// really does hold an escape. A corpus of escape-free strings would pass the
	// whole suite while proving nothing.
	for case in &cases {
		assert!(!case.why.trim().is_empty(), "case `{}` should say why it exists", case.name);
	}
	assert!(
		cases
			.iter()
			.filter(|case| case.input.contains('\u{1b}'))
			.count()
			>= 16,
		"most cases should actually contain an escape"
	);
	assert!(
		cases.iter().any(|case| case.input.contains("\u{1b}]")),
		"at least one case should be an OSC, which is the half this crate was missing"
	);
	assert!(
		cases.iter().any(|case| case.input.contains("\u{1b}[")),
		"and at least one should be a CSI"
	);
}

/// Every case strips to exactly the bytes the corpus names.
///
/// Exact equality, not a `contains` or a "no escapes remain" check: what broke
/// before was the TEXT that survived a partial sequence, so a rule about
/// escapes alone would have passed while `8;;https://example.com` sat in the output.
///
/// All failures are collected before the panic so one run reports every
/// divergence rather than the first.
#[test]
fn every_corpus_case_strips_to_exactly_its_expected_text() {
	let mut failures = Vec::new();

	for case in corpus() {
		let got = primitives::strip_ansi(&case.input);
		if got != case.expected {
			failures.push(format!(
				"{}\n  why:      {}\n  input:    {:?}\n  expected: {:?}\n  got:      {:?}",
				case.name, case.why, case.input, case.expected, got
			));
		}
	}

	assert!(
		failures.is_empty(),
		"{} corpus case(s) diverged from the shared contract:\n\n{}",
		failures.len(),
		failures.join("\n\n")
	);
}

/// Stripping twice is stripping once, for every case.
///
/// The property that made the malformed-run rule what it is. A pass that leaves
/// an escape behind can strip differently the second time, so a filter's answer
/// would depend on how many times it had run. Asserted over the whole corpus
/// rather than one hand-picked string, because the case that broke it was found
/// by a fuzzer and not by inspection.
#[test]
fn stripping_is_a_fixed_point_for_every_corpus_case() {
	for case in corpus() {
		let once = primitives::strip_ansi(&case.input);
		let twice = primitives::strip_ansi(&once);

		assert_eq!(
			twice, once,
			"case `{}` is not a fixed point: {:?} became {:?} on the second pass ({})",
			case.name, once, twice, case.why
		);
		assert!(
			!once.contains('\u{1b}'),
			"case `{}` left an escape byte in {:?}, which is what makes a second pass differ",
			case.name,
			once
		);
	}
}

/// A partial sequence keeps its text, whatever the cut point.
///
/// Every prefix of a real OSC hyperlink is a capture cut at a buffer boundary,
/// which happens constantly and used to lose output. The rule for a prefix that
/// is not a complete sequence is exact: the escape goes, the rest stays.
/// Written as a sweep over all cut points because the interesting one is not
/// obvious, and the answer must not depend on where the knife fell.
#[test]
fn every_truncation_of_a_sequence_keeps_the_text_after_the_escape() {
	for sequence in
		["\u{1b}]8;;https://example.com\u{7}", "\u{1b}[38:2:255:0:0m", "\u{1b}]0;title\u{1b}\\"]
	{
		let full = format!("before {sequence} after");
		assert_eq!(
			primitives::strip_ansi(&full),
			"before  after",
			"a complete sequence should leave only the surrounding text"
		);

		// Every strict prefix of the sequence: not a sequence, so its bytes minus
		// the escape are text.
		for cut in 1..sequence.len() {
			if !sequence.is_char_boundary(cut) {
				continue;
			}
			let partial = &sequence[..cut];
			let line = format!("before {partial}");
			let stripped = primitives::strip_ansi(&line);
			assert_eq!(
				stripped,
				format!("before {}", partial.replace('\u{1b}', "")),
				"a capture cut after {cut} byte(s) of {sequence:?} should keep its text"
			);
		}
	}
}

/// There is one `strip_ansi` in the crates tree, and one scanner per sequence
/// kind.
///
/// A source scan because a second copy compiles and passes. This is not
/// hypothetical: the TypeScript side accumulated six copies of `stripAnsi`,
/// three of them under that exact name with three different behaviors, which is
/// what its own lock now forbids (`packages/utils/test/strip-ansi.test.ts`).
#[test]
fn the_crates_tree_defines_the_stripper_exactly_once() {
	let crates_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
	let mut definitions: Vec<String> = Vec::new();
	let mut csi_scanners = 0usize;
	let mut osc_scanners = 0usize;
	let mut files_read = 0usize;

	/// Count definitions of exactly `name`, not of names that start with it.
	///
	/// A substring count says two for this crate, because the tests module holds
	/// `fn strip_ansi_is_a_fixed_point`; the rule would then be unsatisfiable
	/// and the honest fix would look like weakening it. The next byte after the
	/// name has to be a non-identifier one.
	fn definitions_of(text: &str, name: &str) -> usize {
		let needle = format!("fn {name}");
		text
			.match_indices(&needle)
			.filter(|(at, _)| {
				text[at + needle.len()..]
					.chars()
					.next()
					.is_none_or(|next| !next.is_alphanumeric() && next != '_')
			})
			.count()
	}

	fn walk(dir: &PathBuf, out: &mut Vec<PathBuf>) {
		let Ok(entries) = fs::read_dir(dir) else {
			return;
		};
		for entry in entries.flatten() {
			let path = entry.path();
			let name = entry.file_name().to_string_lossy().into_owned();
			// `vendor` is a read-only snapshot of upstream crates and `target` is
			// build output; neither is ours to hold to this rule.
			if path.is_dir() {
				if name != "vendor" && name != "target" {
					walk(&path, out);
				}
			} else if Path::new(&name)
				.extension()
				.is_some_and(|ext| ext.eq_ignore_ascii_case("rs"))
			{
				out.push(path);
			}
		}
	}

	let mut files = Vec::new();
	walk(&crates_dir, &mut files);
	files.sort();

	// This file names the patterns it looks for, so it matches itself. Skipping it
	// is honest: a scanner is not a stripper. Everything else in the tree,
	// sources and tests alike, is held to the rule, because a test-helper copy
	// drifts exactly like a source copy and that is where the TypeScript copies
	// hid.
	let scanner = crates_dir.join("veyyon-shell/tests/ansi_strip_contract.rs");

	for path in &files {
		let Ok(text) = fs::read_to_string(path) else {
			continue;
		};
		files_read += 1;
		if *path == scanner {
			continue;
		}
		let relative = path
			.strip_prefix(&crates_dir)
			.unwrap_or(path)
			.display()
			.to_string();
		for _ in 0..definitions_of(&text, "strip_ansi") {
			definitions.push(relative.clone());
		}
		csi_scanners += definitions_of(&text, "csi_sequence_len");
		osc_scanners += definitions_of(&text, "osc_sequence_len");
	}

	// NON-VACUITY: the walk really reached the tree and really found the owner.
	assert!(files_read >= 120, "the scan should read the crates tree; it read {files_read} files");
	assert!(
		files.contains(&scanner),
		"the walk should have reached this file, or the skip above is skipping nothing and the rule \
		 below is measuring the wrong tree"
	);
	assert_eq!(
		definitions,
		vec!["veyyon-shell/src/minimizer/primitives.rs".to_string()],
		"exactly one `strip_ansi`, in the minimizer's primitives; import it instead of writing a \
		 second one, and give a narrower stripper its own honest name"
	);
	assert_eq!(csi_scanners, 1, "one CSI scanner");
	assert_eq!(osc_scanners, 1, "one OSC scanner");
}
