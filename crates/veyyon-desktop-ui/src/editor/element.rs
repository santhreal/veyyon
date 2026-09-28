//! The element that shapes, sizes, scrolls and paints the editor text.

use std::{ops::Range, rc::Rc};

use veyyon_gpui::{
	App, AvailableSpace, Bounds, ContentMask, DispatchPhase, Element, ElementId,
	ElementInputHandler, Entity, GlobalElementId, Hsla, InspectorElementId, IntoElement, LayoutId,
	MouseMoveEvent, MouseUpEvent, Pixels, Point, SharedString, Size, Style, TextAlign, TextRun,
	TextStyle, UnderlineStyle, Window, fill, point, relative, size,
};

use super::{Editor, layout::TextLayout, mask::Mask};
use crate::theme::{ActiveTheme, size as measure};

/// The text canvas of an [`Editor`].
pub struct EditorElement {
	pub editor: Entity<Editor>,
}

/// The text and runs a frame shapes: the buffer, its mask, or the
/// placeholder.
pub struct Shaping {
	text:        SharedString,
	runs:        Vec<TextRun>,
	placeholder: bool,
	/// Set when `text` is the mask of a masked buffer.
	mask:        Option<Mask>,
	font_size:   Pixels,
	line_height: Pixels,
}

impl Editor {
	/// The text to shape and its runs: the buffer, or its mask while masked,
	/// with the composition underlined; or the placeholder in `text.faint`
	/// when the buffer is empty.
	fn shaping(&self, style: &TextStyle, window: &Window, cx: &App) -> Shaping {
		let run = |len: usize, color: Hsla, underline: Option<UnderlineStyle>| TextRun {
			len,
			font: style.font(),
			color,
			background_color: None,
			underline,
			strikethrough: None,
			tracking: style.tracking,
		};
		let font_size = style.font_size.to_pixels(window.rem_size());
		let line_height = window.line_height();
		if self.buffer.is_empty() {
			let faint = cx.theme().palette.text.faint;
			return Shaping {
				text: self.placeholder.clone(),
				runs: vec![run(self.placeholder.len(), faint, None)],
				placeholder: true,
				mask: None,
				font_size,
				line_height,
			};
		}
		let mask = self.masked.then(|| Mask::new(self.buffer.text()));
		let (text, marked) = if let Some(mask) = &mask {
			let marked = self
				.marked
				.clone()
				.map(|marked| mask.to_display(marked.start)..mask.to_display(marked.end));
			(mask.display().clone(), marked)
		} else {
			(SharedString::from(self.buffer.text().to_owned()), self.marked.clone())
		};
		let runs = match marked {
			Some(marked) if marked.start < marked.end && marked.end <= text.len() => {
				let underline = UnderlineStyle {
					thickness: measure::HAIRLINE,
					color:     Some(style.color),
					wavy:      false,
				};
				vec![
					run(marked.start, style.color, None),
					run(marked.len(), style.color, Some(underline)),
					run(text.len() - marked.end, style.color, None),
				]
			},
			_ => vec![run(text.len(), style.color, None)],
		};
		Shaping { text, runs, placeholder: false, mask, font_size, line_height }
	}

	/// Keeps the frame's layout for hit testing and motion, clamps the scroll
	/// offset to the content, and scrolls the caret into view when asked.
	fn adopt_layout(&mut self, layout: Rc<TextLayout>, bounds: Bounds<Pixels>) {
		let viewport = bounds.size;
		let max = if self.wraps() {
			point(Pixels::ZERO, (layout.height() - viewport.height).max(Pixels::ZERO))
		} else {
			point((layout.width + measure::CARET - viewport.width).max(Pixels::ZERO), Pixels::ZERO)
		};
		let mut scroll = self.scroll;
		if std::mem::take(&mut self.autoscroll) {
			let caret = if layout.placeholder {
				Point::default()
			} else {
				layout.position(self.buffer.cursor())
			};
			let far = caret + point(measure::CARET, layout.line_height);
			scroll.x = scroll.x.min(caret.x).max(far.x - viewport.width);
			scroll.y = scroll.y.min(caret.y).max(far.y - viewport.height);
		}
		self.scroll =
			point(scroll.x.min(max.x).max(Pixels::ZERO), scroll.y.min(max.y).max(Pixels::ZERO));
		self.layout = Some(layout);
		self.bounds = Some(bounds);
	}
}

impl IntoElement for EditorElement {
	type Element = Self;

	fn into_element(self) -> Self::Element {
		self
	}
}

impl Element for EditorElement {
	type PrepaintState = Option<Rc<TextLayout>>;
	type RequestLayoutState = Shaping;

	fn id(&self) -> Option<ElementId> {
		None
	}

	fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
		None
	}

	/// Sizes the element to its rows, clamped to the editor's row limits.
	fn request_layout(
		&mut self,
		_id: Option<&GlobalElementId>,
		_inspector_id: Option<&InspectorElementId>,
		window: &mut Window,
		cx: &mut App,
	) -> (LayoutId, Self::RequestLayoutState) {
		let editor = self.editor.read(cx);
		let shaping = editor.shaping(&window.text_style(), window, cx);
		let (min_rows, max_rows) = editor.row_limits();
		let wraps = editor.wraps();
		let (text, runs) = (shaping.text.clone(), shaping.runs.clone());
		let (font_size, line_height) = (shaping.font_size, shaping.line_height);
		let mut style = Style::default();
		style.size.width = relative(1.).into();
		let layout_id = window.request_measured_layout(style, move |known, available, window, _| {
			let definite = match available.width {
				AvailableSpace::Definite(width) => Some(width),
				AvailableSpace::MinContent | AvailableSpace::MaxContent => None,
			};
			let wrap_width = if wraps {
				known.width.or(definite)
			} else {
				None
			};
			let lines = window
				.text_system()
				.shape_text(text.clone(), font_size, &runs, wrap_width, None)
				.unwrap_or_default();
			let rows: usize = lines
				.iter()
				.map(|line| line.wrap_boundaries().len() + 1)
				.sum();
			let rows = rows.max(min_rows).min(max_rows.unwrap_or(usize::MAX));
			let widest = lines
				.iter()
				.fold(Pixels::ZERO, |width, line| width.max(line.unwrapped_layout.width));
			Size::new(
				known.width.or(definite).unwrap_or(widest + measure::CARET),
				known.height.unwrap_or(line_height * rows as f32),
			)
		});
		(layout_id, shaping)
	}

	fn prepaint(
		&mut self,
		_id: Option<&GlobalElementId>,
		_inspector_id: Option<&InspectorElementId>,
		bounds: Bounds<Pixels>,
		shaping: &mut Self::RequestLayoutState,
		window: &mut Window,
		cx: &mut App,
	) -> Self::PrepaintState {
		let editor = self.editor.read(cx);
		let wrap_width = editor.wraps().then_some(bounds.size.width);
		let revision = editor.buffer.revision();
		let lines = window
			.text_system()
			.shape_text(shaping.text.clone(), shaping.font_size, &shaping.runs, wrap_width, None)
			.unwrap_or_default();
		let layout = Rc::new(TextLayout::new(
			lines.into_vec(),
			shaping.line_height,
			revision,
			shaping.placeholder,
			shaping.mask.clone(),
		));
		self
			.editor
			.update(cx, |editor, _| editor.adopt_layout(layout.clone(), bounds));
		Some(layout)
	}

	fn paint(
		&mut self,
		_id: Option<&GlobalElementId>,
		_inspector_id: Option<&InspectorElementId>,
		bounds: Bounds<Pixels>,
		_shaping: &mut Self::RequestLayoutState,
		prepaint: &mut Self::PrepaintState,
		window: &mut Window,
		cx: &mut App,
	) {
		let Some(layout) = prepaint.take() else {
			return;
		};
		let editor = self.editor.read(cx);
		let focus_handle = editor.focus_handle.clone();
		let focused = focus_handle.is_focused(window);
		let caret_visible = focused && editor.caret_visible;
		let selection = editor.buffer.selection();
		let origin = bounds.origin - editor.scroll;
		let accent = cx.theme().palette.accent;

		window.handle_input(&focus_handle, ElementInputHandler::new(bounds, self.editor.clone()), cx);
		self.track_drag(window);
		window.with_content_mask(Some(ContentMask::from_bounds(bounds)), |window| {
			if focused && !selection.is_empty() && !layout.placeholder {
				paint_selection(&layout, selection.range(), origin, accent.focus_ring, window);
			}
			for (index, line) in layout.lines.iter().enumerate() {
				let line_origin = point(origin.x, origin.y + layout.line_top(index));
				let _ = line.paint(
					line_origin,
					layout.line_height,
					TextAlign::Left,
					Some(bounds),
					window,
					cx,
				);
			}
			if caret_visible {
				let caret = if layout.placeholder {
					Point::default()
				} else {
					layout.position(selection.head)
				};
				let caret = Bounds::new(origin + caret, size(measure::CARET, layout.line_height));
				window.paint_quad(fill(caret, accent.base));
			}
		});
	}
}

impl EditorElement {
	/// Follows a selection drag and its release anywhere in the window, so a
	/// drag that leaves the editor keeps extending the selection.
	fn track_drag(&self, window: &mut Window) {
		let editor = self.editor.clone();
		window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
			if phase == DispatchPhase::Bubble && event.dragging() && editor.read(cx).selecting {
				editor.update(cx, |editor, cx| editor.drag_to(event.position, cx));
			}
		});
		let editor = self.editor.clone();
		window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
			if phase == DispatchPhase::Bubble && editor.read(cx).selecting {
				editor.update(cx, |editor, _| editor.selecting = false);
			}
		});
	}
}

/// Tints the selected part of every row `range` touches. A row the selection
/// runs past gets one caret width more, marking the line break as selected.
fn paint_selection(
	layout: &TextLayout,
	range: Range<usize>,
	origin: Point<Pixels>,
	color: Hsla,
	window: &mut Window,
) {
	let first = layout.row_for_offset(range.start);
	let last = layout.row_for_offset(range.end);
	for (index, row) in layout.rows.iter().enumerate().take(last + 1).skip(first) {
		let left = layout.x_in_row(index, range.start.max(row.start));
		let mut right = layout.x_in_row(index, range.end.min(row.end));
		if range.end > row.end {
			right += measure::CARET;
		}
		if right > left {
			let top = origin.y + layout.line_height * index as f32;
			let tint =
				Bounds::new(point(origin.x + left, top), size(right - left, layout.line_height));
			window.paint_quad(fill(tint, color));
		}
	}
}
