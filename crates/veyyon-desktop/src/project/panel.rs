//! The right panel's content: what the run changed, file views, and directory
//! tree.

use veyyon_desktop_model::{
	Capability, CapabilityMap, CapabilityStatus, ChangesView, Domains, ExportView, FileTreeView,
	SessionId,
};
use veyyon_desktop_surface::{
	DerivedFrom, DiffFile, DiffStatus, DiffWithheld, FileView, PanelContent, PanelTab, TreeContent,
	TreeRowItem, TreeStatus, diff::parse_diff, right_panel::highlight_source,
};

/// Projects domain models from the store onto the right panel's content,
/// preserving window-owned state (active tab, diff mode, tree expansion,
/// selection).
///
/// `previous` is what the window is holding, by value: parsing a repository's
/// unified diff into rows and highlighting the open file are the two
/// derivations here that cost more than a frame, and a projection runs on
/// every host event batch, so both are moved out of `previous` rather than
/// derived again while the host has stated nothing new.
#[must_use]
pub fn project_panel(
	domains: &Domains,
	capabilities: &CapabilityMap,
	active: Option<&SessionId>,
	previous: PanelContent,
) -> PanelContent {
	let derived_from = DerivedFrom {
		changes:      domains.changes.answers(),
		file_content: domains.file_content.answers(),
		export:       domains.export.answers(),
	};

	// The status a tab reports comes from the capability and the answer, both
	// cheap, so it is stated every projection. Only the parse is held.
	let (diff, diff_status, withheld) = if let Some(changes) = domains.changes.get() {
		let files = if derived_from.changes == previous.derived_from.changes {
			previous.diff
		} else if !changes.diff.is_empty() {
			parse_diff(&changes.diff)
		} else if !changes.files.is_empty() {
			// If diff text is not provided, construct stub files from ChangesView.files
			changes
				.files
				.iter()
				.map(|f| DiffFile {
					path:      f.path.clone(),
					old_path:  f.previous_path.clone(),
					status:    f.status,
					additions: usize::try_from(f.additions).unwrap_or(usize::MAX),
					deletions: usize::try_from(f.deletions).unwrap_or(usize::MAX),
					rows:      Vec::new(),
				})
				.collect()
		} else {
			Vec::new()
		};
		// What the host cut is three fields off the answer, so it is stated
		// every projection rather than held: a notice that outlived the
		// snapshot it describes would claim a cut diff the host has since
		// sent whole.
		let withheld = DiffWithheld {
			diff_truncated: changes.diff_truncated,
			files_withheld: changes.files_withheld,
			diff_bytes:     changes.diff.len(),
		};
		(files, DiffStatus::Loaded, withheld)
	} else if matches!(capabilities.get(Capability::Changes), CapabilityStatus::Unavailable { .. }) {
		(Vec::new(), DiffStatus::Failed, DiffWithheld::default())
	} else {
		(Vec::new(), previous.diff_status, DiffWithheld::default())
	};

	// The file the operator opened holds the tab. An export they asked for
	// takes it only while no file is open, so the answer to `ExportSession` is
	// on a surface rather than in the store alone, and reading a file after
	// exporting replaces it rather than fighting it.
	//
	// Highlighting the file line by line is the panel's other derivation that
	// costs more than a frame, so it is held while both answers stand. A panel
	// whose stamps agree while its document disagrees with the store -- one
	// assembled by a fixture, a scene seed or a restored window rather than by
	// a projection -- derives instead of trusting the stamp.
	let has_document = domains.file_content.is_some() || domains.export.is_some();
	let file = if derived_from.file_content == previous.derived_from.file_content
		&& derived_from.export == previous.derived_from.export
		&& previous.file.is_some() == has_document
	{
		previous.file
	} else {
		domains
			.file_content
			.get()
			.map(|fc| highlight_source(&fc.path, &fc.content, fc.truncated, fc.binary))
			.or_else(|| domains.export.get().map(export_view))
	};

	let tree =
		project_tree(domains.file_tree.as_ref(), domains.changes.get(), capabilities, &previous.tree);

	// The usage tab is the turn footer's destination. A host that declared usage
	// unavailable takes the tab away, which is how the footer degrades to naming
	// the model and nothing else. A host that has not answered yet offers no tab
	// either, rather than one that opens on nothing — but a tab the operator
	// already opened from the footer is window state and survives, or the panel
	// they are reading closes itself on the next unrelated snapshot.
	let usage = active.and_then(|id| domains.usage.get(id)).cloned();
	let usage_offered = match capabilities.get(Capability::Usage) {
		CapabilityStatus::Unavailable { .. } => false,
		CapabilityStatus::Available => true,
		_ => usage.is_some() || previous.tabs.contains(&PanelTab::Usage),
	};

	let mut tabs = Vec::with_capacity(4);
	// The tab draws what `Changes` answers. `PendingEdits` is a separate
	// capability with no content here, so a host that reports repository
	// changes and no edit buffer still offers the tab.
	if matches!(capabilities.get(Capability::Changes), CapabilityStatus::Available) {
		tabs.push(PanelTab::Diff);
	}
	// An export is a session action, not a file one, so its view is reachable
	// on a host that offers no file browsing.
	if matches!(capabilities.get(Capability::Files), CapabilityStatus::Available) {
		tabs.push(PanelTab::File);
		tabs.push(PanelTab::Tree);
	} else if file.is_some() {
		tabs.push(PanelTab::File);
	}
	if usage_offered {
		tabs.push(PanelTab::Usage);
	}

	let unavailable_reason = if tabs.is_empty() {
		if let CapabilityStatus::Unavailable { reason } = capabilities.get(Capability::Changes) {
			Some(reason.clone())
		} else if let CapabilityStatus::Unavailable { reason } = capabilities.get(Capability::Files) {
			Some(reason.clone())
		} else if matches!(
			capabilities.get(Capability::Changes),
			CapabilityStatus::UnknownUntilAttached
		) || matches!(
			capabilities.get(Capability::Files),
			CapabilityStatus::UnknownUntilAttached
		) {
			Some("Connecting to host...".to_string())
		} else {
			Some("Panel features unavailable".to_string())
		}
	} else {
		None
	};

	let active_tab = if tabs.contains(&previous.active_tab) {
		previous.active_tab
	} else {
		tabs.first().copied().unwrap_or(PanelTab::Diff)
	};

	PanelContent {
		tabs,
		active_tab,
		diff,
		diff_status,
		review_repository: domains.changes.get().and_then(|changes| {
			changes
				.repository
				.as_ref()
				.map(|repository| (repository.clone(), changes.scope))
		}),
		file,
		tree,
		diff_mode: previous.diff_mode,
		usage,
		unavailable_reason,
		derived_from,
		withheld,
		// The failure the active tab states is resolved from the controls
		// after this, every projection, so nothing here can outlive the
		// error it described.
		failure: None,
	}
}

/// The export snapshot as a document: its content when the host returned one,
/// and the path it was written to when it returned a file instead.
///
/// The name carries the format so the view highlights the export the way it
/// would highlight the same file opened from the tree.
fn export_view(export: &ExportView) -> FileView {
	let name = export
		.path
		.clone()
		.unwrap_or_else(|| format!("{}.{}", export.session.0, export.format));
	let content = export
		.content
		.clone()
		.unwrap_or_else(|| format!("Exported {} to {name}", export.format));
	highlight_source(&name, &content, false, false)
}

fn project_tree(
	file_tree: Option<&FileTreeView>,
	changes: Option<&ChangesView>,
	capabilities: &CapabilityMap,
	previous_tree: &TreeContent,
) -> TreeContent {
	if let Some(ft) = file_tree {
		let mut rows = Vec::with_capacity(ft.entries.len());
		let change_map: std::collections::HashMap<&str, (u32, u32)> = changes
			.map(|c| {
				c.files
					.iter()
					.map(|f| (f.path.as_str(), (clamp_u32(f.additions), clamp_u32(f.deletions))))
					.collect()
			})
			.unwrap_or_default();

		for entry in &ft.entries {
			let is_dir = matches!(entry.kind, veyyon_desktop_model::FileKind::Directory);
			let is_expanded = previous_tree.expanded_paths.contains(&entry.path);
			let changed = change_map.get(entry.path.as_str()).copied();

			rows.push(TreeRowItem {
				path: entry.path.clone(),
				name: entry.name.clone(),
				depth: usize::try_from(entry.depth).unwrap_or(usize::MAX),
				is_dir,
				is_expanded,
				changed,
			});
		}

		TreeContent {
			rows,
			selected_path: previous_tree.selected_path.clone(),
			expanded_paths: previous_tree.expanded_paths.clone(),
			status: TreeStatus::Loaded,
		}
	} else {
		let status =
			if matches!(capabilities.get(Capability::Files), CapabilityStatus::Unavailable { .. }) {
				TreeStatus::Failed
			} else {
				previous_tree.status
			};

		TreeContent {
			rows: Vec::new(),
			selected_path: previous_tree.selected_path.clone(),
			expanded_paths: previous_tree.expanded_paths.clone(),
			status,
		}
	}
}

fn clamp_u32(n: u64) -> u32 {
	u32::try_from(n).unwrap_or(u32::MAX)
}
