//! Card row renderer for the queue rail (§5.1, §5.2).
//!
//! Renders a 78px card row with badge, timer, title, subtitle, and hover
//! actions.

use veyyon_desktop_kit::{
	Badge as BadgeChip, ColorRole, RadiusStep, SpacingStep, TextRamp, TextWeight, TokenSet,
	controls::{IconButton, IconButtonVariant},
	icons::{IconName, IconSize},
};
use veyyon_desktop_tokens::QueueSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, ElementId, InteractiveElement, IntoElement, MouseButton, MouseDownEvent,
	ParentElement, StatefulInteractiveElement, Styled, div, px,
};

use crate::{
	Intent, ShellView,
	model::{Badge, Row},
	queue::RowMenu,
};

/// Renders a card row (78px): badge, timer, title, subtitle, and hover actions.
pub fn card_row(
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

	let in_flight = matches!(row.badge, Some(Badge::Working | Badge::Watching));
	let row_opacity = if in_flight { 0.70 } else { 1.00 };

	let has_attention_strip = row.badge.is_some_and(Badge::blocks_on_operator)
		|| matches!(row.badge, Some(Badge::Done | Badge::Failed));

	let mut header = div()
		.h(px(geometry.card_badge_height))
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.gap(tokens.spacing(SpacingStep::S2));

	let badge_element = row.badge.map(|badge| {
		let label = badge.label();
		BadgeChip::new(label, badge.tint())
	});

	let badge_slot = div()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S1))
		.children(badge_element);

	let park_id = id;
	let defer_id = id;
	let actions = div()
		.invisible()
		.group_hover("queue-card-row", |style| style.visible())
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S1))
		.child(
			IconButton::new(IconName::Stop)
				.id(ElementId::NamedInteger("queue-card-park".into(), park_id))
				.size(IconSize::Size12)
				.variant(IconButtonVariant::Ghost)
				.on_click(cx.listener(move |view, _event: &ClickEvent, _window, cx| {
					view.dispatch(Intent::ParkSession(park_id));
					cx.notify();
				})),
		)
		.child(
			IconButton::new(IconName::Pause)
				.id(ElementId::NamedInteger("queue-card-defer".into(), defer_id))
				.size(IconSize::Size12)
				.variant(IconButtonVariant::Ghost)
				.on_click(cx.listener(move |view, _event: &ClickEvent, _window, cx| {
					view.dispatch(Intent::DeferSession(defer_id));
					cx.notify();
				})),
		);

	let meta_text = row.meta.clone().unwrap_or_default();
	let meta_slot = div()
		.flex_1()
		.min_w_0()
		.flex()
		.flex_row()
		.items_center()
		.justify_end()
		.child(
			div()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.font_weight(tokens.font_weight(TextWeight::Regular))
				.text_color(tokens.color(ColorRole::Muted))
				.child(meta_text),
		)
		.child(actions);

	header = header.child(badge_slot).child(meta_slot);

	let hover_bg = tokens.row_hover();

	let mut card = div()
		.group("queue-card-row")
		.id(("queue-card", id as usize))
		.relative()
		.on_click(cx.listener(move |view, _event, _window, cx| {
			view.dispatch(Intent::SelectSession(id));
			cx.notify();
		}))
		// A right-click opens the row's answers as a menu at the pointer.
		.on_mouse_down(
			MouseButton::Right,
			cx.listener(move |view, event: &MouseDownEvent, _window, cx| {
				view.open_row_menu(RowMenu { id, origin: event.position, card: true });
				cx.notify();
			}),
		)
		.hover(move |style| style.bg(hover_bg))
		.flex_shrink_0()
		.h(px(geometry.card_px))
		.mx(px(geometry.row_inset))
		.pt(px(geometry.card_padding_top))
		.pb(px(geometry.card_padding_bottom))
		.px(px(geometry.card_padding_horizontal))
		.rounded(tokens.radius(RadiusStep::Md))
		.bg(ground)
		.opacity(row_opacity)
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
						.text_size(tokens.font_size(TextRamp::Read))
						.line_height(tokens.line_height(TextRamp::Read))
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
						.font_weight(tokens.font_weight(TextWeight::Regular))
						.text_color(tokens.color(ColorRole::Secondary))
						.child(row.subtitle.clone()),
				),
		);

	if has_attention_strip {
		let tint_fill = row
			.badge
			.map_or_else(|| tokens.transparent(), |b| tokens.tint(b.tint()).fill);
		card = card.child(
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
		card = card.top(px(shift_y));
	}

	card
}
