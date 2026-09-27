//! WHY: a turn the window drew states its words when it is taken out of the
//! window, and a block whose words never reach `turn_text` is copied as a gap:
//! the paste is short a line and nothing on screen says so.
//!
//! CLASS CLOSED: the block projection is swept over `BlockShape` at run time,
//! so a block kind added to the transcript states its text or this is red, and
//! the turn projection is swept over the `Turn` union, whose arms are named by
//! an exhaustive match rather than by a list here.
//!
//! GAPS: this is the projection alone. That a press reaches it, that the turn
//! under the pointer is the turn copied, and that the platform clipboard holds
//! the result are driven through the real window by
//! `a-turn-the-window-drew-can-be-taken-out-of-it.rs`.

use std::sync::Arc;

use strum::IntoEnumIterator;
use veyyon_desktop_model::tool_view::{StatusRowView, ToolView};
use veyyon_desktop_surface::{
	Artifact, Block, BlockShape, ToolInvocationViews, Turn, transcript::turn_text,
};

/// One block of each shape, with the words its copy must state.
///
/// The match is exhaustive over `BlockShape`, so a block kind added to the
/// transcript stops this compiling until it states what it copies.
fn sample_block(shape: BlockShape) -> (Block, Vec<&'static str>) {
	match shape {
		BlockShape::Prose => (Block::Prose("the linker resolves symbols".to_owned()), vec![
			"the linker resolves symbols",
		]),
		BlockShape::Note => (
			Block::Note {
				label:    "compacted",
				text:     "nine turns folded into one".to_owned(),
				boundary: true,
			},
			vec!["compacted", "nine turns folded into one"],
		),
		BlockShape::Invoke => (
			Block::Invoke {
				call_id: "c9".to_owned(),
				tool:    "read".to_owned(),
				target:  "crates/veyyon-desktop-surface/src/transcript.rs".to_owned(),
				result:  Some("93 lines".to_owned()),
				views:   ToolInvocationViews::default(),
			},
			vec!["read", "crates/veyyon-desktop-surface/src/transcript.rs", "93 lines"],
		),
		BlockShape::Reason => {
			(Block::Reason("weighing two spellings".to_owned()), vec!["weighing two spellings"])
		},
		BlockShape::Pane => (
			Block::Pane {
				caption: "scripts/verify-scene.ts".to_owned(),
				lines:   vec!["const scene = read(path);".to_owned(), "verify(scene);".to_owned()],
			},
			vec!["scripts/verify-scene.ts", "const scene = read(path);", "verify(scene);"],
		),
		BlockShape::Unknown => (
			Block::Unknown {
				producer: "some-other-host".to_owned(),
				lines:    vec!["a record this build has no renderer for".to_owned()],
			},
			vec!["some-other-host", "a record this build has no renderer for"],
		),
		BlockShape::Artifact => (
			Block::Artifact(Artifact::File {
				path:               "docs/handbook/src/foundations/verification.md".to_owned(),
				has_content:        true,
				lines:              Some(204),
				bytes:              Some(8_192),
				unavailable_reason: None,
				image:              None,
			}),
			vec!["docs/handbook/src/foundations/verification.md"],
		),
		BlockShape::Report => (
			Block::Report {
				variant: "skill-prompt".to_owned(),
				view:    Arc::new(ToolView::StatusRow(StatusRowView::new("skill: release-cut"))),
				lines:   vec!["skill: release-cut".to_owned()],
			},
			vec!["skill: release-cut"],
		),
	}
}

/// Which arm of the union a turn is, named by the turn itself so a variant
/// added to `Turn` stops this compiling.
const fn turn_kind(turn: &Turn) -> &'static str {
	match turn {
		Turn::Operator(_) => "Operator",
		Turn::OperatorArtifacts { .. } => "OperatorArtifacts",
		Turn::Agent { .. } => "Agent",
	}
}

/// One turn of each kind, with the words its copy must state.
fn sample_turns() -> Vec<(Turn, Vec<&'static str>)> {
	vec![
		(Turn::Operator("what does a linker do?".to_owned()), vec!["what does a linker do?"]),
		(
			Turn::OperatorArtifacts {
				text:      "look at this".to_owned(),
				artifacts: vec![
					Artifact::Image {
						media_type: "image/png".to_owned(),
						data:       Arc::from(&[0u8, 1, 2][..]),
						alt:        Some("the composer at 960px".to_owned()),
					},
					Artifact::File {
						path:               "proof/scenes/lib.sh".to_owned(),
						has_content:        false,
						lines:              None,
						bytes:              None,
						unavailable_reason: Some("not read".to_owned()),
						image:              None,
					},
				],
			},
			vec!["look at this", "the composer at 960px", "proof/scenes/lib.sh"],
		),
		(
			Turn::Agent {
				blocks: vec![
					Block::Reason("reading the two files".to_owned()),
					Block::Prose("it resolves symbols to addresses".to_owned()),
				],
				model:  Some("local/qwen2.5-1.5b".to_owned()),
			},
			vec!["reading the two files", "it resolves symbols to addresses"],
		),
	]
}

#[test]
fn every_block_a_turn_can_hold_states_its_words_when_the_turn_is_taken_out() {
	let mut swept: Vec<BlockShape> = Vec::new();
	for shape in BlockShape::iter() {
		let (block, wanted) = sample_block(shape);
		let copied = turn_text(&Turn::Agent { blocks: vec![block], model: None });
		for words in &wanted {
			assert!(
				copied.contains(words),
				"a {shape:?} block states `{words}` when it is copied, copied `{copied}`"
			);
		}
		swept.push(shape);
	}
	assert_eq!(
		swept.len(),
		BlockShape::iter().count(),
		"every block kind the transcript holds is swept"
	);
}

#[test]
fn every_kind_of_turn_states_its_words_when_it_is_taken_out() {
	let samples = sample_turns();
	let kinds: Vec<&str> = samples.iter().map(|(turn, _)| turn_kind(turn)).collect();
	assert_eq!(
		kinds,
		["Operator", "OperatorArtifacts", "Agent"],
		"every arm of the turn union is swept, in the order the union states them"
	);

	for (turn, wanted) in samples {
		let copied = turn_text(&turn);
		for words in wanted {
			assert!(
				copied.contains(words),
				"a {} turn states `{words}` when it is copied, copied `{copied}`",
				turn_kind(&turn)
			);
		}
	}
}
