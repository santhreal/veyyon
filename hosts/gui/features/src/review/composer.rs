//! Inline composer for starting a new review thread on the selected diff range.

use gpui::{AnyElement, App, InteractiveElement, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{UiCommand, model::LineRange};
use veyyon_gui_kit::{
	motion::{OwnerNamespace, control},
	theme::{Theme, space, weight},
	ui::{Badge, Button, Fill, Icon, Size, Tone, text},
};

use super::logic;
use crate::act;

const NS: OwnerNamespace = OwnerNamespace::Changes;

pub fn render_new_thread_composer(
	path: &str,
	range: LineRange,
	draft: Option<&str>,
	cx: &mut App,
) -> AnyElement {
	let theme = Theme::get(cx);
	let draft_text = draft.unwrap_or("").to_string();
	let location_text = logic::thread_location_label(path, &range);

	let cancel_path = path.to_string();
	let cancel_btn = Button::labelled(
		"cancel-review-composer",
		control(NS, "review-composer", "cancel", 0),
		"Cancel",
	)
	.size(Size::Small)
	.fill(Fill::Ghost)
	.on_click(act::click(UiCommand::SetReviewRange { path: cancel_path, range: None }));

	let start_path = path.to_string();
	let start_text = if draft_text.trim().is_empty() {
		"Review note".to_string()
	} else {
		draft_text.clone()
	};
	let start_btn = Button::labelled(
		"start-review-thread",
		control(NS, "review-composer", "start", 1),
		"Comment",
	)
	.icon(Icon::Review)
	.size(Size::Small)
	.tone(Tone::Accent)
	.fill(Fill::Solid)
	.on_click(act::click(UiCommand::StartReviewThread {
		path: start_path,
		range,
		text: start_text,
	}));

	div()
		.id("new-review-thread-composer")
		.flex()
		.flex_col()
		.gap(px(space::X6))
		.p(px(space::X8))
		.rounded_lg()
		.border_1()
		.border_color(theme.ring)
		.bg(theme.raised)
		.shadow_sm()
		.child(
			div()
				.flex()
				.items_center()
				.justify_between()
				.child(
					div()
						.flex()
						.items_center()
						.gap(px(space::X6))
						.child(text::line("New review comment").font_weight(weight::MEDIUM))
						.child(Badge::new(location_text).tone(Tone::Plain)),
				)
				.child(cancel_btn),
		)
		.child(
			div()
				.flex()
				.items_center()
				.justify_end()
				.gap(px(space::X6))
				.child(start_btn),
		)
		.into_any_element()
}
