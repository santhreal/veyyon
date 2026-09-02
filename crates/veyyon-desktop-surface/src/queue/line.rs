//! Line row renderer for the queue rail (§5.1, §5.2).
//!
//! Renders a 36px line row with leading tint dot, title, trailing meta, and
//! hover actions.

use veyyon_desktop_kit::{
	ColorRole, RadiusStep, SpacingStep, TextRamp, TextWeight, TokenSet,
	controls::{IconButton, IconButtonVariant},
	icons::{IconName, IconSize},
};
use veyyon_desktop_tokens::QueueSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, ElementId, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};

use crate::{
	Intent, ShellView,
	model::{Badge, Row},
};

/// Renders a line row (36px): leading tint dot, title, trailing meta, and hover
/// actions.
pub fn line_row(
	row: &Row,
	selected: bool,
	is_open: bool,
	shift_y: f32,
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let id = row.id;
	let ground = if is_open {
		tokens.row_active()
	} else if selected {
		tokens.row_selected()
	} else {
		tokens.transparent()
	};

	let dot_size = tokens.spacing(SpacingStep::S2);
	let hover_bg = tokens.row_hover();

	let has_attention_strip = row.badge.is_some_and(Badge::blocks_on_operator)
		|| matches!(row.badge, Some(Badge::Done | Badge::Failed));

	let dot = row
		.badge
		.map_or_else(|| tokens.transparent(), |badge| tokens.tint(badge.tint()).fill);

	let unpark_id = id;
	let recall_id = id;
	let actions = div()
		.invisible()
		.group_hover("queue-line-row", |style| style.visible())
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S1))
		.child(
			IconButton::new(IconName::Play)
				.id(ElementId::NamedInteger("queue-line-unpark".into(), unpark_id))
				.size(IconSize::Size12)
				.variant(IconButtonVariant::Ghost)
				.on_click(cx.listener(move |view, _event: &ClickEvent, _window, cx| {
					view.dispatch(Intent::ParkSession(unpark_id));
					cx.notify();
				})),
		)
		.child(
			IconButton::new(IconName::Refresh)
				.id(ElementId::NamedInteger("queue-line-recall".into(), recall_id))
				.size(IconSize::Size12)
				.variant(IconButtonVariant::Ghost)
				.on_click(cx.listener(move |view, _event: &ClickEvent, _window, cx| {
					view.dispatch(Intent::DeferSession(recall_id));
					cx.notify();
				})),
		);

	let mut line = div()
		.group("queue-line-row")
		.id(("queue-line", id as usize))
		.relative()
		.on_click(cx.listener(move |view, _event, _window, cx| {
			view.dispatch(Intent::SelectSession(id));
			cx.notify();
		}))
		.hover(move |style| style.bg(hover_bg))
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
		.overflow_hidden()
		.child(
			div()
				.flex_shrink_0()
				.w(dot_size)
				.h(dot_size)
				.rounded_full()
				.bg(dot),
		)
		.child(
			div()
				.flex_1()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.font_weight(tokens.font_weight(TextWeight::Regular))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(row.title.clone()),
		);

	if let Some(meta) = &row.meta {
		line = line.child(
			div()
				.flex_shrink_0()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.font_weight(tokens.font_weight(TextWeight::Regular))
				.text_color(tokens.color(ColorRole::Muted))
				.child(meta.clone()),
		);
	}

	line = line.child(actions);

	if has_attention_strip {
		let tint_fill = row
			.badge
			.map_or_else(|| tokens.transparent(), |b| tokens.tint(b.tint()).fill);
		line = line.child(
			div()
				.absolute()
				.left_0()
				.top_0()
				.bottom_0()
				.w(px(1.0))
				.bg(tint_fill),
		);
	}

	if shift_y.abs() > 0.001 {
		line = line.top(px(shift_y));
	}

	line
}
