//! The session surface: the transcript column (§5.2).
//!
//! The column is a fixed measure centred in whatever width is left over, so the
//! line length the operator reads does not change when the queue is resized or
//! the right panel opens. Everything a run produces is drawn at one of four
//! vertical gaps, and which gap applies is decided by what the two neighbouring
//! blocks are: two invocations in a row are one activity and sit tight, an
//! invocation followed by prose is a change of subject and sits apart. That is
//! the whole rhythm, and it is why a long run of tool calls reads as one band
//! rather than a list of unrelated rows.

use veyyon_desktop_kit::{
	CodeBlock, ColorRole, Markdown, MonoSizeStep, SpacingStep, TextRamp, TextWeight, TokenSet,
	Truncate,
};
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{Div, IntoElement, ParentElement, SharedString, Styled, div, px};

use crate::{
	damage::{LaidOut, Region},
	model::{Block, Turn},
};

/// Builds the transcript column, centred in the space available.
///
/// Every turn's box is recorded in `laid_out` as the column is prepainted, so
/// a change to one turn can be repainted inside that turn alone (P5).
pub fn transcript_column(
	turns: &[Turn],
	geometry: &TranscriptSurfaceTokens,
	user_ground: ColorRole,
	tokens: &TokenSet,
	laid_out: &LaidOut,
	measure_px: f32,
) -> impl IntoElement {
	// The column is a maximum, not a fixed width. A session region narrower
	// than the measure would otherwise clip the column on both edges rather
	// than reflow it, which is the one failure a reader cannot work around.
	//
	// The bubble cannot read the column's shrunk width from the token
	// measure alone, so the shed-adjusted measure arrives with the call:
	// capped at the token measure, it is what the trailing-aligned bubble
	// sizes itself against, and a region narrower than the measure no
	// longer pushes the bubble's leading edge out of the column.
	let measure_px = geometry.column_width_px.min(measure_px);
	let mut column = div().flex().flex_col().w_full().max_w(px(measure_px));

	for (index, turn) in turns.iter().enumerate() {
		let mut block = match turn {
			Turn::Operator(text) => operator_turn(text, geometry, user_ground, tokens, measure_px),
			Turn::Agent(blocks) => agent_turn(blocks, geometry, tokens),
		};
		// The gap belongs between turns, not after the last one, so it is a
		// leading margin on every turn but the first rather than a trailing
		// margin on all of them.
		if index > 0 {
			block = block.mt(px(geometry.turns_gap));
		}
		column = column.child(block);
	}

	div()
		.flex()
		.flex_row()
		.justify_center()
		.w_full()
		.child(laid_out.track_children(column, |index| Some(Region::Turn(index))))
}

/// What the operator sent: a tinted bubble, aligned to the trailing edge.
fn operator_turn(
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
			// The trailing corner is the one nearest the operator's own edge of
			// the column, and it is drawn tight so the bubble reads as anchored
			// there rather than floating.
			.rounded_br(px(geometry.user_turn_radius_trailing))
			.text_size(px(geometry.user_turn_type_size.size))
			.line_height(px(geometry.user_turn_type_size.line_height))
			.text_color(tokens.color(ColorRole::Foreground))
			.child(text.to_owned()),
	)
}

/// What the agent produced: prose, invocations, reasoning and panes.
fn agent_turn(blocks: &[Block], geometry: &TranscriptSurfaceTokens, tokens: &TokenSet) -> Div {
	let mut turn = div().flex().flex_col().w_full();

	for (index, block) in blocks.iter().enumerate() {
		let mut rendered = match block {
			Block::Prose(text) => prose_block(text, geometry),
			Block::Invoke { tool, target, result } => {
				invoke_line(tool, target, result.as_deref(), geometry, tokens)
			},
			Block::Reason(summary) => reason_line(summary, geometry, tokens),
			Block::Pane { caption, lines } => pane_block(caption, lines, geometry),
		};

		if index > 0 {
			// Two blocks of the same kind are one activity; a change of kind is
			// a change of subject and takes the wider gap.
			let previous = blocks.get(index - 1);
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

/// Whether two blocks are the same kind, for gap selection.
const fn same_kind(left: &Block, right: &Block) -> bool {
	matches!(
		(left, right),
		(Block::Prose(_), Block::Prose(_))
			| (Block::Invoke { .. }, Block::Invoke { .. })
			| (Block::Reason(_), Block::Reason(_))
			| (Block::Pane { .. }, Block::Pane { .. })
	)
}

/// Prose, at the reading size, read as Markdown.
fn prose_block(text: &str, geometry: &TranscriptSurfaceTokens) -> Div {
	div()
		.w_full()
		.child(Markdown::new(text.to_owned()).prose_size(
			px(geometry.assistant_turn_type_size.size),
			px(geometry.assistant_turn_type_size.line_height),
		))
}

/// One invocation, collapsed to a single line.
fn invoke_line(
	tool: &str,
	target: &str,
	result: Option<&str>,
	geometry: &TranscriptSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	let mut line = div()
		.h(px(geometry.chrome_event_line_height_px))
		.w_full()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.overflow_hidden()
		.child(
			div()
				.flex_shrink_0()
				.text_size(tokens.mono_font_size(MonoSizeStep::Small))
				.line_height(tokens.mono_line_height(MonoSizeStep::Small))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(tool.to_owned()),
		)
		.child(
			// The target is the part that grows without bound, so it is the
			// part that gives way. The tool name and the outcome stay legible
			// at any width.
			div().flex_1().min_w_0().child(
				Truncate::new(target.to_owned())
					.mono(MonoSizeStep::Small)
					.color(ColorRole::Secondary),
			),
		);

	if let Some(result) = result {
		line = line.child(
			div()
				.flex_shrink_0()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(result.to_owned()),
		);
	}

	line
}

/// A reasoning summary, collapsed to one line.
fn reason_line(summary: &str, geometry: &TranscriptSurfaceTokens, tokens: &TokenSet) -> Div {
	div()
		.h(px(geometry.chrome_collapsed_height_px))
		.w_full()
		.flex()
		.items_center()
		.overflow_hidden()
		.whitespace_nowrap()
		.truncate()
		.italic()
		.text_size(tokens.font_size(TextRamp::Small))
		.line_height(tokens.line_height(TextRamp::Small))
		.text_color(tokens.color(ColorRole::Muted))
		.child(summary.to_owned())
}

/// A mono pane: a captioned, height-capped excerpt.
fn pane_block(caption: &str, lines: &[String], geometry: &TranscriptSurfaceTokens) -> Div {
	div().w_full().child(
		CodeBlock::lines(lines.iter().map(|line| SharedString::from(line.clone())))
			.caption(caption.to_owned())
			.size(MonoSizeStep::Small)
			.max_height(px(geometry.chrome_invoke_mono_pane_max_height_px)),
	)
}
