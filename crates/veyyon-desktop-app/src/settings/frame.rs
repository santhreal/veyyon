//! The settings frame: the page navigation, the page's column with the
//! refusal line above it, and the dialog over both. Each render forgets the
//! driver targets the last one drew and this one does not.

use veyyon_desktop_ui::{
	controls::hover_transition,
	icons::Icon,
	theme::{ActiveTheme, TypeStyled, radius, size, space, text},
};
use veyyon_gpui::{
	Context, Div, IntoElement, KeyDownEvent, Render, SharedString, Window, div, prelude::*,
};

use super::{Page, SettingsView, targets};
use crate::{actions::workspace, driver};

impl SettingsView {
	fn nav(&self, cx: &Context<Self>) -> Div {
		let palette = cx.theme().palette;
		let mut column = div()
			.flex_none()
			.w(size::SETTINGS_NAV)
			.h_full()
			.p(space::S2)
			.flex()
			.flex_col()
			.gap(space::S0_5)
			.border_r_1()
			.border_color(palette.border.subtle)
			.child(
				div()
					.id("settings-back")
					.flex()
					.items_center()
					.h(size::ROW)
					.px(space::S2)
					.mb(space::S2)
					.rounded(radius::MD)
					.type_style(text::UI)
					.text_color(palette.text.muted)
					.transition(hover_transition())
					.hover(|el| el.bg(palette.bg.hover))
					.on_click(|_, window, cx| {
						window.dispatch_action(Box::new(workspace::CloseSettings), cx);
					})
					.child("← Back to thread"),
			);
		for page in Page::ALL {
			let selected = page == self.page;
			let entry = div()
				.id(page.name())
				.flex()
				.items_center()
				.gap(space::S2)
				.h(size::ROW)
				.px(space::S2)
				.rounded(radius::MD)
				.type_style(text::UI)
				.transition(hover_transition())
				.when(selected, |el| el.bg(palette.bg.selected).text_color(palette.text.primary))
				.when(!selected, |el| {
					el.text_color(palette.text.secondary)
						.hover(|el| el.bg(palette.bg.hover))
				})
				.on_click(cx.listener(move |this, _, window, cx| {
					this.show(page, cx);
					// The layout states the page shown, so settings reopen on it
					// and asking for another page later is a change.
					let name = SharedString::new_static(page.name());
					this.requested = (true, Some(name.clone()));
					window.dispatch_action(Box::new(workspace::OpenSettings { page: Some(name) }), cx);
				}))
				.child(
					Icon::new(page.icon())
						.size(size::ICON_SM)
						.color(palette.text.muted),
				)
				.child(page.label());
			column = column.child(targets::target(("settings.page", page.name()), entry));
		}
		column
	}

	/// Forgets every target the view drew, for a view no longer shown.
	pub(super) fn forget_targets(&mut self, window: &Window, cx: &mut veyyon_gpui::App) {
		for id in self.drawn.drain() {
			driver::forget(window, &id, cx);
		}
		driver::forget(window, "dialog", cx);
	}

	/// Escape outside an input, with no question asked, closes settings. An
	/// input and the dialog take their own Escape first.
	fn on_key_down(event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
		if event.keystroke.key == "escape" {
			cx.stop_propagation();
			window.dispatch_action(Box::new(workspace::CloseSettings), cx);
		}
	}
}

impl Render for SettingsView {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.renders += 1;
		// Whatever an earlier render left noted is not this render's.
		targets::take();
		let palette = cx.theme().palette;
		let content = match self.page {
			Page::General => self.general(window, cx),
			Page::Appearance => self.appearance(cx),
			Page::Keybindings => self.keybindings(window, cx),
			Page::Providers => self.providers(window, cx),
			Page::Mcp => self.mcp(window, cx),
			Page::Extensions => self.extensions(cx),
		};
		let failure = self.failure.clone().map(|failure| {
			targets::target(
				"settings.error",
				div()
					.mb(space::S3)
					.px(space::S3)
					.py(space::S2)
					.rounded(radius::MD)
					.border_1()
					.border_color(palette.status.error)
					.type_style(text::UI)
					.text_color(palette.status.error)
					.child(failure),
			)
		});
		let nav = self.nav(cx);
		let drawn = targets::take();
		for gone in self.drawn.difference(&drawn) {
			driver::forget(window, gone, cx);
		}
		self.drawn = drawn;
		// The dialog registers its own target when it renders.
		let dialog = self.dialog.as_ref().map(|(dialog, _)| dialog.clone());
		if dialog.is_none() {
			driver::forget(window, "dialog", cx);
		}
		div()
			.track_focus(&self.focus)
			.key_context("Settings")
			.on_key_down(cx.listener(|_, event, window, cx| Self::on_key_down(event, window, cx)))
			.size_full()
			.flex()
			.bg(palette.bg.app)
			.child(nav)
			.child(
				div()
					.id("settings-content")
					.flex_1()
					.h_full()
					.overflow_y_scroll()
					.track_scroll(&self.scroll)
					.child(
						div()
							.max_w(size::SETTINGS_COLUMN)
							.w_full()
							.mx_auto()
							.px(space::S6)
							.py(space::S6)
							.children(failure)
							.child(content),
					),
			)
			.children(dialog)
	}
}
