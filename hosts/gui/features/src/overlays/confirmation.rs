//! A destructive action confirmation.

use gpui::{AnyElement, App, IntoElement, ParentElement, ScrollHandle, Styled, div, px};
use veyyon_gui_core::UiCommand;
use veyyon_gui_kit::{
	theme::{Theme, space},
	ui::{Button, Fill, Sheet, Tone, text},
};

use super::state::owner_of;
use crate::act;

pub fn render(
	title: &str,
	body: &str,
	confirm: &UiCommand,
	scroll: &ScrollHandle,
	open: bool,
	cx: &mut App,
) -> AnyElement {
	let sheet_owner = owner_of(&format!("confirmation:{title}"));
	let cancel_owner = owner_of(&format!("confirmation:{title}:cancel"));
	let confirm_owner = owner_of(&format!("confirmation:{title}:confirm"));
	let theme = Theme::get(cx);
	Sheet::new("destructive-confirmation", sheet_owner, open)
		.centred()
		.on_dismiss(act::click(UiCommand::CloseTopOverlay))
		.child(text::heading(title.to_owned(), &theme))
		// The body states what is about to be destroyed, at whatever length the
		// command that opened the dialog wrote: it is the region that scrolls,
		// so Confirm and Cancel stay drawn however long the warning runs.
		.body(scroll, text::body(body.to_owned(), &theme))
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
