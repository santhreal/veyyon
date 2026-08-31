//! Searchable changed-file tree/list for the contextual sidebar.

use gpui::{
	AnyElement, App, Entity, InteractiveElement, IntoElement, ParentElement, ScrollHandle, Styled,
	div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{ChangedFileView, FileChangeStatus, FileKind},
	navigation::ChangesTreeMode,
};
use veyyon_gui_kit::{
	input::Editor,
	motion::RetainedKey,
	theme::{Elevation, Theme, control, layout, space},
	ui::{
		Badge, Button, Empty, Fill, Icon, Row, Scrollbar, Scrolls, SearchField, Size, Tab, Tabs, Tone,
	},
};

use super::{
	cache::ChangesCache,
	owners::{self, Chrome, RowSlot},
	tree::TreeRow,
};
use crate::act;

pub fn render(
	store: &Store,
	cache: &ChangesCache,
	search: &Entity<Editor>,
	scroll: &ScrollHandle,
	cx: &mut App,
) -> AnyElement {
	let theme = Theme::get(cx);
	let column = div()
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.bg(theme.chrome)
		.child(header(store, search, &theme));

	let Some(versioned) = store.replica.changes.readable() else {
		return column
			.child(
				Empty::new("No changed files")
					.icon(Icon::Changed)
					.note("Changed files appear after a host supplies a snapshot.")
					.filling(),
			)
			.into_any_element();
	};
	let snapshot = &versioned.value;
	if snapshot.files.is_empty() {
		return column
			.child(
				Empty::new("No changed files")
					.icon(Icon::Changed)
					.note("The selected scope has no changes.")
					.filling(),
			)
			.into_any_element();
	}
	if cache.tree().is_empty() {
		return column
			.child(
				Empty::new("No matches")
					.icon(Icon::Search)
					.note("Try fewer search terms.")
					.filling(),
			)
			.into_any_element();
	}

	let mut rows = div()
		.id("changes-tree")
		.flex()
		.flex_col()
		.gap(px(space::X2))
		.flex_1()
		.min_h(px(0.0))
		.px(px(space::X6))
		.pb(px(space::X8));
	for row in cache.tree() {
		rows = rows.child(match row {
			TreeRow::Folder { path, name, depth, expanded, owner } => {
				folder(path, name, *depth, *expanded, *owner)
			},
			TreeRow::File { file, depth, owner } => snapshot
				.files
				.get(*file)
				.map(|file| changed_file(file, *depth, store, *owner))
				.unwrap_or_else(|| Row::new("missing-change-row", *owner, "Unavailable file")),
		});
	}
	column
		.child(
			div()
				.relative()
				.flex()
				.flex_col()
				.flex_1()
				.min_h(px(0.0))
				.child(
					rows
						.scrolls_y(scroll, Elevation::Chrome)
						.band(layout::fade_band_tight()),
				)
				.child(Scrollbar::new("changes-tree-scrollbar", scroll.clone())),
		)
		.into_any_element()
}

fn header(store: &Store, search: &Entity<Editor>, _theme: &Theme) -> impl IntoElement {
	let mode = store.frontend.changes_tree_mode;
	div()
		.flex()
		.flex_col()
		.gap(px(space::X6))
		.p(px(space::X8))
		.child(SearchField::new("changes-filter", owners::chrome(Chrome::Search), search.clone()))
		.child(
			Tabs::new("changes-tree-mode")
				.stretch()
				.tab(
					Tab::new(owners::chrome(Chrome::TreeMode), "Tree", mode == ChangesTreeMode::Tree)
						.on_click(act::click(UiCommand::SetChangesTreeMode(ChangesTreeMode::Tree))),
				)
				.tab(
					Tab::new(owners::chrome(Chrome::ListMode), "List", mode == ChangesTreeMode::List)
						.on_click(act::click(UiCommand::SetChangesTreeMode(ChangesTreeMode::List))),
				),
		)
}

fn folder(path: &str, name: &str, depth: u8, expanded: bool, owner: RetainedKey) -> Row {
	Row::new(format!("changes-folder-{path}"), owner, name.to_owned())
		.icon(if expanded { Icon::Open } else { Icon::Folded })
		.depth(depth)
		.tone(Tone::Muted)
		.on_click(act::click(UiCommand::ToggleChangeFolder(path.to_owned())))
}

fn changed_file(file: &ChangedFileView, depth: u8, store: &Store, owner: RetainedKey) -> Row {
	let active = store.frontend.selected_file.as_ref() == Some(&file.id);
	let name = file
		.path
		.rsplit('/')
		.next()
		.unwrap_or(file.path.as_str())
		.to_owned();
	let mut row = Row::new(format!("change-file-{}", file.id), owner, name)
		.icon(kind_icon(&file.kind))
		.depth(if store.frontend.changes_tree_mode == ChangesTreeMode::Tree {
			depth
		} else {
			0
		})
		.note(file.path.clone())
		.active(active)
		.tone(if active { Tone::Plain } else { Tone::Muted })
		.on_click(act::click(UiCommand::SelectFile(file.id.clone())));
	row = row.child(
		Badge::new(status_name(&file.status))
			.tone(status_tone(&file.status))
			.bare(),
	);
	if file.additions > 0 {
		row = row.child(
			Badge::new(format!("+{}", file.additions))
				.tone(Tone::Ok)
				.bare(),
		);
	}
	if file.deletions > 0 {
		row = row.child(
			Badge::new(format!("−{}", file.deletions))
				.tone(Tone::Danger)
				.bare(),
		);
	}
	let unresolved = store.frontend.review.unresolved_count_for_file(&file.path);
	if unresolved > 0 {
		row = row.child(
			Badge::new(format!("{unresolved}"))
				.icon(Icon::Review)
				.tone(Tone::Warn)
				.bare(),
		);
	}

	let actions = div()
		.flex()
		.items_center()
		.child(
			Button::new(
				format!("open-change-{}", file.id),
				owners::file_control(&file.id, RowSlot::Open),
				Icon::Read,
			)
			.size(Size::Small)
			.fill(Fill::Ghost)
			.tip("Open file")
			.on_click(act::click(UiCommand::OpenExternal(file.path.clone()))),
		)
		.child(
			Button::new(
				format!("reveal-change-{}", file.id),
				owners::file_control(&file.id, RowSlot::Reveal),
				Icon::Checkout,
			)
			.size(Size::Small)
			.fill(Fill::Ghost)
			.tip("Reveal file")
			.on_click(act::click(UiCommand::RevealFile(file.id.clone()))),
		)
		.child(
			Button::new(
				format!("copy-change-{}", file.id),
				owners::file_control(&file.id, RowSlot::Copy),
				Icon::Copy,
			)
			.size(Size::Small)
			.fill(Fill::Ghost)
			.tip("Copy path")
			.on_click(act::click(UiCommand::CopyText(file.path.clone()))),
		);

	row.hover_actions(control::action_slot() * 3.0, actions)
}

fn kind_icon(kind: &FileKind) -> Icon {
	match kind {
		FileKind::Directory => Icon::Checkout,
		FileKind::Text => Icon::Read,
		FileKind::Image => Icon::Attachment,
		FileKind::Binary | FileKind::Symlink | FileKind::Other => Icon::Changed,
	}
}

fn status_name(status: &FileChangeStatus) -> &str {
	match status {
		FileChangeStatus::Added => "A",
		FileChangeStatus::Modified => "M",
		FileChangeStatus::Deleted => "D",
		FileChangeStatus::Renamed => "R",
		FileChangeStatus::Copied => "C",
		FileChangeStatus::Untracked => "U",
		FileChangeStatus::Conflicted => "!",
		FileChangeStatus::Unknown(_) => "?",
	}
}

fn status_tone(status: &FileChangeStatus) -> Tone {
	match status {
		FileChangeStatus::Added | FileChangeStatus::Untracked => Tone::Ok,
		FileChangeStatus::Deleted | FileChangeStatus::Conflicted => Tone::Danger,
		FileChangeStatus::Modified
		| FileChangeStatus::Renamed
		| FileChangeStatus::Copied
		| FileChangeStatus::Unknown(_) => Tone::Muted,
	}
}
