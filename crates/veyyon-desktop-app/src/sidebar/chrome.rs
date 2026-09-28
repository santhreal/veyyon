//! The sidebar's top rows (wordmark, refresh, new thread, thread search) and
//! its footer (settings, profile switcher, connection dot).

use gpui::{AnyElement, ClickEvent, Context, SharedString, Window, div, prelude::*};
use veyyon_desktop_model::{ConnectionState, Gate, HostAction, HostActionKind, SurfaceId};
use veyyon_desktop_ui::{
	controls::{DotStatus, IconButton, StatusDot, Tooltip},
	icons::{Icon, IconName},
	theme::{ActiveTheme, TypeStyled, radius, size, space, text},
};

use super::Sidebar;
use crate::{
	actions::workspace::{NewThread, OpenSettings},
	driver, workspace,
};

impl Sidebar {
	pub(super) fn render_header(&self, cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let app = self.app.read(cx);
		let list_unavailable = unavailable(app.gate(HostActionKind::ListSessions));
		let create_unavailable = unavailable(app.gate(HostActionKind::CreateSession));
		let create_disabled = create_unavailable.is_some();
		let refreshing = self.refreshing.is_some();
		let refresh_disabled = refreshing || list_unavailable.is_some();
		let tooltip = match (list_unavailable, refreshing) {
			(Some(reason), _) => reason,
			(None, true) => "Refreshing threads".to_owned(),
			(None, false) => "Refresh threads".to_owned(),
		};
		let refresh = IconButton::new("sidebar-refresh", IconName::RefreshCw)
			.tooltip(tooltip)
			.disabled(refresh_disabled)
			.on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
				let request = this.app.update(cx, |app, cx| {
					app.dispatch(HostAction::ListSessions, SurfaceId::QueueFilterInput, cx)
				});
				this.refreshing = Some(request);
				cx.notify();
			}));
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
					.h(size::CONTROL)
					.child(workspace::drag_region(
						div()
							.flex_1()
							.h_full()
							.flex()
							.items_center()
							.type_style(text::TITLE)
							.text_color(palette.text.primary)
							.child("veyyon"),
					))
					.child(
						div()
							.flex()
							.items_center()
							.gap(space::S1)
							.child(driver::target("sidebar.refresh", refresh))
							.child(
								IconButton::new("sidebar-new-thread", IconName::Pencil)
									.tooltip(create_unavailable.unwrap_or_else(|| "New thread".to_owned()))
									.disabled(create_disabled)
									.on_click(|_, window, cx| {
										window.dispatch_action(Box::new(NewThread), cx);
									}),
							),
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
					.child(
						Icon::new(IconName::Search)
							.size(size::ICON_SM)
							.color(palette.text.muted),
					)
					.child(div().flex_1().min_w_0().child(self.search.clone()))
					.when(!self.query.is_empty(), |el| {
						el.child(
							IconButton::new("sidebar-search-clear", IconName::X)
								.tooltip("Clear search")
								.on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
									this.search.update(cx, |editor, cx| editor.set_text("", cx));
								})),
						)
					}),
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
		let button = self.profile_button.clone();
		let asked = self.profile_asked.clone();
		let sidebar = cx.weak_entity();
		div()
			.flex()
			.items_center()
			.gap(space::S1)
			.px(space::S2)
			.py(space::S2)
			.border_t_1()
			.border_color(palette.border.subtle)
			.on_children_prepainted(move |laid, window, _| {
				let Some(bounds) = laid.get(PROFILE_BUTTON).copied() else {
					return;
				};
				button.set(Some(bounds));
				if asked.replace(false) {
					let sidebar = sidebar.clone();
					window.on_next_frame(move |window, cx| {
						let _ = sidebar.update(cx, |sidebar, cx| {
							sidebar.open_profile_menu(bounds.origin, window, cx);
						});
					});
				}
			})
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
					.child(
						Icon::new(IconName::User)
							.size(size::ICON_SM)
							.color(palette.text.muted),
					)
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

/// The footer child that is the profile button: settings, profile, connection.
const PROFILE_BUTTON: usize = 1;

/// The reason a gate states an action cannot run, `None` when it can or may.
fn unavailable(gate: Gate) -> Option<String> {
	match gate {
		Gate::Unavailable { reason } => Some(reason),
		Gate::Enabled | Gate::Pending { .. } | Gate::Unknown => None,
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
