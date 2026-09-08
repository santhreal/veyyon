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

	/// Whether the command sends the draft written after its spelling.
	///
	/// The composer's text is the palette's query while a slash menu is open,
	/// and the ranker scores a query against the row's own name: a message
	/// long enough to outrun that name loses the row it was addressed to. A
	/// command that carries a message is therefore ranked on its first word
	/// alone, and the rest is the message.
	#[must_use]
	pub const fn carries_draft(self) -> bool {
		match self {
			Self::Steer | Self::Queue => true,
			Self::AttachFiles | Self::Models | Self::Effort | Self::QueueMode => false,
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
///
/// A row states the capability its action needs, which is the capability
/// `action_to_capability` maps the host action it reports to; a row that
/// reports nothing to the host states `None`, since no host can decline the
/// window's own navigation.
#[must_use]
pub fn command_items() -> Vec<PaletteItem> {
	let mut items: Vec<_> = [
		(
			"/new",
			Intent::NewSession,
			Command::NewSession.label(),
			Some(Command::NewSession),
			Some(Capability::Sessions),
		),
		(
			"/terminal",
			Intent::SetDrawer { open: true },
			"Open terminal drawer",
			Some(Command::ToggleDrawer),
			// The drawer's two tenants are resolved by the projection, which
			// offers it when either carries it.
			None,
		),
		(
			"/abort",
			Intent::AbortTurn,
			Command::AbortTurn.label(),
			Some(Command::AbortTurn),
			Some(Capability::TurnControl),
		),
		(
			"/files",
			Intent::FindFile(String::new()),
			"Find a file by name",
			None,
			Some(Capability::Files),
		),
		(
			"/search",
			Intent::FindText(String::new()),
			"Search the workspace for text",
			None,
			Some(Capability::Files),
		),
		(
			"/project",
			Intent::BrowseTo { path: None },
			"Browse the workspace directories",
			None,
			Some(Capability::Files),
		),
		("/account", Intent::Navigate(SurfaceRoute::Account), "Accounts and sign-in", None, None),
		(
			"/settings",
			Intent::Navigate(SurfaceRoute::Settings),
			"Preferences and appearance",
			None,
			None,
		),
		(
			"/export",
			Intent::ExportSession(None),
			"Export active session to HTML",
			None,
			Some(Capability::Sessions),
		),
		(
			"/compact",
			Intent::CompactSession(None),
			"Compact active session transcript",
			None,
			Some(Capability::Sessions),
		),
		(
			"/handoff",
			Intent::HandoffSession(None),
			"Hand off active session to a new agent",
			None,
			Some(Capability::Sessions),
		),
		(
			"/reload-transcript",
			Intent::LoadTranscript(None),
			"Reload active session transcript",
			None,
			Some(Capability::Transcript),
		),
	]
	.into_iter()
	.enumerate()
	.map(|(index, (name, intent, description, shortcut, capability))| {
		let mut item = PaletteItem::command(index as u64 + 1, name, intent, shortcut);
		item.subtitle = Some(description.to_owned());
		item.capability = capability;
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
		// The page's own data is what the row asks the host for, so the row
		// rides on the capability that answers it. The two pages the window
		// draws from state it already holds ask for nothing.
		let capability = match page {
			SettingsPage::General => Some(Capability::Settings),
			SettingsPage::Themes => Some(Capability::Themes),
			SettingsPage::Keybindings => Some(Capability::Keybindings),
			SettingsPage::Providers => Some(Capability::Providers),
			SettingsPage::Mcp => Some(Capability::Mcp),
			SettingsPage::Diagnostics => Some(Capability::Diagnostics),
			SettingsPage::Usage => Some(Capability::Usage),
			SettingsPage::ContextBreakdown => Some(Capability::ContextBreakdown),
			SettingsPage::Authentication | SettingsPage::Extensions => None,
		};
		let mut item = PaletteItem::command(
			items.len() as u64 + 1,
			name,
			Intent::Navigate(SurfaceRoute::Page(page)),
			None,
		);
		item.subtitle = Some(page.description().to_owned());
		item.capability = capability;
		items.push(item);
	}
	for command in ComposerCommand::iter() {
		// The chord a command answers to, for the four that have one. Steering
		// and queueing are what the composer's own arrow sends, so neither has
		// a chord of its own to state.
		let chord = match command {
			ComposerCommand::AttachFiles => Some(Command::AttachFile),
			ComposerCommand::Models => Some(Command::ModelPicker),
			ComposerCommand::Effort => Some(Command::ThinkingLevel),
			ComposerCommand::QueueMode => Some(Command::ToggleQueueMode),
			ComposerCommand::Steer | ComposerCommand::Queue => None,
		};
		let description = match command {
			ComposerCommand::AttachFiles => Command::AttachFile.label(),
			ComposerCommand::Models => Command::ModelPicker.label(),
			ComposerCommand::Effort => Command::ThinkingLevel.label(),
			ComposerCommand::QueueMode => Command::ToggleQueueMode.label(),
			ComposerCommand::Steer => "Steer the running turn with a message",
			ComposerCommand::Queue => "Queue a follow-up message",
		};
		items.push(PaletteItem {
			id:         items.len() as u64 + 1,
			title:      command.name().to_owned(),
			subtitle:   Some(description.to_owned()),
			group:      None,
			search:     None,
			badge:      None,
			meta:       chord.map(super::PaletteMeta::Chord),
			capability: command.capability(),
			kind:       PaletteItemKind::Composer { command },
		});
	}
	items
}
