//! Line row renderer for the queue rail (§5.1, §5.2).
//!
//! Renders a 36px line row with leading tint dot, title, trailing meta, and
//! hover actions.

use veyyon_desktop_kit::{
	ColorRole, Dot, RadiusStep, SpacingStep, Text, TextRamp, TokenSet, Truncate,
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
	model::{Badge, Row, Section},
};

/// Renders a line row (36px): leading tint dot, title, trailing meta, and hover
/// actions.
pub fn line_row(
	row: &Row,
	section: Section,
	selected: bool,
	is_open: bool,
	shift_y: f32,
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
	view: Option<WeakEntity<ShellView>>,
) -> impl IntoElement {
	let id = row.id;
	let ground = if is_open {
		tokens.row_active()
	} else if selected {
		tokens.row_selected()
	} else {
		tokens.transparent()
	};

	let hover_bg = tokens.row_hover();

	let has_attention_strip = row.badge.is_some_and(Badge::blocks_on_operator)
		|| matches!(row.badge, Some(Badge::Done | Badge::Failed));

	let dot = row
		.badge
		.map_or_else(Dot::empty, |badge| Dot::new(badge.tint()));

	let weak_action = view.clone();
	let action_btn = match section {
		Section::Deferred => {
			let recall_id = id;
			let mut btn = IconButton::new(IconName::Refresh)
				.id(ElementId::NamedInteger("queue-line-recall".into(), recall_id))
				.size(IconSize::Size12)
				.variant(IconButtonVariant::Ghost);
			if let Some(weak) = weak_action {
				btn = btn.on_click(move |_event, _window, app| {
					app.stop_propagation();
					let _ =
						weak.update(app, |view, cx| view.dispatch(Intent::RecallSession(recall_id), cx));
				});
			}
			Some(btn)
		},
		Section::Parked => {
			let unpark_id = id;
			let mut btn = IconButton::new(IconName::Play)
				.id(ElementId::NamedInteger("queue-line-unpark".into(), unpark_id))
				.size(IconSize::Size12)
				.variant(IconButtonVariant::Ghost);
			if let Some(weak) = weak_action {
				btn = btn.on_click(move |_event, _window, app| {
					app.stop_propagation();
					let _ =
						weak.update(app, |view, cx| view.dispatch(Intent::UnparkSession(unpark_id), cx));
				});
			}
			Some(btn)
		},
		_ => None,
	};

	let mut actions = div()
		.invisible()
		.group_hover("queue-line-row", |style| style.visible())
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S1));

	if let Some(btn) = action_btn {
		actions = actions.child(btn);
	}
	let mut line = div()
		.group("queue-line-row")
		.id(("queue-line", id as usize))
		.relative();

	if let Some(weak) = view.clone() {
		let weak_select = weak.clone();
		let weak_menu = weak;
		line = line
			.on_click(move |_event, _window, app| {
				let _ = weak_select.update(app, |view, cx| {
					view.dispatch(Intent::SelectSession(id), cx);
				});
			})
			.on_mouse_down(MouseButton::Right, move |event: &MouseDownEvent, _window, app| {
				let _ = weak_menu.update(app, |view, cx| {
					let kind = match section {
						Section::Deferred => RowMenuKind::Deferred,
						Section::Parked => RowMenuKind::Parked,
						_ => RowMenuKind::Card,
					};
					view.open_row_menu(RowMenu { id, origin: event.position, kind });
					cx.notify();
				});
			});
	}

	let mut line = line
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
		.child(dot)
		.child(
			div()
				.flex_1()
				.min_w_0()
				.child(Truncate::new(row.title.clone()).color(ColorRole::Secondary)),
		);

	if let Some(meta) = &row.meta {
		line = line.child(
			div().flex_shrink_0().child(
				Text::new(meta.clone())
					.ramp(TextRamp::Small)
					.color(ColorRole::Muted),
			),
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
