//! Native command entries for existing desktop surfaces and composer actions.

use strum::{EnumIter, IntoEnumIterator};

use super::{PaletteItem, PaletteItemKind};
use crate::{
	Intent, Overlay,
	settings::{SettingsPage, SettingsState},
};

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
}

/// Every settings page is reachable from command search without adding composer
/// chrome.
#[must_use]
pub fn command_items() -> Vec<PaletteItem> {
	let mut items = vec![
		PaletteItem::command(1, "/new", Intent::NewSession, Some("Cmd/Ctrl N")),
		PaletteItem::command(2, "/terminal", Intent::SetDrawer { open: true }, Some("Cmd/Ctrl J")),
		PaletteItem::command(3, "/abort", Intent::AbortTurn, Some("Cmd/Ctrl .")),
	];
	for page in SettingsPage::iter() {
		let name = match page {
			SettingsPage::General => "/settings",
			SettingsPage::Themes => "/settings themes",
			SettingsPage::Keybindings => "/hotkeys",
			SettingsPage::Providers => "/providers",
			SettingsPage::Authentication => "/login",
			SettingsPage::Mcp => "/mcp",
			SettingsPage::Extensions => "/extensions",
			SettingsPage::Diagnostics => "/settings diagnostics",
			SettingsPage::Usage => "/usage",
			SettingsPage::ContextBreakdown => "/context",
		};
		let mut item = PaletteItem::command(
			items.len() as u64 + 1,
			name,
			Intent::OpenOverlay(Box::new(Overlay::Settings(Box::new(SettingsState::new(page))))),
			None,
		);
		item.subtitle = Some(page.description().to_owned());
		items.push(item);
	}
	for command in ComposerCommand::iter() {
		items.push(PaletteItem {
			id:       items.len() as u64 + 1,
			title:    command.name().to_owned(),
			subtitle: None,
			badge:    None,
			meta:     None,
			kind:     PaletteItemKind::Composer { command },
		});
	}
	items
}
