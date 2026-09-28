//! The strips above the composer frame: the prompt the host refused, the
//! prompts queued behind the turn, the command the turn waits on, the
//! dictation, and the widgets extensions set; and the line under the frame
//! stating why an attachment or a send was refused.

use gpui::{AnyElement, App, Context, Div, SharedString, div, prelude::*};
use veyyon_desktop_model::{ExtensionWidgetPlacement, HostActionKind};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant, Spinner},
	icons::{Icon, IconName},
	theme::{ActiveTheme, TypeStyled, radius, size, space, text},
};

use super::Composer;

/// Most queued prompts the strip lists before it counts the rest.
const QUEUED_ROWS: usize = 3;

/// A strip's frame: a quiet row inside the composer column.
fn strip(id: &'static str, cx: &App) -> gpui::Stateful<Div> {
	let palette = cx.theme().palette;
	div()
		.id(id)
		.flex()
		.gap(space::S2)
		.px(space::S3)
		.py(space::S1_5)
		.rounded(radius::LG)
		.bg(palette.bg.surface)
		.border_1()
		.border_color(palette.border.subtle)
		.type_style(text::SMALL)
		.text_color(palette.text.secondary)
}

/// The first line of `text`, as one strip row states a prompt.
fn first_line(text: &str) -> SharedString {
	text.lines().next().unwrap_or_default().to_owned().into()
}

impl Composer {
	/// Every strip the shown session has, top to bottom.
	pub(super) fn render_strips(&self, cx: &Context<Self>) -> Vec<AnyElement> {
		let mut strips = Vec::new();
		strips.extend(self.render_refused(cx));
		strips.extend(self.render_queued(cx));
		strips.extend(self.render_foreground(cx));
		strips.extend(self.render_dictation(cx));
		strips.extend(self.render_widgets(ExtensionWidgetPlacement::AboveEditor, cx));
		strips
	}

	/// The prompt the host refused, offered again.
	fn render_refused(&self, cx: &Context<Self>) -> Option<AnyElement> {
		let text = self.refused.text(self.session.as_ref()?)?;
		let palette = cx.theme().palette;
		Some(
			strip("composer-refused", cx)
				.items_center()
				.child(
					Icon::new(IconName::CircleAlert)
						.size(size::ICON_SM)
						.color(palette.status.error),
				)
				.child(
					div()
						.flex_none()
						.text_color(palette.status.error)
						.child("Not sent"),
				)
				.child(div().flex_1().min_w_0().truncate().child(first_line(text)))
				.child(
					Button::new("composer-refused-retry", "Retry")
						.size(ButtonSize::Sm)
						.on_click(cx.listener(|this, _, _, cx| this.retry_refused(cx))),
				)
				.child(
					Button::new("composer-refused-dismiss", "Dismiss")
						.variant(ButtonVariant::Ghost)
						.size(ButtonSize::Sm)
						.on_click(cx.listener(|this, _, _, cx| this.dismiss_refused(cx))),
				)
				.into_any_element(),
		)
	}

	/// The prompts the session holds behind its turn, in delivery order, and
	/// the control that takes the newest back into the draft.
	fn render_queued(&self, cx: &Context<Self>) -> Option<AnyElement> {
		let session = self.session.as_ref()?;
		let queued = self
			.app
			.read(cx)
			.store()
			.queued
			.get(session)
			.filter(|queued| !queued.is_empty())?;
		let palette = cx.theme().palette;
		let count = queued.len();
		let hidden = count.saturating_sub(QUEUED_ROWS);
		let refusal = self.refusal(HostActionKind::DequeueQueuedPrompt, cx);
		let heading = if count == 1 {
			"1 queued".to_owned()
		} else {
			format!("{count} queued")
		};
		let rows = queued
			.in_delivery_order()
			.map(first_line)
			.skip(hidden)
			.enumerate()
			.map(|(ix, prompt)| {
				div()
					.id(("composer-queued-row", ix))
					.flex()
					.items_center()
					.gap(space::S2)
					.min_w_0()
					.child(
						Icon::new(IconName::Clock)
							.size(size::ICON_SM)
							.color(palette.text.faint),
					)
					.child(div().flex_1().min_w_0().truncate().child(prompt))
			});
		Some(
			strip("composer-queued", cx)
				.flex_col()
				.gap(space::S1)
				.child(
					div()
						.flex()
						.items_center()
						.justify_between()
						.text_color(palette.text.muted)
						.child(heading)
						.child(
							Button::new("composer-queued-take-back", "Edit last")
								.variant(ButtonVariant::Ghost)
								.size(ButtonSize::Sm)
								.icon(IconName::Pencil)
								.disabled(refusal.is_some())
								.on_click(cx.listener(|this, _, _, cx| this.take_back_queued(cx))),
						),
				)
				.when(hidden > 0, |strip| {
					strip.child(
						div()
							.text_color(palette.text.faint)
							.child(format!("{hidden} earlier")),
					)
				})
				.children(rows)
				.into_any_element(),
		)
	}

	/// The command the turn waits on, with the controls that move it to a
	/// background job or stop the turn.
	fn render_foreground(&self, cx: &Context<Self>) -> Option<AnyElement> {
		let session = self.session.as_ref()?;
		let command = self.app.read(cx).store().domains.foreground.get(session)?;
		let palette = cx.theme().palette;
		let shown = if command.truncated {
			format!("{}…", command.command)
		} else {
			command.command.clone()
		};
		let refusal = self.refusal(HostActionKind::BackgroundCommand, cx);
		Some(
			strip("composer-foreground", cx)
				.items_center()
				.child(Spinner::new("composer-foreground-spinner").size(size::ICON_SM))
				.child(
					div()
						.flex_1()
						.min_w_0()
						.truncate()
						.type_style(text::MONO)
						.text_color(palette.text.primary)
						.child(shown),
				)
				.child(
					Button::new("composer-foreground-background", "Background")
						.size(ButtonSize::Sm)
						.disabled(refusal.is_some())
						.on_click(cx.listener(|this, _, _, cx| this.background_command(cx))),
				)
				.child(
					Button::new("composer-foreground-stop", "Stop")
						.variant(ButtonVariant::Ghost)
						.size(ButtonSize::Sm)
						.on_click(cx.listener(|this, _, _, cx| this.stop(cx))),
				)
				.into_any_element(),
		)
	}

	/// The widgets the session's extensions set at `placement`, each line as
	/// the extension wrote it.
	pub(super) fn render_widgets(
		&self,
		placement: ExtensionWidgetPlacement,
		cx: &Context<Self>,
	) -> Vec<AnyElement> {
		let Some(session) = self.session.as_ref() else {
			return Vec::new();
		};
		let Some(ui) = self.app.read(cx).store().domains.extension_ui.get(session) else {
			return Vec::new();
		};
		let palette = cx.theme().palette;
		ui.widgets
			.iter()
			.filter(|widget| widget.placement == placement)
			.map(|widget| {
				let lines = widget
					.lines
					.iter()
					.map(|line| {
						div()
							.min_w_0()
							.truncate()
							.child(SharedString::from(line.clone()))
					})
					.chain(widget.truncated.then(|| {
						div()
							.text_color(palette.text.faint)
							.child("... (widget truncated)")
					}));
				div()
					.id(SharedString::from(format!("composer-widget-{}", widget.key)))
					.flex()
					.flex_col()
					.px(space::S3)
					.type_style(text::SMALL)
					.text_color(palette.text.muted)
					.children(lines)
					.into_any_element()
			})
			.collect()
	}

	/// Why the last attachment or send was refused, under the frame.
	pub(super) fn render_notice(&self, cx: &App) -> Option<AnyElement> {
		let notice = self.notice.clone()?;
		let palette = cx.theme().palette;
		Some(
			div()
				.id("composer-notice")
				.px(space::S3)
				.type_style(text::SMALL)
				.text_color(palette.status.error)
				.child(notice)
				.into_any_element(),
		)
	}
}
