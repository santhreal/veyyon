//! WHY: the transcript drew every word a session produced and a reader could
//! take none of them by hand. The turn menu copied a whole turn, which is the
//! answer for a turn and no answer at all for one sentence of it, one path out
//! of a refusal, or one line of a command's output, so a reader who wanted a
//! path retyped it from the screen.
//!
//! CLASS CLOSED: where a press and a drag resolve to, over the shapes an
//! offset is got wrong in -- a paragraph that wrapped, a right-to-left run, a
//! combining accent, an emoji cluster joined by a zero-width joiner, the last
//! character of a line, and a line drawn wider than the box that clips it.
//! Every case drives the live window: a real `ShellView`, the real transcript
//! viewport and the production block renderers, read back through the same
//! projection the copy chord puts on the clipboard.
//!
//! GAPS: it reads which bytes a selection covers and that the covered words
//! repaint, not the colour of the ground they repaint on, which the token
//! suites read. It drives one window width; a paragraph that wraps at another
//! measure is covered by the wrapped case here rather than by a sweep of
//! widths. What a chord takes out of the window is
//! `the-copy-chord-takes-the-text-the-transcript-drew`, which blocks state
//! spans at all is
//! `every-block-states-its-spans-or-records-that-it-offers-none`, and what one
//! selection spans across an entry boundary and across two inline runs of one
//! paragraph is `a-selection-crosses-the-entries-and-the-runs-a-turn-drew`.
//! What a copy carries is read from the spans a block records, so the clipped
//! case pins that record against the drawing rather than pinning the shaper:
//! a renderer that hands the shaper a different string cannot change what
//! comes back, and the offset it resolves is what that case reads.

use veyyon_desktop_kit::document_spans;
use veyyon_desktop_surface::model::{Block, Turn};
use veyyon_gpui::{Point, px};

#[path = "support/text-selection/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared selection helpers")]
mod harness;

use harness::{
	FIRST, PANE_CAPTION, PANE_LINES, SECOND, along, changed_pixels, cluster_offsets, render_session,
	render_session_still, run_holding, run_labelled, two_paragraphs,
};

#[test]
fn a_drag_across_two_blocks_selects_the_words_it_crossed_and_draws_them_selected() {
	let (selected, repainted) = render_session(two_paragraphs(), |session| {
		let rest = session.frame().expect("frame renders");
		let first = run_holding(&rest, FIRST);
		let second = run_holding(&rest, SECOND);
		session
			.drag(along(first, 0.5), along(second, 0.5))
			.expect("the drag reaches the second paragraph");
		let dragged = session.frame().expect("frame renders after the drag");
		let selected = session
			.update(|view, _window, _cx| view.selected_text())
			.expect("the view reads back its selection");
		(selected, changed_pixels(&rest.frame, &dragged.frame, second))
	});

	let (head, tail) = selected.split_once('\n').unwrap_or_else(|| {
		panic!("a drag across two blocks copies one line per block, copied {selected:?}")
	});
	assert!(
		!head.is_empty() && FIRST.ends_with(head),
		"the first line copied is the tail of the first paragraph, was {head:?}"
	);
	assert!(
		!tail.is_empty() && SECOND.starts_with(tail),
		"the second line copied is the head of the second paragraph, was {tail:?}"
	);
	assert!(
		repainted > 0,
		"the second paragraph is under the selection and repainted nothing, so a reader cannot see \
		 what is selected"
	);
}

#[test]
fn a_drag_into_the_last_character_of_a_line_takes_that_character() {
	let selected = render_session(two_paragraphs(), |session| {
		let rest = session.frame().expect("frame renders");
		let first = run_holding(&rest, FIRST);
		// A quarter of a glyph in from the run's right edge, which is inside
		// the last character and past its middle. A reader who drags there
		// means that character; a resolution that took the glyph the position
		// sits inside would stop at that glyph's own start and hand back a
		// sentence one character short of what the drag crossed.
		let glyph = first.size.width / FIRST.chars().count() as f32;
		let into_last =
			Point { x: first.origin.x + first.size.width - glyph / 4.0, y: along(first, 0.5).y };
		session
			.drag(along(first, 0.0), into_last)
			.expect("the drag reaches the end of the paragraph");
		session
			.update(|view, _window, _cx| view.selected_text())
			.expect("the view reads back its selection")
	});

	assert_eq!(
		selected, FIRST,
		"a drag from the start of the paragraph into its last character took {selected:?}, so the \
		 character the pointer was over is unreachable"
	);
}

#[test]
fn a_press_with_shift_extends_the_selection_rather_than_starting_a_new_one() {
	let (plain, extended) = render_session(two_paragraphs(), |session| {
		let rest = session.frame().expect("frame renders");
		let first = run_holding(&rest, FIRST);
		let second = run_holding(&rest, SECOND);
		session.click(along(first, 0.25)).expect("the press lands");
		let plain = session
			.update(|view, _window, _cx| view.selected_text())
			.expect("the view reads back its selection");
		session
			.shift_click(along(second, 0.75))
			.expect("the extending press lands");
		let extended = session
			.update(|view, _window, _cx| view.selected_text())
			.expect("the view reads back its selection");
		(plain, extended)
	});

	assert!(plain.is_empty(), "a press that has not been dragged selects nothing, copied {plain:?}");
	let (head, tail) = extended.split_once('\n').unwrap_or_else(|| {
		panic!("a shift-press in the second block extends across both, copied {extended:?}")
	});
	assert!(
		!head.is_empty() && FIRST.ends_with(head),
		"the extended selection starts where the first press landed, copied {head:?}"
	);
	assert!(
		tail.len() > SECOND.len() / 2 && SECOND.starts_with(tail),
		"the extended selection ends where the shift-press landed, copied {tail:?}"
	);
}

/// A paragraph carrying the shapes a byte offset is got wrong in: a line long
/// enough to wrap at this measure, a right-to-left run, a combining accent,
/// and an emoji cluster joined by a zero-width joiner.
const AWKWARD: &str = "The run wrote one long line that has to wrap at this measure because it \
                       keeps going past the column, and it names \u{5e9}\u{5dc}\u{5d5}\u{5dd} \
                       \u{5e2}\u{5d5}\u{5dc}\u{5dd}, cafe\u{301}, and \u{1f469}\u{200d}\u{1f4bb} \
                       in one sentence.";

/// How many stops the pointer is dragged to across the paragraph. The frame
/// records a wrapped paragraph as one box rather than one run per glyph, so no
/// stop can be aimed at the emoji: sweeping the width instead lands offsets
/// throughout the sentence, the accent and the joined sequence among them.
const STOPS: usize = 24;

#[test]
fn a_drag_over_a_wrapped_line_never_cuts_a_cluster_or_leaves_the_span() {
	let drawn = document_spans(AWKWARD);
	let span = drawn.first().expect("the paragraph draws one span").clone();
	let taken = render_session(
		vec![Turn::Agent { blocks: vec![Block::Prose(AWKWARD.into())], model: None }],
		|session| {
			let rest = session.frame().expect("frame renders");
			let paragraph = run_holding(&rest, "\u{1f469}\u{200d}\u{1f4bb}");
			let height = f32::from(paragraph.size.height);
			assert!(
				height > 30.0,
				"the paragraph has to wrap for this case to mean anything, drew {height}px of a 22px \
				 line"
			);

			// The press opens at the head of the first line and each stop
			// walks the last one, so the head of the selection travels the
			// whole sentence: the offsets it resolves to are wherever the
			// shaper put the cluster boundaries, not where this test guessed
			// they were.
			let from = Point { x: paragraph.origin.x + px(1.0), y: paragraph.origin.y + px(11.0) };
			let last_line = paragraph.origin.y + paragraph.size.height - px(11.0);
			let mut taken: Vec<String> = Vec::new();
			for stop in 0..=STOPS {
				let across = paragraph.size.width * (stop as f32 / STOPS as f32);
				session
					.drag(from, Point { x: paragraph.origin.x + across, y: last_line })
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

	let clusters = cluster_offsets(&span);
	let mut reached: Vec<&String> = taken.iter().filter(|text| !text.is_empty()).collect();
	reached.dedup();
	assert!(
		reached.len() >= 4,
		"a drag across the paragraph selects more the further it goes; {} of {STOPS} stops selected \
		 anything at all",
		reached.len()
	);
	assert!(
		taken
			.iter()
			.any(|text| text.contains("\u{1f469}\u{200d}\u{1f4bb}")),
		"no stop of the drag reached past the joined sequence, so nothing here would notice it \
		 being cut"
	);

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
					 takes half a character"
				);
			}
		}
	}
}

#[test]
fn one_line_of_a_command_s_output_is_selected_after_the_row_that_opened_it() {
	let selected = render_session_still(
		vec![Turn::Agent {
			blocks: vec![Block::Pane {
				caption: PANE_CAPTION.into(),
				lines:   PANE_LINES.iter().map(|line| (*line).to_owned()).collect(),
			}],
			model:  None,
		}],
		true,
		|session| {
			let collapsed = session.frame().expect("frame renders");
			assert!(
				collapsed
					.text_runs
					.iter()
					.all(|run| !run.text.as_ref().contains(PANE_LINES[0])),
				"the pane draws its lines only once the row is open, so this case has to open it"
			);
			session
				.click(along(run_labelled(&collapsed, PANE_CAPTION), 0.5))
				.expect("the press opens the row");
			let opened = session.frame().expect("frame renders after the row opened");
			let line = run_holding(&opened, PANE_LINES[0]);
			session
				.drag(along(line, 0.1), along(line, 0.9))
				.expect("the drag stays inside the line");
			session
				.update(|view, _window, _cx| view.selected_text())
				.expect("the view reads back its selection")
		},
	);

	assert!(
		!selected.is_empty() && PANE_LINES[0].contains(selected.as_str()),
		"a drag along one line of the output copies a piece of that line and nothing of the line \
		 under it, copied {selected:?}"
	);
}

/// One line of output longer than the box the pane draws it in. The pane sets
/// what fits and ends it with the truncation mark, so the text the shaper laid
/// out and the text the span carries are two different strings.
const TRUNCATED_LINE: &str = "running 1 test in target/debug/deps/a_very_long_binary_name_that \
                              _will_not_fit_the_pane-0123456789abcdef --nocapture --test-threads \
                              1 and a tail nobody can see";

#[test]
fn a_drag_across_a_truncated_line_takes_its_text_and_not_the_mark() {
	let (selected, drawn) = render_session_still(
		vec![Turn::Agent {
			blocks: vec![Block::Pane {
				caption: PANE_CAPTION.into(),
				lines:   vec![TRUNCATED_LINE.to_owned()],
			}],
			model:  None,
		}],
		true,
		|session| {
			let collapsed = session.frame().expect("frame renders");
			session
				.click(along(run_labelled(&collapsed, PANE_CAPTION), 0.5))
				.expect("the press opens the row");
			let opened = session.frame().expect("frame renders after the row opened");
			let run = opened
				.text_runs
				.iter()
				.find(|run| run.text.as_ref().starts_with("running 1 test"))
				.expect("the pane draws the line it was given")
				.clone();
			// The head stops one pixel inside the last glyph the pane drew,
			// which is the mark it ended the line with: what comes back states
			// whether the span carries the text or the drawing of it.
			session
				.drag(along(run.bounds, 0.02), Point {
					x: run.bounds.right() - px(1.0),
					y: along(run.bounds, 0.0).y,
				})
				.expect("the drag runs the length of the line as it was drawn");
			let taken = session
				.update(|view, _window, _cx| view.selected_text())
				.expect("the view reads back its selection");
			(taken, run.text.as_ref().to_owned())
		},
	);

	assert!(
		drawn.len() < TRUNCATED_LINE.len(),
		"the pane drew the whole line, so nothing here is truncated and this case proves nothing \
		 about a line set shorter than the text behind it"
	);
	assert!(
		!selected.is_empty() && TRUNCATED_LINE.contains(selected.as_str()),
		"a drag along a truncated line takes a run of the line behind it, took {selected:?}"
	);
	assert!(
		!selected.contains('\u{2026}'),
		"the copy carries the mark the pane ended the line with, which is a character the run never \
		 wrote: {selected:?}"
	);
	assert!(
		selected.len() <= drawn.len(),
		"a drag that ended inside the drawn line took {} bytes of the {} the pane set, so an offset \
		 resolves past the glyphs the reader can see",
		selected.len(),
		drawn.len()
	);
}
