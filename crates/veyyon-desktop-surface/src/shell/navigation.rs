//! Native tab membership controls and named space navigation.

use veyyon_desktop_kit::{
	Button, ButtonSize, ButtonVariant, ColorRole, SpacingStep, TextRamp, TokenSet, input::TextField,
};
use veyyon_desktop_model::SessionId;
use veyyon_gpui::{
	AppContext, Context, Div, FocusHandle, InteractiveElement, IntoElement, ParentElement, Render,
	SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use crate::{Intent, ShellView};

#[derive(Default)]
pub(super) struct NavigationUi {
	return_focus: Option<FocusHandle>,
}

#[derive(Clone)]
struct TabDrag {
	session: SessionId,
	title:   String,
	tokens:  TokenSet,
}

impl Render for TabDrag {
	fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
		div()
			.px(self.tokens.spacing(SpacingStep::S3))
			.py(self.tokens.spacing(SpacingStep::S2))
			.bg(self.tokens.color(ColorRole::Rail))
			.text_color(self.tokens.color(ColorRole::Foreground))
			.text_size(self.tokens.font_size(TextRamp::Small))
			.child(self.title.clone())
	}
}

impl ShellView {
	/// A navigation transition cannot outrun work that still owns the current
	/// draft.
	pub const fn navigation_rejection(&self) -> Option<&'static str> {
		if self.submitted.is_some() {
			Some("Wait for the pending submission before changing tabs or spaces")
		} else if self.state.navigation_pending {
			Some("Wait for the session to finish opening before changing its draft or navigating")
		} else if self.attachments_loading() {
			Some("Wait for attachment loading before changing tabs or spaces")
		} else if self.state.close_tab_prompt.is_some() {
			Some("Confirm or cancel the pending tab close before navigating")
		} else {
			None
		}
	}

	pub fn request_close_tab(
		&mut self,
		session: SessionId,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if let Some(reason) = self.navigation_rejection() {
			self.set_notice(Some(reason.into()), cx);
			return;
		}
		let current = self.state.navigation.active().selected.as_ref() == Some(&session);
		let dirty = if current {
			!self.composer_cache.is_empty() || !self.state.composer.attachments.is_empty()
		} else {
			self
				.state
				.session_tabs
				.iter()
				.any(|(id, _, dirty)| id == &session && *dirty)
		};
		if dirty {
			self.navigation_ui.return_focus = window.focused(cx);
			self.state.close_tab_prompt = Some(session);
			cx.notify();
		} else {
			self.dispatch(Intent::CloseSessionTab(session), cx);
		}
	}

	pub fn answer_close_tab(&mut self, close: bool, window: &mut Window, cx: &mut Context<Self>) {
		let session = self.state.close_tab_prompt.take();
		if close && let Some(session) = session {
			self.dispatch(Intent::CloseSessionTab(session), cx);
		}
		if let Some(focus) = self.navigation_ui.return_focus.take() {
			window.focus(&focus, cx);
		}
		cx.notify();
	}

	pub(super) fn navigation_height(&self) -> f32 {
		self.installed.surface.shell.titlebar_height_px
			* if self.state.close_tab_prompt.is_some() {
				3.0
			} else {
				2.0
			}
	}

	pub(super) fn navigation_strip(&mut self, window: &Window, cx: &mut Context<Self>) -> Div {
		let tokens = self.installed.set.clone();
		let height = self.installed.surface.shell.titlebar_height_px;
		let current = self.state.navigation.active();
		let (space_id, name) = (current.id, current.name.clone());
		let editor = self.space_name_field_editor(space_id, &name, window, cx);
		let mut spaces = div()
			.id("space-list")
			.flex()
			.items_center()
			.overflow_x_scroll()
			.flex_1()
			.min_w_0()
			.gap(tokens.spacing(SpacingStep::S1));
		for space in self.state.navigation.spaces() {
			let id = space.id;
			spaces = spaces.child(
				Button::new(SharedString::from(format!("space-{id}")), space.name.clone())
					.size(ButtonSize::Small)
					.variant(if id == space_id {
						ButtonVariant::Default
					} else {
						ButtonVariant::Ghost
					})
					.on_click(
						cx.listener(move |view, _, _, cx| view.dispatch(Intent::SwitchSpace(id), cx)),
					),
			);
		}
		let mut tabs = div()
			.id("session-tab-list")
			.flex()
			.items_center()
			.overflow_x_scroll()
			.flex_1()
			.min_w_0()
			.h_full()
			.gap(tokens.spacing(SpacingStep::S1));
		for (session, title, persisted_dirty) in &self.state.session_tabs {
			let selected = self.state.navigation.active().selected.as_ref() == Some(session);
			let dirty = if selected {
				!self.composer_cache.is_empty() || !self.state.composer.attachments.is_empty()
			} else {
				*persisted_dirty
			};
			let select = session.clone();
			let close = session.clone();
			let target = session.clone();
			let drag =
				TabDrag { session: session.clone(), title: title.clone(), tokens: tokens.clone() };
			tabs = tabs.child(
				div()
					.id(SharedString::from(format!("session-tab-{}", session.0)))
					.flex()
					.items_center()
					.flex_shrink_0()
					.cursor_pointer()
					.bg(tokens.color(if selected {
						ColorRole::Ground
					} else {
						ColorRole::Rail
					}))
					.on_drag(drag, |drag: &TabDrag, _, _, cx| cx.new(|_| drag.clone()))
					.on_drop(cx.listener(move |view, drag: &TabDrag, _, cx| {
						view.dispatch(
							Intent::ReorderSessionTab {
								session: drag.session.clone(),
								target:  target.clone(),
							},
							cx,
						);
					}))
					.child(
						Button::new(
							SharedString::from(format!("select-tab-{}", session.0)),
							if dirty {
								format!("{title} (draft)")
							} else {
								title.clone()
							},
						)
						.size(ButtonSize::Small)
						.variant(ButtonVariant::Ghost)
						.on_click(cx.listener(move |view, _, _, cx| {
							view.dispatch(Intent::OpenSession(select.clone()), cx);
						})),
					)
					.child(
						Button::new(SharedString::from(format!("close-tab-{}", session.0)), "Close")
							.size(ButtonSize::Small)
							.variant(ButtonVariant::Ghost)
							.on_click(cx.listener(move |view, _, window, cx| {
								cx.stop_propagation();
								view.request_close_tab(close.clone(), window, cx);
							})),
					),
			);
		}
		let mut strip = div()
			.flex()
			.flex_col()
			.flex_shrink_0()
			.bg(tokens.color(ColorRole::Rail))
			.child(
				div()
					.flex()
					.items_center()
					.h(px(height))
					.px(tokens.spacing(SpacingStep::S2))
					.gap(tokens.spacing(SpacingStep::S2))
					.child(spaces)
					.child(
						div()
							.w(px(self.installed.surface.queue.width_min_px))
							.child(TextField::new("space-name", editor)),
					)
					.child(
						Button::new("space-create", "New space")
							.size(ButtonSize::Small)
							.variant(ButtonVariant::Ghost)
							.on_click(cx.listener(|view, _, _, cx| {
								let mut number = view.state.navigation.spaces().count() + 1;
								while view
									.state
									.navigation
									.spaces()
									.any(|space| space.name == format!("Space {number}"))
								{
									number += 1;
								}
								view.dispatch(Intent::CreateSpace(format!("Space {number}")), cx);
							})),
					),
			)
			.child(
				div()
					.flex()
					.items_center()
					.h(px(height))
					.px(tokens.spacing(SpacingStep::S2))
					.child(tabs)
					.child(
						Button::new("tab-open", "Open session")
							.size(ButtonSize::Small)
							.variant(ButtonVariant::Ghost)
							.on_click(cx.listener(|view, _, _, cx| {
								view.dispatch(Intent::FindSessions(String::new()), cx);
							})),
					),
			);
		if self.state.close_tab_prompt.is_some() {
			strip = strip.child(
				div()
					.flex()
					.items_center()
					.h(px(height))
					.gap(tokens.spacing(SpacingStep::S2))
					.px(tokens.spacing(SpacingStep::S2))
					.child("Close this tab? The unsent draft will remain saved.")
					.child(
						Button::new("tab-close-cancel", "Cancel")
							.size(ButtonSize::Small)
							.variant(ButtonVariant::Ghost)
							.on_click(
								cx.listener(|view, _, window, cx| view.answer_close_tab(false, window, cx)),
							),
					)
					.child(
						Button::new("tab-close-confirm", "Close tab")
							.size(ButtonSize::Small)
							.variant(ButtonVariant::Default)
							.on_click(
								cx.listener(|view, _, window, cx| view.answer_close_tab(true, window, cx)),
							),
					),
			);
		}
		strip
	}
}
