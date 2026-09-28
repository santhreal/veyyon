//! The drawer's frame: the tab strip with the shown tab's controls beside it,
//! the shown tab's content, and the refusal row over it.

use veyyon_desktop_model::{HostActionKind, SurfaceId, TerminalStatus};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, Spinner},
	icons::IconName,
	theme::{ActiveTheme, TypeStyled, size, space, text},
};
use veyyon_gpui::{
	AnyElement, App, ClickEvent, Context, FocusHandle, Focusable, IntoElement, Render, SharedString,
	Window, div, prelude::*,
};

use super::{DrawerTab, TerminalDrawer, tabs};
use crate::{driver, panel::style::empty_state};

impl TerminalDrawer {
	/// `element` registered as the driver target `id`, noted as drawn by the
	/// render in progress so the next render forgets it once it is not.
	pub(super) fn target(&self, id: impl driver::TargetId, element: impl IntoElement) -> AnyElement {
		if !driver::is_enabled() {
			return element.into_any_element();
		}
		let id = id.into_target_id();
		self.noted.borrow_mut().insert(id.clone());
		driver::target(id, element)
	}

	/// Forgets the targets the last render drew and this one did not. The
	/// strip's tabs are drawn by the strip's own view, so they are counted
	/// from the strip the drawer holds.
	fn forget_undrawn(&mut self, window: &Window, cx: &mut App) {
		if !driver::is_enabled() {
			return;
		}
		let mut drawn = self.noted.take();
		drawn.extend(
			self
				.strip
				.iter()
				.map(|tab| SharedString::from(format!("drawer.tab:{}", tab.slug()))),
		);
		for gone in self.drawn.difference(&drawn) {
			driver::forget(window, gone, cx);
		}
		self.drawn = drawn;
	}

	/// What the shown tab draws under the strip.
	fn content(&self, shown: Option<DrawerTab>, window: &Window, cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let Some(tab) = shown else {
			if self.creating {
				let waiting = div()
					.flex()
					.flex_1()
					.items_center()
					.justify_center()
					.child(Spinner::new("drawer-starting"));
				return waiting.into_any_element();
			}
			let app = self.app.read(cx);
			if !tabs::terminals_offered(app) {
				let copy = "The host runs no terminals and supervises no processes.";
				return empty_state(copy, None::<AnyElement>, &palette).into_any_element();
			}
			let open = Button::new("drawer-empty-new", "New terminal")
				.icon(IconName::Terminal)
				.size(ButtonSize::Sm)
				.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.new_terminal(cx)));
			return empty_state("No terminal is open.", Some(open), &palette).into_any_element();
		};
		match &tab {
			DrawerTab::Processes => self.supervisor(cx),
			DrawerTab::Terminal(id) => {
				let failed = self
					.app
					.read(cx)
					.store()
					.domains
					.terminals
					.iter()
					.find_map(|terminal| match &terminal.status {
						TerminalStatus::Failed { message } if &terminal.id == id => Some(message.clone()),
						_ => None,
					});
				let grid = self.grid(&tab, window, cx);
				div()
					.flex()
					.flex_col()
					.size_full()
					.when_some(failed, |el, message| {
						el.child(
							div()
								.px(space::S3)
								.pt(space::S2)
								.type_style(text::SMALL)
								.text_color(palette.status.error)
								.child(format!("The shell failed: {message}")),
						)
					})
					.child(grid)
					.into_any_element()
			},
			DrawerTab::Process(name) => {
				let surface =
					self.surface(cx, |session| SurfaceId::ProcessSendButton(session, name.clone()));
				let refused = self
					.app
					.read(cx)
					.panel_unavailable(HostActionKind::ProcessSend);
				let send = Button::new("drawer-send", "Send")
					.size(ButtonSize::Sm)
					.disabled(refused.is_some())
					.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.send_line(cx)));
				let send = self.control_button(send, &surface, &format!("send:{name}"));
				let grid = self.grid(&tab, window, cx);
				div()
					.flex()
					.flex_col()
					.size_full()
					.child(grid)
					.child(
						div()
							.flex()
							.flex_none()
							.items_center()
							.gap(space::S1)
							.px(space::S2)
							.h(size::CONTROL_LG)
							.border_t_1()
							.border_color(palette.border.subtle)
							.child(div().flex_1().min_w_0().child(self.line.clone()))
							.child(send),
					)
					.into_any_element()
			},
		}
	}
}

impl Focusable for TerminalDrawer {
	fn focus_handle(&self, _: &App) -> FocusHandle {
		self.focus.clone()
	}
}

impl Render for TerminalDrawer {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.renders += 1;
		let palette = cx.theme().palette;
		let shown = self.shown(cx);
		let trailing = self.trailing(shown.as_ref(), cx);
		let refusal = self.refusal(&palette, cx);
		let content = self.content(shown, window, cx);
		self.forget_undrawn(window, cx);
		// The workspace registers the `drawer` target around this region.
		div()
			.id("drawer")
			.key_context("Drawer")
			.flex()
			.flex_col()
			.size_full()
			.min_h_0()
			.overflow_hidden()
			.bg(palette.bg.surface)
			.border_t_1()
			.border_color(palette.border.subtle)
			.child(
				div()
					.flex()
					.flex_none()
					.child(
						div()
							.flex_1()
							.min_w_0()
							.overflow_hidden()
							.child(self.tabs.clone()),
					)
					.child(
						div()
							.flex()
							.flex_none()
							.items_center()
							.gap(space::S0_5)
							.px(space::S1)
							.border_b_1()
							.border_color(palette.border.subtle)
							.children(trailing),
					),
			)
			.child(
				div()
					.relative()
					.flex()
					.flex_col()
					.flex_1()
					.min_h_0()
					.child(content)
					.children(refusal),
			)
			.child(self.signals.clone())
	}
}
