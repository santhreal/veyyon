//! A destructive action confirmation.

use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::UiCommand;
use veyyon_gui_kit::{
	theme::{Theme, space},
	ui::{Banner, Button, Fill, Sheet, Tone, text},
};

use super::state::OverlayState;
use crate::act;

pub fn render(
	title: &str,
	body: &str,
	confirm: &UiCommand,
	state: &mut OverlayState,
	open: bool,
	cx: &mut App,
) -> AnyElement {
	let Some(sheet_owner) = state.owner(format!("confirmation:{title}")) else {
		return Banner::failure("Confirmation unavailable")
			.detail("The retained identity table is full")
			.into_any_element();
	};
	let Some(cancel_owner) = state.owner(format!("confirmation:{title}:cancel")) else {
		return Banner::failure("Confirmation unavailable").into_any_element();
	};
	let Some(confirm_owner) = state.owner(format!("confirmation:{title}:confirm")) else {
		return Banner::failure("Confirmation unavailable").into_any_element();
	};
	let theme = Theme::get(cx);
	Sheet::new("destructive-confirmation", sheet_owner, open)
		.centred()
		.on_dismiss(act::click(UiCommand::CloseTopOverlay))
		.child(
			text::stack(space::BASE)
				.child(text::heading(title.to_owned(), &theme))
				.child(text::body(body.to_owned(), &theme)),
		)
		.child(
			div()
				.flex()
				.items_center()
				.justify_end()
				.gap(px(space::SNUG))
				.child(
					Button::labelled("confirmation-cancel", cancel_owner, "Cancel")
						.on_click(act::click(UiCommand::CloseTopOverlay)),
				)
				.child(
					Button::labelled("confirmation-confirm", confirm_owner, "Confirm")
						.tone(Tone::Danger)
						.fill(Fill::Solid)
						.on_click(run_then_close(confirm.clone())),
				),
		)
		.into_any_element()
}

fn run_then_close(
	command: UiCommand,
) -> impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut App) + 'static {
	move |_, window, cx| {
		act::run(UiCommand::CloseTopOverlay, window, cx);
		act::run(command.clone(), window, cx);
	}
}
