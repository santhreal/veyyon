//! The queue rail (§5.1).
//!
//! The rail is the only surface that shows every session at once, so it is the
//! one place where density has to be decided rather than allowed. Two row
//! shapes carry that: a card for the sections the operator is working in, and a
//! line for the ones they are not. A parked list of forty sessions costs forty
//! lines, not forty cards, which is what keeps the rail readable at the bottom
//! as well as the top.
//!
//! Every dimension here is read from `QueueSurfaceTokens`. None is written as a
//! literal, so a density change is a token edit and the hot-reload loop shows
//! it without a rebuild.

use veyyon_desktop_kit::{
	Badge as BadgeChip, ColorRole, RadiusStep, SpacingStep, TextRamp, TextWeight, TokenSet,
};
use veyyon_desktop_tokens::QueueSurfaceTokens;
use veyyon_gpui::{Div, IntoElement, ParentElement, Styled, div, px};

use crate::model::{Row, Section};

/// Builds the queue rail.
pub fn queue_rail(
	sections: &[(Section, Vec<Row>)],
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
) -> impl IntoElement {
	let mut rail = div()
		.flex()
		.flex_col()
		.h_full()
		.w(px(geometry.width_default_px))
		.min_w(px(geometry.width_min_px))
		.flex_shrink_0()
		.bg(tokens.color(ColorRole::Rail))
		.border_r(px(geometry.outer_edge_stroke))
		.border_color(tokens.color(ColorRole::Hairline))
		.pt(px(geometry.content_inset))
		.pb(px(geometry.content_inset))
		.overflow_hidden();

	for (section, rows) in sections {
		// A section with no rows draws nothing at all. An empty header is a
		// line of chrome that states only that there is nothing to state.
		if rows.is_empty() {
			continue;
		}
		rail = rail.child(section_header(*section, rows.len(), geometry, tokens));

		let visible = if *section == Section::Parked {
			geometry.parked_initial_page_size.min(rows.len())
		} else {
			rows.len()
		};

		for row in rows.iter().take(visible) {
			rail = if section.draws_cards() {
				rail.child(card_row(row, geometry, tokens))
			} else {
				rail.child(line_row(row, geometry, tokens))
			};
		}

		// `saturating_sub` rather than a subtraction: `visible` is already
		// clamped to the row count, but an underflow here would be a panic in
		// the render path.
		let hidden = rows.len().saturating_sub(visible);
		if hidden > 0 {
			rail = rail.child(more_row(hidden, geometry, tokens));
		}
	}

	rail
}

/// A section header: the label, and the number of rows under it.
fn section_header(
	section: Section,
	count: usize,
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	div()
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
fn card_row(row: &Row, geometry: &QueueSurfaceTokens, tokens: &TokenSet) -> Div {
	let ground = if row.current {
		tokens.color(ColorRole::Canvas)
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

	div()
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
fn line_row(row: &Row, geometry: &QueueSurfaceTokens, tokens: &TokenSet) -> Div {
	let dot_size = tokens.spacing(SpacingStep::S2);
	let mut line = div()
		.h(px(geometry.line_px))
		.mx(px(geometry.row_inset))
		.px(px(geometry.card_padding_horizontal))
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

/// The row that states how many rows a section is not showing.
fn more_row(hidden: usize, geometry: &QueueSurfaceTokens, tokens: &TokenSet) -> Div {
	div()
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
