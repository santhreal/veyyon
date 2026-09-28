//! The read-only viewer of one file: a header with the path and the line
//! count, then the numbered lines in view.

use std::ops::Range;

use veyyon_desktop_model::HostAction;
use veyyon_desktop_ui::{
	controls::IconButton,
	icons::IconName,
	markdown::highlight,
	theme::{ActiveTheme, Palette, TypeStyled, space, text},
};
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, IntoElement, ParentElement, ScrollStrategy, ScrollWheelEvent,
	SharedString, Styled, Window, div, prelude::*, uniform_list,
};

use super::FilesView;
use crate::panel::style::{code_line, counted, heading, language_tag, toolbar};

impl FilesView {
	/// Splits the viewed file into lines and highlights it when the host
	/// answered since the last split, then scrolls to the line asked for. A
	/// new answer for another path, a file the palette or the diff opened,
	/// becomes the viewed file.
	pub(super) fn load_content(&mut self, cx: &mut Context<Self>) {
		let (answers, content) = {
			let answered = &self.app.read(cx).store().domains.file_content;
			let answers = answered.answers();
			if answers != self.answers
				&& let Some(content) = answered.get()
				&& self
					.open
					.as_ref()
					.is_none_or(|(path, _)| *path != content.path)
			{
				self.open = Some((content.path.clone(), None));
			}
			let content = answered.get().filter(|content| {
				!content.binary
					&& self
						.open
						.as_ref()
						.is_some_and(|(path, _)| *path == content.path)
			});
			(answers, content.map(|content| content.content.clone()))
		};
		if answers != self.answers || self.lines.is_empty() {
			self.answers = answers;
			self.highlighted = None;
			self.lines.clear();
			self.sideways.reset();
			if let Some(content) = content {
				self.split(content, cx);
			}
		}
		if let Some(line) = self.open.as_ref().and_then(|(_, line)| *line)
			&& !self.lines.is_empty()
		{
			let ix = (line.saturating_sub(1) as usize).min(self.lines.len() - 1);
			self.viewer.scroll_to_item(ix, ScrollStrategy::Center);
		}
		cx.notify();
	}

	/// Records the line ranges of `content`, and highlights it on the
	/// background executor.
	fn split(&mut self, content: String, cx: &Context<Self>) {
		let mut start = 0;
		for line in content.split_inclusive('\n') {
			self
				.lines
				.push(start..start + line.trim_end_matches(['\n', '\r']).len());
			start += line.len();
		}
		let lang = self
			.open
			.as_ref()
			.map(|(path, _)| language_tag(path).to_owned())
			.unwrap_or_default();
		let answers = self.answers;
		let task = cx.background_spawn(async move { highlight(&content, Some(&lang)) });
		cx.spawn(async move |this, cx| {
			let highlighted = task.await;
			this
				.update(cx, |this, cx| {
					if this.answers == answers {
						this.highlighted = Some(highlighted);
						cx.notify();
					}
				})
				.ok();
		})
		.detach();
	}

	/// The viewed file's header, then its lines in view: the numbers pinned
	/// at the left and the code scrolled sideways past them.
	pub(super) fn render_viewer(
		&mut self,
		path: &str,
		palette: &Palette,
		window: &Window,
		cx: &Context<Self>,
	) -> AnyElement {
		let content = self
			.app
			.read(cx)
			.store()
			.domains
			.file_content
			.get()
			.filter(|content| content.path == path);
		if let Some(content) = content.filter(|content| !content.binary) {
			let lines = self
				.lines
				.iter()
				.filter_map(|line| content.content.get(line.clone()));
			self.sideways.measure(lines, window);
		}
		let notice = match content {
			None => Some("Loading\u{2026}"),
			Some(content) if content.binary => Some("Binary file"),
			Some(content) if content.truncated => Some("The file stops at the host's size limit"),
			Some(_) => None,
		};
		let external = path.to_owned();
		let header = toolbar(palette)
			.child(
				IconButton::new("files-close", IconName::X)
					.tooltip("Close the file")
					.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.close(cx))),
			)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.truncate()
					.type_style(text::UI)
					.child(path.to_owned()),
			)
			.child(
				div()
					.flex_none()
					.type_style(text::SMALL)
					.text_color(palette.text.muted)
					.child(counted(self.lines.len() as u64, "line", "lines")),
			)
			.child(
				IconButton::new("files-external", IconName::ExternalLink)
					.tooltip("Open in the default application")
					.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
						this.send(HostAction::OpenExternal { path: external.clone() }, cx);
					})),
			);
		let mut body = uniform_list(
			"files-viewer",
			self.lines.len(),
			cx.processor(|this, range: Range<usize>, _, cx| {
				let palette = cx.theme().palette;
				let Some(source) = this.app.read(cx).store().domains.file_content.get() else {
					return Vec::new();
				};
				range
					.filter_map(|ix| Some((ix, this.lines.get(ix)?.clone())))
					.map(|(ix, line)| {
						let code = SharedString::from(
							source
								.content
								.get(line.clone())
								.unwrap_or_default()
								.to_owned(),
						);
						let code = code_line(code, this.highlighted.as_ref(), line.start, &palette);
						// A row laid out as a flex row shrinks to its content
						// unless it is given the list's width, and its code
						// column then has no width to draw in.
						div()
							.flex()
							.w_full()
							.type_style(text::MONO)
							.child(
								div()
									.w(space::S10)
									.flex_none()
									.pr(space::S2)
									.flex()
									.justify_end()
									.text_color(palette.text.faint)
									.child((ix + 1).to_string()),
							)
							.child(this.sideways.column(code).text_color(palette.text.primary))
					})
					.collect()
			}),
		)
		.track_scroll(&self.viewer)
		.on_scroll_wheel(cx.listener(|this, event: &ScrollWheelEvent, _, cx| {
			if this.sideways.wheel(event) {
				cx.notify();
			}
		}))
		.flex_1();
		// The list scrolls down only, and would take a sideways gesture as a
		// scroll down unless held to the gesture's axis.
		body.style().restrict_scroll_to_axis = Some(true);
		div()
			.flex()
			.flex_col()
			.flex_1()
			.min_h_0()
			.child(header)
			.children(notice.map(|copy| heading(copy, palette)))
			.child(body)
			.into_any_element()
	}
}
