//! WHY: the transcript drew its text and answered no drag, and the first
//! answer to that stops at the edge of whatever the press landed in. A reader
//! quoting an exchange takes the question and the answer, and a reader
//! dragging over a word whose accent is set in bold takes the whole letter,
//! not the letter without its accent.
//!
//! CLASS CLOSED: what one selection spans, at the two boundaries a projection
//! can stop at without looking wrong on the frame -- the boundary between two
//! entries, which is the last boundary between drawn spans, and the boundary
//! between two inline runs of one paragraph, where the shaper starts a new run
//! inside a grapheme cluster. Both drive the live window: a real `ShellView`,
//! the production block renderers, and the same projection the copy chord puts
//! on the clipboard.
//!
//! GAPS: it reads which bytes come back and not the colour they repaint on,
//! which the token suites read. Where a press inside one run resolves is
//! `a-drag-over-the-transcript-selects-the-words-it-crossed`, what a chord
//! takes out of the window is
//! `the-copy-chord-takes-the-text-the-transcript-drew`, and which blocks state
//! spans at all is
//! `every-block-states-its-spans-or-records-that-it-offers-none`.

use veyyon_desktop_kit::document_spans;
use veyyon_desktop_surface::model::{Block, Turn};
use veyyon_gpui::{Point, px};

#[path = "support/text-selection/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared selection helpers")]
mod harness;

use harness::{FIRST, SECOND, along, cluster_offsets, render_session, run_holding};

/// Two entries, which is the smallest transcript a drag can cross an entry
/// boundary in: one span in each, so a selection that reaches the second has
/// left the first behind rather than moved inside it.
fn two_entries() -> Vec<Turn> {
	vec![Turn::Agent { blocks: vec![Block::Prose(FIRST.into())], model: None }, Turn::Agent {
		blocks: vec![Block::Prose(SECOND.into())],
		model:  None,
	}]
}

#[test]
fn a_drag_from_one_entry_into_the_next_takes_a_line_of_each() {
	let selected = render_session(two_entries(), |session| {
		let rest = session.frame().expect("frame renders");
		let first = run_holding(&rest, FIRST);
		let second = run_holding(&rest, SECOND);
		assert!(
			second.origin.y > first.origin.y,
			"the second entry is drawn under the first, or this drag never crosses an entry"
		);
		session
			.drag(along(first, 0.5), along(second, 0.5))
			.expect("the drag reaches the second entry");
		session
			.update(|view, _window, _cx| view.selected_text())
			.expect("the view reads back its selection")
	});

	let (head, tail) = selected.split_once('\n').unwrap_or_else(|| {
		panic!("a selection across two entries comes back as one line of each, copied {selected:?}")
	});
	assert!(
		!head.is_empty() && FIRST.ends_with(head),
		"the selection starts where the press landed in the first entry and runs to its end, copied \
		 {head:?}"
	);
	assert!(
		!tail.is_empty() && SECOND.starts_with(tail),
		"the selection ends where the drag stopped in the second entry, copied {tail:?}"
	);
}

/// A paragraph whose combining accent is set in a run of its own: the letter
/// is plain and the accent is bold, so the shaper starts a new run inside one
/// grapheme cluster and an offset resolved at the run boundary would cut the
/// letter off its accent.
const SPLIT_RUN: &str = "the shelf label reads cafe**\u{301}** and the rest of the sign is plain.";

/// How many stops the pointer is dragged to across the paragraph. The frame
/// records the paragraph as one box rather than one run per glyph, so the
/// stops sweep its width instead of aiming at the split. There are more of
/// them than the sentence has characters, so a stop lands on either side of
/// the accent rather than stepping over the letter it belongs to.
const STOPS: usize = 120;

#[test]
fn a_cluster_split_across_two_inline_runs_is_never_cut_in_half() {
	let span = document_spans(SPLIT_RUN)
		.first()
		.expect("the paragraph draws one span")
		.clone();
	assert!(
		span.contains("cafe\u{301}"),
		"the markers come off and the accent stays on the letter before it, drew {span:?}"
	);

	let taken = render_session(
		vec![Turn::Agent { blocks: vec![Block::Prose(SPLIT_RUN.into())], model: None }],
		|session| {
			let rest = session.frame().expect("frame renders");
			let paragraph = run_holding(&rest, "the rest of the sign");
			let from = Point { x: paragraph.origin.x + px(1.0), y: along(paragraph, 0.0).y };
			let mut taken: Vec<String> = Vec::new();
			for stop in 0..=STOPS {
				let across = paragraph.size.width * (stop as f32 / STOPS as f32);
				session
					.drag(from, Point { x: paragraph.origin.x + across, y: from.y })
					.expect("the drag reaches the stop");
				taken.push(
					session
						.update(|view, _window, _cx| view.selected_text())
						.expect("the view reads back its selection"),
				);
			}
			taken
		},
	);

	assert!(
		taken.iter().any(|text| text.contains("cafe\u{301}")),
		"no stop of the drag reached past the accent, so nothing here would notice it being cut off \
		 the letter"
	);
	let clusters = cluster_offsets(&span);
	for text in taken.iter().filter(|text| !text.is_empty()) {
		let start = span.find(text.as_str()).unwrap_or_else(|| {
			panic!("every stop copies a piece of the span the frame drew, copied {text:?}")
		});
		let end = start + text.len();
		for (offset, cluster) in &clusters {
			if *offset < end && offset + cluster.len() > start {
				assert!(
					*offset >= start && offset + cluster.len() <= end,
					"the copy {text:?} cuts the cluster {cluster:?} at byte {offset}, so a reader \
					 takes a letter without its accent"
				);
			}
		}
	}
}
