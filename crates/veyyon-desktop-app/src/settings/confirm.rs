//! A confirmation dialog: a question over a dimmed page, with Cancel and a
//! destructive confirm button. Enter confirms and Escape cancels. The dialog
//! sends nothing itself; its owner sends the request once it is confirmed.

use veyyon_desktop_model::{HostAction, SurfaceId};
use veyyon_desktop_ui::{
	controls::{Button, ButtonVariant},
	theme::{ActiveTheme, TypeStyled, radius, size, space, text},
};
use veyyon_gpui::{
	AppContext as _, Context, EventEmitter, FocusHandle, Focusable, IntoElement, KeyDownEvent,
	Render, SharedString, Window, deferred, div, prelude::*,
};

use super::SettingsView;
use crate::driver;

/// A question the confirmation dialog asks before sending a request.
pub(super) struct Ask {
	pub(super) title:   String,
	pub(super) body:    String,
	pub(super) label:   &'static str,
	pub(super) action:  HostAction,
	pub(super) surface: SurfaceId,
}

impl SettingsView {
	/// Asks `ask` over the page and sends its request through the page once
	/// confirmed, so the gate and a refusal of it apply as to any control.
	/// Closing the dialog hands focus back to what held it inside the page,
	/// or to the page.
	pub(super) fn confirm(&mut self, ask: Ask, window: &mut Window, cx: &mut Context<Self>) {
		let Ask { title, body, label, action, surface } = ask;
		let dialog = cx.new(|cx| ConfirmDialog::new(title, body, label, cx));
		let previous = window
			.focused(cx)
			.filter(|_| self.focus.contains_focused(window, cx))
			.unwrap_or_else(|| self.focus.clone());
		let subscription =
			cx.subscribe_in(&dialog, window, move |this, _, event: &ConfirmEvent, window, cx| {
				if *event == ConfirmEvent::Confirmed {
					this.send(action.clone(), surface.clone(), cx);
				}
				this.dialog = None;
				window.focus(&previous, cx);
				cx.notify();
			});
		let focus = dialog.focus_handle(cx);
		window.focus(&focus, cx);
		self.dialog = Some((dialog, subscription));
		cx.notify();
	}
}

/// How the dialog closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfirmEvent {
	/// The confirm button or Enter.
	Confirmed,
	/// Cancel, Escape or a click on the dimmed page.
	Cancelled,
}

/// A question that waits on an answer.
pub struct ConfirmDialog {
	title:   SharedString,
	body:    SharedString,
	confirm: SharedString,
	focus:   FocusHandle,
}

impl EventEmitter<ConfirmEvent> for ConfirmDialog {}

impl ConfirmDialog {
	/// A dialog asking `title`, explained by `body`, whose confirm button
	/// reads `confirm`.
	pub fn new(
		title: impl Into<SharedString>,
		body: impl Into<SharedString>,
		confirm: impl Into<SharedString>,
		cx: &mut Context<Self>,
	) -> Self {
		Self {
			title:   title.into(),
			body:    body.into(),
			confirm: confirm.into(),
			focus:   cx.focus_handle(),
		}
	}

	fn on_key_down(event: &KeyDownEvent, cx: &mut Context<Self>) {
		match event.keystroke.key.as_str() {
			"enter" => cx.emit(ConfirmEvent::Confirmed),
			"escape" => cx.emit(ConfirmEvent::Cancelled),
			_ => return,
		}
		cx.stop_propagation();
	}
}

impl Focusable for ConfirmDialog {
	fn focus_handle(&self, _: &veyyon_gpui::App) -> FocusHandle {
		self.focus.clone()
	}
}

impl Render for ConfirmDialog {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let palette = cx.theme().palette;
		let card = div()
			.id("confirm-dialog")
			.occlude()
			.track_focus(&self.focus)
			.on_key_down(cx.listener(|_, event, _, cx| Self::on_key_down(event, cx)))
			.w(size::TOAST_WIDTH)
			.p(space::S4)
			.flex()
			.flex_col()
			.gap(space::S3)
			.bg(palette.bg.elevated)
			.rounded(radius::XL)
			.border_1()
			.border_color(palette.border.default)
			.shadow_lg()
			.child(
				div()
					.type_style(text::TITLE)
					.text_color(palette.text.primary)
					.child(self.title.clone()),
			)
			.child(
				div()
					.type_style(text::UI)
					.text_color(palette.text.secondary)
					.child(self.body.clone()),
			)
			.child(
				div()
					.flex()
					.justify_end()
					.gap(space::S2)
					.child(
						Button::new("confirm-cancel", "Cancel")
							.variant(ButtonVariant::Ghost)
							.on_click(cx.listener(|_, _, _, cx| cx.emit(ConfirmEvent::Cancelled))),
					)
					.child(
						Button::new("confirm-accept", self.confirm.clone())
							.variant(ButtonVariant::Danger)
							.on_click(cx.listener(|_, _, _, cx| cx.emit(ConfirmEvent::Confirmed))),
					),
			);
		deferred(
			div()
				.id("confirm-scrim")
				.absolute()
				.top_0()
				.left_0()
				.size_full()
				.flex()
				.items_center()
				.justify_center()
				.bg(palette.bg.app.opacity(0.6))
				.on_click(cx.listener(|_, _, _, cx| cx.emit(ConfirmEvent::Cancelled)))
				.child(driver::target("dialog", card)),
		)
		.with_priority(3)
	}
}
