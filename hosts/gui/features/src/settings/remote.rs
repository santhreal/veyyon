//! Truthful shells for engine-owned settings data.

use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	UiCommand,
	model::{CapabilityStatus, ConnectionState, RemoteData, StaleReason},
};
use veyyon_gui_kit::{
	theme::space,
	ui::{Banner, Empty, Fill, Icon, Size, Tone, text},
};

use crate::act;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostState<'a> {
	Detached,
	Loading,
	Connected,
	Stale(&'a str),
	Fatal(&'a str),
}

pub fn host_state(connection: &ConnectionState) -> HostState<'_> {
	match connection {
		ConnectionState::Detached => HostState::Detached,
		ConnectionState::Connecting { .. } | ConnectionState::Syncing { .. } => HostState::Loading,
		ConnectionState::Connected { .. } => HostState::Connected,
		ConnectionState::Reconnecting { message, .. } => HostState::Stale(message),
		ConnectionState::Fatal { message } => HostState::Fatal(message),
	}
}
pub fn capability_state<'a>(
	connection: &'a ConnectionState,
	capability: &'a CapabilityStatus,
) -> HostState<'a> {
	match capability {
		CapabilityStatus::Available => host_state(connection),
		CapabilityStatus::Unavailable { reason } => HostState::Fatal(reason),
		CapabilityStatus::UnknownUntilAttached if connection.is_connected() => {
			HostState::Fatal("The attached host did not advertise this capability.")
		},
		CapabilityStatus::UnknownUntilAttached => host_state(connection),
	}
}

pub fn mutation_state(mutable: bool) -> HostState<'static> {
	if mutable {
		HostState::Connected
	} else {
		HostState::Stale("Changes are disabled until the engine reconnects.")
	}
}

pub struct Copy<'a> {
	pub loading:     &'a str,
	pub empty:       &'a str,
	pub empty_note:  &'a str,
	pub detached:    &'a str,
	pub unavailable: &'a str,
}

pub fn render<T>(
	data: &RemoteData<T>,
	host: HostState<'_>,
	copy: Copy<'_>,
	retry: UiCommand,
	content: impl Fn(&T, bool, &mut App) -> AnyElement,
	cx: &mut App,
) -> AnyElement {
	let mutable = matches!(host, HostState::Connected);
	if data.readable().is_none() {
		match host {
			HostState::Detached => {
				return Empty::new(copy.detached)
					.icon(Icon::Engine)
					.note("Attach an engine to load this registry.")
					.filling()
					.into_any_element();
			},
			HostState::Fatal(message) => {
				return Empty::new(copy.unavailable)
					.icon(Icon::Failed)
					.note(message.to_owned())
					.filling()
					.into_any_element();
			},
			HostState::Stale(message) => {
				return Empty::new(copy.loading)
					.icon(Icon::Running)
					.note(message.to_owned())
					.filling()
					.into_any_element();
			},
			HostState::Loading | HostState::Connected => {},
		}
	}

	match data {
		RemoteData::Unrequested | RemoteData::Loading { .. } => div()
			.flex()
			.items_center()
			.justify_center()
			.gap(px(space::BASE))
			.py(px(space::HUGE))
			.child(crate::settings::controls::spinner("settings-loading", Icon::Running))
			.child(text::line(copy.loading))
			.into_any_element(),
		RemoteData::Empty => Empty::new(copy.empty)
			.note(copy.empty_note)
			.filling()
			.into_any_element(),
		RemoteData::Ready(value) => match host {
			HostState::Stale(message) | HostState::Fatal(message) => text::stack(space::BASE)
				.child(Banner::waiting("Showing the last confirmed data").detail(message.to_owned()))
				.child(content(value, false, cx))
				.into_any_element(),
			HostState::Detached | HostState::Loading | HostState::Connected => {
				content(value, mutable, cx)
			},
		},
		RemoteData::Stale { value, reason } => text::stack(space::BASE)
			.child(Banner::waiting("Showing the last confirmed data").detail(stale_reason(reason)))
			.child(content(value, false, cx))
			.into_any_element(),
		RemoteData::Error { message, retryable, stale } => {
			let mut banner = Banner::failure(if *retryable {
				"This data could not be refreshed"
			} else {
				copy.unavailable
			})
			.detail(message.clone());
			if *retryable {
				let mut retry_btn = crate::settings::controls::button("settings-retry", "Retry")
					.icon(Icon::Running)
					.fill(Fill::Tinted)
					.tone(Tone::Danger)
					.size(Size::Small);
				if !mutable {
					retry_btn = retry_btn.disabled("Connection is not active");
				} else {
					retry_btn = retry_btn.on_click(act::click(retry));
				}
				banner = banner.child(retry_btn);
			}
			let mut stack = text::stack(space::BASE).child(banner);
			if let Some(value) = stale {
				stack = stack.child(content(value, false, cx));
			}
			stack.into_any_element()
		},
	}
}

fn stale_reason(reason: &StaleReason) -> String {
	match reason {
		StaleReason::Disconnected => "The engine is disconnected.".to_owned(),
		StaleReason::Reconnecting => "The engine is reconnecting.".to_owned(),
		StaleReason::RevisionGap { expected, received } => {
			format!("Expected revision {expected}, received {received}.")
		},
		StaleReason::RefreshFailed(message) => message.clone(),
	}
}
