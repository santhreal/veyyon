//! Turn rendering: operator bubbles and assistant response blocks (§5.2, §5.3).
//!
//! Enforces the 12 roles / 4 registers and 4 vertical rhythm gaps specified in
//! plan §5.3:
//! - User turns are right-aligned bubbles at 80%–85% of the column with
//!   trailing corner at 4px.
//! - Assistant turns sit bare on the canvas at full width without artificial
//!   speaker framing.
//! - Gaps strictly enforce adjacent same kind (4px) vs group blocks (12px) vs
//!   turns (24px).

use veyyon_desktop_kit::{ColorRole, TokenSet};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{Div, ParentElement, Styled, WeakEntity, div, px};

use super::{
	blocks::{
		render_artifact_block, render_invoke_block, render_note_block, render_pane_block,
		render_prose_block, render_reason_block,
	},
	state::TranscriptViewportState,
};
use crate::{
	ShellView,
	model::{Block, Turn},
};

/// Renders a single turn with appropriate role alignment and rhythm gaps.
pub fn render_turn(
	turn_ix: usize,
	turn: &Turn,
	is_last: bool,
	is_streaming: bool,
	caret_opacity: f32,
	state: &TranscriptViewportState,
	geometry: &TranscriptSurfaceTokens,
	user_ground: ColorRole,
	tokens: &TokenSet,
	motion_tokens: &MotionTokens,
	reduced_motion: bool,
	measure_px: f32,
	view: Option<&WeakEntity<ShellView>>,
) -> Div {
	match turn {
		Turn::Operator(text) => operator_turn(text, geometry, user_ground, tokens, measure_px),
		Turn::OperatorArtifacts { text, artifacts } => {
			let mut turn = div()
				.flex()
				.flex_col()
				.items_end()
				.w_full()
				.gap(px(geometry.group_blocks_gap));
			if !text.is_empty() {
				turn = turn.child(operator_turn(text, geometry, user_ground, tokens, measure_px));
			}
			let mut column = div()
				.flex()
				.flex_col()
				.w_full()
				.max_w(px(measure_px * geometry.user_turn_width_ratio));
			for (block_ix, artifact) in artifacts.iter().enumerate() {
				column = column.child(render_artifact_block(
					turn_ix,
					block_ix,
					artifact,
					state.is_block_expanded(turn_ix, block_ix),
					geometry,
					tokens,
					motion_tokens,
					reduced_motion,
					state,
					view,
				));
			}
			turn.child(column)
		},
		Turn::Agent(blocks) => agent_turn(
			turn_ix,
			blocks,
			is_last,
			is_streaming,
			caret_opacity,
			state,
			geometry,
			tokens,
			motion_tokens,
			reduced_motion,
			view,
		),
	}
}

/// What the operator sent: a tinted bubble, aligned to the trailing edge
/// (§5.3).
pub fn operator_turn(
	text: &str,
	geometry: &TranscriptSurfaceTokens,
	user_ground: ColorRole,
	tokens: &TokenSet,
	measure_px: f32,
) -> Div {
	let bubble_width = measure_px * geometry.user_turn_width_ratio;

	div().flex().flex_row().justify_end().w_full().child(
		div()
			.max_w(px(bubble_width))
			.p(px(geometry.user_turn_padding))
			.bg(tokens.color(user_ground))
			.rounded_tl(px(geometry.user_turn_radius_outer))
			.rounded_tr(px(geometry.user_turn_radius_outer))
			.rounded_bl(px(geometry.user_turn_radius_outer))
			// The trailing corner is drawn tight so the bubble reads as anchored
			// to the operator's side rather than floating.
			.rounded_br(px(geometry.user_turn_radius_trailing))
			.text_size(px(geometry.user_turn_type_size.size))
			.line_height(px(geometry.user_turn_type_size.line_height))
			.text_color(tokens.color(ColorRole::Foreground))
			.child(text.to_owned()),
	)
}

/// What the agent produced: prose, invocations, reasoning, and panes.
pub fn agent_turn(
	turn_ix: usize,
	blocks: &[Block],
	is_last: bool,
	is_streaming: bool,
	caret_opacity: f32,
	state: &TranscriptViewportState,
	geometry: &TranscriptSurfaceTokens,
	tokens: &TokenSet,
	motion_tokens: &MotionTokens,
	reduced_motion: bool,
	view: Option<&WeakEntity<ShellView>>,
) -> Div {
	let mut turn = div().flex().flex_col().w_full();

	for (block_ix, block) in blocks.iter().enumerate() {
		let is_last_block = is_last && (block_ix + 1 == blocks.len());
		let is_expanded = state.is_block_expanded(turn_ix, block_ix);

		let mut rendered = match block {
			Block::Prose(text) => {
				render_prose_block(text, is_last_block && is_streaming, caret_opacity, geometry, tokens)
			},
			Block::Note { label, text, boundary } => render_note_block(label, text, *boundary, tokens),
			Block::Artifact(artifact) => render_artifact_block(
				turn_ix,
				block_ix,
				artifact,
				is_expanded,
				geometry,
				tokens,
				motion_tokens,
				reduced_motion,
				state,
				view,
			),
			Block::Invoke { tool, target, result, .. } => render_invoke_block(
				turn_ix,
				block_ix,
				tool,
				target,
				result.as_deref(),
				is_expanded,
				geometry,
				tokens,
				motion_tokens,
				reduced_motion,
				state,
				view,
			),
			Block::Reason(summary) => render_reason_block(
				turn_ix,
				block_ix,
				summary,
				is_expanded,
				geometry,
				tokens,
				motion_tokens,
				reduced_motion,
				state,
				view,
			),
			Block::Pane { caption, lines } | Block::Unknown { producer: caption, lines } => {
				render_pane_block(
					turn_ix,
					block_ix,
					caption,
					lines,
					is_expanded,
					matches!(block, Block::Unknown { .. }),
					geometry,
					tokens,
					motion_tokens,
					reduced_motion,
					state,
					view,
				)
			},
		};

		if block_ix > 0 {
			let previous = blocks.get(block_ix - 1);
			let gap = if previous.is_some_and(|prev| same_kind(prev, block)) {
				geometry.adjacent_same_kind_gap
			} else {
				geometry.group_blocks_gap
			};
			rendered = rendered.mt(px(gap));
		}

		turn = turn.child(rendered);
	}

	turn
}

/// Whether two blocks are the same kind, for vertical rhythm gap selection.
#[must_use]
pub const fn same_kind(left: &Block, right: &Block) -> bool {
	matches!(
		(left, right),
		(Block::Prose(_), Block::Prose(_))
			| (Block::Note { .. }, Block::Note { .. })
			| (Block::Invoke { .. }, Block::Invoke { .. })
			| (Block::Reason(_), Block::Reason(_))
			| (Block::Pane { .. }, Block::Pane { .. })
			| (Block::Unknown { .. }, Block::Unknown { .. })
			| (Block::Artifact(_), Block::Artifact(_))
	)
}
