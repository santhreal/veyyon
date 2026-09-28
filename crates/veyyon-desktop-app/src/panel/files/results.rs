//! The answer to a search: the paths whose names hold the query, then the
//! lines whose text does. The tab draws the answers it held for the query
//! it asked, and a result for an earlier query is not drawn.

use veyyon_desktop_ui::{
	controls::ListRow,
	icons::{Icon, IconName},
	theme::{Palette, space},
};
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, Div, IntoElement, ParentElement, Styled, div, prelude::*,
};

use super::FilesView;
use crate::panel::style::{counted, empty_state, heading};

impl FilesView {
	pub(super) fn render_results(&self, palette: &Palette, cx: &Context<Self>) -> AnyElement {
		let paths = self
			.found_paths
			.as_ref()
			.filter(|results| results.query == self.query);
		let lines = self
			.found_lines
			.as_ref()
			.filter(|found| found.query == self.query);
		if paths.is_none() && lines.is_none() {
			return empty_state("Press Enter to search", None::<Div>, palette).into_any_element();
		}
		let file_rows = paths
			.into_iter()
			.flat_map(|results| results.paths.iter().enumerate())
			.map(|(ix, path)| {
				let open = path.clone();
				ListRow::new(("found", ix), path.clone())
					.leading(Icon::new(IconName::File).color(palette.text.muted))
					.on_click(
						cx.listener(move |this, _: &ClickEvent, _, cx| this.open(open.clone(), None, cx)),
					)
			});
		let line_rows = lines
			.into_iter()
			.flat_map(|found| found.matches.iter().enumerate())
			.map(|(ix, found)| {
				let (path, line) = (found.path.clone(), found.line);
				ListRow::new(
					("match", ix),
					format!("{}:{}  {}", found.path, found.line, found.preview.trim()),
				)
				.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
					this.open(path.clone(), Some(line), cx);
				}))
			});
		let path_count = paths.map_or(0, |results| results.paths.len());
		let line_count = lines.map_or(0, |found| found.matches.len());
		let cut = paths.is_some_and(|results| results.truncated)
			|| lines.is_some_and(|found| found.truncated);
		div()
			.id("files-results")
			.flex()
			.flex_col()
			.flex_1()
			.min_h_0()
			.px(space::S1)
			.overflow_y_scroll()
			.child(heading(counted(path_count as u64, "file", "files"), palette))
			.children(file_rows)
			.child(heading(counted(line_count as u64, "matching line", "matching lines"), palette))
			.children(line_rows)
			.when(cut, |el| el.child(heading("The host stopped short of every match", palette)))
			.into_any_element()
	}
}
