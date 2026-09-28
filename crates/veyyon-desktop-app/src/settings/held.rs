//! The changes a page draws before the host answers them.
//!
//! A switch flipped, a choice picked, a theme chosen or a binding typed draws
//! its new value from the click on, rather than the host's old one while the
//! host writes it. The page holds each change until every request it sent is
//! answered, by which time the answers carry the sections the changes are in.
//! A change the host refuses is dropped at once, so its row draws the host's
//! value again beside the refusal.

use std::collections::BTreeMap;

use serde_json::Value;
use veyyon_desktop_model::{
	HostAction, KeybindingView, McpServerView, RequestId, SettingEntry, ThemesView,
};

/// One change a request makes to a value a page draws.
#[derive(Debug)]
pub(super) enum Change {
	Setting { key: String, value: Value },
	Keys { action: String, keys: Vec<String> },
	Server { name: String, enabled: bool },
}

impl Change {
	/// What `action` changes. A reset changes the setting to its default,
	/// read from `settings`. A request that changes no drawn value is none.
	pub(super) fn of(
		action: &HostAction,
		settings: Option<&BTreeMap<String, SettingEntry>>,
	) -> Option<Self> {
		match action {
			HostAction::SetSetting { key, value } => {
				Some(Self::Setting { key: key.clone(), value: value.clone() })
			},
			HostAction::ResetSetting { key } => {
				let entry = settings?.get(key)?;
				Some(Self::Setting { key: key.clone(), value: entry.default.clone() })
			},
			HostAction::SetKeybinding { action, keys } => {
				Some(Self::Keys { action: action.clone(), keys: keys.clone() })
			},
			HostAction::SetMcpEnabled { server, enabled } => {
				Some(Self::Server { name: server.clone(), enabled: *enabled })
			},
			_ => None,
		}
	}
}

/// The changes the page sent that the host has not answered, oldest first.
#[derive(Debug, Default)]
pub(super) struct Held(Vec<(RequestId, Change)>);

impl Held {
	/// Holds `change`, sent as `request`.
	pub(super) fn hold(&mut self, request: RequestId, change: Option<Change>) {
		if let Some(change) = change {
			self.0.push((request, change));
		}
	}

	/// Settles `request`: a refused change is dropped, and once `quiet`, no
	/// request of the page outstanding, every change is. Answers whether a
	/// change was dropped.
	pub(super) fn settle(&mut self, request: RequestId, ok: bool, quiet: bool) -> bool {
		let before = self.0.len();
		if quiet {
			self.0.clear();
		} else if !ok {
			self.0.retain(|(held, _)| *held != request);
		}
		self.0.len() != before
	}

	/// Drops every change, for a page shown afresh.
	pub(super) fn clear(&mut self) {
		self.0.clear();
	}

	/// Draws each held setting's value in `settings`.
	pub(super) fn settings(&self, settings: &mut BTreeMap<String, SettingEntry>) {
		for (key, value) in self.setting_values() {
			if let Some(entry) = settings.get_mut(key) {
				entry.value.clone_from(value);
			}
		}
	}

	/// Draws each held `theme.dark` and `theme.light` choice in `themes`.
	pub(super) fn themes(&self, themes: &mut ThemesView) {
		for (key, value) in self.setting_values() {
			let ground = match key {
				"theme.dark" => &mut themes.dark,
				"theme.light" => &mut themes.light,
				_ => continue,
			};
			if let Value::String(theme) = value {
				ground.clone_from(theme);
			}
		}
	}

	/// Draws each held binding in `bindings`, as the user's own.
	pub(super) fn keybindings(&self, bindings: &mut [KeybindingView]) {
		for (_, change) in &self.0 {
			let Change::Keys { action, keys } = change else {
				continue;
			};
			if let Some(binding) = bindings
				.iter_mut()
				.find(|binding| binding.action == *action)
			{
				binding.keys.clone_from(keys);
				"user".clone_into(&mut binding.source);
			}
		}
	}

	/// Draws each held switch position in `servers`.
	pub(super) fn servers(&self, servers: &mut [McpServerView]) {
		for (_, change) in &self.0 {
			let Change::Server { name, enabled } = change else {
				continue;
			};
			if let Some(server) = servers.iter_mut().find(|server| server.name == *name) {
				server.enabled = *enabled;
			}
		}
	}

	fn setting_values(&self) -> impl Iterator<Item = (&str, &Value)> {
		self.0.iter().filter_map(|(_, change)| match change {
			Change::Setting { key, value } => Some((key.as_str(), value)),
			Change::Keys { .. } | Change::Server { .. } => None,
		})
	}
}
