//! Session tabs and terminal actions above the retained viewport.

use gpui::{App, InteractiveElement, ParentElement, ScrollHandle, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{TerminalId, TerminalRunView},
	navigation::TerminalPresentation,
};
use veyyon_gui_kit::{
	theme::{Elevation, Theme, layout, space},
	ui::{Badge, EdgeFade, Fill, Scrolls, Size},
};

use super::lifecycle;
use crate::act;

pub fn selected<'a>(store: &Store, terminals: &'a [TerminalRunView]) -> &'a TerminalId {
	store
		.frontend
		.selected_terminal
		.as_ref()
		.and_then(|selected| terminals.iter().find(|terminal| &terminal.id == selected))
		.map(|terminal| &terminal.id)
		.unwrap_or(&terminals[0].id)
}

pub fn latest_error(store: &Store, terminal: &TerminalId) -> Option<String> {
	match store.command_state(&veyyon_gui_core::store::CommandTarget::Terminal(terminal.clone())) {
		veyyon_gui_core::model::CommandState::Failed { message, .. } => Some(message),
		_ => None,
	}
}

pub fn render(
	store: &Store,
	terminals: &[TerminalRunView],
	selected: &TerminalId,
	selection: Option<&str>,
	cx: &mut App,
) -> EdgeFade {
	let theme = Theme::get(cx);
	let selected_run = terminals.iter().find(|terminal| &terminal.id == selected);
	let tabs_scroll = ScrollHandle::new();
	let bar_scroll = ScrollHandle::new();
	let mut tabs = div()
		.flex()
		.items_center()
		.gap(px(space::PAIR))
		.flex_1()
		.min_w(px(0.0));
	for terminal in terminals {
		let title = if terminal.command.trim().is_empty() {
			terminal.id.as_str()
		} else {
			terminal.command.as_str()
		};
		tabs = tabs.child(
			crate::terminal::control::button(format!("terminal-tab-{}", terminal.id), title)
				.size(Size::Small)
				.fill(if &terminal.id == selected {
					Fill::Tinted
				} else {
					Fill::Ghost
				})
				.on(&terminal.id == selected)
				.on_click(act::click(UiCommand::SelectTerminal(terminal.id.clone()))),
		);
	}
	let mut bar = div()
		.flex()
		.items_center()
		.id("terminal-chrome-scroll-1")
		.gap(px(space::SNUG))
		.h(px(layout::toolbar()))
		.px(px(space::SNUG))
		.border_b_1()
		.border_color(theme.stroke)
		.bg(theme.chrome)
		.child(
			div()
				.id("terminal-chrome-inline-1")
				.flex()
				.flex_1()
				.min_w(px(0.0))
				.child(tabs)
				.scrolls_x(&tabs_scroll, Elevation::Chrome),
		);
	if let Some(terminal) = selected_run {
		let state = lifecycle(terminal, &store.connection, None);
		let selected_text = selection.unwrap_or_default().to_owned();
		bar = bar
			.child(Badge::new(state.label).tone(state.tone))
			.child(
				crate::terminal::control::button("terminal-focus", "Focus")
					.size(Size::Small)
					.on_click(act::click(UiCommand::FocusTerminal(terminal.id.clone()))),
			)
			.child(
				crate::terminal::control::enabled(
					crate::terminal::control::button("terminal-paste", "Paste").size(Size::Small),
					state.accepts_input,
					"Action unavailable in the current state",
				)
				.on_click(act::click(UiCommand::PasteTerminal(terminal.id.clone()))),
			)
			.child(
				crate::terminal::control::enabled(
					crate::terminal::control::button("terminal-copy", "Copy").size(Size::Small),
					selection.is_some(),
					"Action unavailable in the current state",
				)
				.on_click(act::click(UiCommand::CopyTerminalSelection {
					terminal: terminal.id.clone(),
					text:     selected_text.clone(),
				})),
			);
		if let Some(session) = &store.frontend.selected_session {
			bar = bar.child(
				crate::terminal::control::enabled(
					crate::terminal::control::button("terminal-add-to-composer", "Add to composer")
						.size(Size::Small),
					selection.is_some(),
					"Action unavailable in the current state",
				)
				.on_click(act::click(UiCommand::AddTerminalSelection {
					session:  session.clone(),
					terminal: terminal.id.clone(),
					text:     selected_text,
				})),
			);
		}
		bar = bar.child(
			crate::terminal::control::button("terminal-follow-tail", "Follow")
				.size(Size::Small)
				.on(store.frontend.terminal_follow_tail.contains(&terminal.id))
				.on_click(act::click(UiCommand::SetTerminalFollowTail {
					terminal: terminal.id.clone(),
					follow:   !store.frontend.terminal_follow_tail.contains(&terminal.id),
				})),
		);
		if let Some(other) = terminals
			.iter()
			.find(|candidate| candidate.id != terminal.id)
		{
			bar = bar
				.child(
					crate::terminal::control::button("terminal-split-horizontal", "Split across")
						.size(Size::Small)
						.on_click(act::click(UiCommand::SplitTerminal {
							terminal: terminal.id.clone(),
							with:     other.id.clone(),
							axis:     veyyon_gui_core::model::SplitAxis::Horizontal,
						})),
				)
				.child(
					crate::terminal::control::button("terminal-split-vertical", "Split down")
						.size(Size::Small)
						.on_click(act::click(UiCommand::SplitTerminal {
							terminal: terminal.id.clone(),
							with:     other.id.clone(),
							axis:     veyyon_gui_core::model::SplitAxis::Vertical,
						})),
				);
		}
		if matches!(
			&terminal.phase,
			veyyon_gui_core::model::TerminalPhase::Reconnecting { .. }
				| veyyon_gui_core::model::TerminalPhase::Error { .. }
		) {
			bar = bar.child(
				crate::terminal::control::enabled(
					crate::terminal::control::button("terminal-attach", "Attach").size(Size::Small),
					store.connection.is_connected(),
					"Action unavailable in the current state",
				)
				.on_click(act::click(UiCommand::AttachTerminal(terminal.id.clone()))),
			);
		}
		bar = bar
			.child(
				crate::terminal::control::enabled(
					crate::terminal::control::button("terminal-restart", "Restart").size(Size::Small),
					state.can_restart,
					"Action unavailable in the current state",
				)
				.on_click(act::click(UiCommand::RestartTerminal(terminal.id.clone()))),
			)
			.child(
				crate::terminal::control::enabled(
					crate::terminal::control::button("terminal-clear", "Clear").size(Size::Small),
					store.connection.is_connected(),
					"Action unavailable in the current state",
				)
				.on_click(act::click(UiCommand::ClearTerminal(terminal.id.clone()))),
			)
			.child(
				crate::terminal::control::enabled(
					crate::terminal::control::button("terminal-close", "Close").size(Size::Small),
					store.connection.is_connected(),
					"Action unavailable in the current state",
				)
				.on_click(act::click(UiCommand::CloseTerminal(terminal.id.clone()))),
			);
	}
	let next_presentation = match store.frontend.terminal_presentation {
		TerminalPresentation::BottomDock => TerminalPresentation::Inspector,
		TerminalPresentation::Inspector => TerminalPresentation::BottomDock,
	};
	bar.child(
		crate::terminal::control::button("terminal-move-presentation", "Move")
			.size(Size::Small)
			.on_click(act::click(UiCommand::SetTerminalPresentation(next_presentation))),
	)
	.child(
		crate::terminal::control::enabled(
			crate::terminal::control::button("terminal-create", "New").size(Size::Small),
			store.connection.is_connected(),
			"Action unavailable in the current state",
		)
		.on_click(act::click(UiCommand::CreateTerminal { cwd: None })),
	)
	.scrolls_x(&bar_scroll, Elevation::Chrome)
}
