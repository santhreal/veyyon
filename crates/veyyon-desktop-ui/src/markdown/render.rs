//! Draws a [`MarkdownDoc`] as gpui elements with the active theme.
//!
//! Prose is one `StyledText` per paragraph, with a run per style; a paragraph
//! holding a link is an `InteractiveText` that opens the link's URL on click.
//! A code block is highlighted through [`highlight`], or drawn plain until
//! [`cached`] holds its result when highlighting is deferred, and scrolls
//! sideways instead of wrapping.

use std::{rc::Rc, sync::Arc};

use veyyon_gpui::{
	AbsoluteLength, AnyElement, App, Div, ElementId, Font, FontStyle, FontWeight, HighlightStyle,
	Hsla, InteractiveElement, InteractiveText, IntoElement, ParentElement, Pixels, SharedString,
	StatefulInteractiveElement, StrikethroughStyle, Styled, StyledText, TextRun, UnderlineStyle,
	Window, div, font,
};

use super::{
	MarkdownDoc,
	highlight::{Highlighted, cached, highlight},
	model::{Align, Block, Inlines},
};
use crate::{
	fonts::MONO_FAMILY,
	theme::{ActiveTheme, Palette, TypeStyle, TypeStyled, radius, size, space, text},
};

/// Builds the button in a code block's header that copies the block's code.
/// It receives the code and returns the element to place in the header.
pub type CopyButton = Rc<dyn Fn(Arc<str>, &mut Window, &mut App) -> AnyElement>;

/// Handles a click on a link. It receives the link's URL.
pub type LinkHandler = Rc<dyn Fn(Arc<str>, &mut Window, &mut App)>;

/// Bullet glyphs by list depth, repeating past the last.
const BULLETS: [&str; 3] = ["•", "◦", "▪"];

/// How [`render`] draws a document.
#[derive(Clone)]
pub struct MarkdownStyle {
	/// The id of the root element. It namespaces the ids of the links and
	/// scroll regions inside, so it is unique among its siblings.
	pub id:          ElementId,
	/// The type ramp step of prose; headings and code use their own steps.
	pub prose:       TypeStyle,
	/// The copy button of each code block, or none.
	pub copy_button: Option<CopyButton>,
	/// Whether a code block draws only a cached highlight result and draws
	/// plain text on a miss, leaving [`highlight`] to the caller, for example
	/// on a background executor followed by a notify.
	pub deferred_highlight: bool,
	/// What a click on a link runs, or none to open the URL with
	/// `App::open_url`.
	pub on_link: Option<LinkHandler>,
}

impl MarkdownStyle {
	/// Prose in [`text::BODY`], code blocks without a copy button and links
	/// opened with `App::open_url`.
	pub fn new(id: impl Into<ElementId>) -> Self {
		Self {
			id: id.into(),
			prose: text::BODY,
			copy_button: None,
			deferred_highlight: false,
			on_link: None,
		}
	}

	/// Places the element `build` returns in the header of each code block.
	pub fn copy_button(
		mut self,
		build: impl Fn(Arc<str>, &mut Window, &mut App) -> AnyElement + 'static,
	) -> Self {
		self.copy_button = Some(Rc::new(build));
		self
	}

	/// Draws code blocks from [`cached`] results only, and plain on a miss.
	pub const fn deferred_highlight(mut self) -> Self {
		self.deferred_highlight = true;
		self
	}

	/// Runs `handle` with a link's URL when the link is clicked, instead of
	/// opening the URL.
	pub fn on_link(mut self, handle: impl Fn(Arc<str>, &mut Window, &mut App) + 'static) -> Self {
		self.on_link = Some(Rc::new(handle));
		self
	}
}

/// Draws `doc`: blocks in a column `space::S3` apart, prose in `style.prose`
/// and `text.primary`.
pub fn render(
	doc: &MarkdownDoc,
	style: &MarkdownStyle,
	window: &mut Window,
	cx: &mut App,
) -> impl IntoElement {
	let palette = cx.theme().palette;
	let mut painter = Painter { palette, style, color: palette.text.primary, ids: 0 };
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
		blocks.iter().map(|block| self.block(block, depth, window, cx)).collect()
	}

	fn block(&mut self, block: &Block, depth: usize, window: &mut Window, cx: &mut App) -> AnyElement {
		match block {
			Block::Paragraph(inlines) => self.inlines(inlines, self.style.prose, false),
			Block::Heading { level, runs } => {
				let step = match level {
					1 => text::H1,
					2 => text::H2,
					_ => text::H3,
				};
				div().type_style(step).child(self.inlines(runs, step, false)).into_any_element()
			}
			Block::CodeBlock { lang, code } => self.code_block(lang.as_ref(), code, window, cx),
			Block::List { ordered, start, items } => {
				self.list(*ordered, *start, items, depth, window, cx)
			}
			Block::TaskItem { checked } => self.checkbox(*checked),
			Block::Quote(blocks) => self.quote(blocks, depth, window, cx),
			Block::Table { align, head, rows } => self.table(align, head, rows),
			Block::Rule => div().h(size::HAIRLINE).bg(self.palette.border.subtle).into_any_element(),
		}
	}

	/// One `StyledText` with a run per style. `strong` sets every run
	/// semibold, as a table header does.
	fn inlines(&mut self, inlines: &Inlines, step: TypeStyle, strong: bool) -> AnyElement {
		if inlines.is_empty() {
			return div().into_any_element();
		}
		let (palette, color) = (self.palette, self.color);
		let mut links = Vec::new();
		let mut urls: Vec<Arc<str>> = Vec::new();
		let runs = inlines
			.runs
			.iter()
			.map(|run| {
				let style = &run.style;
				if let Some(url) = &style.link {
					links.push(run.range.clone());
					urls.push(url.clone());
				}
				let family = if style.code { MONO_FAMILY } else { step.family };
				TextRun {
					len: run.range.len(),
					font: Font {
						weight: if style.bold || strong { FontWeight::SEMIBOLD } else { step.weight },
						style: if style.italic { FontStyle::Italic } else { FontStyle::Normal },
						..font(SharedString::new_static(family))
					},
					color: if style.link.is_some() { palette.accent.base } else { color },
					background_color: style.code.then_some(palette.code.bg),
					underline: style.link.as_ref().map(|_| UnderlineStyle {
						thickness: size::HAIRLINE,
						color:     Some(palette.accent.base),
						wavy:      false,
					}),
					strikethrough: style
						.strike
						.then_some(StrikethroughStyle { thickness: size::HAIRLINE, color: None }),
					..TextRun::default()
				}
			})
			.collect();
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
		let tag = lang.map(|lang| lang.as_ref());
		let highlighted =
			if self.style.deferred_highlight { cached(code, tag) } else { Some(highlight(code, tag)) };
		let spans = highlighted.as_deref().map_or(&[][..], Highlighted::spans);
		let styles = spans.iter().map(|(range, role)| {
			(range.clone(), HighlightStyle {
				color: Some(role.color(&palette.syntax)),
				..HighlightStyle::default()
			})
		});
		let body = StyledText::new(SharedString::from(code.clone())).with_highlights(styles);
		let label = lang.map_or_else(|| SharedString::new_static("text"), SharedString::from);
		let button = self.style.copy_button.as_ref().map(|build| build(code.clone(), window, cx));
		let header = div()
			.flex()
			.items_center()
			.justify_between()
			.type_style(text::SMALL)
			.text_color(palette.text.muted)
			.child(label)
			.children(button);
		let scroller = div().id(self.id("md-code")).flex().overflow_x_scroll().child(
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
			let body = div().flex_1().min_w_0().flex().flex_col().gap(space::S1_5).children(body);
			rows.push(div().flex().gap(space::S2).child(marker).child(body).into_any_element());
		}
		div().flex().flex_col().gap(space::S1).children(rows).into_any_element()
	}

	fn marker(&self, ordered: bool, number: u64, depth: usize) -> AnyElement {
		let label = if ordered {
			SharedString::from(format!("{number}."))
		} else {
			SharedString::new_static(BULLETS[depth % BULLETS.len()])
		};
		div().flex_none().min_w(space::S5).text_color(self.palette.text.muted).child(label).into_any_element()
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
			tick.bg(palette.accent.base).border_color(palette.accent.base).text_color(palette.accent.fg).child("✓")
		} else {
			tick
		};
		div().flex_none().min_w(space::S5).child(tick).into_any_element()
	}

	fn quote(&mut self, blocks: &[Block], depth: usize, window: &mut Window, cx: &mut App) -> AnyElement {
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
			let cell = div().flex().flex_1().min_w_0().px(space::S3).py(space::S1_5);
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
