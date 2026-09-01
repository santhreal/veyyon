//! The rail's row shapes: the section header, the card, the line, and the row
//! that states what the rail is not showing.
//!
//! Every one of these is `flex_shrink_0` at the height its token states. That
//! is what makes the height budget in the parent module the whole story: a
//! shrinkable row lets flex compress the column to fit instead, each row's
//! fixed-height contents overflow their box, and the result is a rail of
//! half-drawn text that reads as a font defect rather than as an overfull rail.

use veyyon_desktop_kit::{
	Badge as BadgeChip, ColorRole, RadiusStep, SpacingStep, TextRamp, TextWeight, TokenSet,
};
use veyyon_desktop_tokens::QueueSurfaceTokens;
use veyyon_gpui::{
	Context, Div, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, div, px,
};

use crate::{
	ShellView,
	intent::Intent,
	model::{Row, Section},
};

/// A section header: the label, and the number of rows under it.
pub fn section_header(
	section: Section,
	count: usize,
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	div()
		.flex_shrink_0()
		.h(px(geometry.section_header_px))
		.px(px(geometry.content_inset))
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Muted))
				.child(section.label().to_owned()),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Placeholder))
				.child(count.to_string()),
		)
}

/// A card row: badge, elapsed time, title and subtitle.
pub fn card_row(
	row: &Row,
	selected: bool,
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let ground = if selected {
		tokens.row_selected()
	} else {
		tokens.transparent()
	};

	let mut header = div()
		.h(px(geometry.card_badge_height))
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div().flex_shrink_0().children(
				row.badge
					.map(|badge| BadgeChip::new(badge.label(), badge.tint())),
			),
		);

	if let Some(meta) = &row.meta {
		header = header.child(
			div()
				.flex_1()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_right()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(meta.clone()),
		);
	}

	let id = row.id;
	let hover = tokens.row_hover();

	div()
		// The whole row is the target, not the title inside it. A hit area
		// smaller than the row is the defect an operator experiences as the
		// click that did nothing.
		.id(("queue-card", id as usize))
		.on_click(cx.listener(move |view, _event, _window, cx| {
			view.dispatch(Intent::SelectSession(id));
			cx.notify();
		}))
		.hover(move |style| style.bg(hover))
		.flex_shrink_0()
		.h(px(geometry.card_px))
		.mx(px(geometry.row_inset))
		.pt(px(geometry.card_padding_top))
		.pb(px(geometry.card_padding_bottom))
		.px(px(geometry.card_padding_horizontal))
		.rounded(tokens.radius(RadiusStep::Md))
		.bg(ground)
		.flex()
		.flex_col()
		.gap(px(geometry.card_header_gap))
		.overflow_hidden()
		.child(header)
		.child(
			div()
				.flex()
				.flex_col()
				.gap(px(geometry.card_body_gap))
				.child(
					div()
						.h(px(geometry.card_title_height))
						.w_full()
						.min_w_0()
						.overflow_hidden()
						.whitespace_nowrap()
						.truncate()
						.text_size(tokens.font_size(TextRamp::Body))
						.line_height(tokens.line_height(TextRamp::Body))
						.font_weight(tokens.font_weight(TextWeight::Medium))
						.text_color(tokens.color(ColorRole::Foreground))
						.child(row.title.clone()),
				)
				.child(
					div()
						.h(px(geometry.card_subtitle_height))
						.w_full()
						.min_w_0()
						.overflow_hidden()
						.whitespace_nowrap()
						.truncate()
						.text_size(tokens.font_size(TextRamp::Small))
						.line_height(tokens.line_height(TextRamp::Small))
						.text_color(tokens.color(ColorRole::Secondary))
						.child(row.subtitle.clone()),
				),
		)
}

/// A line row: a title, and the badge reduced to a dot of its tint.
pub fn line_row(
	row: &Row,
	selected: bool,
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let dot_size = tokens.spacing(SpacingStep::S2);
	let id = row.id;
	let hover = tokens.row_hover();
	let ground = if selected {
		tokens.row_selected()
	} else {
		tokens.transparent()
	};
	let mut line = div()
		.id(("queue-line", id as usize))
		.on_click(cx.listener(move |view, _event, _window, cx| {
			view.dispatch(Intent::SelectSession(id));
			cx.notify();
		}))
		.hover(move |style| style.bg(hover))
		.flex_shrink_0()
		.h(px(geometry.line_px))
		.mx(px(geometry.row_inset))
		.px(px(geometry.card_padding_horizontal))
		.rounded(tokens.radius(RadiusStep::Sm))
		.bg(ground)
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.overflow_hidden();

	// A line row has no space for a badge, so the badge's tint becomes a dot.
	// The colour still carries the state; only the label is dropped.
	//
	// The slot is reserved whether or not there is a badge, because a dot that
	// appears only on some rows indents only those titles, and a ragged left
	// edge down the rail reads as breakage rather than as state.
	let dot = row
		.badge
		.map_or_else(|| tokens.transparent(), |badge| tokens.tint(badge.tint()).fill);
	line = line.child(
		div()
			.flex_shrink_0()
			.w(dot_size)
			.h(dot_size)
			.rounded_full()
			.bg(dot),
	);

	line = line.child(
		div()
			.flex_1()
			.min_w_0()
			.overflow_hidden()
			.whitespace_nowrap()
			.truncate()
			.text_size(tokens.font_size(TextRamp::Small))
			.line_height(tokens.line_height(TextRamp::Small))
			.text_color(tokens.color(ColorRole::Secondary))
			.child(row.title.clone()),
	);

	if let Some(meta) = &row.meta {
		line = line.child(
			div()
				.flex_shrink_0()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(meta.clone()),
		);
	}

	line
}

/// The row that states how many rows the rail is not showing.
///
/// It is not a control. A row the rail withheld for want of height is reached
/// by making the window taller or by parking something, and a paged-out row by
/// the page control, so a click here would have nothing to do.
pub fn more_row(hidden: usize, geometry: &QueueSurfaceTokens, tokens: &TokenSet) -> Div {
	div()
		.flex_shrink_0()
		.h(px(geometry.line_px))
		.mx(px(geometry.row_inset))
		.px(px(geometry.card_padding_horizontal))
		.flex()
		.items_center()
		.text_size(tokens.font_size(TextRamp::Micro))
		.line_height(tokens.line_height(TextRamp::Micro))
		.text_color(tokens.color(ColorRole::Muted))
		.child(format!("{hidden} more"))
}
