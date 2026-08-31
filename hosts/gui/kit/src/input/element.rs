//! The element that shapes, measures and paints one field, and the field's
//! own `Render`, which is one line of chrome around that element.

use super::*;

impl Render for Editor {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		// Both names, not one: the caret's table is written over the kinds, and
		// a field that declared only its own name would answer to nothing the
		// table binds. `add` takes a `&'static str` through `SharedString`, so
		// neither name allocates per frame.
		let mut context = KeyContext::new_with_defaults();
		context.add(self.kind);
		if let Some(name) = self.name {
			context.add(name);
		}
		div()
			.key_context(context)
			.track_focus(&self.focus)
			.cursor(CursorStyle::IBeam)
			.on_action(cx.listener(Self::left))
			.on_action(cx.listener(Self::right))
			.on_action(cx.listener(Self::up))
			.on_action(cx.listener(Self::down))
			.on_action(cx.listener(Self::word_left))
			.on_action(cx.listener(Self::word_right))
			.on_action(cx.listener(Self::home))
			.on_action(cx.listener(Self::end))
			.on_action(cx.listener(Self::doc_start))
			.on_action(cx.listener(Self::doc_end))
			.on_action(cx.listener(Self::select_left))
			.on_action(cx.listener(Self::select_right))
			.on_action(cx.listener(Self::select_up))
			.on_action(cx.listener(Self::select_down))
			.on_action(cx.listener(Self::select_word_left))
			.on_action(cx.listener(Self::select_word_right))
			.on_action(cx.listener(Self::select_home))
			.on_action(cx.listener(Self::select_end))
			.on_action(cx.listener(Self::select_all))
			.on_action(cx.listener(Self::backspace))
			.on_action(cx.listener(Self::delete))
			.on_action(cx.listener(Self::delete_word_left))
			.on_action(cx.listener(Self::delete_word_right))
			.on_action(cx.listener(Self::delete_to_line_end))
			.on_action(cx.listener(Self::newline))
			.on_action(cx.listener(Self::submit))
			.on_action(cx.listener(Self::paste))
			.on_action(cx.listener(Self::copy))
			.on_action(cx.listener(Self::cut))
			.on_action(cx.listener(Self::show_character_palette))
			.on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
			.on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
			.on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
			.on_mouse_move(cx.listener(Self::on_mouse_move))
			.on_scroll_wheel(cx.listener(Self::on_scroll))
			.w_full()
			.child(EditorElement { editor: cx.entity() })
	}
}

/// The element that shapes, measures and draws one [`Editor`].
struct EditorElement {
	editor: Entity<Editor>,
}

struct Painted {
	lines:  Lines,
	quads:  Vec<PaintQuad>,
	caret:  Option<PaintQuad>,
	scroll: Pixels,
}

impl IntoElement for EditorElement {
	type Element = Self;

	fn into_element(self) -> Self::Element {
		self
	}
}

/// Shape one field's text at a width. Called by the measure pass and again by
/// the paint pass; gpui's line layout cache is what makes that cheap.
fn shape(input: &ShapeInput, theme: &Theme, width: Pixels, window: &mut Window) -> Lines {
	let style = window.text_style();
	let font_size = style.font_size.to_pixels(window.rem_size());
	let color = if input.placeholder {
		theme.text_faint
	} else {
		style.color
	};

	let base = TextRun {
		len: input.display.len(),
		font: style.font(),
		color,
		background_color: None,
		underline: None,
		strikethrough: None,
	};
	let runs = match input.marked.as_ref() {
		Some(marked) if !input.placeholder && marked.end <= input.display.len() => vec![
			TextRun { len: marked.start, ..base.clone() },
			TextRun {
				len: marked.end - marked.start,
				underline: Some(UnderlineStyle {
					color:     Some(color),
					thickness: px(1.0),
					wavy:      false,
				}),
				..base.clone()
			},
			TextRun { len: input.display.len() - marked.end, ..base },
		]
		.into_iter()
		.filter(|run| run.len > 0)
		.collect(),
		_ => vec![base],
	};

	let lines = window
		.text_system()
		.shape_text(input.display.clone(), font_size, &runs, Some(width), None)
		.unwrap_or_default();
	Arc::new(lines.into_vec())
}

impl Element for EditorElement {
	type PrepaintState = Painted;
	type RequestLayoutState = ();

	fn id(&self) -> Option<ElementId> {
		None
	}

	fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
		None
	}

	fn request_layout(
		&mut self,
		_: Option<&GlobalElementId>,
		_: Option<&InspectorElementId>,
		window: &mut Window,
		cx: &mut App,
	) -> (LayoutId, Self::RequestLayoutState) {
		let mut style = Style::default();
		style.size.width = relative(1.0).into();

		let editor = self.editor.clone();
		let theme = Theme::get(cx);
		let id = window.request_measured_layout(style, move |known, available, window, cx| {
			let width = known.width.unwrap_or(match available.width {
				gpui::AvailableSpace::Definite(width) => width,
				_ => px(320.0),
			});
			let (input, min, max) = {
				let editor = editor.read(cx);
				(editor.shape_input(), editor.min_height, editor.max_height)
			};
			let lines = shape(&input, &theme, width, window);
			let height = (window.line_height() * rows_in(&lines) as f32).clamp(min, max);
			Size { width, height }
		});
		(id, ())
	}

	fn prepaint(
		&mut self,
		_: Option<&GlobalElementId>,
		_: Option<&InspectorElementId>,
		bounds: Bounds<Pixels>,
		_: &mut Self::RequestLayoutState,
		window: &mut Window,
		cx: &mut App,
	) -> Self::PrepaintState {
		let theme = Theme::get(cx);
		let line_height = window.line_height();
		let input = self.editor.read(cx).shape_input();
		let lines = shape(&input, &theme, bounds.size.width, window);

		let content = line_height * rows_in(&lines) as f32;
		let overflow = (content - bounds.size.height).max(px(0.0));
		let focused = self.editor.read(cx).focus.is_focused(window);

		// The entity answers geometry out of what was shaped, so it gets this
		// frame's lines before anything asks it where the caret is.
		let (selection, caret_offset) = self.editor.update(cx, |editor, _| {
			editor.focused = focused;
			editor.scroll = editor.scroll.clamp(px(0.0), overflow);
			editor.shaped =
				Some(Shaped { lines: lines.clone(), line_height, bounds, scroll: editor.scroll });
			(editor.selection.clone(), editor.caret())
		});

		let caret_at = self.editor.read(cx).position_of(caret_offset);
		let scroll = self.editor.update(cx, |editor, _| {
			if let Some(at) = caret_at {
				if at.y < editor.scroll {
					editor.scroll = at.y;
				} else if at.y + line_height > editor.scroll + bounds.size.height {
					editor.scroll = at.y + line_height - bounds.size.height;
				}
				editor.scroll = editor.scroll.clamp(px(0.0), overflow);
			}
			if let Some(shaped) = editor.shaped.as_mut() {
				shaped.scroll = editor.scroll;
			}
			editor.scroll
		});

		// One quad per visual row the selection touches.
		let mut quads = Vec::new();
		if !selection.is_empty() && !input.placeholder {
			let editor = self.editor.read(cx);
			let mut start = 0;
			for line in lines.iter() {
				let end = start + line.len();
				if selection.end >= start && selection.start <= end {
					for (row_start, row_end) in rows_of(line, start) {
						let from = selection.start.max(row_start);
						let to = selection.end.min(row_end);
						if from >= to {
							continue;
						}
						let Some(a) = editor.position_of(from) else {
							continue;
						};
						let b = editor
							.position_of(to)
							.filter(|b| b.y == a.y)
							.unwrap_or(point(line.width(), a.y));
						quads.push(fill(
							Bounds::new(
								point(bounds.origin.x + a.x, bounds.origin.y + a.y - scroll),
								size((b.x - a.x).max(px(2.0)), line_height),
							),
							theme.accent.opacity(0.28),
						));
					}
				}
				start = end + 1;
			}
		}

		let caret = (focused && selection.is_empty())
			.then_some(caret_at)
			.flatten()
			.map(|at| {
				fill(
					Bounds::new(
						point(bounds.origin.x + at.x, bounds.origin.y + at.y - scroll + px(1.0)),
						size(px(1.5), line_height - px(2.0)),
					),
					theme.accent,
				)
			});

		Painted { lines, quads, caret, scroll }
	}

	fn paint(
		&mut self,
		_: Option<&GlobalElementId>,
		_: Option<&InspectorElementId>,
		bounds: Bounds<Pixels>,
		_: &mut Self::RequestLayoutState,
		painted: &mut Self::PrepaintState,
		window: &mut Window,
		cx: &mut App,
	) {
		let focus = self.editor.read(cx).focus.clone();
		window.handle_input(&focus, ElementInputHandler::new(bounds, self.editor.clone()), cx);

		let line_height = window.line_height();
		let scroll = painted.scroll;
		let lines = painted.lines.clone();
		let quads: Vec<PaintQuad> = painted.quads.drain(..).collect();
		let caret = painted.caret.take();

		window.with_content_mask(Some(ContentMask { bounds }), |window| {
			for quad in quads {
				window.paint_quad(quad);
			}

			let mut top = bounds.origin.y - scroll;
			for line in lines.iter() {
				let _ = line.paint(
					point(bounds.origin.x, top),
					line_height,
					TextAlign::Left,
					None,
					window,
					cx,
				);
				top += line_height * (line.wrap_boundaries().len() + 1) as f32;
			}

			if let Some(caret) = caret {
				window.paint_quad(caret);
			}
		});
	}
}
