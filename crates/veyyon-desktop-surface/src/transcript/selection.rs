//! Selecting the words a transcript drew, and taking them out of the window
//! (§5.3).
//!
//! WHY: a turn could be copied whole from its menu and nothing smaller could be
//! taken at all. One sentence of an answer, one path out of a refusal and one
//! line of a command's output were drawn and unreachable, so a reader who
//! wanted a path retyped it.
//!
//! A selection is two points in the transcript, and a point is a byte offset in
//! one drawn span. The id of a span is built from where it sits -- the turn,
//! the block inside the turn, then the span inside the block -- so comparing
//! two ids compares two places on the frame, and a selection covers the whole
//! of every span between its ends without naming them.
//!
//! The spans a block draws and the text this module reads back are the same
//! list in the same order. [`block_spans`] is exhaustive over `Block`, so a
//! block kind added to the transcript states its spans here or the crate does
//! not compile, and [`SELECTION_OPT_OUTS`] names the kinds that deliberately
//! offer none.

use veyyon_desktop_kit::{
	Markdown, SelectableProse, SpanGesture, SpanId, SpanPoint, TextSelection, document_spans,
};
use veyyon_gpui::WeakEntity;

use crate::{
	ShellView,
	model::{Block, Turn},
};

/// Bits an id reserves for the spans inside one block.
const SPAN_BITS: u32 = 20;
/// Bits an id reserves for the blocks inside one turn.
const BLOCK_BITS: u32 = 20;

/// The id the spans of one block are numbered from.
///
/// Ordering is the frame's own: an earlier turn sorts before a later one, and
/// an earlier block of the same turn before a later block, whatever each block
/// drew. The indices are masked rather than wrapped, so a transcript past the
/// ceiling numbers its last spans together instead of numbering them under an
/// earlier block.
#[must_use]
pub const fn block_base(turn_ix: usize, block_ix: usize) -> SpanId {
	let turn = (turn_ix as u64) & ((1 << (64 - BLOCK_BITS - SPAN_BITS)) - 1);
	let block = (block_ix as u64) & ((1 << BLOCK_BITS) - 1);
	SpanId((turn << (BLOCK_BITS + SPAN_BITS)) | (block << SPAN_BITS))
}

/// The block kinds that draw no selectable span, and why.
///
/// An artifact is a picture or a file row: its text is a name the chrome draws
/// beside a control, not prose a reader drags over. A tool card's body is the
/// host's own presentation, which draws its rows through the tool view
/// renderers rather than through this module's spans.
pub const SELECTION_OPT_OUTS: [&str; 2] = ["Artifact", "Invoke with a host view"];

/// What a block hands the pointer: the text of each span it draws, in the
/// order it draws them.
///
/// A row that toggles the block is not a span -- a drag over it would fight
/// the press that expands it -- so a collapsed block states the text of the
/// body it would expand to and draws none of it until it is open. That is what
/// makes a selection stable across an expansion: the span ids do not move when
/// the body appears.
#[must_use]
pub fn block_spans(block: &Block) -> Vec<String> {
	match block {
		Block::Prose(text) | Block::Reason(text) => document_spans(text),
		Block::Note { label, text, .. } => {
			vec![if text.is_empty() {
				(*label).to_string()
			} else {
				format!("{label}: {text}")
			}]
		},
		// The pane's lines are its spans; its caption heads the row that opens
		// it.
		Block::Pane { lines, .. } | Block::Unknown { lines, .. } => lines.clone(),
		// A call the host drew a view for states its text through that view; a
		// call with a raw result states the lines of the result.
		Block::Invoke { result, views, .. } => {
			match (views.result.as_ref().or(views.call.as_ref()), result) {
				(Some(_), _) | (None, None) => Vec::new(),
				(None, Some(result)) => result.lines().map(ToOwned::to_owned).collect(),
			}
		},
		Block::Artifact(_) => Vec::new(),
	}
}

/// Every span one turn draws, with the id it draws under.
///
/// An operator turn is one span: the bubble's text. The artifacts under it
/// draw none, so the bubble takes the first block's numbering and nothing
/// collides with it.
#[must_use]
pub fn turn_spans(turn_ix: usize, turn: &Turn) -> Vec<(SpanId, String)> {
	match turn {
		Turn::Operator(text) | Turn::OperatorArtifacts { text, .. } => {
			if text.is_empty() {
				Vec::new()
			} else {
				vec![(block_base(turn_ix, 0), text.clone())]
			}
		},
		Turn::Agent { blocks, .. } => blocks
			.iter()
			.enumerate()
			.flat_map(|(block_ix, block)| {
				let base = block_base(turn_ix, block_ix);
				block_spans(block)
					.into_iter()
					.enumerate()
					.map(move |(index, text)| (base.nth(index as u16), text))
			})
			.collect(),
	}
}

/// What `selection` covers of `turns`, as a reader would take it out of the
/// window.
///
/// The covered piece of each span is joined by the line break the frame draws
/// between them, so a selection across two paragraphs comes out as two lines
/// rather than as one run-on sentence. A span the selection covers nothing of
/// contributes nothing, which is what keeps a drag that ended one pixel into a
/// block from copying a blank line.
#[must_use]
pub fn selected_text(turns: &[Turn], selection: TextSelection) -> String {
	if selection.is_collapsed() {
		return String::new();
	}
	let mut parts: Vec<String> = Vec::new();
	for (turn_ix, turn) in turns.iter().enumerate() {
		for (span, text) in turn_spans(turn_ix, turn) {
			if let Some(range) = selection.range_in(span, text.len()) {
				parts.push(slice(&text, range.start, range.end).to_owned());
			}
		}
	}
	parts.join("\n")
}

/// The whole of one turn, as a selection.
///
/// `None` when the turn drew no selectable span, so the chord that takes an
/// entry leaves the selection alone rather than collapsing it over an empty
/// turn.
#[must_use]
pub fn select_whole_turn(turn_ix: usize, turn: &Turn) -> Option<TextSelection> {
	let spans = turn_spans(turn_ix, turn);
	let (first, _) = spans.first()?;
	let (last, text) = spans.last()?;
	Some(TextSelection::new(SpanPoint::new(*first, 0), SpanPoint::new(*last, text.len())))
}

/// What the selection becomes after `gesture`.
///
/// A press with no modifier starts a new selection where it landed. A press
/// with Shift held, and every move of the pointer with the button down, leave
/// the anchor where it was and move the head, which is what makes a drag back
/// over its own start select backwards rather than swapping its ends.
#[must_use]
pub fn after_gesture(current: Option<TextSelection>, gesture: SpanGesture) -> TextSelection {
	match gesture {
		SpanGesture::Press { at, extend: false } => TextSelection::collapsed(at),
		SpanGesture::Press { at, extend: true } | SpanGesture::Extend(at) => current
			.map_or_else(|| TextSelection::collapsed(at), |held| TextSelection::new(held.anchor, at)),
	}
}

/// What a block hands its drawn text so the text can be selected: the id its
/// spans are numbered from, the selection to draw, and the window to report
/// the pointer to.
///
/// `None` when no window is attached, which is the raster fixture: a frame
/// with nothing to report a gesture to draws its text plain rather than
/// registering listeners that go nowhere.
#[must_use]
pub fn selectable_block(
	view: Option<&WeakEntity<ShellView>>,
	selection: Option<TextSelection>,
	turn_ix: usize,
	block_ix: usize,
) -> Option<SelectableProse> {
	let view = view.cloned()?;
	Some(SelectableProse::new(
		block_base(turn_ix, block_ix),
		selection,
		move |gesture, _window, cx| {
			let _ = view.update(cx, |shell, cx| {
				shell.report_span_gesture(gesture);
				cx.notify();
			});
		},
	))
}

/// `markdown` drawing `selection`, or drawing nothing selectable when the
/// frame has no window to report to.
#[must_use]
pub fn selectable_markdown(markdown: Markdown, prose: Option<SelectableProse>) -> Markdown {
	match prose {
		Some(prose) => markdown.selection(prose),
		None => markdown,
	}
}

/// `text[start..end]`, with both ends moved back to a character boundary.
///
/// The offsets come from the shaper that drew the text, and the text read back
/// here is projected from the state: a projection that has moved on since the
/// frame was drawn states a different length, and slicing a string between two
/// bytes of one character panics.
fn slice(text: &str, start: usize, end: usize) -> &str {
	let start = boundary(text, start.min(text.len()));
	let end = boundary(text, end.min(text.len()));
	&text[start..end.max(start)]
}

/// The character boundary at or before `at`.
const fn boundary(text: &str, at: usize) -> usize {
	let mut at = at;
	while at > 0 && !text.is_char_boundary(at) {
		at -= 1;
	}
	at
}

#[cfg(test)]
mod tests {
	use veyyon_desktop_kit::{SpanId, SpanPoint, TextSelection};

	use super::{block_base, block_spans, select_whole_turn, selected_text, turn_spans};
	use crate::model::{Artifact, Block, ToolInvocationViews, Turn};

	fn agent(blocks: Vec<Block>) -> Turn {
		Turn::Agent { blocks, model: None }
	}

	#[test]
	fn a_block_of_a_later_turn_sorts_after_every_span_of_an_earlier_one() {
		let early = block_base(0, 9).nth(u16::MAX);
		let late = block_base(1, 0);
		assert!(early < late, "{early:?} should sort before {late:?}");
		assert!(block_base(3, 0) < block_base(3, 1));
		assert!(block_base(3, 1).nth(3) < block_base(3, 2));
	}

	#[test]
	fn a_pane_draws_one_span_per_line_and_prose_one_per_paragraph() {
		let pane = Block::Pane { caption: "read".into(), lines: vec!["one".into(), "two".into()] };
		assert_eq!(block_spans(&pane), vec!["one".to_owned(), "two".to_owned()]);

		let prose = Block::Prose("first\n\nsecond".into());
		assert_eq!(block_spans(&prose), vec!["first".to_owned(), "second".to_owned()]);
	}

	#[test]
	fn a_call_the_host_drew_a_view_for_states_no_span_of_its_own() {
		let raw = Block::Invoke {
			call_id: "c1".into(),
			tool:    "read".into(),
			target:  "src/main.rs".into(),
			result:  Some("line one\nline two".into()),
			views:   ToolInvocationViews::default(),
		};
		assert_eq!(block_spans(&raw), vec!["line one".to_owned(), "line two".to_owned()]);
	}

	#[test]
	fn a_selection_across_two_blocks_copies_the_tail_of_one_and_the_head_of_the_next() {
		let turns =
			vec![agent(vec![Block::Prose("hello world".into()), Block::Prose("second line".into())])];
		let selection = TextSelection::new(
			SpanPoint::new(block_base(0, 0), 6),
			SpanPoint::new(block_base(0, 1), 6),
		);
		assert_eq!(selected_text(&turns, selection), "world\nsecond");
	}

	#[test]
	fn a_span_between_the_ends_is_copied_whole() {
		let turns = vec![agent(vec![
			Block::Prose("alpha".into()),
			Block::Prose("beta".into()),
			Block::Prose("gamma".into()),
		])];
		let selection = TextSelection::new(
			SpanPoint::new(block_base(0, 0), 2),
			SpanPoint::new(block_base(0, 2), 3),
		);
		assert_eq!(selected_text(&turns, selection), "pha\nbeta\ngam");
	}

	#[test]
	fn a_collapsed_selection_copies_nothing() {
		let turns = vec![agent(vec![Block::Prose("alpha".into())])];
		let selection = TextSelection::collapsed(SpanPoint::new(block_base(0, 0), 3));
		assert_eq!(selected_text(&turns, selection), "");
	}

	#[test]
	fn an_offset_inside_a_character_is_cut_at_the_boundary_before_it() {
		let turns = vec![agent(vec![Block::Prose("héllo".into())])];
		// One byte into the two-byte `é`, which is no place a string can be cut.
		let selection = TextSelection::new(
			SpanPoint::new(block_base(0, 0), 0),
			SpanPoint::new(block_base(0, 0), 2),
		);
		assert_eq!(selected_text(&turns, selection), "h");
	}

	#[test]
	fn taking_a_whole_turn_covers_its_first_span_to_the_end_of_its_last() {
		let turns = vec![agent(vec![Block::Prose("alpha".into()), Block::Pane {
			caption: "read".into(),
			lines:   vec!["one".into(), "two".into()],
		}])];
		let selection = select_whole_turn(0, &turns[0]).expect("the turn draws spans");
		assert_eq!(selected_text(&turns, selection), "alpha\none\ntwo");
	}

	#[test]
	fn an_operator_turn_draws_its_bubble_as_one_span() {
		let turn = Turn::Operator("what changed?".into());
		assert_eq!(turn_spans(2, &turn), vec![(block_base(2, 0), "what changed?".to_owned())]);
		assert_eq!(turn_spans(2, &Turn::Operator(String::new())), Vec::new());
	}

	#[test]
	fn a_turn_that_drew_nothing_selectable_takes_no_selection() {
		let turn = agent(vec![Block::Artifact(Artifact::File {
			path:               "docs/plan.md".into(),
			has_content:        false,
			lines:              None,
			bytes:              Some(12),
			unavailable_reason: None,
			image:              None,
		})]);
		assert!(select_whole_turn(0, &turn).is_none());
		assert_eq!(turn_spans(0, &turn), Vec::<(SpanId, String)>::new());
	}
}
