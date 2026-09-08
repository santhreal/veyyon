//! Shell rendering implementation (§4.2).

use veyyon_desktop_kit::{Axis, ColorRole, Resizable, Sheet, SpacingStep};
use veyyon_desktop_model::SurfaceId;
use veyyon_gpui::{
	Context, InteractiveElement, IntoElement, ParentElement, Styled, Window, div, px,
};

use super::{
	connection::connection_banner,
	keys::bind_global_keys,
	session::session_surface,
	titlebar::{TitlebarState, attention_strip, attention_strip_height, titlebar},
};
use crate::{
	ShellView,
	attach::render_attach_screen,
	damage::Region,
	layout::{RightPanelPlacement, ShedInput, shell_widths},
	panel::right_panel,
	queue::{queue_rail, row_menu_layer},
};

/// Renders the root shell view.
pub fn render_shell(
	view: &mut ShellView,
	window: &mut Window,
	cx: &mut Context<ShellView>,
) -> impl IntoElement {
	view.ensure_composer(cx);
	view.sample_split_motion(window, cx);
	let transcript_height = view
		.laid_out()
		.bounds(Region::Transcript)
		.map_or(0.0, |bounds| f32::from(bounds.size.height));
	let now = cx.background_executor().now();
	view.sync_transcript_viewport(transcript_height, now);

	let chrome_px = view.installed().surface.shell.titlebar_height_px
		+ if view.has_notice() {
			attention_strip_height(&view.installed().set)
		} else {
			0.0
		};
	let keymap = &view.state().keymap;
	let panel_available = view.state().connection.is_attached();
	let mut widths = shell_widths(
		ShedInput {
			viewport_px:        f32::from(window.viewport_size().width),
			viewport_height_px: f32::from(window.viewport_size().height),
			chrome_height_px:   chrome_px,
			gutter_px:          f32::from(view.installed().set.spacing(SpacingStep::S4)),
			queue_collapsed:    keymap.queue_collapsed,
			panel_open:         panel_available && !keymap.panel_collapsed,
			panel_width:        view.panel_width(),
			labels:             view.labels(),
		},
		&view.installed().surface,
	);
	if let Some(height) = view.split_motion.drawer_height() {
		let panels = &view.installed().surface.panels;
		let maximum = widths.columns_px * panels.terminal_drawer_max_viewport_ratio;
		let minimum = panels.terminal_drawer_min_height_px.min(maximum);
		widths.drawer.height_px = height.clamp(minimum, maximum);
	}
	view.set_labels(widths.labels);

	let focus_handle = view
		.focus_handle
		.get_or_insert_with(|| cx.focus_handle())
		.clone();
	if window.focused(cx).is_none() {
		if view.state().overlay.is_some() {
			if view
				.state()
				.overlay
				.as_ref()
				.is_some_and(crate::Overlay::is_palette)
			{
				if let Some(editor) = view.palette_editor() {
					let focus = editor.read(cx).focus_handle().clone();
					window.focus(&focus, cx);
				}
			} else {
				let dest_focus = view.destination_focus_handle(cx);
				window.focus(&dest_focus, cx);
			}
		} else if let Some(editor) = view.composer() {
			let focus = editor.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
		} else {
			window.focus(&focus_handle, cx);
		}
	}

	let tokens = view.installed().set.clone();
	let surface = view.installed().surface.clone();

	let root = div()
		.track_focus(&focus_handle)
		.key_context("Shell")
		.flex()
		.flex_col()
		.size_full()
		.bg(tokens.color(ColorRole::Ground))
		.text_color(tokens.color(ColorRole::Foreground))
		// Every run under the root inherits this family, deferred overlays
		// included: GPUI's own default is `.SystemUIFont`, which its Linux
		// text system cannot resolve, and an unresolvable family costs a
		// ten-deep fallback walk and a constructed error per run per frame.
		.font_family(tokens.ui_family())
		.overflow_hidden()
		.child(titlebar(
			TitlebarState {
				title: &view.state().title,
				connection: &view.state().connection,
				queue_collapsed: view.state().keymap.queue_collapsed,
				panel_available,
				panel_collapsed: view.state().keymap.panel_collapsed,
				drawer_available: view.state().drawer.offered,
				drawer_open: view.state().drawer_open,
			},
			&surface.shell,
			&tokens,
			cx,
		));
	let root = view
		.laid_out()
		.track_children(root, |index| (index == 0).then_some(Region::Titlebar));
	let mut root = bind_global_keys(root, cx);

	if let Some(banner) = connection_banner(
		&view.state().connection,
		&view.state().controls,
		view.clock_ms(),
		&tokens,
		cx,
	) {
		root = root.child(banner);
	}

	if let Some(notice) = view.notice() {
		root = root.child(attention_strip(notice, &tokens));
	} else if let Some(err) = view.state().controls.error(&SurfaceId::GlobalTitlebarLine) {
		root = root.child(attention_strip(&err.message, &tokens));
	}

	// A phase answered by the banner keeps the cached queue and transcript
	// behind it, so a dialog phase alone replaces the columns (§8.12).
	let secret = view.secret_field_editor(cx);
	if let Some(editor) = view.take_field_focus() {
		let focus = editor.read(cx).focus_handle().clone();
		window.focus(&focus, cx);
	}
	if let Some(attach_screen) = render_attach_screen(&view.state().connection, secret, &tokens, cx)
	{
		return root.child(attach_screen);
	}

	let panels = &surface.panels;

	// The columns row is the overlay's positioning parent, so an overlaid
	// right panel covers the queue and the transcript and leaves the
	// titlebar and the attention strip reachable above it.
	let mut columns = div()
		.relative()
		.flex()
		.flex_row()
		.w_full()
		.flex_1()
		.overflow_hidden();

	// A collapsed rail is absent, not zero-width: a zero-width column still
	// draws its right border, leaving a hairline against the window edge
	// with nothing behind it.
	//
	// The columns' regions, in child order. The session column records
	// its own regions, so its slot is empty here.
	let mut column_regions: Vec<Option<Region>> = Vec::with_capacity(3);
	if let Some(queue_px) = widths.queue_px {
		let queue_focus = view
			.queue_focus
			.get_or_insert_with(|| cx.focus_handle())
			.clone();
		columns = columns.child(queue_rail(
			&view.state.sections,
			view.state.keymap.queue_filter.as_deref(),
			view.state.current_id,
			queue_px,
			widths.columns_px,
			&view.state.controls,
			&surface.queue,
			&tokens,
			&mut view.rail_motion,
			&queue_focus,
			window,
			cx,
		));
		column_regions.push(Some(Region::Queue));
	}
	column_regions.push(None);

	let has_text = view.has_composer_text();
	let find_bar = view
		.state
		.keymap
		.find_open
		.then(|| div().child(view.render_transcript_find_bar(&tokens, cx)));
	// Both region handles are created before the surfaces that carry them and
	// kept on the view, so a press focuses something the next frame tracks
	// rather than a handle discarded with the frame that made it.
	let transcript_focus = view
		.transcript_focus
		.get_or_insert_with(|| cx.focus_handle())
		.clone();
	let panel_focus = view
		.panel_focus
		.get_or_insert_with(|| cx.focus_handle())
		.clone();
	let session = session_surface(
		view.state(),
		view.composer(),
		view.composer_local(),
		has_text,
		&widths,
		view.installed(),
		view.laid_out(),
		view.palette_anchor(),
		&view.transcript_viewport,
		&transcript_focus,
		view.rail_motion.is_reduced_motion(),
		find_bar,
		window,
		cx,
	);

	let panel = &view.state().panel;
	columns = match widths.right_panel {
		RightPanelPlacement::Absent => columns.child(session),
		// A docked panel is the second pane of a split whose handle the
		// operator drags (§5.6). The handle sits inside the panel's measure,
		// so the session surface keeps the width the shed gave it, and the
		// panel's own box is recorded from inside the split.
		RightPanelPlacement::Inline { width_px } => {
			let grip_px = f32::from(Resizable::handle_extent(&tokens));
			let body = right_panel(panel, width_px - grip_px, panels, &tokens, &panel_focus, cx);
			let tracked = view
				.laid_out()
				.track_children(div().h_full().w_full().flex().child(body), |index| {
					(index == 0).then_some(Region::Panel)
				});
			let split_px = widths.session_px + width_px;
			let shell = cx.weak_entity();
			let release_shell = shell.clone();
			let min_width = panels.right_panel_min_width_px;
			let max_width = (f32::from(window.viewport_size().width)
				* panels.right_panel_max_viewport_ratio)
				.min(split_px - panels.right_panel_container_margin_px)
				.max(min_width);
			columns.child(
				Resizable::new(Axis::Horizontal, session, tracked)
					.id("shell-split")
					.ratio(widths.session_px / split_px)
					.on_resize(move |ratio, _window, cx| {
						let asked_px = (1.0 - ratio) * split_px;
						// A released view has no handle to move; the drag
						// ends with the window.
						let _ = shell.update(cx, |view, cx| {
							view.drag_panel(asked_px, min_width, max_width, cx);
							cx.notify();
						});
					})
					.on_resize_end(move |_window, cx| {
						let _ = release_shell.update(cx, |view, cx| {
							view.release_panel(cx);
							cx.notify();
						});
					}),
			)
		},
		// The panel takes its width from the window rather than from the
		// transcript, as a sheet docked to the trailing edge over a blurred
		// scrim stating that what it covers is still there (§5.6).
		RightPanelPlacement::Overlay { width_px } => {
			column_regions.push(Some(Region::Panel));
			let inset_px = f32::from(Sheet::inset(&tokens));
			let body =
				right_panel(panel, inset_px.mul_add(-2.0, width_px), panels, &tokens, &panel_focus, cx);
			columns.child(session).child(
				div()
					.absolute()
					.inset_0()
					.flex()
					.flex_row()
					.justify_end()
					.backdrop_blur(px(panels.right_panel_overlay_scrim_blur_px))
					.bg(tokens.scrim())
					.child(Sheet::right(body)),
			)
		},
	};
	let mut columns = view
		.laid_out()
		.track_children(columns, move |index| column_regions.get(index).copied().flatten());
	if let Some(overlay) = super::float::overlay_layer(view, widths.columns_px, window, cx) {
		columns = columns.child(overlay);
	}
	if let Some(menu) = view.row_menu() {
		columns = columns.child(row_menu_layer(menu, &view.state().controls, &tokens, cx));
	}

	root.child(columns)
}
