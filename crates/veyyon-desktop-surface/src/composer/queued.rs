//! The strip of prompts waiting behind a running turn (§5.4).
//!
//! Stated inside the composer float above the editor content, in delivery order
//! with the newest prompt last, with one control at the trailing edge that
//! takes the newest prompt back into the composer.

use veyyon_desktop_kit::{
	ColorRole, Icon, IconName, IconSize, RadiusStep, SpacingStep, TextRamp, TokenSet, Tooltip,
};
use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_gpui::{
	ClickEvent, Context, Div, ElementId, InteractiveElement, ParentElement, Stateful,
	StatefulInteractiveElement, Styled, div,
};

use super::state::ComposerState;
use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
};

/// The strip drawn above the editor while prompts wait behind a turn.
pub fn queued_strip(
	composer: &ComposerState,
	session_id: u64,
	controls: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Stateful<Div> {
	let count = composer.queued.len();
	let count_label = if count == 1 {
		"1 queued prompt".to_string()
	} else {
		format!("{count} queued prompts")
	};

	let take_back_id = SurfaceId::ComposerQueuedTakeBack(SessionId::from(session_id.to_string()));
	let availability = controls.availability(&take_back_id);
	let (opacity, cursor, allowed) = availability_style(&availability, tokens);

	let mut take_back_btn = div()
		.id("composer-queued-take-back")
		.aria_label("Take back queued message")
		.flex()
		.items_center()
		.justify_center()
		.p(tokens.spacing(SpacingStep::S1))
		.rounded(tokens.radius(RadiusStep::Sm))
		.opacity(opacity)
		.cursor(cursor)
		.child(
			Icon::new(IconName::ArrowUp)
				.size(IconSize::Size12)
				.color(tokens.color(ColorRole::Secondary)),
		);

	if allowed {
		let hover = tokens.row_hover();
		take_back_btn = take_back_btn
			.hover(move |style| style.bg(hover))
			.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
				view.dispatch(Intent::DequeueQueuedPrompt, cx);
			}));
	}

	let header_row = div()
		.id("composer-queued-header")
		.w_full()
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div()
				.flex()
				.flex_row()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S2))
				.child(
					Icon::new(IconName::Layers)
						.size(IconSize::Size12)
						.color(tokens.color(ColorRole::Secondary)),
				)
				.child(
					div()
						.text_size(tokens.font_size(TextRamp::Micro))
						.line_height(tokens.line_height(TextRamp::Micro))
						.text_color(tokens.color(ColorRole::Secondary))
						.whitespace_nowrap()
						.child(count_label),
				),
		)
		.children(availability.is_drawn().then(|| {
			let reason = availability.reason().unwrap_or("Take back queued message");
			Tooltip::new(reason.to_string(), take_back_btn)
				.above()
				.aligned_end()
				.group("composer-queued-take-back-hint")
		}));

	let prompt_rows = div()
		.id("composer-queued-prompts")
		.w_full()
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S1))
		.children(composer.queued.iter().enumerate().map(|(index, prompt)| {
			div()
				.id(ElementId::NamedInteger("composer-queued-row".into(), index as u64))
				.w_full()
				.min_w_0()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Placeholder))
				.whitespace_nowrap()
				.overflow_hidden()
				.text_ellipsis()
				.child(prompt.clone())
		}));

	div()
		.id("composer-queued")
		.w_full()
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S1))
		.child(header_row)
		.child(prompt_rows)
}
