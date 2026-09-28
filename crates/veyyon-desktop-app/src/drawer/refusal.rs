//! The row that states a request the host refused, over the top of the shown
//! tab so a terminal keeps its size while the row shows: the host's sentence,
//! the retry that sends the request again when the host takes it a second
//! time, and the dismissal that forgets it.

use veyyon_desktop_model::{HostAction, SurfaceId};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant, IconButton},
	icons::IconName,
	theme::{Palette, TypeStyled, space, text},
};
use veyyon_gpui::{AnyElement, App, ClickEvent, Context, div, prelude::*};

use super::TerminalDrawer;

impl TerminalDrawer {
	/// The refusal row, laid over the top of the shown tab. A refusal the
	/// control no longer holds -- one it sent again -- draws no row.
	pub(super) fn refusal(&self, palette: &Palette, cx: &Context<Self>) -> Option<AnyElement> {
		let surface = self.refused.as_ref()?;
		let retries = &self.app.read(cx).store().retries;
		let copy =
			format!("The host refused {}: {}", refused_label(surface), retries.reason(surface)?);
		let retry = retries.can_retry(surface).then(|| {
			let button = Button::new("drawer-retry", "Retry")
				.size(ButtonSize::Sm)
				.variant(ButtonVariant::Ghost)
				.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.retry(cx)));
			self.target("drawer.retry", button)
		});
		let dismiss = IconButton::new("drawer-dismiss", IconName::X)
			.tooltip("Dismiss")
			.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.dismiss(cx)));
		let row = div()
			.absolute()
			.top_0()
			.left_0()
			.right_0()
			.flex()
			.items_center()
			.gap(space::S2)
			.px(space::S3)
			.py(space::S1)
			.bg(palette.bg.surface)
			.border_b_1()
			.border_color(palette.border.subtle)
			.type_style(text::SMALL)
			.text_color(palette.status.error)
			.child(div().flex_1().min_w_0().child(copy))
			.children(retry)
			.child(self.target("drawer.dismiss", dismiss));
		Some(self.target("drawer.refused", row))
	}

	/// Whether the request the host refused on `surface` asked for a terminal.
	pub(super) fn refused_create(&self, surface: &SurfaceId, cx: &App) -> bool {
		matches!(
			self.app.read(cx).store().retries.peek(surface),
			Some(HostAction::CreateTerminal { .. })
		)
	}

	/// Sends the refused request again, waiting again for a terminal it asks
	/// for.
	fn retry(&mut self, cx: &mut Context<Self>) {
		let Some(surface) = self.refused.take() else {
			return;
		};
		let create = self.refused_create(&surface, cx);
		if let Some(request) = self
			.app
			.update(cx, |app, cx| app.retry_refused(&surface, cx))
		{
			self.awaiting.push((request, surface));
			if create {
				self.creating = true;
				self.refresh_tabs(cx);
			}
		}
		cx.notify();
	}

	/// Forgets the refused request.
	fn dismiss(&mut self, cx: &mut Context<Self>) {
		if let Some(surface) = self.refused.take() {
			self.app.update(cx, |app, _| app.forget_refused(&surface));
		}
		cx.notify();
	}
}

/// What a refused request on `surface` did, as the refusal row states it.
fn refused_label(surface: &SurfaceId) -> String {
	match surface {
		SurfaceId::TerminalCreateButton(_) => "opening the terminal".to_owned(),
		SurfaceId::TerminalClearButton(..) => "clearing the terminal".to_owned(),
		SurfaceId::TerminalRestartButton(..) => "restarting the shell".to_owned(),
		SurfaceId::TerminalCloseButton(..) => "closing the terminal".to_owned(),
		SurfaceId::ProcessStartButton(_) => "starting the command".to_owned(),
		SurfaceId::ProcessStopButton(_, name) => format!("stopping {name}"),
		SurfaceId::ProcessRestartButton(_, name) => format!("restarting {name}"),
		SurfaceId::ProcessSignalButton(_, name) => format!("the signal to {name}"),
		SurfaceId::ProcessSendButton(_, name) => format!("the line to {name}"),
		SurfaceId::ProcessLogsTab(_, name) => format!("the output of {name}"),
		_ => "the last request".to_owned(),
	}
}
