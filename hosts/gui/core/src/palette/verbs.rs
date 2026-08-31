//! The verbs that change what the window shows, and the content it holds.
//!
//! A route or a mode is a destination and lives in the catalogue. These are the
//! verbs a reader reaches for once they are already somewhere: the panels, the
//! tabs inside them, the two ends of the transcript, the appearance switches,
//! and whatever the open conversation offers to open. Each one closes the
//! palette first, so the frame after the acceptance is the change itself.

use crate::{
	Store, UiCommand,
	model::{ContentBlock, PlanState},
	navigation::{BottomTab, InspectorTab, Overlay},
	palette::types::{Group, Item},
};

/// The panels, the tabs they hold, and the ends of the transcript.
pub(super) fn view(store: &Store) -> Group {
	let panels = &store.frontend.panels;
	let mut items = vec![
		verb("view-sidebar", "Toggle sidebar", panels.sidebar_open, UiCommand::ToggleSidebar),
		verb("view-inspector", "Toggle inspector", panels.inspector_open, UiCommand::ToggleInspector),
		verb("view-dock", "Toggle bottom dock", panels.bottom_open, UiCommand::ToggleBottomDock),
	];
	// Swept from the tab sets, so a fourth dock tab or inspector tab is
	// reachable from the palette the day it exists.
	for tab in BottomTab::ALL {
		items.push(verb(
			format!("view-dock-{}", slug(tab.label())),
			format!("Show {}", tab.label().to_lowercase()),
			panels.bottom_open && store.frontend.bottom_tab == tab,
			UiCommand::SetBottomTab(tab),
		));
	}
	for tab in InspectorTab::ALL {
		items.push(verb(
			format!("view-inspector-{}", slug(tab.label())),
			format!("Show {}", tab.label().to_lowercase()),
			panels.inspector_open && store.frontend.inspector_tab == tab,
			UiCommand::SetInspectorTab(tab),
		));
	}
	items.push(verb(
		"view-transcript-oldest",
		"Jump to oldest message",
		false,
		UiCommand::JumpToOldest,
	));
	items.push(verb(
		"view-transcript-latest",
		"Jump to latest message",
		false,
		UiCommand::JumpToLatest,
	));
	Group { id: "view", label: "View", items }
}

/// The appearance switches and the themes, each stating which one is in force.
///
/// A theme was reachable by pressing a row on the settings page and nowhere
/// else, so a reader without a pointer could not change one. The rows are the
/// themes this build ships, so a theme added to `core::theme::THEMES` is
/// offered here with no edit.
pub(super) fn appearance(store: &Store) -> Group {
	let preferences = &store.frontend.preferences;
	let mut items = vec![
		verb(
			"appearance-dark",
			"Dark appearance",
			preferences.dark,
			UiCommand::SetDarkAppearance(true),
		),
		verb(
			"appearance-light",
			"Light appearance",
			!preferences.dark,
			UiCommand::SetDarkAppearance(false),
		),
		verb(
			"appearance-reduced-motion",
			"Toggle reduced motion",
			preferences.reduced_motion,
			UiCommand::SetReducedMotion(!preferences.reduced_motion),
		),
	];
	for theme in &crate::theme::THEMES {
		items.push(verb(
			format!("appearance-theme-{}", theme.id),
			format!("Use theme: {}", theme.name),
			preferences.theme.as_deref() == Some(theme.id),
			UiCommand::SetTheme(theme.id.to_owned()),
		));
	}
	Group { id: "appearance", label: "Appearance", items }
}

/// What the open conversation offers to open: a plan waiting for review, and
/// every image the transcript holds.
///
/// Both are otherwise reachable by pointer only, from a banner and from a
/// button inside a message.
pub(super) fn content(store: &Store) -> Option<Group> {
	let mut items = Vec::new();
	if let Some(plan) = store.replica.plan.readable()
		&& let PlanState::Active { approval: Some(approval), .. } = &plan.value
	{
		items.push(Item {
			id:              "content-plan-review".to_owned(),
			title:           "Review plan".to_owned(),
			detail:          approval.title.clone(),
			disabled_reason: None,
			current:         false,
			commands:        vec![
				UiCommand::CloseTopOverlay,
				UiCommand::OpenOverlay(Overlay::PlanReview {
					request:     approval.request,
					interaction: approval.interaction.clone(),
				}),
			],
		});
	}
	if let Some(transcript) = store.replica.transcript.readable() {
		for entry in &transcript.value {
			for (index, block) in entry.content.iter().enumerate() {
				let ContentBlock::Image { alt, data, .. } = block else {
					continue;
				};
				// An image with no bytes draws its fallback and has nothing to
				// open, which is the same rule the message's own button uses.
				if data.is_empty() {
					continue;
				}
				items.push(Item {
					id:              format!("content-image-{}-{index}", entry.id.as_str()),
					title:           "Open image".to_owned(),
					detail:          alt.clone(),
					disabled_reason: None,
					current:         false,
					commands:        vec![UiCommand::CloseTopOverlay, UiCommand::OpenImage {
						entry: entry.id.clone(),
						index,
					}],
				});
			}
		}
	}
	(!items.is_empty()).then_some(Group { id: "content", label: "This conversation", items })
}

fn verb(
	id: impl Into<String>,
	title: impl Into<String>,
	current: bool,
	command: UiCommand,
) -> Item {
	Item {
		id: id.into(),
		title: title.into(),
		detail: None,
		disabled_reason: None,
		current,
		commands: vec![UiCommand::CloseTopOverlay, command],
	}
}

fn slug(label: &str) -> String {
	label.to_lowercase().replace(' ', "-")
}
