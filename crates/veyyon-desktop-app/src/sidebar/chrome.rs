//! The sidebar's top rows (wordmark, new thread, thread search) and its
//! footer (settings, profile switcher, connection dot).

use gpui::{AnyElement, ClickEvent, Context, SharedString, Window, div, prelude::*};
use veyyon_desktop_model::ConnectionState;
use veyyon_desktop_ui::{
	controls::{DotStatus, IconButton, StatusDot, Tooltip},
	icons::{Icon, IconName},
	theme::{ActiveTheme, TypeStyled, radius, size, space, text},
};

use super::Sidebar;
use crate::actions::workspace::{NewThread, OpenSettings};

impl Sidebar {
	pub(super) fn render_header(&self, cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		div()
			.flex()
			.flex_col()
			.gap(space::S2)
			.px(space::S3)
			.pt(space::S3)
			.pb(space::S2)
			.child(
				div()
					.flex()
					.items_center()
					.justify_between()
					.h(size::CONTROL)
					.child(
						div()
							.type_style(text::TITLE)
							.text_color(palette.text.primary)
							.child("veyyon"),
					)
					.child(
						IconButton::new("sidebar-new-thread", IconName::Pencil)
							.tooltip("New thread")
							.on_click(|_, window, cx| window.dispatch_action(Box::new(NewThread), cx)),
					),
			)
			.child(
				div()
					.flex()
					.items_center()
					.gap(space::S2)
					.h(size::CONTROL)
					.px(space::S2)
					.rounded(radius::MD)
					.border_1()
					.border_color(palette.border.subtle)
					.bg(palette.bg.surface)
					.type_style(text::UI)
					.child(Icon::new(IconName::Search).size(size::ICON_SM).color(palette.text.muted))
					.child(div().flex_1().min_w_0().child(self.search.clone())),
			)
			.into_any_element()
	}

	/// The field naming a new or the active profile, while one is open.
	pub(super) fn render_profile_naming(&self, cx: &Context<Self>) -> Option<AnyElement> {
		let naming = self.naming.as_ref().filter(|naming| naming.is_profile())?;
		let palette = cx.theme().palette;
		Some(
			div()
				.flex()
				.flex_col()
				.gap(space::S1)
				.px(space::S3)
				.py(space::S2)
				.border_t_1()
				.border_color(palette.border.subtle)
				.type_style(text::SMALL)
				.text_color(palette.text.muted)
				.child(if matches!(naming.target, super::naming::NameTarget::NewProfile) {
					"New profile name"
				} else {
					"Profile display name"
				})
				.child(
					div()
						.h(size::CONTROL)
						.px(space::S2)
						.flex()
						.items_center()
						.rounded(radius::MD)
						.border_1()
						.border_color(palette.border.default)
						.bg(palette.bg.surface)
						.type_style(text::UI)
						.text_color(palette.text.primary)
						.child(naming.editor.clone()),
				)
				.into_any_element(),
		)
	}

	pub(super) fn render_footer(&self, _window: &mut Window, cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let store = self.app.read(cx).store();
		let profile: SharedString = store
			.domains
			.profiles
			.as_ref()
			.and_then(|profiles| profiles.active_entry())
			.map_or_else(|| "Profile".into(), |entry| entry.label().into());
		let (status, label) = connection(&store.connection);
		div()
			.flex()
			.items_center()
			.gap(space::S1)
			.px(space::S2)
			.py(space::S2)
			.border_t_1()
			.border_color(palette.border.subtle)
			.child(
				IconButton::new("sidebar-settings", IconName::Settings)
					.tooltip("Settings")
					.on_click(|_, window, cx| {
						window.dispatch_action(Box::new(OpenSettings::default()), cx);
					}),
			)
			.child(
				div()
					.id("sidebar-profile")
					.flex_1()
					.min_w_0()
					.flex()
					.items_center()
					.gap(space::S1_5)
					.h(size::CONTROL)
					.px(space::S2)
					.rounded(radius::MD)
					.type_style(text::UI)
					.text_color(palette.text.secondary)
					.hover(move |style| style.bg(palette.bg.hover).text_color(palette.text.primary))
					.tooltip(Tooltip::text("Switch profile"))
					.on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
						this.open_profile_menu(event.position(), window, cx);
					}))
					.child(Icon::new(IconName::User).size(size::ICON_SM).color(palette.text.muted))
					.child(div().flex_1().min_w_0().truncate().child(profile)),
			)
			.child(
				div()
					.id("sidebar-connection")
					.flex()
					.items_center()
					.justify_center()
					.size(size::CONTROL)
					.tooltip(Tooltip::text(label))
					.child(StatusDot::new(status)),
			)
			.into_any_element()
	}
}

/// The dot and the tooltip of a connection state.
fn connection(state: &ConnectionState) -> (DotStatus, String) {
	match state {
		ConnectionState::Detached => (DotStatus::Idle, "Detached".to_owned()),
		ConnectionState::Connecting { attempt } => {
			(DotStatus::Waiting, format!("Connecting, attempt {attempt}"))
		},
		ConnectionState::Syncing { .. } => (DotStatus::Waiting, "Syncing".to_owned()),
		ConnectionState::Connected { endpoint, .. } => {
			(DotStatus::Success, format!("Connected to {endpoint}"))
		},
		ConnectionState::Reconnecting { attempt, message, .. } => {
			(DotStatus::Waiting, format!("Reconnecting, attempt {attempt}: {message}"))
		},
		ConnectionState::Fatal { message } => (DotStatus::Error, format!("Disconnected: {message}")),
	}
}
