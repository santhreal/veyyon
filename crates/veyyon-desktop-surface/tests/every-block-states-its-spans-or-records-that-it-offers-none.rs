//! WHY: a mechanism wired to the block kind someone had in mind, and to none
//! of its siblings, is how this defect returns. Selection is stated per block,
//! so a kind that draws text and reports no span is unselectable in silence.
//!
//! CLASS CLOSED: the kinds are swept from `BlockShape` at run time, so a kind
//! that draws text has to state its spans and a kind that draws none has to be
//! recorded in `SELECTION_OPT_OUTS`, which is pinned here by exact equality. A
//! `Block` variant added to the transcript turns this suite red until its
//! spans, or its opt-out, are recorded.
//!
//! GAPS: a tool card the host drew a view for states its text through the tool
//! view renderers and is recorded as offering no span, so a selection inside
//! one of those rows is out of scope until those rows carry spans of their own.

use std::sync::Arc;

use strum::IntoEnumIterator;
use veyyon_desktop_model::tool_view::{TextBlockView, ToolPresentation, ToolView};
use veyyon_desktop_surface::{
	model::{Artifact, Block, BlockShape, ToolInvocationViews, Turn},
	transcript::{SELECTION_OPT_OUTS, block_spans, select_whole_turn, selected_text},
};

#[path = "support/text-selection/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared selection helpers")]
mod harness;

use harness::{PANE_CAPTION, PANE_LINES};

/// One sample of every kind of block a turn can hold, keyed by its shape, so
/// the sweep reads the union from `BlockShape` rather than from a list written
/// here.
fn sample(shape: BlockShape) -> Block {
	match shape {
		BlockShape::Prose => Block::Prose("A sentence the run wrote.".into()),
		BlockShape::Reason => Block::Reason("What it was working out.".into()),
		BlockShape::Note => {
			Block::Note { label: "Compacted", text: "the earlier turns".into(), boundary: true }
		},
		BlockShape::Invoke => Block::Invoke {
			call_id: "call-1".into(),
			tool:    "bash".into(),
			target:  PANE_CAPTION.into(),
			result:  Some(PANE_LINES.join("\n")),
			views:   ToolInvocationViews::default(),
		},
		BlockShape::Pane => Block::Pane {
			caption: PANE_CAPTION.into(),
			lines:   PANE_LINES.iter().map(|line| (*line).to_owned()).collect(),
		},
		BlockShape::Unknown => Block::Unknown {
			producer: "some-plugin".into(),
			lines:    vec!["a line it recorded".into()],
		},
		BlockShape::Artifact => Block::Artifact(Artifact::File {
			path:               "docs/plan.md".into(),
			has_content:        false,
			lines:              Some(12),
			bytes:              Some(480),
			unavailable_reason: None,
			image:              None,
		}),
	}
}

#[test]
fn every_kind_of_block_either_states_its_spans_or_is_recorded_as_offering_none() {
	let mut offering_none: Vec<String> = Vec::new();
	for shape in BlockShape::iter() {
		let block = sample(shape);
		let spans = block_spans(&block);
		if spans.is_empty() {
			offering_none.push(format!("{shape:?}"));
			continue;
		}

		// Every span a kind states is reachable: the selection the entry chord
		// takes covers it, and what comes back is the text the block drew.
		let turn = Turn::Agent { blocks: vec![block], model: None };
		let selection = select_whole_turn(0, &turn).expect("a block with spans takes a selection");
		let copied = selected_text(std::slice::from_ref(&turn), selection);
		for span in &spans {
			assert!(
				copied.contains(span.as_str()),
				"{shape:?} states the span {span:?} and taking the whole turn copied {copied:?}"
			);
		}
	}

	// An opt-out named by one word is a whole block kind, which is what this
	// sweep can see. One carrying a qualifier is a case of a kind that states
	// spans otherwise, and each of those carries a case of its own below.
	let whole_kinds: Vec<&str> = SELECTION_OPT_OUTS
		.iter()
		.copied()
		.filter(|opt| !opt.contains(' '))
		.collect();
	assert_eq!(
		offering_none.iter().map(String::as_str).collect::<Vec<_>>(),
		whole_kinds,
		"a block kind that draws no selectable span is recorded in SELECTION_OPT_OUTS, and one \
		 recorded there draws none"
	);

	let shapes: Vec<String> = BlockShape::iter()
		.map(|shape| format!("{shape:?}"))
		.collect();
	for opt in SELECTION_OPT_OUTS {
		let named = opt.split_whitespace().next().unwrap_or_default();
		assert!(
			shapes.iter().any(|shape| shape == named),
			"the opt-out {opt:?} names {named:?}, which is no kind of block a turn can hold"
		);
	}
}

#[test]
fn a_call_the_host_drew_a_view_for_states_no_span_and_is_recorded_as_offering_none() {
	assert_eq!(
		SELECTION_OPT_OUTS,
		["Artifact", "Invoke with a host view"],
		"the kinds and cases that draw no selectable span are pinned, so one added or taken away is \
		 a decision rather than a drift"
	);

	let presented = ToolPresentation {
		expanded: true,
		view:     ToolView::TextBlock(TextBlockView::text(PANE_LINES[0])),
	};
	let drawn_by_the_host = Block::Invoke {
		call_id: "call-1".into(),
		tool:    "bash".into(),
		target:  PANE_CAPTION.into(),
		result:  Some(PANE_LINES.join("\n")),
		views:   ToolInvocationViews { call: None, result: Some(Arc::new(presented)) },
	};

	assert!(
		block_spans(&drawn_by_the_host).is_empty(),
		"a call the host drew a view for states its text through that view, not through a span of \
		 this module's, so the raw result is not offered twice"
	);
}
