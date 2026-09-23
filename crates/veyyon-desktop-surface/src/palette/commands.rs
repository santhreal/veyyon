//! Native command entries for existing desktop surfaces and composer actions.

use strum::IntoEnumIterator;
use veyyon_desktop_model::{Capability, SettableMode};

use super::{PaletteItem, PaletteItemKind, composer_commands::ComposerCommand};
use crate::{Command, Intent, navigation::SurfaceRoute, settings::SettingsPage};

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
			"/retry",
			Intent::RetryTurn,
			"Run the last turn again after it failed",
			None,
			Some(Capability::TurnControl),
		),
		(
			"/rephrase",
			Intent::RephraseReply,
			"Ask for the last reply again, in plainer prose",
			None,
			Some(Capability::TurnControl),
		),
		(
			"/plan-review",
			Intent::ReviewPlan,
			"Read the plan again and accept it or send it back",
			None,
			Some(Capability::Approvals),
		),
		// Two rows for the one freeze, for the reason the mode rows give: a
		// list ranked against what was typed cannot show which way a toggle
		// would go, and the host refuses the one that does not apply.
		(
			"/pause",
			Intent::PauseAgents,
			"Freeze every agent until you resume it",
			None,
			Some(Capability::Lifecycle),
		),
		// Spelled `/unpause` and not `/resume`, because the terminal's
		// `/resume` opens a different session. One spelling meaning two things
		// across the two front ends is the row an operator types from muscle
		// memory and watches switch sessions under a frozen agent.
		(
			"/unpause",
			Intent::ResumeAgents,
			"Wake every agent the freeze parked",
			None,
			Some(Capability::Lifecycle),
		),
		// Two rows per mode rather than one that toggles: a command list is
		// ranked against what was typed, and a row whose action depends on
		// state the operator cannot see from the list is a press with two
		// outcomes. Both leaving rows send the same request, since the host
		// reads `None` as the session leaving whichever mode it is in; they
		// are two rows so that the mode being left is the one the operator
		// typed.
		(
			"/plan",
			Intent::SetSessionMode { mode: SettableMode::Plan },
			"Plan this task before any of it is done",
			None,
			Some(Capability::Sessions),
		),
		(
			"/plan off",
			Intent::SetSessionMode { mode: SettableMode::None },
			"Leave plan mode and take the tools back",
			None,
			Some(Capability::Sessions),
		),
		(
			"/vibe",
			Intent::SetSessionMode { mode: SettableMode::Vibe },
			"Read and direct worker sessions that do the writing",
			None,
			Some(Capability::Sessions),
		),
		(
			"/vibe off",
			Intent::SetSessionMode { mode: SettableMode::None },
			"Leave vibe mode and stop every worker it started",
			None,
			Some(Capability::Sessions),
		),
		(
			"/loop",
			Intent::SetSessionMode { mode: SettableMode::Loop },
			"Repeat the last prompt after each turn",
			None,
			Some(Capability::Sessions),
		),
		(
			"/loop off",
			Intent::SetSessionMode { mode: SettableMode::None },
			"Stop repeating the prompt",
			None,
			Some(Capability::Sessions),
		),
		(
			"/goal",
			Intent::ToggleGoalCard,
			"Set an autonomous goal or review the current one",
			None,
			Some(Capability::Goals),
		),
		(
			"/history",
			Intent::FindSessions(String::new()),
			"Search persisted sessions",
			None,
			Some(Capability::Sessions),
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
		(
			"/agents",
			Intent::Navigate(SurfaceRoute::Agents),
			"The agents running in this session, and what they say to each other",
			None,
			Some(Capability::Agents),
		),
		("/account", Intent::Navigate(SurfaceRoute::Account), "Accounts and sign-in", None, None),
		(
			"/collab",
			Intent::Navigate(SurfaceRoute::Share),
			"Share this session over a relay",
			None,
			Some(Capability::Share),
		),
		(
			"/join",
			Intent::Navigate(SurfaceRoute::Share),
			"Join the shared session a link names",
			None,
			Some(Capability::Share),
		),
		("/leave", Intent::LeaveShare, "Leave the shared session", None, Some(Capability::Share)),
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
		(
			"/clear",
			Intent::ClearOutput,
			"Clear active session output",
			None,
			Some(Capability::Sessions),
		),
	]
	.into_iter()
	.enumerate()
	.map(|(index, (name, intent, description, shortcut, capability))| {
		let mut item = PaletteItem::command(index as u64 + 1, name, intent, shortcut);
		item.subtitle = Some(description.to_owned());
		item.capability = capability;
		item.takes_argument = matches!(name, "/goal" | "/join");
		// The terminal reaches the same card under another spelling, so that
		// spelling finds this row. `search` is matched and not drawn, which
		// keeps one row in the list rather than several that open the one
		// surface under one description.
		item.search = match name {
			"/agents" => Some("/cockpit /hub".to_owned()),
			"/collab" => Some("/share".to_owned()),
			_ => None,
		};
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
			SettingsPage::Extensions => "/extensions",
			SettingsPage::Diagnostics => "/settings diagnostics",
			SettingsPage::Usage => "/usage",
			SettingsPage::ContextBreakdown => "/context",
			SettingsPage::Profiles => "/profile",
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
			SettingsPage::Profiles => Some(Capability::Profiles),
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
		// and queueing are what the composer's own arrow sends, and a
		// session-only model is the picker again with a different answer, so
		// none of the three has a chord of its own to state.
		let chord = match command {
			ComposerCommand::AttachFiles => Some(Command::AttachFile),
			ComposerCommand::Models => Some(Command::ModelPicker),
			ComposerCommand::Effort => Some(Command::ThinkingLevel),
			ComposerCommand::QueueMode => Some(Command::ToggleQueueMode),
			ComposerCommand::SwitchModel | ComposerCommand::Steer | ComposerCommand::Queue => None,
		};
		let description = match command {
			ComposerCommand::AttachFiles => Command::AttachFile.label(),
			ComposerCommand::Models => Command::ModelPicker.label(),
			ComposerCommand::SwitchModel => "Try a model for this session only",
			ComposerCommand::Effort => Command::ThinkingLevel.label(),
			ComposerCommand::QueueMode => Command::ToggleQueueMode.label(),
			ComposerCommand::Steer => "Steer the running turn with a message",
			ComposerCommand::Queue => "Queue a follow-up message",
		};
		items.push(PaletteItem {
			id:             items.len() as u64 + 1,
			title:          command.name().to_owned(),
			subtitle:       Some(description.to_owned()),
			group:          None,
			search:         None,
			badge:          None,
			meta:           chord.map(super::PaletteMeta::Chord),
			capability:     command.capability(),
			kind:           PaletteItemKind::Composer { command },
			takes_argument: command.carries_draft(),
		});
	}
	items
}

/// Whether a native command row takes a trailing argument.
#[must_use]
pub fn command_takes_argument(name: &str) -> bool {
	let normalized = name.trim_start_matches('/');
	command_items().iter().any(|item| {
		item.takes_argument
			&& item
				.title
				.trim_start_matches('/')
				.eq_ignore_ascii_case(normalized)
	})
}
