//! Line-granularity virtualized diff viewport.

use gpui::{
	Context, InteractiveElement, IntoElement, ListAlignment, ListState, ParentElement, Render,
	ScrollHandle, SharedString, Styled, Window, list, px,
};
use veyyon_gui_core::{model::LineRange, text::diff::FileDiff};
use veyyon_gui_kit::{
	theme::{Elevation, Theme, diff, layout},
	ui::{Scrolls, card, scrolls_list},
};

use super::{
	paint::FilePaint,
	rows::{Layout, Rows},
};

pub struct DiffViewport {
	pub(super) revision:     u64,
	pub(super) fold_key:     u64,
	pub(super) layout:       Layout,
	pub(super) wrap:         bool,
	pub(super) whitespace:   bool,
	pub(super) review_path:  Option<SharedString>,
	pub(super) review_range: Option<LineRange>,
	pub(super) rows:         Rows,
	pub(super) files:        Vec<FilePaint>,
	pub(super) list:         ListState,
	pub(super) scroll_x:     ScrollHandle,
}

impl Default for DiffViewport {
	fn default() -> Self {
		Self::new()
	}
}

impl DiffViewport {
	pub fn new() -> Self {
		Self {
			revision:     0,
			fold_key:     0,
			layout:       Layout::Unified,
			wrap:         false,
			whitespace:   false,
			review_path:  None,
			review_range: None,
			rows:         Rows::default(),
			files:        Vec::new(),
			list:         ListState::new(0, ListAlignment::Top, px(diff::line_height())),
			scroll_x:     ScrollHandle::new(),
		}
	}

	/// Twelve arguments, each a fact the caller already holds about the paint it
	/// wants; grouping them would build a struct at the one call site and
	/// destructure it here.
	#[allow(clippy::too_many_arguments)]
	pub fn replace(
		&mut self,
		revision: u64,
		files: &[FileDiff],
		fold_key: u64,
		layout: Layout,
		wrap: bool,
		whitespace: bool,
		collapsed: impl FnMut(usize, &FileDiff) -> bool,
		truncated: bool,
		malformed_hunks: u32,
		review: Option<(&str, LineRange)>,
		cx: &mut Context<Self>,
	) {
		let same_review = match (&self.review_path, self.review_range, review) {
			(None, None, None) => true,
			(Some(current_path), Some(current_range), Some((path, range))) => {
				current_path.as_ref() == path && current_range == range
			},
			_ => false,
		};
		if self.revision == revision
			&& self.fold_key == fold_key
			&& self.layout == layout
			&& self.wrap == wrap
			&& self.whitespace == whitespace
			&& same_review
		{
			return;
		}
		let anchor_path = self
			.rows
			.file_at(self.list.logical_scroll_top().item_ix)
			.and_then(|file| self.files.get(file))
			.map(|file| file.path.clone());
		self.revision = revision;
		self.fold_key = fold_key;
		self.layout = layout;
		self.wrap = wrap;
		self.whitespace = whitespace;
		self.review_path = review.map(|(path, _)| SharedString::from(path.to_owned()));
		self.review_range = review.map(|(_, range)| range);
		self
			.rows
			.rebuild(files, layout, collapsed, truncated, malformed_hunks);
		self.files.clear();
		self.files.reserve(files.len());
		self
			.files
			.extend(files.iter().map(|file| FilePaint::new(file, whitespace)));
		self
			.list
			.reset_with_uniform_height(self.rows.len(), px(diff::line_height()));
		if let Some(anchor_path) = anchor_path
			&& let Some(file) = self.files.iter().position(|file| file.path == anchor_path)
			&& let Some(range) = self.rows.file_range(file)
		{
			self.list.scroll_to_reveal_item(range.start);
		}
		cx.notify();
	}

	pub fn revision(&self) -> u64 {
		self.revision
	}

	pub fn layout(&self) -> Layout {
		self.layout
	}

	pub fn wraps(&self) -> bool {
		self.wrap
	}

	pub fn shows_whitespace(&self) -> bool {
		self.whitespace
	}

	pub fn reveal_file(&self, file: usize) {
		if let Some(range) = self.rows.file_range(file) {
			self.list.scroll_to_reveal_item(range.start);
		}
	}

	pub fn reveal_selected_hunk(&self, file: usize, hunk: usize) {
		if let Some(row) = self.rows.hunk_row(file, hunk) {
			self.list.scroll_to_reveal_item(row);
		}
	}

	pub fn reveal_hunk(&self, current_row: Option<usize>, forward: bool) -> Option<usize> {
		let row = self.rows.next_hunk(current_row, forward)?;
		self.list.scroll_to_reveal_item(row);
		Some(row)
	}
}

impl Render for DiffViewport {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let theme = Theme::get(cx);
		card::well(&theme)
			.size_full()
			.id("changes-viewport-scroll-1")
			.child(scrolls_list(
				list(self.list.clone(), cx.processor(Self::render_row))
					.size_full()
					.min_w(px(layout::measure()))
					.with_sizing_behavior(gpui::ListSizingBehavior::Auto),
				&self.list,
				Elevation::Sunken,
			))
			.scrolls_x(&self.scroll_x, Elevation::Sunken)
	}
}
