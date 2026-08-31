//! The exhaustive settings information architecture.

use veyyon_gui_core::{
	UiCommand,
	navigation::{Route, SettingsPage},
};
use veyyon_gui_kit::ui::Icon;

#[derive(Debug, Clone, PartialEq)]
pub struct PageRegistration {
	pub page:     SettingsPage,
	pub label:    &'static str,
	pub summary:  &'static str,
	pub keywords: &'static str,
	pub icon:     Icon,
}

pub fn registration(page: SettingsPage) -> PageRegistration {
	match page {
		SettingsPage::Appearance => PageRegistration {
			page,
			label: page.label(),
			summary: "Theme, typography, and motion",
			keywords: "theme light dark font reduced motion",
			icon: Icon::Light,
		},
		SettingsPage::General => PageRegistration {
			page,
			label: page.label(),
			summary: "Window and session behavior",
			keywords: "window sessions queue behavior",
			icon: Icon::Settings,
		},
		SettingsPage::Models => PageRegistration {
			page,
			label: page.label(),
			summary: "Selection, thinking, and favorites",
			keywords: "model thinking effort reasoning favorite",
			icon: Icon::Engine,
		},
		SettingsPage::Providers => PageRegistration {
			page,
			label: page.label(),
			summary: "Instances, accounts, and authentication",
			keywords: "provider instance account auth login",
			icon: Icon::Allow,
		},
		SettingsPage::Tools => PageRegistration {
			page,
			label: page.label(),
			summary: "Tools, extensions, and contributed commands",
			keywords: "tool extension plugin skill command",
			icon: Icon::Tool,
		},
		SettingsPage::Mcp => PageRegistration {
			page,
			label: page.label(),
			summary: "Servers, tools, resources, and prompts",
			keywords: "mcp server resource prompt connect",
			icon: Icon::Running,
		},
		SettingsPage::Agents => PageRegistration {
			page,
			label: page.label(),
			summary: "Model roles and task behavior",
			keywords: "agent subagent model role task",
			icon: Icon::Engine,
		},
		SettingsPage::Context => PageRegistration {
			page,
			label: page.label(),
			summary: "Context composition and queue modes",
			keywords: "context compaction queue follow-up steer",
			icon: Icon::Attachment,
		},
		SettingsPage::Keybindings => PageRegistration {
			page,
			label: page.label(),
			summary: "Shortcuts and conflicts",
			keywords: "keyboard shortcut chord conflict reset",
			icon: Icon::Keyboard,
		},
		SettingsPage::Advanced => PageRegistration {
			page,
			label: page.label(),
			summary: "Diagnostics and expert controls",
			keywords: "advanced diagnostics experimental profile",
			icon: Icon::Settings,
		},
	}
}

pub fn pages(query: &str) -> Vec<PageRegistration> {
	let query = query.trim().to_lowercase();
	SettingsPage::ALL
		.into_iter()
		.map(registration)
		.filter(|entry| {
			query.is_empty()
				|| entry.label.to_lowercase().contains(&query)
				|| entry.summary.to_lowercase().contains(&query)
				|| entry.keywords.contains(&query)
		})
		.collect()
}

pub fn open_command(page: SettingsPage) -> UiCommand {
	UiCommand::Navigate(Route::Settings(page))
}
