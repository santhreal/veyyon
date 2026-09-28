//! Draws a [`MarkdownDoc`] as gpui elements with the active theme.
//!
//! Prose is one `StyledText` per paragraph, with a run per style; a paragraph
//! holding a link is an `InteractiveText` that opens the link's URL on click.
//! A code block is highlighted through [`highlight`], or drawn plain until
//! [`cached`] holds its result when highlighting is deferred, and scrolls
//! sideways instead of wrapping.

use std::sync::Arc;

use veyyon_gpui::{
	AbsoluteLength, AnyElement, App, Div, ElementId, HighlightStyle, Hsla, InteractiveElement,
	InteractiveText, IntoElement, ParentElement, Pixels, SharedString, StatefulInteractiveElement,
	Styled, StyledText, TextRun, Window, combine_highlights, div,
};

use super::{
	MarkdownDoc, MarkdownStyle,
	fade::{FadeStop, fade_highlights, fade_runs, fades},
	highlight::{Highlighted, cached, highlight},
	model::{Align, Block, Inlines},
	style::text_run,
};
use crate::theme::{ActiveTheme, Palette, TypeStyle, TypeStyled, radius, size, space, text};

/// Bullet glyphs by list depth, repeating past the last.
const BULLETS: [&str; 3] = ["•", "◦", "▪"];

/// Draws `doc`: blocks in a column `space::S3` apart, prose in `style.prose`
/// and `text.primary`.
pub fn render(
	doc: &MarkdownDoc,
	style: &MarkdownStyle,
	window: &mut Window,
	cx: &mut App,
) -> impl IntoElement {
	render_fading(doc, style, &[], window, cx)
}

/// Draws `doc` as [`render`] does, the drawn text from each stop of `fade`
/// at the stop's opacity.
pub fn render_fading(
	doc: &MarkdownDoc,
	style: &MarkdownStyle,
	fade: &[FadeStop],
	window: &mut Window,
	cx: &mut App,
) -> impl IntoElement {
	let palette = cx.theme().palette;
	let mut painter =
		Painter { palette, style, color: palette.text.primary, ids: 0, fade, drawn: 0 };
	let blocks = painter.blocks(doc.blocks(), 0, window, cx);
	div()
		.id(style.id.clone())
		.flex()
		.flex_col()
		.gap(space::S3)
		.type_style(style.prose)
		.text_color(palette.text.primary)
		.children(blocks)
}

struct Painter<'a> {
	palette: Palette,
	style:   &'a MarkdownStyle,
	/// The color of prose at the current depth; quotes draw it muted.
	color:   Hsla,
	ids:     usize,
	/// The opacity of the drawn text from each stop on.
	fade:    &'a [FadeStop],
	/// How much of the drawn text the blocks drawn so far hold.
	drawn:   usize,
}

impl Painter<'_> {
	fn id(&mut self, name: &'static str) -> ElementId {
		self.ids += 1;
		ElementId::from((name, self.ids))
	}

	fn blocks(
		&mut self,
		blocks: &[Block],
		depth: usize,
		window: &mut Window,
		cx: &mut App,
	) -> Vec<AnyElement> {
		blocks
			.iter()
			.map(|block| self.block(block, depth, window, cx))
			.collect()
	}

	fn block(
		&mut self,
		block: &Block,
		depth: usize,
		window: &mut Window,
		cx: &mut App,
	) -> AnyElement {
		match block {
			Block::Paragraph(inlines) => self.inlines(inlines, self.style.prose, false),
			Block::Heading { level, runs } => {
				let step = match level {
					1 => text::H1,
					2 => text::H2,
					_ => text::H3,
				};
				div()
					.type_style(step)
					.child(self.inlines(runs, step, false))
					.into_any_element()
			},
			Block::CodeBlock { lang, code } => self.code_block(lang.as_ref(), code, window, cx),
			Block::List { ordered, start, items } => {
				self.list(*ordered, *start, items, depth, window, cx)
			},
			Block::TaskItem { checked } => self.checkbox(*checked),
			Block::Quote(blocks) => self.quote(blocks, depth, window, cx),
			Block::Table { align, head, rows } => self.table(align, head, rows),
			Block::Rule => div()
				.h(size::HAIRLINE)
				.bg(self.palette.border.subtle)
				.into_any_element(),
		}
	}

	/// One `StyledText` with a run per style. `strong` sets every run
	/// semibold, as a table header does.
	fn inlines(&mut self, inlines: &Inlines, step: TypeStyle, strong: bool) -> AnyElement {
		let base = self.drawn;
		self.drawn += inlines.text.len();
		if inlines.is_empty() {
			return div().into_any_element();
		}
		let (palette, color) = (self.palette, self.color);
		let mut links = Vec::new();
		let mut urls: Vec<Arc<str>> = Vec::new();
		let runs: Vec<TextRun> = inlines
			.runs
			.iter()
			.map(|run| {
				if let Some(url) = &run.style.link {
					links.push(run.range.clone());
					urls.push(url.clone());
				}
				text_run(&run.style, run.range.len(), step, strong, color, &palette)
			})
			.collect();
		let runs = if fades(self.fade, base, inlines.text.len()) {
			fade_runs(runs, &inlines.text, base, self.fade)
		} else {
			runs
		};
		let styled = StyledText::new(SharedString::from(inlines.text.clone())).with_runs(runs);
		if links.is_empty() {
			return styled.into_any_element();
		}
		let on_link = self.style.on_link.clone();
		InteractiveText::new(self.id("md-link"), styled)
			.on_click(links, move |index, window, cx| {
				let Some(url) = urls.get(index) else {
					return;
				};
				match &on_link {
					Some(handle) => handle(url.clone(), window, cx),
					None => cx.open_url(url),
				}
			})
			.into_any_element()
	}

	fn code_block(
		&mut self,
		lang: Option<&Arc<str>>,
		code: &Arc<str>,
		window: &mut Window,
		cx: &mut App,
	) -> AnyElement {
		let palette = self.palette;
		let base = self.drawn;
		self.drawn += code.len();
		let tag = lang.map(|lang| lang.as_ref());
		let highlighted = if self.style.deferred_highlight {
			cached(code, tag)
		} else {
			Some(highlight(code, tag))
		};
		let spans = highlighted.as_deref().map_or(&[][..], Highlighted::spans);
		let styles = spans.iter().map(|(range, role)| {
			(range.clone(), HighlightStyle {
				color: Some(role.color(&palette.syntax)),
				..HighlightStyle::default()
			})
		});
		let body = StyledText::new(SharedString::from(code.clone()));
		let body = if fades(self.fade, base, code.len()) {
			body.with_highlights(combine_highlights(styles, fade_highlights(code, base, self.fade)))
		} else {
			body.with_highlights(styles)
		};
		let label = lang.map_or_else(|| SharedString::new_static("text"), SharedString::from);
		let button = self
			.style
			.copy_button
			.as_ref()
			.map(|build| build(code.clone(), window, cx));
		let header = div()
			.flex()
			.items_center()
			.justify_between()
			.type_style(text::SMALL)
			.text_color(palette.text.muted)
			.child(label)
			.children(button);
		let scroller = div()
			.id(self.id("md-code"))
			.flex()
			.overflow_x_scroll()
			.child(
				div()
					.flex_none()
					.type_style(text::MONO)
					.whitespace_nowrap()
					.text_color(palette.text.primary)
					.child(body),
			);
		div()
			.flex()
			.flex_col()
			.gap(space::S2)
			.p(space::S3)
			.bg(palette.code.bg)
			.rounded(radius::LG)
			.child(header)
			.child(scroller)
			.into_any_element()
	}

	fn list(
		&mut self,
		ordered: bool,
		start: u64,
		items: &[Vec<Block>],
		depth: usize,
		window: &mut Window,
		cx: &mut App,
	) -> AnyElement {
		let mut rows = Vec::with_capacity(items.len());
		for (number, item) in (start..).zip(items) {
			let (marker, body) = match item.split_first() {
				Some((Block::TaskItem { checked }, rest)) => (self.checkbox(*checked), rest),
				_ => (self.marker(ordered, number, depth), item.as_slice()),
			};
			let body = self.blocks(body, depth + 1, window, cx);
			let body = div()
				.flex_1()
				.min_w_0()
				.flex()
				.flex_col()
				.gap(space::S1_5)
				.children(body);
			rows.push(
				div()
					.flex()
					.gap(space::S2)
					.child(marker)
					.child(body)
					.into_any_element(),
			);
		}
		div()
			.flex()
			.flex_col()
			.gap(space::S1)
			.children(rows)
			.into_any_element()
	}

	fn marker(&self, ordered: bool, number: u64, depth: usize) -> AnyElement {
		let label = if ordered {
			SharedString::from(format!("{number}."))
		} else {
			SharedString::new_static(BULLETS[depth % BULLETS.len()])
		};
		div()
			.flex_none()
			.min_w(space::S5)
			.text_color(self.palette.text.muted)
			.child(label)
			.into_any_element()
	}

	fn checkbox(&self, checked: bool) -> AnyElement {
		let palette = self.palette;
		let tick = div()
			.flex()
			.items_center()
			.justify_center()
			.mt(space::S1)
			.size(size::ICON_SM)
			.rounded(radius::SM)
			.border_color(palette.border.strong)
			.type_style(text::MICRO);
		let tick = outline(tick, size::HAIRLINE);
		let tick = if checked {
			tick
				.bg(palette.accent.base)
				.border_color(palette.accent.base)
				.text_color(palette.accent.fg)
				.child("✓")
		} else {
			tick
		};
		div()
			.flex_none()
			.min_w(space::S5)
			.child(tick)
			.into_any_element()
	}

	fn quote(
		&mut self,
		blocks: &[Block],
		depth: usize,
		window: &mut Window,
		cx: &mut App,
	) -> AnyElement {
		let outer = self.color;
		self.color = self.palette.text.secondary;
		let body = self.blocks(blocks, depth, window, cx);
		self.color = outer;
		let mut quote = div()
			.flex()
			.flex_col()
			.gap(space::S3)
			.pl(space::S3)
			.text_color(self.palette.text.secondary)
			.border_color(self.palette.border.strong)
			.children(body);
		quote.style().border_widths.left = Some(AbsoluteLength::from(size::QUOTE_RULE));
		quote.into_any_element()
	}

	fn table(&mut self, align: &[Align], head: &[Inlines], rows: &[Vec<Inlines>]) -> AnyElement {
		let mut lines = Vec::with_capacity(rows.len() + 1);
		lines.push(self.row(align, head, true));
		for row in rows {
			let mut line = self.row(align, row, false);
			line.style().border_widths.top = Some(AbsoluteLength::from(size::HAIRLINE));
			lines.push(line);
		}
		let table = div()
			.flex()
			.flex_col()
			.rounded(radius::MD)
			.border_color(self.palette.border.subtle)
			.children(lines);
		outline(table, size::HAIRLINE).into_any_element()
	}

	fn row(&mut self, align: &[Align], cells: &[Inlines], head: bool) -> Div {
		let prose = self.style.prose;
		let mut line = div().flex().border_color(self.palette.border.subtle);
		for (column, cell) in cells.iter().enumerate() {
			let content = self.inlines(cell, prose, head);
			let cell = div()
				.flex()
				.flex_1()
				.min_w_0()
				.px(space::S3)
				.py(space::S1_5);
			let cell = match align.get(column).copied().unwrap_or_default() {
				Align::Center => cell.justify_center(),
				Align::Right => cell.justify_end(),
				Align::None | Align::Left => cell,
			};
			line = line.child(cell.child(content));
		}
		line
	}
}

/// Sets a border of `width` on every edge of `element`.
fn outline(mut element: Div, width: Pixels) -> Div {
	let width = Some(AbsoluteLength::from(width));
	let edges = &mut element.style().border_widths;
	edges.top = width;
	edges.right = width;
	edges.bottom = width;
	edges.left = width;
	element
}
