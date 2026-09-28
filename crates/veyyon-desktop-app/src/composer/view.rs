//! How the composer is laid out: the strips and the completion list above the
//! frame, the tray, the editor and the footer inside it, the widgets and the
//! refusal line under it, all in a column no wider than the transcript's. The
//! frame's edge strengthens while the editor has the keyboard and takes the
//! accent while files are dragged over it.

use gpui::{Context, ExternalPaths, Focusable, IntoElement, Render, Window, div, prelude::*};
use veyyon_desktop_model::ExtensionWidgetPlacement;
use veyyon_desktop_ui::theme::{ActiveTheme, radius, size, space};

use super::{Composer, KEY_CONTEXT, measure::measure};
use crate::driver;

impl Render for Composer {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.renders += 1;
		let palette = cx.theme().palette;
		let edge = if self.editor.focus_handle(cx).contains_focused(window, cx) {
			palette.border.strong
		} else {
			palette.border.default
		};
		let dropping = palette.accent.base;
		let strips = self.render_strips(cx);
		let completion = self.render_completion(cx);
		let tray = self.render_tray(cx);
		let footer = self.render_footer(cx);
		let below = self.render_widgets(ExtensionWidgetPlacement::BelowEditor, cx);
		let notice = self.render_notice(cx);
		let frame = div()
			.id("composer-frame")
			.flex()
			.flex_col()
			.gap(space::S2)
			.px(space::S3)
			.pt(space::S3)
			.pb(space::S2)
			.rounded(radius::XL)
			.border_1()
			.border_color(edge)
			.drag_over::<ExternalPaths>(move |style, _, _, _| style.border_color(dropping))
			.bg(palette.bg.surface)
			.children(tray)
			.child(div().px(space::S1).child(self.editor.clone()))
			.child(footer);
		let column = div()
			.flex()
			.flex_col()
			.gap(space::S2)
			.w_full()
			.max_w(size::COLUMN_MAX)
			.mx_auto()
			.children(strips)
			.children(completion)
			.child(frame)
			.children(below)
			.children(notice);
		let element = Self::listen(div().id("composer").key_context(KEY_CONTEXT), cx)
			.w_full()
			.px(space::S6)
			.pb(space::S4)
			.child(column)
			.children(self.render_pickers());
		measure(div().child(driver::target("composer", element)), cx)
	}
}
