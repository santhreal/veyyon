//! Inline command and skill completions from the engine registry.

use gpui::{App, Div, ParentElement, Styled, div, px};
use veyyon_gui_core::{Store, UiCommand};
use veyyon_gui_kit::{
	theme::{Theme, radius, space},
	ui::{Empty, Icon, Row, text},
};

use super::{completion, logic, state::completion_owner};
use crate::act;

const VISIBLE_COMPLETIONS: usize = 6;

pub fn completion_menu(store: &Store, cx: &mut App) -> Option<Div> {
	let (session, draft) = logic::selected_draft(store)?;
	let trigger = completion::at_caret(&draft.text, draft.caret)?;
	let theme = Theme::get(cx);
	let registry = store.replica.extensions.readable();
	let mut menu = div()
		.flex()
		.flex_col()
		.gap(px(space::ROWS))
		.p(px(space::X6))
		.rounded(px(radius::POPOVER))
		.bg(theme.overlay);
	let Some(registry) = registry else {
		return Some(menu.child(Empty::new("Completions are not available yet").icon(Icon::Magic)));
	};
	let mut shown = 0;
	match trigger.kind {
		completion::CompletionKind::SlashCommand => {
			for command in registry
				.value
				.commands
				.iter()
				.filter(|command| matches_query(&command.name, trigger.query))
				.take(VISIBLE_COMPLETIONS)
			{
				menu = menu.child(completion_row(
					session,
					draft,
					trigger.replace_from,
					draft.caret,
					format!("/{}", command.name),
					command.description.clone(),
				));
				shown += 1;
			}
		},
		completion::CompletionKind::Skill => {
			for skill in registry
				.value
				.skills
				.iter()
				.filter(|skill| matches_query(&skill.name, trigger.query))
				.take(VISIBLE_COMPLETIONS)
			{
				menu = menu.child(completion_row(
					session,
					draft,
					trigger.replace_from,
					draft.caret,
					format!("${}", skill.name),
					"Skill".to_owned(),
				));
				shown += 1;
			}
		},
	}
	if shown == 0 {
		menu = menu.child(
			div()
				.p(px(space::X8))
				.child(text::note("No matching completions", &theme)),
		);
	}
	Some(menu)
}

fn completion_row(
	session: &veyyon_gui_core::model::SessionId,
	draft: &veyyon_gui_core::navigation::Draft,
	replace_from: usize,
	caret: usize,
	value: String,
	note: String,
) -> Row {
	let mut text = String::with_capacity(draft.text.len() + value.len());
	text.push_str(&draft.text[..replace_from]);
	text.push_str(&value);
	text.push_str(&draft.text[caret..]);
	let next_caret = replace_from + value.len();
	let edit = UiCommand::EditDraft { session: session.clone(), text };
	let move_caret = UiCommand::SetDraftCaret { session: session.clone(), byte: next_caret };
	Row::new(format!("completion:{value}"), completion_owner(&value), value)
		.note(note)
		.icon(Icon::Magic)
		.on_click(move |_, window, cx| {
			act::run(edit.clone(), window, cx);
			act::run(move_caret.clone(), window, cx);
		})
}

fn matches_query(value: &str, query: &str) -> bool {
	if query.is_empty() {
		return true;
	}
	if !value.is_ascii() || !query.is_ascii() {
		return value.contains(query);
	}
	value
		.as_bytes()
		.windows(query.len())
		.any(|window| window.eq_ignore_ascii_case(query.as_bytes()))
}
