//! The files tab: the project tree, a search over file names and contents,
//! and a read-only viewer for one file.
//!
//! The tree and the viewer draw only the rows in view. The viewed file is
//! highlighted on the background executor once per host answer and drawn
//! plain until its spans arrive.

mod results;
mod viewer;

use std::{
	collections::{HashMap, HashSet},
	ops::Range,
	sync::Arc,
};

use veyyon_desktop_model::{
	ContentMatchesView, FileKind, HostAction, HostActionKind, SearchResultsView,
	SnapshotSectionKind, SurfaceId,
};
use veyyon_desktop_ui::{
	controls::{IconButton, ListRow, Tooltip},
	editor::{Editor, EditorEvent, EditorMode},
	icons::{Icon, IconName},
	markdown::Highlighted,
	theme::{ActiveTheme, Palette, TypeStyled, size, space, text},
};
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, Div, Entity, IntoElement, ParentElement, Render, Styled,
	Subscription, UniformListScrollHandle, Window, div, prelude::*, uniform_list,
};

use super::{
	sideways::Sideways,
	style::{empty_state, heading, toolbar},
};
use crate::{AppState, StoreEvent};

/// The files tab's view.
pub struct FilesView {
	app:            Entity<AppState>,
	expanded:       HashSet<String>,
	/// The file being viewed and the one-based line to show.
	open:           Option<(String, Option<u32>)>,
	/// The last `file_content` answer the view read.
	answers:        u64,
	/// The `file_content` answer and the path the lines were split from.
	derived:        Option<(u64, String)>,
	/// How many host answers the viewer has split into lines.
	derivations:    u64,
	/// Each line of the viewed file, as a byte range of its text.
	lines:          Vec<Range<usize>>,
	/// How far the viewed file's code is scrolled past its line numbers.
	sideways:       Sideways,
	highlighted:    Option<Arc<Highlighted>>,
	viewer:         UniformListScrollHandle,
	search:         Entity<Editor>,
	query:          String,
	/// The query the tab last asked the host to search for.
	asked:          String,
	/// The host's last answers to a query the tab asked, held so an answer to
	/// a query it did not ask replaces none of the rows drawn.
	found_paths:    Option<SearchResultsView>,
	found_lines:    Option<ContentMatchesView>,
	renders:        u64,
	_subscriptions: Vec<Subscription>,
}

impl FilesView {
	/// Builds the tab over `app`'s file tree.
	pub fn new(app: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
		let search = cx.new(|cx| {
			let mut editor = Editor::new(EditorMode::SingleLine, window, cx);
			editor.set_placeholder("Search files and contents", cx);
			editor
		});
		let subscriptions = vec![
			cx.subscribe(&app, |this, _, event: &StoreEvent, cx| match event {
				StoreEvent::DomainChanged(SnapshotSectionKind::FileContent) => this.load_content(cx),
				StoreEvent::DomainChanged(
					SnapshotSectionKind::SearchResults | SnapshotSectionKind::ContentMatches,
				) => this.hold_answers(cx),
				StoreEvent::DomainChanged(
					SnapshotSectionKind::FileTree
					| SnapshotSectionKind::Changes
					| SnapshotSectionKind::Capabilities,
				) => cx.notify(),
				_ => {},
			}),
			cx.subscribe(&search, |this, editor, event: &EditorEvent, cx| match event {
				EditorEvent::Changed => {
					this.query = editor.read(cx).text().trim().to_owned();
					cx.notify();
				},
				EditorEvent::Submit => this.run_search(cx),
				_ => {},
			}),
		];
		Self {
			app,
			expanded: HashSet::new(),
			open: None,
			answers: 0,
			derived: None,
			derivations: 0,
			lines: Vec::new(),
			sideways: Sideways::default(),
			highlighted: None,
			viewer: UniformListScrollHandle::new(),
			search,
			query: String::new(),
			asked: String::new(),
			found_paths: None,
			found_lines: None,
			renders: 0,
			_subscriptions: subscriptions,
		}
	}

	/// How many times the tab has rendered.
	pub const fn render_count(&self) -> u64 {
		self.renders
	}

	/// How many host answers the viewer has split into lines, which a view
	/// test compares across events that answer nothing new.
	pub const fn derivations(&self) -> u64 {
		self.derivations
	}

	/// The file the viewer shows.
	pub fn open_path(&self) -> Option<&str> {
		self.open.as_ref().map(|(path, _)| path.as_str())
	}

	/// How many lines of the viewed file the viewer holds.
	pub const fn line_count(&self) -> usize {
		self.lines.len()
	}

	/// Shows `path` and asks the host for its text; the viewer scrolls to the
	/// one-based `line` once it arrives.
	pub fn open(&mut self, path: String, line: Option<u32>, cx: &mut Context<Self>) {
		self.send(HostAction::ReadFile { path: path.clone() }, cx);
		self.open = Some((path, line));
		self.load_content(cx);
	}

	/// Sets the search text and runs the search, as Enter in the field does.
	pub fn search(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) {
		self
			.search
			.update(cx, |editor, cx| editor.set_text(query, cx));
		query.trim().clone_into(&mut self.query);
		self.run_search(cx);
		self
			.search
			.update(cx, |editor, cx| editor.focus(window, cx));
	}

	/// Asks the host for the paths and the lines that hold the query, whose
	/// answer is drawn in place of the viewed file.
	fn run_search(&mut self, cx: &mut Context<Self>) {
		if self.query.is_empty() {
			return;
		}
		self.asked.clone_from(&self.query);
		self.open = None;
		self.send(HostAction::SearchFiles { query: self.query.clone() }, cx);
		self.send(HostAction::SearchContent { query: self.query.clone() }, cx);
		cx.notify();
	}

	/// Holds the host's answers to the query the tab asked for. An answer to
	/// another one, a slower earlier search or a lookup another surface sent,
	/// is left to that surface.
	fn hold_answers(&mut self, cx: &mut Context<Self>) {
		let domains = &self.app.read(cx).store().domains;
		if let Some(paths) = domains
			.search
			.as_ref()
			.filter(|paths| paths.query == self.asked)
		{
			self.found_paths = Some(paths.clone());
		}
		if let Some(lines) = domains
			.content_matches
			.as_ref()
			.filter(|lines| lines.query == self.asked)
		{
			self.found_lines = Some(lines.clone());
		}
		cx.notify();
	}

	fn close(&mut self, cx: &mut Context<Self>) {
		self.open = None;
		cx.notify();
	}

	fn send(&self, action: HostAction, cx: &mut Context<Self>) {
		self.app.update(cx, |app, cx| {
			let surface = app
				.active_session()
				.cloned()
				.map_or(SurfaceId::GlobalTitlebarLine, SurfaceId::RightPanelFileTab);
			app.dispatch(action, surface, cx);
		});
	}

	fn toggle_dir(&mut self, path: &str, cx: &mut Context<Self>) {
		if !self.expanded.remove(path) {
			self.expanded.insert(path.to_owned());
		}
		cx.notify();
	}

	/// The indices of the tree entries whose every parent directory is
	/// expanded.
	fn visible_entries(&self, app: &AppState) -> Vec<usize> {
		let Some(tree) = &app.store().domains.file_tree else {
			return Vec::new();
		};
		let mut hidden_below = None;
		let mut visible = Vec::new();
		for (ix, entry) in tree.entries.iter().enumerate() {
			if hidden_below.is_some_and(|depth| entry.depth > depth) {
				continue;
			}
			hidden_below = None;
			visible.push(ix);
			if entry.kind == FileKind::Directory && !self.expanded.contains(&entry.path) {
				hidden_below = Some(entry.depth);
			}
		}
		visible
	}

	fn render_tree(&self, palette: &Palette, cx: &Context<Self>) -> AnyElement {
		let app = self.app.read(cx);
		let Some(tree) = &app.store().domains.file_tree else {
			return empty_state("The project tree has not loaded", None::<Div>, palette)
				.into_any_element();
		};
		let truncated = tree.truncated;
		let visible = self.visible_entries(app);
		let list = uniform_list(
			"files-tree",
			visible.len(),
			cx.processor(move |this, range: Range<usize>, _, cx| {
				let palette = cx.theme().palette;
				let app = this.app.read(cx);
				let Some(tree) = &app.store().domains.file_tree else {
					return Vec::new();
				};
				let changed: HashMap<&str, (u64, u64)> = app
					.store()
					.domains
					.changes
					.get()
					.map(|changes| {
						changes
							.files
							.iter()
							.map(|file| (file.path.as_str(), (file.additions, file.deletions)))
							.collect()
					})
					.unwrap_or_default();
				visible
					.get(range)
					.unwrap_or_default()
					.iter()
					.filter_map(|&ix| Some((ix, tree.entries.get(ix)?)))
					.map(|(ix, entry)| {
						let dir = entry.kind == FileKind::Directory;
						let icon = match (dir, this.expanded.contains(&entry.path)) {
							(true, true) => IconName::FolderOpen,
							(true, false) => IconName::Folder,
							(false, _) => IconName::File,
						};
						let badge = changed.get(entry.path.as_str()).map(|&(added, removed)| {
							div()
								.flex()
								.gap(space::S1)
								.type_style(text::MONO)
								.child(
									div()
										.text_color(palette.diff.add_fg)
										.child(format!("+{added}")),
								)
								.child(
									div()
										.text_color(palette.diff.del_fg)
										.child(format!("\u{2212}{removed}")),
								)
						});
						let path = entry.path.clone();
						let mut row = ListRow::new(("tree", ix), entry.name.clone())
							.leading(Icon::new(icon).color(palette.text.muted))
							.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
								if dir {
									this.toggle_dir(&path, cx);
								} else {
									this.open(path.clone(), None, cx);
								}
							}));
						if let Some(badge) = badge {
							row = row.trailing(badge);
						}
						div()
							.id(("tree-tip", ix))
							.pl(space::S3 * entry.depth as f32)
							.tooltip(Tooltip::text(entry.path.clone()))
							.child(row)
					})
					.collect()
			}),
		)
		.flex_1();
		div()
			.flex()
			.flex_col()
			.flex_1()
			.min_h_0()
			.px(space::S1)
			.child(list)
			.when(truncated, |el| {
				el.child(heading("The tree stops at the host's size limit", palette))
			})
			.into_any_element()
	}
}

impl Render for FilesView {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.renders += 1;
		let palette = cx.theme().palette;
		let refused = self
			.app
			.read(cx)
			.panel_unavailable(HostActionKind::LoadFileTree);
		let disabled = refused.is_some();
		let body = match (refused, self.open.clone()) {
			// A host that browses no files states why in place of the tree.
			(Some(reason), _) => empty_state(reason, None::<Div>, &palette).into_any_element(),
			(None, Some((path, _))) => self.render_viewer(&path, &palette, window, cx),
			(None, None) if !self.query.is_empty() => self.render_results(&palette, cx),
			(None, None) => self.render_tree(&palette, cx),
		};
		div()
			.flex()
			.flex_col()
			.size_full()
			.child(
				toolbar(&palette)
					.child(
						Icon::new(IconName::Search)
							.size(size::ICON_SM)
							.color(palette.text.muted),
					)
					.child(div().flex_1().min_w_0().child(self.search.clone()))
					.child(
						IconButton::new("files-refresh", IconName::RefreshCw)
							.tooltip("Reload the tree")
							.disabled(disabled)
							.on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
								this.send(HostAction::LoadFileTree { root: None }, cx);
							})),
					),
			)
			.child(body)
	}
}
