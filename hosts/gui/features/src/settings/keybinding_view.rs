//! Searchable effective keybindings, conflicts, and reset actions.

use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{CommandState, KeybindingState, Versioned},
	store::CommandTarget,
};
use veyyon_gui_kit::{
	theme::{Theme, space},
	ui::{Badge, Banner, Empty, Field, Fill, Group, Icon, Size, Tone, text},
};

use super::{keybindings, remote};
use crate::act;

pub fn render(store: &Store, cx: &mut App) -> AnyElement {
	remote::render(
		&store.replica.keybindings,
		remote::host_state(&store.connection),
		remote::Copy {
			loading:     "Loading keybindings",
			empty:       "No custom keybindings",
			empty_note:  "The default keymap remains active.",
			detached:    "Keybindings are not loaded",
			unavailable: "Keybindings are unavailable",
		},
		UiCommand::LoadKeybindings,
		|versioned: &Versioned<KeybindingState>, mutable, cx| {
			content(store, &versioned.value, mutable, cx)
		},
		cx,
	)
}

fn content(store: &Store, state: &KeybindingState, mutable: bool, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	let command = store.command_state(&CommandTarget::Keybindings);
	let query = &store.frontend.settings_filter;
	let rows = keybindings::rows(state, query);
	let mut page = text::stack(space::LOOSE)
		.child(text::title("Keybindings", &theme))
		.child(text::note_wrapping(
			"Search matches command, chord, and source. Conflicts stay beside the affected shortcut.",
			&theme,
		));
	if let CommandState::Failed { message, .. } = &command {
		page = page.child(Banner::failure("Keybinding change failed").detail(message.clone()));
	}
	if rows.is_empty() {
		return page
			.child(
				Empty::new(if query.trim().is_empty() {
					"No keybindings were published"
				} else {
					"No keybindings match this search"
				})
				.icon(Icon::Search)
				.note("Try a command name, chord, or source."),
			)
			.into_any_element();
	}
	let pending = matches!(command, CommandState::Pending { .. });
	let mut group = Group::new("Effective shortcuts");
	for binding in rows {
		let mut controls = div()
			.flex()
			.flex_wrap()
			.items_center()
			.gap(px(space::SNUG))
			.child(Badge::new(binding.binding.chord.clone()).exact());
		if let Some(conflict) = binding.conflict {
			controls = controls.child(
				Badge::new(format!("Conflict: {} commands", conflict.commands.len()))
					.icon(Icon::Failed)
					.tone(Tone::Danger),
			);
		}
		if let Some(default) = keybindings::default_for(state, &binding.binding.command)
			&& default.chord != binding.binding.chord
		{
			let mut reset_btn = crate::settings::controls::button(
				format!("reset-keybinding-{}", binding.binding.command),
				"Reset",
			)
			.fill(Fill::Ghost)
			.size(Size::Small);
			if pending {
				reset_btn = reset_btn.disabled("Keybinding change is pending");
			} else if !mutable {
				reset_btn = reset_btn.disabled("Keybindings are read-only");
			} else {
				reset_btn = reset_btn.on_click(act::click(UiCommand::SetKeybinding {
					command: binding.binding.command.clone(),
					chord:   Some(default.chord.clone()),
				}));
			}
			controls = controls.child(reset_btn);
		}
		group = group.child(
			Field::new(binding.binding.command.clone())
				.stacked()
				.note(binding.binding.source.clone())
				.child(controls),
		);
	}
	page.child(group).into_any_element()
}
