//! Host-backed fuzzy filename and content search results.

use gpui::{App, InteractiveElement, ParentElement, ScrollHandle, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{FileSearchResult, FileWorkspaceState, LineRange, RemoteData},
};
use veyyon_gui_kit::{
	theme::{Elevation, space},
	ui::{Banner, EdgeFade, Empty, Icon, Row, Scrolls, text},
};

use super::{logic, owners};
use crate::act;

pub fn render(
	store: &Store,
	files: Option<&FileWorkspaceState>,
	scroll: &ScrollHandle,
	_cx: &mut App,
) -> EdgeFade {
	let Some(files) = files else {
		return div()
			.id("files-search-unavailable")
			.size_full()
			.child(
				Empty::new("Search unavailable")
					.icon(Icon::Search)
					.filling(),
			)
			.scrolls_y(scroll, Elevation::Chrome);
	};
	let query = &store.frontend.file_filter;
	let (results, stale, error): (&[FileSearchResult], bool, Option<&str>) = match &files.search {
		RemoteData::Unrequested => (&[], false, None),
		RemoteData::Loading { .. } => {
			return div()
				.id("files-search-loading")
				.size_full()
				.child(Empty::new("Searching files…").icon(Icon::Running).filling())
				.scrolls_y(scroll, Elevation::Chrome);
		},
		RemoteData::Ready(results) => (&results.value, false, None),
		RemoteData::Empty => (&[], false, None),
		RemoteData::Stale { value, .. } => (&value.value, true, None),
		RemoteData::Error { message, stale, .. } => (
			stale
				.as_ref()
				.map(|value| value.value.as_slice())
				.unwrap_or_default(),
			stale.is_some(),
			Some(message),
		),
	};
	let ranked = logic::ranked_results(query, results);
	if ranked.is_empty() && error.is_none() {
		return div()
			.id("files-search-no-match")
			.size_full()
			.child(
				Empty::new("No matching files")
					.icon(Icon::Search)
					.note(format!("No host result matched “{query}”."))
					.filling(),
			)
			.scrolls_y(scroll, Elevation::Chrome);
	}
	let mut column = text::stack(space::ROWS).w_full().p(px(space::TIGHT));
	if stale {
		column = column.child(Banner::notice("Showing stale search results"));
	}
	if let Some(message) = error {
		column = column.child(Banner::failure("File search failed").detail(message.to_owned()));
	}
	for result in ranked {
		let owner = owners::search_hit(&result.file, result.line);
		let mut row = Row::new(
			format!("file-search-{}-{:?}", result.file, result.line),
			owner,
			result.path.clone(),
		)
		.icon(Icon::Read)
		.active(store.frontend.selected_file.as_ref() == Some(&result.file))
		.selected(store.frontend.file_cursor.as_ref() == Some(&result.file));
		if let Some(excerpt) = &result.excerpt {
			row = row.note(excerpt.clone());
		}
		if store.connection.is_connected() && !stale {
			row = row.on_click(act::click(UiCommand::ReadFile {
				file:  result.file.clone(),
				range: result.line.map(|line| LineRange { start: line, end: line }),
			}));
		} else if store.connection.is_connected() {
			row = row.on_click(act::click(UiCommand::SelectFile(result.file.clone())));
		} else {
			row = row.disabled("Disconnected from host");
		}
		column = column.child(row);
	}
	div()
		.id("files-search-inline-1")
		.size_full()
		.child(column)
		.scrolls_y(scroll, Elevation::Chrome)
}
