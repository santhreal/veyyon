//! Typed palette rows, static catalogue, dynamic sources, and cursor
//! resolution.

mod catalog;
pub mod cursor;
mod sources;
mod types;
mod verbs;

pub use cursor::*;
pub use types::*;

use crate::{
	Store, UiCommand,
	navigation::{Overlay, PaletteMode},
};

pub fn current_mode(store: &Store) -> PaletteMode {
	store
		.frontend
		.overlays
		.last()
		.and_then(|overlay| match overlay {
			Overlay::CommandPalette { mode } => Some(*mode),
			Overlay::QuickOpen => Some(PaletteMode::QuickOpen),
			Overlay::SessionSwitcher => Some(PaletteMode::Sessions),
			_ => None,
		})
		.unwrap_or(PaletteMode::Commands)
}

pub fn results(store: &Store, mode: PaletteMode, query: &str) -> Results {
	let mut result = match mode {
		PaletteMode::Commands => catalog::commands(store),
		PaletteMode::QuickOpen => sources::quick_open(store),
		PaletteMode::Sessions => sources::sessions(store),
		PaletteMode::Messages => sources::messages(store),
		PaletteMode::Files => sources::files(store),
		PaletteMode::Models => sources::models(store),
		PaletteMode::Providers => sources::providers(store),
		PaletteMode::Settings => catalog::settings(),
		PaletteMode::Agents => sources::agents(store),
	};
	let query = query.trim();
	if !query.is_empty() {
		for group in &mut result.groups {
			group.items.retain(|item| matches_query(item, query));
		}
		result.groups.retain(|group| !group.items.is_empty());
		if result.groups.is_empty() && matches!(result.state, SourceState::Ready) {
			result.state = SourceState::Empty;
		}
	}
	result
}

pub fn accept(store: &Store) -> Vec<UiCommand> {
	let mode = current_mode(store);
	let res = results(store, mode, &store.frontend.palette_query);
	let selected = store.frontend.palette_cursor;
	cursor::selected_item(&res.groups, selected)
		.filter(|item| item.disabled_reason.is_none())
		.map(|item| item.commands.clone())
		.unwrap_or_default()
}

fn matches_query(item: &Item, query: &str) -> bool {
	let query = query.to_lowercase();
	item.title.to_lowercase().contains(&query)
		|| item
			.detail
			.as_deref()
			.is_some_and(|detail| detail.to_lowercase().contains(&query))
}

#[cfg(test)]
mod every_view_verb_is_in_the_palette;
#[cfg(test)]
mod tests;
