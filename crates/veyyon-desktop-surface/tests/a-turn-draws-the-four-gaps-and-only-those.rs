//! WHY: §5.3 gives the session surface four vertical gaps and calls four "the
//! target and the ceiling": 0 between consecutive muted event lines, 4 between
//! blocks of one group, 8 between groups in one turn, 16 between turns. The
//! renderer read three of them. `turn_groups_gap` was authored, loaded, typed
//! and never read by any surface, so a tool call followed by prose — a change
//! of subject — sat at the same 4px as two tool calls in a row, and a long run
//! of activity did not read as one band. The defect class is a rhythm step that
//! exists in the tokens and nowhere on the frame.
//!
//! The class closes two ways. `block_gap` is swept over every ordered pair of
//! block shapes enumerated from `BlockShape` at run time, and the set of steps
//! it produces must be exactly the three intra-turn tokens: a dead token or a
//! collapsed ladder fails here. Then the gaps are measured off real frames by
//! permuting one turn's blocks, which holds the content height fixed and moves
//! only the gaps, so the observed height delta is the gap delta and nothing
//! else.
//!
//! What this does not catch: a gap authored at the wrong step (`s2` where §5.3
//! wants `s4`). The tokens are the authority for the values; this suite pins
//! which token reaches which boundary.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{ColorRole, TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_scene::headless::{
	Headless, RenderOptions, headless_context, render_view_captured,
};
use veyyon_desktop_surface::{
	damage::LaidOut,
	install_tokens,
	model::{Artifact, Block, BlockShape, ToolInvocationViews, Turn},
	transcript::{block_gap, transcript_column},
};
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{
	App, AppContext, Context, IntoElement, ParentElement, Render, Styled, Window, div, px,
};

/// The column the transcript is measured at, so wrapping is identical across
/// every permutation.
const MEASURE_PX: f32 = 768.0;

/// Every block a turn can hold. The match is exhaustive, so a new `Block`
/// variant does not compile until someone decides which gap it sits at.
#[must_use]
fn sample(shape: BlockShape) -> Block {
	match shape {
		BlockShape::Prose => Block::Prose("prose".to_owned()),
		BlockShape::Note => {
			Block::Note { label: "note", text: "noted".to_owned(), boundary: false }
		},
		BlockShape::Invoke => Block::Invoke {
			call_id: "call".to_owned(),
			tool:    "read".to_owned(),
			target:  "src/lib.rs".to_owned(),
			result:  Some("ok".to_owned()),
			views:   ToolInvocationViews::default(),
		},
		BlockShape::Reason => Block::Reason("thought".to_owned()),
		BlockShape::Pane => {
			Block::Pane { caption: "output".to_owned(), lines: vec!["line".to_owned()] }
		},
		BlockShape::Unknown => {
			Block::Unknown { producer: "ext".to_owned(), lines: vec!["raw".to_owned()] }
		},
		BlockShape::Artifact => Block::Artifact(Artifact::File {
			path:               "src/lib.rs".to_owned(),
			has_content:        true,
			lines:              Some(4),
			bytes:              Some(96),
			unavailable_reason: None,
			image:              None,
		}),
	}
}

#[test]
fn every_pair_of_blocks_sits_at_one_of_the_three_gaps_a_turn_owns() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let geometry = &tokens.surface.transcript;
	let shapes: Vec<BlockShape> = BlockShape::iter().collect();
	assert_eq!(
		shapes.len(),
		7,
		"a block shape was added or removed; decide which of §5.3's gaps it sits at",
	);

	let authored =
		[geometry.adjacent_same_kind_gap, geometry.group_blocks_gap, geometry.turn_groups_gap];
	let mut reached = Vec::new();
	for previous in &shapes {
		for current in &shapes {
			let gap = block_gap(&sample(*previous), &sample(*current), geometry);
			assert!(
				authored.contains(&gap),
				"{previous:?} above {current:?} draws {gap}px, which is no authored rhythm step",
			);
			if !reached.contains(&gap) {
				reached.push(gap);
			}

			// A change of subject is never tighter than staying with one: that
			// ordering is what makes a run of activity read as one band.
			let staying = block_gap(&sample(*previous), &sample(*previous), geometry);
			assert!(
				gap >= staying,
				"{previous:?} above {current:?} draws {gap}px, tighter than the {staying}px \
				 {previous:?} keeps with its own kind",
			);
		}
	}

	reached.sort_by(f32::total_cmp);
	let mut expected = authored.to_vec();
	expected.sort_by(f32::total_cmp);
	assert_eq!(
		reached, expected,
		"a turn reaches {reached:?} of the authored {expected:?}; an authored step no surface draws \
		 is a step that does not exist",
	);

	// The zero step is §5.3's "consecutive muted events" and nothing else. An
	// `Unknown` line is muted too, but it expands into a pane, and two panes
	// touching read as one.
	for previous in &shapes {
		for current in &shapes {
			let gap = block_gap(&sample(*previous), &sample(*current), geometry);
			let both_notes = matches!((previous, current), (BlockShape::Note, BlockShape::Note));
			assert_eq!(
				gap == geometry.adjacent_same_kind_gap,
				both_notes,
				"{previous:?} above {current:?} draws {gap}px at the zero step",
			);
		}
	}
}

#[test]
fn permuting_a_turn_moves_its_ink_by_exactly_the_gap_it_changed() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let geometry = tokens.surface.transcript;
	let prose = || Block::Prose("prose".to_owned());
	let note = || Block::Note { label: "note", text: "noted".to_owned(), boundary: false };
	let invoke = || Block::Invoke {
		call_id: "call".to_owned(),
		tool:    "read".to_owned(),
		target:  "src/lib.rs".to_owned(),
		result:  Some("ok".to_owned()),
		views:   ToolInvocationViews::default(),
	};

	let mut cx = headless_context().expect("a headless renderer is required to measure the column");

	// Each pair holds the same blocks, opens with the same kind and closes with
	// the same kind, so the content between the first and last ink is identical
	// and the extent delta is the gap delta and nothing else.
	let grouped = ink_extent(&mut cx, vec![Turn::Agent {
		blocks: vec![invoke(), invoke(), prose(), note()],
		model:  None,
	}]);
	let split = ink_extent(&mut cx, vec![Turn::Agent {
		blocks: vec![invoke(), prose(), invoke(), note()],
		model:  None,
	}]);
	assert_eq!(
		round_px(split - grouped),
		round_px(geometry.turn_groups_gap - geometry.group_blocks_gap),
		"two invocations in a row sit at the group gap and an invocation above prose at the \
		 group-change gap",
	);

	let run = ink_extent(&mut cx, vec![Turn::Agent {
		blocks: vec![note(), note(), invoke(), prose()],
		model:  None,
	}]);
	let broken = ink_extent(&mut cx, vec![Turn::Agent {
		blocks: vec![note(), invoke(), note(), prose()],
		model:  None,
	}]);
	assert_eq!(
		round_px(broken - run),
		round_px(geometry.turn_groups_gap - geometry.adjacent_same_kind_gap),
		"consecutive event lines run with no gap between them",
	);

	let one_turn =
		ink_extent(&mut cx, vec![Turn::Agent { blocks: vec![prose(), prose()], model: None }]);
	let two_turns =
		ink_extent(&mut cx, vec![Turn::Agent { blocks: vec![prose()], model: None }, Turn::Agent {
			blocks: vec![prose()],
			model:  None,
		}]);
	assert_eq!(
		round_px(two_turns - one_turn),
		round_px(geometry.turns_gap - geometry.group_blocks_gap),
		"a turn boundary sits at the turn gap, not at the gap between two of one turn's blocks",
	);
}

/// How far the column's ink reaches, top to bottom, as the frame shaped it.
///
/// Measured from the shaped text runs alone. The window's own ground quad spans
/// the whole surface, so a painted-box extent is the window's height in every
/// permutation and measures nothing.
///
/// # Arguments
/// * `cx` - The headless context holding the offscreen renderer.
/// * `turns` - The turns the column is built from.
#[must_use]
fn ink_extent(cx: &mut Headless, turns: Vec<Turn>) -> f32 {
	let bundled = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let captured = render_view_captured(
		cx,
		&RenderOptions {
			width: MEASURE_PX as u32,
			height: 1200,
			scale_factor: 1.0,
			..RenderOptions::default()
		},
		move |_, app: &mut App| {
			let installed =
				install_tokens(app, &bundled, &theme, Path::new("surface")).expect("installed");
			let geometry = bundled.surface.transcript.clone();
			app.new(|_| ColumnUnderTest {
				turns,
				tokens: installed.set,
				geometry,
				motion: installed.motion,
			})
		},
	)
	.expect("the column renders offscreen");

	let top = captured
		.text_runs
		.iter()
		.map(|run| f32::from(run.bounds.top()))
		.fold(f32::MAX, f32::min);
	let bottom = captured
		.text_runs
		.iter()
		.map(|run| f32::from(run.bounds.bottom()))
		.fold(f32::MIN, f32::max);
	assert!(bottom > top, "the column shaped no text to measure");
	bottom - top
}

/// Rounds to a tenth of a pixel: the renderer lays out in floats and a gap
/// comparison is not a bit comparison.
#[must_use]
fn round_px(value: f32) -> f32 {
	(value * 10.0).round() / 10.0
}

/// The production transcript column with nothing above or beside it.
struct ColumnUnderTest {
	turns:    Vec<Turn>,
	tokens:   TokenSet,
	geometry: TranscriptSurfaceTokens,
	motion:   MotionTokens,
}

impl Render for ColumnUnderTest {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div().w(px(MEASURE_PX)).child(transcript_column(
			&self.turns,
			&self.geometry,
			ColorRole::Inset,
			&self.tokens,
			&self.motion,
			&LaidOut::default(),
			MEASURE_PX,
		))
	}
}
