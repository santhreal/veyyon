//! WHY: a hunk that changes one line is the case a diff parser is written
//! against, and a hunk that changes four consecutive lines is the case an
//! operator reads. The parser buffers a run of removed lines and a run of
//! added lines and pairs them positionally, so removed[i] is the line
//! added[i] replaced. The removed side computed that pairing from the buffer.
//! The added side recovered it by counting backwards through the rows it had
//! already pushed, which lands on removed[2i]: correct for the first line of
//! a block, wrong for the second, and past the removed rows entirely from the
//! halfway point on, where the lookup misses and the line loses its
//! highlights. A word-level highlight that points at a line the operator's
//! line did not replace states an edit that never happened.
//!
//! THE CLASS THIS CLOSES: an intraline span on a changed row that does not
//! come from the row it is paired with. Every offset in a block is swept, not
//! the first one, and the sweep is driven from the parsed rows rather than
//! from hardcoded indices, so a block of any length is covered and a
//! block-grouping change that regroups the rows is covered with it. Both
//! directions of an uneven block are included, since the pair count is the
//! shorter run and the surplus rows carry no highlight.
//!
//! WHAT IT DOES NOT CATCH: what `pair_intraline` decides is a word, which is
//! `veyyon_diff_kernel::align_words` and is pinned there; and how a span is
//! painted, which the raster suites in this directory own. A block whose runs
//! are separated by a context line is two blocks by construction, and this
//! suite states that grouping rather than questioning it.

use std::{fmt::Write as _, ops::Range};

use veyyon_desktop_surface::{
	DiffRow,
	diff::{pair_intraline, parse_diff},
};

/// One block of changed rows: the removed run, then the added run.
struct Block {
	removed: Vec<(String, Vec<Range<usize>>)>,
	added:   Vec<(String, Vec<Range<usize>>)>,
}

/// Groups parsed rows into blocks of consecutive removed-then-added rows, the
/// runs `flush_pending` emits together. Derived from the rows the parser
/// produced, so a block of any length arrives without being named here.
fn blocks(rows: &[DiffRow]) -> Vec<Block> {
	let mut blocks: Vec<Block> = Vec::new();
	let mut open = false;
	for row in rows {
		match row {
			DiffRow::Removed { text, intraline, .. } => {
				// A removed row after an added one starts the next block.
				if !open || blocks.last().is_some_and(|b| !b.added.is_empty()) {
					blocks.push(Block { removed: Vec::new(), added: Vec::new() });
					open = true;
				}
				if let Some(block) = blocks.last_mut() {
					block.removed.push((text.clone(), intraline.clone()));
				}
			},
			DiffRow::Added { text, intraline, .. } => {
				if !open {
					blocks.push(Block { removed: Vec::new(), added: Vec::new() });
					open = true;
				}
				if let Some(block) = blocks.last_mut() {
					block.added.push((text.clone(), intraline.clone()));
				}
			},
			_ => open = false,
		}
	}
	blocks
}

/// The substrings a set of spans highlights, in the order they are drawn.
fn highlighted(text: &str, spans: &[Range<usize>]) -> Vec<String> {
	spans
		.iter()
		.map(|span| text[span.clone()].to_string())
		.collect()
}

/// A diff whose blocks are 4x4, 3x5, 5x3 and 1x1, with one pair inside the
/// first block whose two lines are identical.
fn fixture() -> String {
	let mut text = String::new();
	text.push_str("diff --git a/src/lib.rs b/src/lib.rs\n");
	text.push_str("--- a/src/lib.rs\n");
	text.push_str("+++ b/src/lib.rs\n");

	// Block 1 -- four replaced lines, each changing a different token, with
	// the third pair identical on both sides.
	text.push_str("@@ -1,6 +1,6 @@\n");
	text.push_str(" fn main() {\n");
	text.push_str("-let alpha = 1;\n");
	text.push_str("-let bravo = 2;\n");
	text.push_str("-let carol = 3;\n");
	text.push_str("-let delta = 4;\n");
	text.push_str("+let alpha = 11;\n");
	text.push_str("+let bravo = 22;\n");
	text.push_str("+let carol = 3;\n");
	text.push_str("+let delta = 44;\n");
	text.push_str(" }\n");

	// Block 2 -- three removed, five added: two added rows have nothing to
	// highlight against.
	text.push_str("@@ -20,5 +20,7 @@\n");
	text.push_str(" fn wider() {\n");
	text.push_str("-let echo = 5;\n");
	text.push_str("-let foxtrot = 6;\n");
	text.push_str("-let golf = 7;\n");
	text.push_str("+let echo = 55;\n");
	text.push_str("+let foxtrot = 66;\n");
	text.push_str("+let golf = 77;\n");
	text.push_str("+let hotel = 88;\n");
	text.push_str("+let india = 99;\n");
	text.push_str(" }\n");

	// Block 3 -- five removed, three added: the mirror of block 2.
	text.push_str("@@ -40,7 +40,5 @@\n");
	text.push_str(" fn narrower() {\n");
	text.push_str("-let juliet = 10;\n");
	text.push_str("-let kilo = 11;\n");
	text.push_str("-let lima = 12;\n");
	text.push_str("-let mike = 13;\n");
	text.push_str("-let november = 14;\n");
	text.push_str("+let juliet = 100;\n");
	text.push_str("+let kilo = 110;\n");
	text.push_str("+let lima = 120;\n");
	text.push_str(" }\n");

	// Block 4 -- the single-line change, the shape the parser was written for.
	text.push_str("@@ -60,3 +60,3 @@\n");
	text.push_str(" fn one() {\n");
	text.push_str("-let oscar = 15;\n");
	text.push_str("+let oscar = 150;\n");
	text.push_str(" }\n");
	text
}

fn fixture_blocks() -> Vec<Block> {
	let files = parse_diff(&fixture());
	assert_eq!(files.len(), 1, "the fixture is one file");
	blocks(&files[0].rows)
}

#[test]
fn every_pair_in_every_block_highlights_against_its_own_counterpart() {
	let blocks = fixture_blocks();
	assert_eq!(blocks.len(), 4, "the fixture states four blocks of changed rows");

	for (index, block) in blocks.iter().enumerate() {
		let pairs = block.removed.len().min(block.added.len());
		for offset in 0..pairs {
			let (old_text, old_spans) = &block.removed[offset];
			let (new_text, new_spans) = &block.added[offset];
			let (expected_old, expected_new) = pair_intraline(old_text, new_text);
			assert_eq!(
				old_spans, &expected_old,
				"block {index} offset {offset}: the removed row highlights against {new_text:?}"
			);
			assert_eq!(
				new_spans, &expected_new,
				"block {index} offset {offset}: the added row {new_text:?} highlights against \
				 {old_text:?}, not against another line of the block"
			);
		}
	}
}

#[test]
fn a_surplus_row_in_an_uneven_block_carries_no_highlight() {
	let blocks = fixture_blocks();

	for (index, block) in blocks.iter().enumerate() {
		let pairs = block.removed.len().min(block.added.len());
		for (offset, (text, spans)) in block.removed.iter().enumerate().skip(pairs) {
			assert!(
				spans.is_empty(),
				"block {index}: removed row {offset} ({text:?}) replaced nothing and must carry no \
				 highlight"
			);
		}
		for (offset, (text, spans)) in block.added.iter().enumerate().skip(pairs) {
			assert!(
				spans.is_empty(),
				"block {index}: added row {offset} ({text:?}) replaced nothing and must carry no \
				 highlight"
			);
		}
	}
}

#[test]
fn the_second_line_of_a_block_highlights_the_token_that_changed_on_it() {
	let blocks = fixture_blocks();
	let first = &blocks[0];

	let expected: [(&str, &[&str]); 4] = [
		("let alpha = 11;", &["11"]),
		("let bravo = 22;", &["22"]),
		("let carol = 3;", &[]),
		("let delta = 44;", &["44"]),
	];
	for (offset, (text, tokens)) in expected.iter().enumerate() {
		let (row_text, spans) = &first.added[offset];
		assert_eq!(row_text, text, "block 0 added row {offset}");
		assert_eq!(
			highlighted(row_text, spans),
			*tokens,
			"block 0 added row {offset} ({row_text:?}) highlights the token it introduced"
		);
	}

	let removed_expected: [(&str, &[&str]); 4] = [
		("let alpha = 1;", &["1"]),
		("let bravo = 2;", &["2"]),
		("let carol = 3;", &[]),
		("let delta = 4;", &["4"]),
	];
	for (offset, (text, tokens)) in removed_expected.iter().enumerate() {
		let (row_text, spans) = &first.removed[offset];
		assert_eq!(row_text, text, "block 0 removed row {offset}");
		assert_eq!(
			highlighted(row_text, spans),
			*tokens,
			"block 0 removed row {offset} ({row_text:?}) highlights the token it lost"
		);
	}
}

#[test]
fn a_pair_whose_two_lines_are_identical_highlights_nothing_on_either_side() {
	let blocks = fixture_blocks();
	let (old_text, old_spans) = &blocks[0].removed[2];
	let (new_text, new_spans) = &blocks[0].added[2];

	assert_eq!(old_text, new_text, "the third pair of block 0 is the unchanged one");
	assert!(
		old_spans.is_empty() && new_spans.is_empty(),
		"an identical pair carries no highlight: {old_spans:?} / {new_spans:?}"
	);
}

#[test]
fn a_long_block_keeps_highlighting_past_its_halfway_point() {
	// A run long enough that a lookup counting backwards through the pushed
	// rows leaves the removed run entirely, which is where the highlights
	// stopped arriving. Every added row here replaced a line that differs, so
	// every one of them owes a span.
	let mut text = String::new();
	text.push_str("diff --git a/src/long.rs b/src/long.rs\n");
	text.push_str("--- a/src/long.rs\n");
	text.push_str("+++ b/src/long.rs\n");
	text.push_str("@@ -1,32 +1,32 @@\n");
	for line in 0..32 {
		let _ = writeln!(text, "-const N{line}: usize = {line};");
	}
	for line in 0..32 {
		let _ = writeln!(text, "+const N{line}: usize = {};", line + 100);
	}

	let files = parse_diff(&text);
	let blocks = blocks(&files[0].rows);
	assert_eq!(blocks.len(), 1, "one run of removed rows and one of added rows is one block");
	let block = &blocks[0];
	assert_eq!(block.removed.len(), 32);
	assert_eq!(block.added.len(), 32);

	for (offset, (row_text, spans)) in block.added.iter().enumerate() {
		assert_eq!(
			highlighted(row_text, spans),
			vec![format!("{}", offset + 100)],
			"added row {offset} ({row_text:?}) highlights the value it introduced"
		);
	}
	for (offset, (row_text, spans)) in block.removed.iter().enumerate() {
		assert_eq!(
			highlighted(row_text, spans),
			vec![format!("{offset}")],
			"removed row {offset} ({row_text:?}) highlights the value it lost"
		);
	}
}
