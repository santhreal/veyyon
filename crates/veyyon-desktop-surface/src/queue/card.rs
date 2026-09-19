//! Card row renderer for the queue rail (§5.1, §5.2).
//!
//! Renders a 78px card row with badge, timer, title, subtitle, and hover
//! actions.

use veyyon_desktop_kit::{
	ColorRole, RadiusStep, SpacingStep, StrokeStep, TextRamp, TextWeight, TokenSet,
	controls::{IconButton, IconButtonVariant},
	icons::{IconName, IconSize},
};
use veyyon_desktop_tokens::QueueSurfaceTokens;
use veyyon_gpui::{
	ElementId, InteractiveElement, IntoElement, MouseButton, MouseDownEvent, ParentElement,
	StatefulInteractiveElement, Styled, WeakEntity, div, px,
};

use super::menu::{RowMenu, RowMenuKind};
use crate::{
	Intent, ShellView,
	controls::ControlStates,
	model::{Badge, Row, Section},
};
/// Renders a card row (78px): badge, timer, title, subtitle, and hover actions.
pub fn card_row(
	row: &Row,
	selected: bool,
	is_open: bool,
	shift_y: f32,
	_controls: &ControlStates,
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
	view: Option<WeakEntity<ShellView>>,
) -> impl IntoElement {
	let id = row.id;
	let placement = row.placement;
	let ground = if is_open {
		tokens.row_active()
	} else if selected {
		tokens.row_selected()
	} else {
		tokens.transparent()
	};

	let in_flight = matches!(row.badge, Some(Badge::Working | Badge::Watching));
	let row_opacity = if is_open {
		1.00
	} else if selected {
		if in_flight { 0.85 } else { 1.00 }
	} else if in_flight {
		0.70
	} else {
		1.00
	};
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
		let tint = tokens.tint(badge.tint());
		div()
			.bg(tint.fill)
			.text_color(tint.ink)
			.rounded(tokens.radius(RadiusStep::Sm))
			.px(tokens.spacing(SpacingStep::S2))
			.line_height(tokens.line_height(TextRamp::Small))
			.font_weight(tokens.font_weight(TextWeight::Medium))
			.max_w_full()
			.overflow_hidden()
			.whitespace_nowrap()
			.truncate()
			.child(badge.label())
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
	let weak_park = view.clone();
	let weak_defer = view.clone();
	let mut park_btn =
		IconButton::new(ElementId::NamedInteger("queue-card-park".into(), park_id), IconName::Stop)
			.size(IconSize::Size12)
			.variant(IconButtonVariant::Ghost);
	if let Some(weak) = weak_park {
		park_btn = park_btn.on_click(move |_event, _window, app| {
			app.stop_propagation();
			let _ = weak.update(app, |view, cx| view.dispatch(Intent::ParkSession(park_id), cx));
		});
	}

	let mut defer_btn = IconButton::new(
		ElementId::NamedInteger("queue-card-defer".into(), defer_id),
		IconName::Pause,
	)
	.size(IconSize::Size12)
	.variant(IconButtonVariant::Ghost);
	if let Some(weak) = weak_defer {
		defer_btn = defer_btn.on_click(move |_event, _window, app| {
			app.stop_propagation();
			let _ = weak.update(app, |view, cx| view.dispatch(Intent::DeferSession(defer_id), cx));
		});
	}
	let shown_actions = [park_btn, defer_btn];
	// Hidden rather than transparent: a hidden subtree keeps its layout and is
	// not painted, so its buttons attach no listener and a click on the space
	// they reserve falls through to the card. An opacity-0 control is painted,
	// so it would answer that click with a park the frame never drew.
	let actions = div()
		.invisible()
		.group_hover("queue-card-row", |style| style.visible())
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S1))
		.children(shown_actions);
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
		.relative();

	if let Some(weak) = view {
		let weak_select = weak.clone();
		let weak_menu = weak;
		card = card
			.on_click(move |_event, _window, app| {
				let _ = weak_select.update(app, |view, cx| {
					view.dispatch(Intent::SelectSession(id), cx);
				});
			})
			.on_mouse_down(MouseButton::Right, move |event: &MouseDownEvent, _window, app| {
				let _ = weak_menu.update(app, |view, cx| {
					// A pinned card's menu is the card's menu plus the way back
					// out of `Pinned`, which no hover action carries: §5.1 caps
					// a card at two. The row's placement decides it, not the
					// section it is drawn in: a pinned session holding a draft
					// draws under `Unsent` and still needs its way back out.
					let kind = if placement == Section::Pinned {
						RowMenuKind::Pinned
					} else {
						RowMenuKind::Card
					};
					view.open_row_menu(RowMenu { id, origin: event.position, kind });
					cx.notify();
				});
			});
	}

	let card_height = geometry.card_padding_top
		+ geometry.card_badge_height
		+ geometry.card_header_gap
		+ geometry.card_title_height
		+ geometry.card_body_gap
		+ geometry.card_subtitle_height
		+ geometry.card_padding_bottom;

	let mut card = card
		.hover(move |style| style.bg(hover_bg))
		.flex_shrink_0()
		.h(px(card_height.max(geometry.card_px)))
		.mx(px(geometry.row_inset))
		.pt(px(geometry.card_padding_top))
		.pb(px(geometry.card_padding_bottom))
		.px(px(geometry.card_padding_horizontal))
		.rounded(tokens.radius(RadiusStep::Md))
		.border(tokens.stroke(StrokeStep::Hairline))
		.border_color(if is_open {
			tokens
				.color(ColorRole::Focus)
				.opacity(geometry.card_open_edge_alpha)
		} else if selected {
			tokens
				.color(ColorRole::Focus)
				.opacity(geometry.card_selected_edge_alpha)
		} else {
			tokens
				.color(ColorRole::Hairline)
				.opacity(geometry.card_resting_edge_alpha)
		})
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
						.text_color(if in_flight && !is_open && !selected {
							tokens
								.color(ColorRole::Foreground)
								.opacity(geometry.card_in_flight_title_alpha)
						} else {
							tokens.color(ColorRole::Foreground)
						})
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
						.text_color(tokens.color(ColorRole::Muted))
						.child(row.subtitle.clone()),
				),
		);

	if has_attention_strip {
		let tint_ink = row
			.badge
			.map_or_else(|| tokens.transparent(), |b| tokens.tint(b.tint()).ink);
		card = card.child(
			div()
				.absolute()
				.left_0()
				.top_0()
				.bottom_0()
				.w(tokens.stroke(StrokeStep::Hairline))
				.bg(tint_ink),
		);
	}

	if shift_y.abs() > 0.001 {
		card = card.top(px(shift_y));
	}

	card
}
