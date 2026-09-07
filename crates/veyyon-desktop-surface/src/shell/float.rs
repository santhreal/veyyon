//! Overlay placement and retained exit frames through the fork's transform
//! path.

use std::time::Instant;

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
	let fields = view.field_slots(cx);
	if view.palette_input.focus_search {
		view.palette_input.focus_search = false;
		if let Some(editor) = &editor {
			let focus = editor.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
		} else {
			window.focus(&dest_focus, cx);
		}
	}
	let frame = view.palette_input.motion.sample(
		open,
		Instant::now(),
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
	geometry.width_px = geometry
		.width_px
		.min(f32::from(window.viewport_size().width - margin * 2.0));
	let max_available_height = f32::from(margin)
		.mul_add(-2.0, available_height_px)
		.max(0.0);
	geometry.max_height_px = geometry.max_height_px.min(max_available_height);
	let content = match retained {
		Overlay::Palette(state) => {
			palette_surface(state, editor, &geometry, tokens, cx).into_any_element()
		},
		Overlay::Settings(state) => {
			let width = if state.route.is_some() {
				geometry.width_px
			} else {
				860.0_f32
			};
			let width = width.min(f32::from(window.viewport_size().width - margin * 2.0));
			let height = 560.0_f32.min(max_available_height);
			div()
				.w(px(width))
				.h(px(height))
				.child(settings_surface(
					state,
					&view.general_settings_list,
					&fields,
					Some(&dest_focus),
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
		.capture_any_mouse_down(move |_event, _window, cx| {
			if !open {
				cx.stop_propagation();
			}
		})
		.capture_any_mouse_up(move |_event, _window, cx| {
			if !open {
				cx.stop_propagation();
			}
		})
		.child(content);
	if view.palette_input.anchored && retained.is_palette() {
		Some(
			deferred(
				anchored()
					.position(view.palette_input.anchor.get())
					.anchor(Anchor::BottomLeft)
					.snap_to_window_with_margin(margin)
					.child(
						div()
							.id("composer-popover")
							// A popover swallows the pointer over its own rect,
							// so a press in the palette does not also answer a
							// card in the transcript behind it.
							.occlude()
							.on_mouse_down_out(cx.listener(|view, event: &MouseDownEvent, _window, cx| {
								if event.button == MouseButton::Left {
									view.close_palette(cx);
								}
							}))
							.child(content),
					),
			)
			.with_priority(1)
			.into_any_element(),
		)
	} else {
		Some(overlay_scrim(content, &surface.panels, tokens, cx).into_any_element())
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
