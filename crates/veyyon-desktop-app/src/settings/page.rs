//! The settings pages, in navigation order.

use veyyon_desktop_model::{HostAction, SnapshotSectionKind};
use veyyon_desktop_ui::icons::IconName;

/// One page of settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Page {
	/// Every setting in the host's schema, filed by its tab and group.
	General,
	/// The window's palette and the installed themes, one chosen for each
	/// ground.
	Appearance,
	/// The keyboard shortcuts.
	Keybindings,
	/// The model providers, their sign-in and the stored accounts.
	Providers,
	/// The Model Context Protocol servers.
	Mcp,
	/// The extensions, skills, hooks and the sources they come from.
	Extensions,
}

impl Page {
	/// Every page, in navigation order.
	pub const ALL: [Self; 6] = [
		Self::General,
		Self::Appearance,
		Self::Keybindings,
		Self::Providers,
		Self::Mcp,
		Self::Extensions,
	];

	/// The stable name `workspace::OpenSettings` and the driver id
	/// `settings.page:<name>` use.
	pub const fn name(self) -> &'static str {
		match self {
			Self::General => "general",
			Self::Appearance => "appearance",
			Self::Keybindings => "keybindings",
			Self::Providers => "providers",
			Self::Mcp => "mcp",
			Self::Extensions => "extensions",
		}
	}

	/// The page with `name`.
	pub fn from_name(name: &str) -> Option<Self> {
		Self::ALL.into_iter().find(|page| page.name() == name)
	}

	/// The navigation label.
	pub const fn label(self) -> &'static str {
		match self {
			Self::General => "General",
			Self::Appearance => "Appearance",
			Self::Keybindings => "Keybindings",
			Self::Providers => "Providers",
			Self::Mcp => "MCP servers",
			Self::Extensions => "Extensions",
		}
	}

	/// One line stating what the page holds.
	pub const fn description(self) -> &'static str {
		match self {
			Self::General => "Every setting, by tab and group",
			Self::Appearance => "The window's palette and the theme for each ground",
			Self::Keybindings => "Keyboard shortcuts",
			Self::Providers => "Sign in to model providers and manage stored accounts",
			Self::Mcp => "Add, test and switch MCP servers",
			Self::Extensions => "Extensions, skills, hooks and their sources",
		}
	}

	/// The terminal spellings that reach the page, which the palette
	/// matches.
	pub const fn spellings(self) -> &'static [&'static str] {
		match self {
			Self::General => &["/settings", "settings", "preferences"],
			Self::Appearance => {
				&["/settings themes", "theme", "themes", "appearance", "dark mode", "light mode"]
			},
			Self::Keybindings => &["/hotkeys", "hotkeys", "shortcuts"],
			Self::Providers => &[
				"/setup",
				"/providers",
				"/login",
				"login",
				"/account",
				"/account manager",
				"/account login",
			],
			Self::Mcp => &[
				"/mcp",
				"mcp",
				"/mcp list",
				"/mcp enable",
				"/mcp disable",
				"/mcp reconnect",
				"/mcp add",
				"/mcp remove",
				"/mcp test",
				"/mcp reauth",
				"/mcp unauth",
				"/mcp reload",
				"/mcp resources",
				"/mcp prompts",
				"/mcp notifications",
			],
			Self::Extensions => &["/extensions", "/status", "skills", "hooks"],
		}
	}

	/// The navigation icon.
	pub const fn icon(self) -> IconName {
		match self {
			Self::General => IconName::SlidersHorizontal,
			Self::Appearance => IconName::Sun,
			Self::Keybindings => IconName::Keyboard,
			Self::Providers => IconName::KeyRound,
			Self::Mcp => IconName::Wrench,
			Self::Extensions => IconName::Sparkles,
		}
	}

	/// The requests that load what the page draws, sent when it is shown.
	pub fn loads(self) -> Vec<HostAction> {
		match self {
			Self::General => vec![HostAction::LoadSettings],
			Self::Appearance => vec![HostAction::LoadThemes],
			Self::Keybindings => vec![HostAction::LoadKeybindings],
			Self::Providers => vec![HostAction::RefreshProviders],
			Self::Mcp => vec![HostAction::RefreshMcp],
			Self::Extensions => vec![HostAction::Extensions(
				veyyon_desktop_model::action::ExtensionsRequest::RefreshExtensions,
			)],
		}
	}

	/// Whether a replaced section is drawn on this page.
	pub fn draws(self, kind: SnapshotSectionKind) -> bool {
		match self {
			Self::General => kind == SnapshotSectionKind::Settings,
			Self::Appearance => kind == SnapshotSectionKind::Themes,
			Self::Keybindings => kind == SnapshotSectionKind::Keybindings,
			Self::Providers => matches!(
				kind,
				SnapshotSectionKind::Providers
					| SnapshotSectionKind::Accounts
					| SnapshotSectionKind::AuthFlow
			),
			Self::Mcp => matches!(
				kind,
				SnapshotSectionKind::Mcp
					| SnapshotSectionKind::McpCatalog
					| SnapshotSectionKind::McpProbe
					| SnapshotSectionKind::McpRegistry
					| SnapshotSectionKind::AuthFlow
			),
			Self::Extensions => kind == SnapshotSectionKind::Extensions,
		}
	}
}
