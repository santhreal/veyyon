//! Route composition and remote-state handling.

use gpui::{AnyElement, App, InteractiveElement, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{
		Capability, CapabilityStatus, ConnectionState, FileReadView, FileWorkspaceState, RemoteData,
		Versioned,
	},
};
use veyyon_gui_kit::{
	theme::{Elevation, space},
	ui::{Banner, EdgeFade, Empty, Icon, Scrolls},
};

use super::{FilesHandles, error, header, inspector, preview, tree};

pub fn render_sidebar(store: &Store, handles: &mut FilesHandles, cx: &mut App) -> gpui::Div {
	handles.sync(store);
	tree::render(store, &handles.search, &handles.tree_scroll, &mut handles.tree, cx)
}

pub fn render_route(store: &Store, handles: &mut FilesHandles, cx: &mut App) -> gpui::Div {
	handles.sync(store);
	if let ConnectionState::Fatal { message } = &store.connection {
		return error::state_empty(
			"Files unavailable",
			message,
			Icon::Failed,
			Some(UiCommand::RetryConnection),
		);
	}
	if let CapabilityStatus::Unavailable { reason } = store.replica.capability(Capability::Files) {
		return error::state_empty("File browsing is unavailable", reason, Icon::Failed, None);
	}
	match &store.replica.files {
		RemoteData::Unrequested => unrequested(store),
		RemoteData::Loading { .. } => error::loading("Loading workspace files…"),
		RemoteData::Empty => error::state_empty(
			"No workspace files",
			"The attached host returned no workspace roots.",
			Icon::Checkout,
			None,
		),
		RemoteData::Ready(files) => selected(store, files, handles, false, None, cx),
		RemoteData::Stale { value: files, reason } => selected(
			store,
			files,
			handles,
			true,
			Some(format!("File data is stale: {}", error::stale_reason(reason))),
			cx,
		),
		RemoteData::Error { message, stale: Some(files), .. } => {
			selected(store, files, handles, true, Some(message.clone()), cx)
		},
		RemoteData::Error { message, retryable, stale: None } => error::state_empty(
			"Unable to load workspace files",
			message,
			Icon::Failed,
			retryable.then_some(UiCommand::RetryConnection),
		),
	}
}

pub fn render_inspector(store: &Store, handles: &mut FilesHandles, cx: &mut App) -> EdgeFade {
	handles.sync(store);
	let read = selected_read(store);
	let cache = read.and_then(|read| handles.cached_body(&read.id));
	div()
		.size_full()
		.min_h(px(0.0))
		.id("files-view-scroll-1")
		.child(inspector::render(store, read, cache.as_ref(), handles, cx))
		.scrolls_y(&handles.inspector_scroll, Elevation::Chrome)
}

fn unrequested(store: &Store) -> gpui::Div {
	match &store.connection {
		ConnectionState::Detached => error::state_empty(
			"Attach to browse files",
			"No workspace or file contents are available while detached.",
			Icon::Checkout,
			Some(UiCommand::Attach { endpoint: None }),
		),
		ConnectionState::Connecting { .. } => error::loading("Connecting to the host…"),
		ConnectionState::Syncing { received, expected } => error::loading(&expected.map_or_else(
			|| format!("Syncing files: {received} received"),
			|expected| format!("Syncing files: {received} of {expected}"),
		)),
		ConnectionState::Connected { .. } => error::state_empty(
			"Files have not been requested",
			"Choose a workspace root or refresh the Files route.",
			Icon::Checkout,
			None,
		),
		ConnectionState::Reconnecting { message, .. } => error::state_empty(
			"Reconnecting",
			message,
			Icon::Running,
			Some(UiCommand::RetryConnection),
		),
		ConnectionState::Fatal { message } => error::state_empty(
			"Files unavailable",
			message,
			Icon::Failed,
			Some(UiCommand::RetryConnection),
		),
	}
}

fn selected(
	store: &Store,
	files: &Versioned<FileWorkspaceState>,
	handles: &FilesHandles,
	stale: bool,
	notice: Option<String>,
	cx: &mut App,
) -> gpui::Div {
	let selected_id = store.frontend.selected_file.as_ref();
	let selected_node =
		selected_id.and_then(|id| files.value.nodes.iter().find(|node| &node.id == id));
	let mut surface = div().flex().flex_col().size_full().min_h(px(0.0));
	if let Some(notice) = notice {
		surface = surface.child(
			div().p(px(space::TIGHT)).child(
				Banner::failure(if stale {
					"Showing cached file data"
				} else {
					"File request failed"
				})
				.detail(notice),
			),
		);
	} else if stale {
		surface = surface.child(
			div()
				.p(px(space::TIGHT))
				.child(Banner::notice("Showing cached file data while disconnected")),
		);
	}
	let Some(node) = selected_node else {
		return surface.child(
			Empty::new("Choose a file")
				.icon(Icon::Read)
				.note("Tree and search selection stay coupled to this preview.")
				.filling(),
		);
	};
	surface = surface.child(header::file_header(
		store,
		node.path.as_str(),
		selected_read(store),
		handles,
		stale,
		cx,
	));
	if node.kind == veyyon_gui_core::model::FileKind::Directory {
		return surface.child(
			Empty::new("Folder selected")
				.icon(Icon::Checkout)
				.note("Expand the folder in the tree to load its direct children.")
				.filling(),
		);
	}
	surface.child(selected_body(store, &files.value, handles, stale, cx))
}

fn selected_body(
	store: &Store,
	files: &FileWorkspaceState,
	handles: &FilesHandles,
	stale_parent: bool,
	cx: &mut App,
) -> AnyElement {
	match &files.selected_read {
		RemoteData::Unrequested => error::state_empty(
			"Preview not loaded",
			"Select the file again to request its contents.",
			Icon::Read,
			None,
		)
		.into_any_element(),
		RemoteData::Loading { .. } => error::loading("Reading file…").into_any_element(),
		RemoteData::Empty => error::state_empty(
			"No file selected",
			"Choose a file from the tree or search results.",
			Icon::Read,
			None,
		)
		.into_any_element(),
		RemoteData::Ready(read) => read_body(store, &read.value, handles, stale_parent, cx),
		RemoteData::Stale { value: read, .. } => read_body(store, &read.value, handles, true, cx),
		RemoteData::Error { message, stale: Some(read), .. } => div()
			.flex()
			.flex_col()
			.size_full()
			.child(
				div()
					.p(px(space::TIGHT))
					.child(Banner::failure("File refresh failed").detail(message.clone())),
			)
			.child(read_body(store, &read.value, handles, true, cx))
			.into_any_element(),
		RemoteData::Error { message, retryable, stale: None } => {
			if let Some(err) = &files.read_error {
				error::render_file_read_error(err, store).into_any_element()
			} else {
				error::state_empty(
					"Unable to read file",
					message,
					Icon::Failed,
					retryable
						.then(|| {
							store
								.frontend
								.selected_file
								.clone()
								.map(|file| UiCommand::ReadFile { file, range: None })
						})
						.flatten(),
				)
				.into_any_element()
			}
		},
	}
}

fn read_body(
	store: &Store,
	read: &FileReadView,
	handles: &FilesHandles,
	stale: bool,
	cx: &mut App,
) -> AnyElement {
	let Some(cache) = handles.cached_body(&read.id) else {
		return error::loading("Preparing preview…").into_any_element();
	};
	div()
		.flex()
		.flex_col()
		.flex_1()
		.min_h(px(0.0))
		.children(stale.then(|| {
			div()
				.p(px(space::TIGHT))
				.child(Banner::notice("This preview is cached and may be out of date"))
		}))
		.child(preview::render(
			&cache,
			&read.path,
			store.frontend.file_range,
			&handles.preview_scroll,
			&handles.markdown_scroll,
			cx,
		))
		.into_any_element()
}

fn selected_read(store: &Store) -> Option<&FileReadView> {
	store
		.replica
		.files
		.readable()?
		.value
		.selected_read
		.readable()
		.map(|read| &read.value)
}
