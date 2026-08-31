//! Lazy workspace tree rendering and toolbar controls.

use gpui::{
	AnyElement, App, Entity, InteractiveElement, IntoElement, ParentElement, ScrollHandle, Styled,
	div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{FileKind, FileSearchMode, FileWorkspaceState, RemoteData},
};
use veyyon_gui_kit::{
	input::Editor,
	theme::{Elevation, Theme, space},
	ui::{Button, Empty, Fill, Icon, Row, Scrolls, SearchField, Size, Tab, Tabs, Tone, text},
};

use super::{
	logic,
	owners::{self, Chrome},
	search,
	tree_cache::{TreeCache, TreeEntry},
};
use crate::act;

pub fn render(
	store: &Store,
	field: &Entity<Editor>,
	scroll: &ScrollHandle,
	cache: &TreeCache,
	cx: &mut App,
) -> gpui::Div {
	let theme = Theme::get(cx);
	let selected_workspace = store.frontend.selected_workspace.as_ref();
	let files = store.replica.files.readable();
	let mut surface = div()
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.bg(theme.chrome);
	surface = surface.child(toolbar(store, field, files.map(|files| &files.value), cx));
	if !store.frontend.file_filter.is_empty() {
		return surface.child(search::render(store, files.map(|files| &files.value), scroll, cx));
	}
	let Some(files) = files else {
		return surface.child(
			Empty::new("Workspace files are unavailable")
				.icon(Icon::Checkout)
				.filling(),
		);
	};
	if files.value.roots.is_empty() {
		return surface.child(
			Empty::new("No workspace roots")
				.icon(Icon::Checkout)
				.note("Attach or open a workspace before browsing files.")
				.filling(),
		);
	}
	if selected_workspace.is_none() {
		return surface.child(
			Empty::new("Choose a workspace root")
				.icon(Icon::Checkout)
				.note("The file tree remains empty until a root is selected.")
				.filling(),
		);
	}
	if cache.rows.is_empty() {
		return surface.child(
			Empty::new("This workspace is empty")
				.icon(Icon::Checkout)
				.note("Refresh to ask the host for its current root entries.")
				.filling(),
		);
	}
	let mut column = text::stack(space::ROWS)
		.id("files-tree-rows")
		.w_full()
		.px(px(space::TIGHT))
		.py(px(space::TIGHT));
	for entry in &cache.rows {
		column = column.child(tree_row(entry, &files.value, store, cx));
	}
	surface.child(
		div()
			.flex_1()
			.min_h(px(0.0))
			.id("files-tree-scroll-1")
			.child(column)
			.scrolls_y(scroll, Elevation::Chrome),
	)
}

fn toolbar(
	store: &Store,
	field: &Entity<Editor>,
	files: Option<&FileWorkspaceState>,
	cx: &mut App,
) -> gpui::Div {
	let theme = Theme::get(cx);
	let mut roots = text::stack(space::ROWS).w_full();
	if let Some(files) = files
		&& let Some(workspaces) = store.replica.workspaces.readable()
	{
		for workspace_id in &files.roots {
			if let Some(workspace) = workspaces
				.value
				.iter()
				.find(|workspace| workspace.id == *workspace_id)
			{
				let owner = owners::workspace(&workspace.id);
				let mut root =
					Row::new(format!("file-root-{}", workspace.id), owner, workspace.name.clone())
						.icon(Icon::Checkout)
						.note(workspace.root.clone())
						.active(store.frontend.selected_workspace.as_ref() == Some(&workspace.id));
				if store.connection.is_connected() {
					root = root.on_click(act::click(UiCommand::LoadFileTree {
						workspace: workspace.id.clone(),
						parent:    None,
					}));
				} else {
					root = root.disabled("Disconnected from host");
				}
				roots = roots.child(root);
			}
		}
	}
	let refresh_disabled = if !store.connection.is_connected() {
		Some("Reconnect before refreshing")
	} else if store.frontend.selected_workspace.is_none() {
		Some("Choose a workspace before refreshing")
	} else {
		None
	};
	let mut refresh =
		Button::new("refresh-file-tree", owners::chrome(Chrome::RefreshTree), Icon::Running)
			.fill(Fill::Ghost)
			.tone(Tone::Muted)
			.size(Size::Small)
			.tip("Refresh files");
	if let Some(reason) = refresh_disabled {
		refresh = refresh.disabled(reason);
	} else if let Some(workspace) = store.frontend.selected_workspace.clone() {
		refresh = refresh.on_click(act::click(UiCommand::LoadFileTree { workspace, parent: None }));
	}

	let can_search = store.connection.is_connected()
		&& !store.frontend.file_filter.trim().is_empty()
		&& store.frontend.selected_workspace.is_some();
	let search_disabled = if !store.connection.is_connected() {
		Some("Reconnect before searching")
	} else if store.frontend.selected_workspace.is_none() {
		Some("Choose a workspace before searching")
	} else if store.frontend.file_filter.trim().is_empty() {
		Some("Enter a query before searching")
	} else {
		None
	};
	let mut search =
		Button::new("search-workspace-files", owners::chrome(Chrome::SearchFiles), Icon::Search)
			.fill(Fill::Ghost)
			.tone(Tone::Muted)
			.size(Size::Small)
			.tip("Search workspace files");
	if let Some(reason) = search_disabled {
		search = search.disabled(reason);
	} else if let Some(workspace) = store
		.frontend
		.selected_workspace
		.clone()
		.filter(|_| can_search)
	{
		search = search.on_click(act::click(UiCommand::SearchFiles {
			workspace,
			query: store.frontend.file_filter.clone(),
			mode: store.frontend.file_search_mode,
		}));
	}
	let modes = Tabs::new("file-search-mode")
		.tab(
			Tab::new(
				owners::chrome(Chrome::TabNames),
				"Names",
				store.frontend.file_search_mode == FileSearchMode::Name,
			)
			.on_click(act::click(UiCommand::SetFileSearchMode(FileSearchMode::Name))),
		)
		.tab(
			Tab::new(
				owners::chrome(Chrome::TabContents),
				"Contents",
				store.frontend.file_search_mode == FileSearchMode::Content,
			)
			.on_click(act::click(UiCommand::SetFileSearchMode(FileSearchMode::Content))),
		)
		.stretch();
	div()
		.flex()
		.flex_col()
		.gap(px(space::TIGHT))
		.p(px(space::TIGHT))
		.border_b_1()
		.border_color(theme.stroke)
		.children((files.is_some()).then_some(roots))
		.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::TIGHT))
				.child(SearchField::new("file-filter", owners::chrome(Chrome::Filter), field.clone()))
				.child(search)
				.child(refresh),
		)
		.child(modes)
}

fn tree_row(
	entry: &TreeEntry,
	files: &FileWorkspaceState,
	store: &Store,
	_cx: &mut App,
) -> AnyElement {
	match entry {
		TreeEntry::File { id, depth } => {
			let Some(node) = files.nodes.iter().find(|node| node.id == *id) else {
				return div().into_any_element();
			};
			let note = logic::metadata(node);
			let owner = owners::file(id);
			let mut row = Row::new(format!("file-node-{}", node.id), owner, node.name.clone())
				.icon(if node.kind == FileKind::Directory {
					if store.frontend.expanded_files.contains(&node.id) {
						Icon::Open
					} else {
						Icon::Folded
					}
				} else {
					Icon::Read
				})
				.depth(*depth)
				.selected(store.frontend.file_cursor.as_ref() == Some(&node.id))
				.active(store.frontend.selected_file.as_ref() == Some(&node.id))
				.tone(if node.ignored {
					Tone::Muted
				} else {
					Tone::Plain
				});
			if !note.is_empty() {
				row = row.note(note);
			}
			let expanded = store.frontend.expanded_files.contains(&node.id);
			let command = if node.kind == FileKind::Directory {
				let needs_load = matches!(
					node.children,
					RemoteData::Unrequested | RemoteData::Error { stale: None, .. }
				);
				if !expanded && needs_load {
					store
						.connection
						.is_connected()
						.then(|| UiCommand::LoadFileTree {
							workspace: node.workspace.clone(),
							parent:    Some(node.id.clone()),
						})
				} else {
					Some(UiCommand::ToggleFileExpanded(node.id.clone()))
				}
			} else if store.connection.is_connected() {
				Some(UiCommand::ReadFile { file: node.id.clone(), range: None })
			} else {
				Some(UiCommand::SelectFile(node.id.clone()))
			};
			if let Some(command) = command {
				row = row.on_click(act::click(command));
			}
			row.into_any_element()
		},
		TreeEntry::Loading { parent, depth } => {
			let owner = owners::aux(&format!("loading-{parent}"));
			Row::new(format!("file-loading-{parent}"), owner, "Loading folder…")
				.icon(Icon::Running)
				.depth(*depth)
				.tone(Tone::Muted)
				.into_any_element()
		},
		TreeEntry::Empty { parent, depth } => {
			let owner = owners::aux(&format!("empty-{parent}"));
			Row::new(format!("file-empty-{parent}"), owner, "Empty folder")
				.icon(Icon::Checkout)
				.depth(*depth)
				.tone(Tone::Muted)
				.into_any_element()
		},
		TreeEntry::Error { workspace, parent, depth, message } => {
			let owner = owners::aux(&format!("error-{parent}"));
			let mut row = Row::new(format!("file-error-{parent}"), owner, "Unable to read folder")
				.icon(Icon::Failed)
				.depth(*depth)
				.note(message.clone())
				.tone(Tone::Danger);
			if store.connection.is_connected() {
				row = row.on_click(act::click(UiCommand::LoadFileTree {
					workspace: workspace.clone(),
					parent:    Some(parent.clone()),
				}));
			} else {
				row = row.disabled("Reconnect to retry reading folder");
			}
			row.into_any_element()
		},
	}
}
