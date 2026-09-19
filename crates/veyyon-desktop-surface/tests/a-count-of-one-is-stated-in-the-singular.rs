//! WHY: the panel drew `1 more changed files are not listed` and the
//! transcript drew `1 lines`, because each surface formatted its own count
//! with the plural noun spelled into the format string. A reader who sees
//! `1 files` reads a surface that is not counting.
//!
//! CLASS CLOSED: every label that states a count states it through
//! `text::counted`, which takes both noun forms rather than suffixing an `s`,
//! so `1 matchs` cannot be produced either. The labels the diff pane draws are
//! read at zero, one and many, and one rendered frame is swept for any run of
//! the shape `1 <word>s` -- so a surface that formats its own count the old
//! way fails on the frame rather than on a string this file would have to name.
//!
//! NOT CAUGHT: a surface whose count-at-one state no scene and no test here
//! renders. The frame sweep reads the runs of the panel it opened, and a
//! surface never drawn in it is never read. A plural that is irregular in a
//! way the sweep cannot see -- `1 indices`, whose singular is not the plural
//! less an `s` -- passes the sweep and is caught only by the label reading
//! above it.

#[path = "support/mono-pane/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared pane helpers")]
mod mono_pane;

use std::fmt::Write as _;

use mono_pane::{WINDOW_H, WINDOW_W, open_session};
use veyyon_desktop_model::DiffMode;
use veyyon_desktop_scene::headless_context;
use veyyon_desktop_surface::{
	DiffStatus, DiffWithheld, PanelContent, PanelTab, ShellState,
	diff::parse_diff,
	diff_rows::{collapsed_label, truncated_notice, withheld_notices},
	fixture,
	text::counted,
};

/// A diff of two files, so the panel draws a pane the notices sit above.
fn diff_text() -> String {
	let mut text = String::new();
	for file in ["src/first.rs", "src/second.rs"] {
		writeln!(text, "diff --git a/{file} b/{file}").expect("a string takes its own bytes");
		writeln!(text, "--- a/{file}").expect("a string takes its own bytes");
		writeln!(text, "+++ b/{file}").expect("a string takes its own bytes");
		text.push_str("@@ -1,2 +1,2 @@\n");
		text.push_str(" the context line\n");
		text.push_str("-pub const OLD: u32 = 0;\n");
		text.push_str("+pub const NEW: u32 = 1;\n");
	}
	text
}

/// The panel showing that diff, stating `withheld`, over an empty transcript.
fn state_with(withheld: DiffWithheld) -> ShellState {
	let mut state = fixture::populated();
	state.transcript.clear();
	state.keymap.panel_collapsed = false;
	state.panel = PanelContent {
		tabs: vec![PanelTab::Diff, PanelTab::File],
		active_tab: PanelTab::Diff,
		diff: parse_diff(&diff_text()),
		diff_status: DiffStatus::Loaded,
		diff_mode: DiffMode::Unified,
		withheld,
		..PanelContent::default()
	};
	state
}

/// Every string the shell drew for `withheld`.
fn drawn_text(withheld: DiffWithheld) -> Vec<String> {
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, state_with(withheld), WINDOW_W, WINDOW_H);
	let frame = session.frame().expect("the shell renders at rest");
	frame
		.text_runs
		.iter()
		.map(|run| run.text.as_ref().to_owned())
		.collect()
}

/// Whether `text` states a count of one against a noun that ends in `s`,
/// which is the shape every defect in this class takes.
///
/// The noun is not always the word after the count -- `1 more changed files`
/// puts two adjectives in between -- so the words after a `1` are read up to
/// the first one that ends the noun phrase. A word counts as plural only when
/// dropping its `s` leaves a word, so `1 pass` and `1 this` are not counts.
fn states_one_of_a_plural(text: &str) -> bool {
	const PHRASE_END: [&str; 13] =
		["of", "in", "and", "or", "to", "not", "is", "are", "was", "were", "the", "for", "at"];
	let words: Vec<&str> = text.split_whitespace().collect();
	for (index, word) in words.iter().enumerate() {
		if *word != "1" {
			continue;
		}
		for noun in &words[index + 1..] {
			let noun = noun.trim_end_matches(|c: char| !c.is_ascii_alphabetic());
			if PHRASE_END.contains(&noun) {
				break;
			}
			if noun.len() > 2 && noun.ends_with('s') && !noun.ends_with("ss") {
				return true;
			}
		}
	}
	false
}

#[test]
fn a_single_withheld_file_is_one_file() {
	let one = DiffWithheld { diff_truncated: false, files_withheld: 1, diff_bytes: 0 };
	assert_eq!(withheld_notices(one), vec!["1 more changed file is not listed".to_owned()]);

	let many = DiffWithheld { diff_truncated: false, files_withheld: 41, diff_bytes: 0 };
	assert_eq!(withheld_notices(many), vec!["41 more changed files are not listed".to_owned()]);
}

#[test]
fn a_collapsed_region_of_one_line_expands_one_line() {
	assert_eq!(collapsed_label(1), "Expand 1 line");
	assert_eq!(collapsed_label(2), "Expand 2 lines");
	assert_eq!(collapsed_label(0), "Expand 0 lines");
}

#[test]
fn the_cap_notice_counts_the_lines_it_withheld() {
	assert!(truncated_notice(1).ends_with("(1 more line not shown)"), "{}", truncated_notice(1));
	assert!(truncated_notice(9).ends_with("(9 more lines not shown)"), "{}", truncated_notice(9));
}

#[test]
fn the_count_owner_takes_both_forms_rather_than_suffixing_an_s() {
	assert_eq!(counted(0, "line", "lines"), "0 lines");
	assert_eq!(counted(1, "line", "lines"), "1 line");
	assert_eq!(counted(2, "line", "lines"), "2 lines");
	// The irregular plural is why both forms are passed: a suffixed `s` would
	// draw `1 matchs` here, which is the defect in a second spelling.
	assert_eq!(counted(1, "match", "matches"), "1 match");
	assert_eq!(counted(3, "match", "matches"), "3 matches");
}

#[test]
fn no_run_in_a_drawn_frame_states_one_of_a_plural() {
	let one = DiffWithheld { diff_truncated: true, files_withheld: 1, diff_bytes: 1024 };
	let drawn = drawn_text(one);
	assert!(
		drawn
			.iter()
			.any(|run| run == "1 more changed file is not listed"),
		"the panel draws the singular notice it was given; it drew {drawn:?}"
	);
	let offenders: Vec<&String> = drawn
		.iter()
		.filter(|run| states_one_of_a_plural(run))
		.collect();
	assert!(offenders.is_empty(), "a frame states a count of one against a plural: {offenders:?}");
}

#[test]
fn the_sweep_reads_a_plural_stated_against_one() {
	// The guard above is only evidence while it can fail: these are the runs
	// this class produces, and the shapes it must not mistake for one.
	assert!(states_one_of_a_plural("1 lines"));
	assert!(states_one_of_a_plural("Expand 1 lines"));
	assert!(states_one_of_a_plural("1 more changed files are not listed"));
	assert!(!states_one_of_a_plural("1 line"));
	assert!(!states_one_of_a_plural("1 match"));
	assert!(!states_one_of_a_plural("21 lines"));
	assert!(!states_one_of_a_plural("1 pass"));
}
