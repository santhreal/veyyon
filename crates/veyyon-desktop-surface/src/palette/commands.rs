//! Native command entries for existing desktop surfaces and composer actions.

use strum::{EnumIter, IntoEnumIterator};
use veyyon_desktop_model::Capability;

use super::{PaletteItem, PaletteItemKind};
use crate::{Command, Intent, navigation::SurfaceRoute, settings::SettingsPage};

/// Actions requiring the composer's editor or a local selection surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter)]
pub enum ComposerCommand {
	AttachFiles,
	Models,
	Effort,
	QueueMode,
	Steer,
	Queue,
}

impl ComposerCommand {
	#[must_use]
	pub const fn name(self) -> &'static str {
		match self {
			Self::AttachFiles => "/attach",
			Self::Models => "/model",
			Self::Effort => "/effort",
			Self::QueueMode => "/queue-mode",
			Self::Steer => "/steer",
			Self::Queue => "/queue",
		}
	}

	/// The capability the command's action needs from the host, for the
	/// commands whose action a host can decline to carry (§5.13).
	///
	/// A command with no capability of its own is `None`: the draft, the
	/// attachment picker and the steering submission are the window's own or
	/// ride on the turn control the composer's arrow already gates.
	#[must_use]
	pub const fn capability(self) -> Option<Capability> {
		match self {
			Self::AttachFiles | Self::Steer => None,
			Self::Models => Some(Capability::Models),
			Self::Effort => Some(Capability::Models),
			// A follow-up behind a running turn, and the mode that chooses it,
			// are what background submission is.
			Self::QueueMode | Self::Queue => Some(Capability::BackgroundSubmission),
		}
	}
}

/// Every settings page is reachable from command search without adding composer
/// chrome.
#[must_use]
pub fn command_items() -> Vec<PaletteItem> {
	let mut items: Vec<_> = [
		("/new", Intent::NewSession, Command::NewSession.label(), Some("Cmd/Ctrl N")),
		("/terminal", Intent::SetDrawer { open: true }, "Open terminal drawer", Some("Cmd/Ctrl J")),
		("/abort", Intent::AbortTurn, Command::AbortTurn.label(), Some("Cmd/Ctrl .")),
		("/account", Intent::Navigate(SurfaceRoute::Account), "Accounts and sign-in", None),
		("/settings", Intent::Navigate(SurfaceRoute::Settings), "Preferences and appearance", None),
	]
	.into_iter()
	.enumerate()
	.map(|(index, (name, intent, description, shortcut))| {
		let mut item = PaletteItem::command(index as u64 + 1, name, intent, shortcut);
		item.subtitle = Some(description.to_owned());
		item
	})
	.collect();
	for page in SettingsPage::iter() {
		if page == SettingsPage::General {
			continue;
		}
		let name = match page {
			SettingsPage::General => "/settings",
			SettingsPage::Themes => "/settings themes",
			SettingsPage::Keybindings => "/hotkeys",
			SettingsPage::Providers => "/account manager",
			SettingsPage::Authentication => "/account login",
			SettingsPage::Mcp => "/mcp",
			SettingsPage::Extensions => "/agents",
			SettingsPage::Diagnostics => "/settings diagnostics",
			SettingsPage::Usage => "/usage",
			SettingsPage::ContextBreakdown => "/context",
		};
		let mut item = PaletteItem::command(
			items.len() as u64 + 1,
			name,
			Intent::Navigate(SurfaceRoute::Page(page)),
			None,
		);
		item.subtitle = Some(page.description().to_owned());
		items.push(item);
	}
	for command in ComposerCommand::iter() {
		let description = match command {
			ComposerCommand::AttachFiles => Command::AttachFile.label(),
			ComposerCommand::Models => Command::ModelPicker.label(),
			ComposerCommand::Effort => Command::ThinkingLevel.label(),
			ComposerCommand::QueueMode => Command::ToggleQueueMode.label(),
			ComposerCommand::Steer => "Steer the running turn with a message",
			ComposerCommand::Queue => "Queue a follow-up message",
		};
		items.push(PaletteItem {
			id:       items.len() as u64 + 1,
			title:    command.name().to_owned(),
			subtitle: Some(description.to_owned()),
			badge:    None,
			meta:     None,
			kind:     PaletteItemKind::Composer { command },
		});
	}
	items
}
