//! Overlay placement and retained exit frames through the fork's transform
//! path.

use veyyon_desktop_kit::SpacingStep;
use veyyon_gpui::{
	Anchor, AnyElement, Context, InteractiveElement, IntoElement, MouseButton, MouseDownEvent,
	ParentElement, Styled, Window, anchored, deferred, div, px,
};

use super::overlay::overlay_scrim;
use crate::{Overlay, ShellView, palette::palette_surface, settings::settings_surface};

pub(super) fn overlay_layer(
	view: &mut ShellView,
	available_height_px: f32,
	window: &mut Window,
	cx: &mut Context<ShellView>,
) -> Option<AnyElement> {
	if view.palette_input.restore_focus {
		view.palette_input.restore_focus = false;
		if let Some(editor) = view.composer() {
			let focus = editor.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
		}
	}
	let dest_focus = view.destination_focus_handle(cx);
	let open = view.state.overlay.is_some();
	if open && view.palette_input.retained.as_ref() != view.state.overlay.as_ref() {
		view.palette_input.retained.clone_from(&view.state.overlay);
	}
	view.palette_input.retained.as_ref()?;
	let needs_editor = view
		.palette_input
		.retained
		.as_ref()
		.is_some_and(Overlay::is_palette)
		&& !view.palette_input.slash;
	let editor = needs_editor.then(|| view.ensure_palette_editor(cx));
	// The prompt belongs to the mode, and a row that opens a lookup changes
	// the mode under an editor the window retains, so it is set where the
	// frame reads it (§5.8).
	if let Some(editor) = &editor
		&& let Some(palette) = view
			.palette_input
			.retained
			.as_ref()
			.and_then(Overlay::as_palette)
	{
		let prompt = palette.mode.placeholder();
		if editor.read(cx).placeholder_text() != prompt {
			editor.update(cx, |editor, _cx| editor.set_placeholder(prompt));
		}
	}
	let fields = view.field_slots(window, cx);
	if view.palette_input.focus_search {
		view.palette_input.focus_search = false;
		if let Some(editor) = &editor {
			let focus = editor.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
		} else if view.settings_query_is_drawn() {
			// The General page is a search over two hundred rows, so the
			// keyboard lands in its query field: the first character an
			// operator types narrows the page rather than reaching nothing,
			// which is what the terminal screen does with it.
			let focus = fields.query.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
		} else {
			window.focus(&dest_focus, cx);
		}
	}
	// The query field is drawn on the General page alone, so a page the
	// operator moved to takes the keyboard off it rather than leaving it
	// typed into a field that is no longer drawn.
	if !view.settings_query_is_drawn() && fields.query.read(cx).focus_handle().is_focused(window) {
		window.focus(&dest_focus, cx);
	}
	let frame = view.palette_input.motion.sample(
		open,
		cx.background_executor().now(),
		&view.installed.motion,
		view.rail_motion.is_reduced_motion(),
	);
	if !open && frame.settled {
		view.palette_input.retained = None;
		return None;
	}
	if !frame.settled {
		let entity = cx.entity();
		window.on_next_frame(move |_window, app| entity.update(app, |_view, cx| cx.notify()));
	}
	let retained = view.palette_input.retained.as_ref()?;
	let tokens = &view.installed.set;
	let surface = &view.installed.surface;
	let mut geometry = surface.palette.clone();
	let margin = tokens.spacing(SpacingStep::S4);
	// A popover anchored to a control is narrower than the palette the window
	// centres (§5.8), so it sits over the composer without covering the turn
	// the operator is reading.
	if view.palette_input.anchored && retained.is_palette() {
		geometry.width_px = geometry.anchored_width_px;
	}
	geometry.width_px = geometry
		.width_px
		.min(f32::from(window.viewport_size().width - margin * 2.0));
	let max_available_height = f32::from(margin)
		.mul_add(-2.0, available_height_px)
		.max(0.0);
	geometry.max_height_px = geometry.max_height_px.min(max_available_height);
	let back = view.back_route();
	let content = match retained {
		Overlay::Palette(state) => palette_surface(
			state,
			editor,
			back,
			&view.keymap,
			&geometry,
			tokens,
			view.palette_input.anchored,
			|item| view.palette_item_enabled(item),
			cx,
		)
		.into_any_element(),
		Overlay::History(state) => {
			let width = surface
				.settings
				.group_width_px
				.min(f32::from(window.viewport_size().width - margin * 2.0));
			div()
				.track_focus(&dest_focus)
				.w(px(width))
				.h(px(surface.settings.sheet_height_px.min(max_available_height)))
				.bg(tokens.color(veyyon_desktop_kit::ColorRole::Float))
				.child(crate::history::history_surface(
					state,
					&surface.transcript,
					view.installed.user_turn_ground,
					tokens,
					&view.installed.motion,
					view.laid_out(),
					width,
					cx,
				))
				.into_any_element()
		},
		Overlay::Settings(state) => {
			// The sheet is the settings surface's own box (§5.9), not the
			// palette's: its rows carry a label, a description and a control
			// column, which the palette's width truncates.
			let width = surface
				.settings
				.group_width_px
				.min(f32::from(window.viewport_size().width - margin * 2.0));
			let height = surface.settings.sheet_height_px.min(max_available_height);
			div()
				.w(px(width))
				.h(px(height))
				.child(settings_surface(
					state,
					&view.general_settings_list,
					&view.state.appearance,
					&fields,
					back,
					Some(&dest_focus),
					&view.palette_input.scroll,
					&view.state.controls,
					&surface.settings,
					tokens,
					cx,
				))
				.into_any_element()
		},
	};
	let content = div()
		.opacity(frame.opacity)
		.translate_y(px(frame.offset_y))
		.child(content);
	if view.palette_input.anchored && retained.is_palette() {
		let mut popover = div().id("composer-popover");
		if open {
			popover = popover
				// A popover swallows the pointer over its own rect, so a press
				// in the palette does not also answer a card in the transcript
				// behind it.
				.occlude()
				.on_mouse_down_out(cx.listener(|view, event: &MouseDownEvent, _window, cx| {
					if event.button == MouseButton::Left {
						view.close_palette(cx);
						// The press that dismissed the popover is spent on the
						// dismissal. Letting it continue would also activate
						// whatever it landed on, which is a decision the
						// operator did not make. Only this press is stopped:
						// the popover is drawn for several frames more while it
						// fades, and a press during those frames belongs to the
						// surface underneath.
						cx.stop_propagation();
					}
				}));
		}
		Some(
			deferred(
				anchored()
					.position(view.palette_input.anchor.get())
					.anchor(Anchor::BottomLeft)
					.snap_to_window_with_margin(margin)
					.child(popover.child(content)),
			)
			.with_priority(1)
			.into_any_element(),
		)
	} else {
		// A palette resizes as its rows filter down, so centring it would move
		// the field the operator is typing into between one keystroke and the
		// next. The box it could fill is centred instead and the card is drawn
		// at the top of it, which leaves the field where it was and grows the
		// list downward.
		let top_inset = retained.is_palette().then(|| {
			px(((available_height_px - geometry.max_height_px) / 2.0).max(f32::from(margin)))
		});
		Some(overlay_scrim(content, open, top_inset, &surface.panels, tokens, cx).into_any_element())
	}
}

impl ShellView {
	/// Settings data remains available until the closing float settles.
	pub(crate) fn active_settings(&self) -> Option<&crate::settings::SettingsState> {
		self.state.overlay_settings().or_else(|| {
			self
				.palette_input
				.retained
				.as_ref()
				.and_then(crate::Overlay::as_settings)
		})
	}
}
