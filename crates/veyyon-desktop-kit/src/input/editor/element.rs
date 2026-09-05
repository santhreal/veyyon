//! Custom GPUI element for rendering styled text, selection, caret, and input
//! handling (§8.25).

use std::sync::Arc;

use veyyon_gpui::{
	App, AvailableSpace, Bounds, Element, ElementId, ElementInputHandler, Entity, GlobalElementId,
	InspectorElementId, IntoElement, LayoutId, Pixels, SharedString, Size, TextAlign, TextRun,
	Window, WrappedLine, fill, point, px, relative, size,
};

use super::{Editor, EditorMode, layout::EditorLayoutState};
use crate::token_set::{ColorRole, TokenSet};

/// Renderable element for the editor text canvas.
pub struct EditorElement {
	/// Entity handle to the parent editor view.
	pub editor: Entity<Editor>,
}

impl IntoElement for EditorElement {
	type Element = Self;

	fn into_element(self) -> Self::Element {
		self
	}
}

impl Element for EditorElement {
	type PrepaintState = Option<EditorLayoutState>;
	type RequestLayoutState = ();

	fn id(&self) -> Option<ElementId> {
		None
	}

	fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
		None
	}

	fn request_layout(
		&mut self,
		_id: Option<&GlobalElementId>,
		_inspector_id: Option<&InspectorElementId>,
		window: &mut Window,
		cx: &mut App,
	) -> (LayoutId, Self::RequestLayoutState) {
		let editor = self.editor.read(cx);
		let mode = editor.mode;
		let max_visible_lines = editor.max_visible_lines;
		let line_height = window.line_height();

		match mode {
			EditorMode::SingleLine => {
				let mut style = veyyon_gpui::Style::default();
				style.size.width = relative(1.).into();
				style.size.height = line_height.into();
				(window.request_layout(style, [], cx), ())
			},
			EditorMode::Multiline { .. } => {
				let text = editor.text().to_string();
				let placeholder = editor.placeholder.clone();
				let layout_id = window.request_measured_layout(
					veyyon_gpui::Style::default(),
					move |known_dimensions, available_space, window, _cx| {
						let wrap_width = known_dimensions.width.or(match available_space.width {
							AvailableSpace::Definite(w) => Some(w),
							AvailableSpace::MinContent => None,
							AvailableSpace::MaxContent => None,
						});

						let content_to_measure = if text.is_empty() {
							placeholder.to_string()
						} else {
							text.clone()
						};

						let style = window.text_style();
						let font_size = style.font_size.to_pixels(window.rem_size());
						let line_h = window.line_height();
						let run = TextRun {
							len:              content_to_measure.len(),
							font:             style.font(),
							color:            style.color,
							background_color: None,
							underline:        None,
							strikethrough:    None,
						};

						let shaped = window
							.text_system()
							.shape_text(
								SharedString::from(content_to_measure),
								font_size,
								&[run],
								wrap_width,
								None,
							)
							.unwrap_or_default();

						let mut visual_count = 0;
						for line in &shaped {
							visual_count += line.wrap_boundaries().len() + 1;
						}
						let visual_count = visual_count.max(1);

						let total_h = line_h * visual_count as f32;
						let clamped_h = if let Some(max_l) = max_visible_lines {
							line_h * visual_count.min(max_l).max(1) as f32
						} else {
							total_h
						};

						let w = known_dimensions
							.width
							.unwrap_or_else(|| wrap_width.unwrap_or(px(100.0)));
						Size::new(w, clamped_h)
					},
				);
				(layout_id, ())
			},
		}
	}

	fn prepaint(
		&mut self,
		_id: Option<&GlobalElementId>,
		_inspector_id: Option<&InspectorElementId>,
		bounds: Bounds<Pixels>,
		_request_layout: &mut Self::RequestLayoutState,
		window: &mut Window,
		cx: &mut App,
	) -> Self::PrepaintState {
		let editor = self.editor.read(cx);
		let content = editor.text().to_string();
		let placeholder = editor.placeholder.clone();
		let is_empty = content.is_empty();
		let scroll_top = editor.scroll_top;

		let style = window.text_style();
		let font_size = style.font_size.to_pixels(window.rem_size());
		let line_height = window.line_height();

		let wrap_width = Some(bounds.size.width);

		let (text_to_shape, run_color) = {
			let tokens = TokenSet::for_app(cx);
			if is_empty {
				(placeholder.to_string(), tokens.color(ColorRole::Muted))
			} else {
				(content, tokens.color(ColorRole::Foreground))
			}
		};

		let run = TextRun {
			len:              text_to_shape.len(),
			font:             style.font(),
			color:            run_color,
			background_color: None,
			underline:        None,
			strikethrough:    None,
		};

		let shaped_lines = window
			.text_system()
			.shape_text(SharedString::from(text_to_shape), font_size, &[run], wrap_width, None)
			.unwrap_or_default();
		let shaped_lines: Arc<[WrappedLine]> = Arc::from(shaped_lines.into_vec());

		let layout_state =
			EditorLayoutState::new(shaped_lines, line_height, font_size, bounds, scroll_top);

		let content_h = layout_state.total_height;
		let layout_clone = layout_state.clone();

		self.editor.update(cx, |ed, _cx| {
			ed.content_height = content_h;
			ed.last_layout = Some(layout_clone);
		});

		Some(layout_state)
	}

	fn paint(
		&mut self,
		_id: Option<&GlobalElementId>,
		_inspector_id: Option<&InspectorElementId>,
		bounds: Bounds<Pixels>,
		_request_layout: &mut Self::RequestLayoutState,
		prepaint: &mut Self::PrepaintState,
		window: &mut Window,
		cx: &mut App,
	) {
		let Some(layout) = prepaint.take() else {
			return;
		};

		let editor = self.editor.read(cx);
		let focus_handle = editor.focus_handle().clone();
		let is_focused = focus_handle.is_focused(window);
		let cursor_visible = editor.cursor_visible;
		let selection = editor.buffer.selection();
		let is_empty = editor.is_empty();
		let scroll_top = editor.scroll_top;

		let (selection_color, caret_color) = {
			let tokens = TokenSet::for_app(cx);
			(tokens.row_selected(), tokens.color(ColorRole::Accent))
		};

		// Register input handler for IME and platform text events
		window.handle_input(&focus_handle, ElementInputHandler::new(bounds, self.editor.clone()), cx);

		// Paint selection background quads
		if is_focused && !selection.is_collapsed() && !is_empty {
			let sel_min = selection.min();
			let sel_max = selection.max();

			for vl in &layout.visual_lines {
				let line_y = bounds.top() + vl.y_offset - scroll_top;
				if line_y + layout.line_height < bounds.top() || line_y > bounds.bottom() {
					continue;
				}

				if sel_min < vl.end_offset && sel_max > vl.start_offset {
					let overlap_start = sel_min.max(vl.start_offset);
					let overlap_end = sel_max.min(vl.end_offset);

					if let Some(p_line) = layout.lines.get(vl.physical_index) {
						let rel_start = (overlap_start - vl.start_offset) + vl.rel_start;
						let rel_end = (overlap_end - vl.start_offset) + vl.rel_start;

						let x1 = p_line.unwrapped_layout.x_for_index(rel_start) - vl.start_unwrapped;
						let x2 = p_line.unwrapped_layout.x_for_index(rel_end) - vl.start_unwrapped;

						let sel_rect = Bounds::new(
							point(bounds.left() + x1, line_y),
							size((x2 - x1).max(px(1.0)), layout.line_height),
						);
						window.paint_quad(fill(sel_rect, selection_color));
					}
				}
			}
		}

		// Paint text lines
		for (p_idx, line) in layout.lines.iter().enumerate() {
			let line_y_base = layout
				.line_starts
				.get(p_idx)
				.and_then(|&offset| {
					let vl_idx = layout.visual_line_for_offset(offset);
					layout.visual_lines.get(vl_idx).map(|vl| vl.y_offset)
				})
				.unwrap_or_else(|| layout.line_height * p_idx as f32);

			let origin = point(bounds.left(), bounds.top() + line_y_base - scroll_top);
			let _ = line.paint(origin, layout.line_height, TextAlign::Left, Some(bounds), window, cx);
		}

		// Paint 1px caret
		if is_focused && cursor_visible {
			if is_empty {
				let caret_rect =
					Bounds::new(point(bounds.left(), bounds.top()), size(px(1.0), layout.line_height));
				window.paint_quad(fill(caret_rect, caret_color));
			} else {
				let head = selection.head;
				let vl_idx = layout.visual_line_for_offset(head);
				if let Some(vl) = layout.visual_lines.get(vl_idx)
					&& let Some(p_line) = layout.lines.get(vl.physical_index)
				{
					let rel_head = head.saturating_sub(vl.start_offset) + vl.rel_start;
					let unwrapped_x = p_line.unwrapped_layout.x_for_index(rel_head);
					let caret_x = unwrapped_x - vl.start_unwrapped;
					let caret_y = bounds.top() + vl.y_offset - scroll_top;

					let caret_rect = Bounds::new(
						point(bounds.left() + caret_x, caret_y),
						size(px(1.0), layout.line_height),
					);
					window.paint_quad(fill(caret_rect, caret_color));
				}
			}
		}
	}
}
