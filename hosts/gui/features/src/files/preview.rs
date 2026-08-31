//! Selected-file readers. Contents enter only through `FileReadView`.

use std::{ops::Range, sync::Arc};

use gpui::{
	AnyElement, App, Div, Image, ImageFormat, InteractiveElement, IntoElement, ObjectFit,
	ParentElement, ScrollHandle, StatefulInteractiveElement, Styled, StyledImage,
	UniformListScrollHandle, div, img, px, uniform_list,
};
use veyyon_gui_core::{
	UiCommand,
	model::{FileBody, FileReadView, LineRange},
	text::markdown::{self, Md},
};
use veyyon_gui_kit::{
	theme::{Elevation, Theme, diff, layout, size, space},
	ui::{EdgeFade, Empty, Icon, Scrolls, card, scrolls_uniform, text},
};

use super::logic;
use crate::{act, render};

/// Parsed and decoded presentation data retained across frames.
#[derive(Clone)]
pub enum CachedBody {
	Text {
		owner:    Arc<str>,
		source:   Arc<str>,
		lines:    Arc<Vec<Range<usize>>>,
		language: Option<Arc<str>>,
	},
	Markdown {
		source: Arc<str>,
		blocks: Arc<Vec<Md>>,
	},
	Image(Arc<Image>),
	Binary {
		size_bytes: Option<u64>,
	},
	TooLarge {
		size_bytes:  Option<u64>,
		limit_bytes: Option<u64>,
	},
	Unavailable(Arc<str>),
}

impl CachedBody {
	pub fn from_read(read: &FileReadView) -> Self {
		match &read.body {
			FileBody::Text { text: source, language } => {
				let language = logic::language(&read.path, language.as_deref()).map(Arc::<str>::from);
				let source: Arc<str> = Arc::from(source.as_str());
				let lines = Arc::new(line_ranges(&source));
				Self::Text { owner: Arc::from(read.path.as_str()), source, lines, language }
			},
			FileBody::Markdown { source } => Self::Markdown {
				source: Arc::from(source.as_str()),
				blocks: Arc::new(markdown::parse(source)),
			},
			FileBody::Image { media_type, bytes } => ImageFormat::from_mime_type(media_type)
				.map(|format| Self::Image(Arc::new(Image::from_bytes(format, bytes.clone()))))
				.unwrap_or_else(|| {
					Self::Unavailable(Arc::from(format!("Unsupported image type: {media_type}")))
				}),
			FileBody::Binary { size_bytes } => Self::Binary { size_bytes: *size_bytes },
			FileBody::TooLarge { size_bytes, limit_bytes } => {
				Self::TooLarge { size_bytes: *size_bytes, limit_bytes: *limit_bytes }
			},
			FileBody::Unavailable { reason } => Self::Unavailable(Arc::from(reason.as_str())),
		}
	}
}

fn line_ranges(source: &str) -> Vec<Range<usize>> {
	if source.is_empty() {
		return Vec::new();
	}
	let mut ranges = Vec::with_capacity(source.lines().count());
	let mut start = 0;
	for line in source.split_inclusive('\n') {
		let end = start + line.trim_end_matches(['\r', '\n']).len();
		ranges.push(start..end);
		start += line.len();
	}
	if start < source.len() {
		ranges.push(start..source.len());
	}
	ranges
}

pub fn render(
	cache: &CachedBody,
	path: &str,
	selected: Option<LineRange>,
	scroll: &UniformListScrollHandle,
	markdown_scroll: &ScrollHandle,
	cx: &mut App,
) -> AnyElement {
	match cache {
		CachedBody::Text { owner, source, lines, language } => text_reader(
			owner.clone(),
			source.clone(),
			lines.clone(),
			language.clone(),
			selected,
			scroll,
		)
		.into_any_element(),
		CachedBody::Markdown { source, blocks } => {
			markdown_reader(path, source, blocks, markdown_scroll, cx).into_any_element()
		},
		CachedBody::Image(image) => image_reader(image.clone(), cx).into_any_element(),
		CachedBody::Binary { size_bytes } => binary_reader(*size_bytes).into_any_element(),
		CachedBody::TooLarge { size_bytes, limit_bytes } => {
			too_large_reader(*size_bytes, *limit_bytes).into_any_element()
		},
		CachedBody::Unavailable(reason) => Empty::new("Preview unavailable")
			.icon(Icon::Failed)
			.note(reason.to_string())
			.filling()
			.into_any_element(),
	}
}

fn text_reader(
	owner: Arc<str>,
	source: Arc<str>,
	lines: Arc<Vec<Range<usize>>>,
	language: Option<Arc<str>>,
	selected: Option<LineRange>,
	scroll: &UniformListScrollHandle,
) -> Div {
	if lines.is_empty() {
		return div().size_full().child(
			Empty::new("This file is empty")
				.icon(Icon::Read)
				.note("No bytes were returned by the host.")
				.filling(),
		);
	}

	let count = lines.len();
	let rows = uniform_list("file-preview-lines", count, move |visible, _window, cx| {
		let theme = Theme::get(cx);
		visible
			.map(|index| {
				line(
					&owner,
					index,
					&source[lines[index].clone()],
					language.as_deref(),
					selected,
					&theme,
				)
			})
			.collect::<Vec<_>>()
	})
	.size_full();

	// The list windows its own rows, so it is tracked through gpui's uniform
	// handle; the fade reads the same offset, and a file opened at a line in
	// the middle reads as content continuing above and below rather than as two
	// half-drawn rows.
	div()
		.size_full()
		.min_h(px(0.0))
		.overflow_hidden()
		.child(scrolls_uniform(rows, scroll, Elevation::Canvas))
}

fn line(
	owner: &str,
	index: usize,
	body: &str,
	language: Option<&str>,
	selected: Option<LineRange>,
	theme: &Theme,
) -> gpui::Stateful<gpui::Div> {
	let number = u32::try_from(index + 1).unwrap_or(u32::MAX);
	let selected = selected.is_some_and(|range| number >= range.start && number <= range.end);
	div()
		.id(format!("file-line-{owner}-{number}"))
		.cursor_pointer()
		.on_click(act::click(UiCommand::SetFileRange(Some(LineRange {
			start: number,
			end:   number,
		}))))
		.flex()
		.items_center()
		.h(px(diff::line_height()))
		.w_full()
		.bg(if selected {
			theme.selected()
		} else {
			gpui::transparent_black()
		})
		.child(
			div()
				.flex_none()
				.w(px(diff::line_number_gutter()))
				.pr(px(space::BASE))
				.text_right()
				.text_size(px(size::mono()))
				.text_color(theme.text_faint)
				.child(number.to_string()),
		)
		.child(
			render::code::lexed(language.unwrap_or_default(), body, theme)
				.flex_1()
				.min_w(px(0.0)),
		)
}

fn markdown_reader(
	path: &str,
	source: &str,
	blocks: &[Md],
	scroll: &ScrollHandle,
	cx: &mut App,
) -> EdgeFade {
	if source.is_empty() {
		return div()
			.id("files-markdown-empty")
			.size_full()
			.child(
				Empty::new("This Markdown file is empty")
					.icon(Icon::Read)
					.note("No bytes were returned by the host.")
					.filling(),
			)
			.scrolls_y(scroll, Elevation::Canvas);
	}
	div()
		.size_full()
		.id("files-preview-scroll-2")
		.child(
			text::stack(space::WIDE)
				.w_full()
				.max_w(px(layout::reading()))
				.mx_auto()
				.px(px(space::HUGE))
				.py(px(space::LOOSE))
				.children(render::markdown::blocks(blocks, &format!("file-{path}"), cx)),
		)
		.scrolls_y(scroll, Elevation::Canvas)
}

fn image_reader(image: Arc<Image>, cx: &mut App) -> gpui::Div {
	let theme = Theme::get(cx);
	div()
		.size_full()
		.overflow_hidden()
		.p(px(space::WIDE))
		.child(
			card::well(&theme)
				.size_full()
				.overflow_hidden()
				.child(img(image).size_full().object_fit(ObjectFit::Contain)),
		)
}

fn binary_reader(size_bytes: Option<u64>) -> Empty {
	let note = size_bytes
		.map(logic::byte_count)
		.map(|size| format!("{size}. Binary contents are not shown."))
		.unwrap_or_else(|| "Binary contents are not shown.".to_owned());
	Empty::new("Binary file")
		.icon(Icon::Read)
		.note(note)
		.filling()
}

fn too_large_reader(size_bytes: Option<u64>, limit_bytes: Option<u64>) -> Empty {
	let detail = match (size_bytes, limit_bytes) {
		(Some(size), Some(limit)) => format!(
			"{} exceeds the {} preview limit.",
			logic::byte_count(size),
			logic::byte_count(limit)
		),
		(Some(size), None) => format!("{} exceeds the host preview limit.", logic::byte_count(size)),
		(None, Some(limit)) => {
			format!("The file exceeds the {} preview limit.", logic::byte_count(limit))
		},
		(None, None) => "The file exceeds the host preview limit.".to_owned(),
	};
	Empty::new("File is too large to preview")
		.icon(Icon::Notice)
		.note(detail)
		.filling()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn ranges_preserve_empty_lines_and_utf8_boundaries() {
		let source = "α\n\nend";
		let actual: Vec<_> = line_ranges(source)
			.into_iter()
			.map(|range| &source[range])
			.collect();
		assert_eq!(actual, ["α", "", "end"]);
	}
}
