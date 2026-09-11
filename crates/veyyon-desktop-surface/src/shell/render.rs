//! Shell rendering implementation (§4.2).
//!
//! This module places the root's regions and nothing else. Where each side
//! column goes at the width the shed resolved is its own concern: `queue` for
//! the rail, inline or floated, and `panel` for the right panel, docked in a
//! split or floated inside the session surface.

mod panel;
mod queue;

use veyyon_desktop_kit::{ColorRole, SpacingStep};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::QueueMode;
use veyyon_gpui::{Context, InteractiveElement, IntoElement, ParentElement, Styled, Window, div};

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
	drawer::{SupervisorFields, signal_menu_layer},
	layout::{RightPanelPlacement, ShedInput, shell_widths},
	queue::row_menu_layer,
	transcript::turn_menu_layer,
};

/// Renders the root shell view.
pub fn render_shell(
	view: &mut ShellView,
	window: &mut Window,
	cx: &mut Context<ShellView>,
) -> impl IntoElement {
	// Reduced motion is the operator's setting, and it arrives with a
	// snapshot rather than at construction, so it is carried onto the driver
	// that owns it before anything in this frame samples one (§7.2).
	let reduced_motion = view.state().reduced_motion;
	view.rail_motion.set_reduced_motion(reduced_motion);
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
			queue_float_open:   view.queue_float_open,
			panel_open:         panel_available && !keymap.panel_collapsed,
			panel_width:        view.panel_width(),
			labels:             view.labels(),
		},
		&view.installed().surface,
	);
	// What the rail control does at this width, read from the row the shed
	// resolved rather than from a width this module restates.
	let floats = matches!(
		view
			.installed()
			.surface
			.breakpoints
			.resolve(f32::from(window.viewport_size().width))
			.queue_mode,
		QueueMode::Overlay
	);
	view.set_queue_floats(floats);
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
	let rename_editor = if view.state().current_id > 0 {
		let current_id = view.state().current_id;
		let title = view.state().title.clone();
		Some(view.session_rename_field_editor(current_id, &title, window, cx))
	} else {
		None
	};

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
				rename_editor,
				connection: &view.state().connection,
				// Lit when a rail is on screen, whether docked beside the
				// transcript or floated over it, rather than from the standing
				// collapsed state alone, which a float leaves untouched.
				queue_collapsed: !widths.queue.is_shown(),
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

	// The columns row places the rail beside the session surface. An overlaid
	// right panel is NOT placed here: it annotates the transcript, so it
	// floats inside the session surface (§5.6). A float over this row would
	// dim the rail it sits beside and cover the draft the operator is writing,
	// which is what a modal does.
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
	// The columns' regions, in child order. The session column records its
	// own regions, so its slot is empty here, and so is a floated rail's: the
	// float records the sheet's own box from inside its scrim, because the
	// scrim spans the whole row and the sheet is the rail.
	let mut column_regions: Vec<Option<Region>> = Vec::with_capacity(3);
	let queue = queue::queue_column(view, &widths, &surface, &tokens, window, cx);
	if let Some(rail) = queue.inline {
		columns = columns.child(rail);
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
	let cards_focus = view
		.cards_focus
		.get_or_insert_with(|| cx.focus_handle())
		.clone();
	// The row the overflowing cards fold into opens for the keyboard that
	// focused it and for the pointer that reached it, and its height is laid
	// out from that rather than refined at paint (§5.5).
	let cards_expanded = cards_focus.is_focused(window) || view.cards_hovered;
	let panel_focus = view
		.panel_focus
		.get_or_insert_with(|| cx.focus_handle())
		.clone();
	let panel_overlay = panel::panel_float(view, &widths, panels, &tokens, &panel_focus, window, cx);
	// The fields the supervisor's controls read are created only while the tab
	// that draws them is the open one: a field nobody can see is a
	// subscription and an entity the window carries for nothing. The input
	// field waits on a process to send to, because a row's `Send` is the only
	// thing that reads it.
	let processes_open = view.state().drawer_open && view.state().drawer.is_processes_active();
	let anything_running = view
		.state()
		.drawer
		.processes
		.iter()
		.any(|process| process.status == "running");
	let process_command = processes_open.then(|| view.process_command_field_editor(cx));
	let process_input =
		(processes_open && anything_running).then(|| view.process_input_field_editor(cx));
	let session = session_surface(
		view.state(),
		view.composer(),
		SupervisorFields { command: process_command.as_ref(), input: process_input.as_ref() },
		view.composer_local(),
		has_text,
		&widths,
		view.installed(),
		view.laid_out(),
		view.palette_anchor(),
		&view.transcript_viewport,
		&transcript_focus,
		&cards_focus,
		cards_expanded,
		view.rail_motion.is_reduced_motion(),
		find_bar,
		view.text_selection(),
		panel_overlay,
		window,
		cx,
	);

	columns = match widths.right_panel {
		// A float takes no width, so the row is the session surface alone and
		// the panel is already inside it.
		RightPanelPlacement::Absent | RightPanelPlacement::Overlay { .. } => columns.child(session),
		// A docked panel is the second pane of a split whose handle the
		// operator drags (§5.6), and the panel's own box is recorded from
		// inside it.
		RightPanelPlacement::Inline { width_px } => columns.child(panel::docked_split(
			view,
			&widths,
			panels,
			&tokens,
			&panel_focus,
			session.into_any_element(),
			width_px,
			window,
			cx,
		)),
	};
	if let Some(float) = queue.float {
		columns = columns.child(float);
		column_regions.push(None);
	}
	let mut columns = view
		.laid_out()
		.track_children(columns, move |index| column_regions.get(index).copied().flatten());
	if let Some(overlay) = super::float::overlay_layer(view, widths.columns_px, window, cx) {
		columns = columns.child(overlay);
	}
	if let Some(menu) = view.row_menu() {
		columns = columns.child(row_menu_layer(menu, &view.state().controls, &tokens, cx));
	}
	if let Some(menu) = view.turn_menu() {
		columns = columns.child(turn_menu_layer(menu, cx));
	}
	if let Some(menu) = view.signal_menu() {
		columns = columns.child(signal_menu_layer(menu, cx));
	}
	// Over every menu: a detail opened from a row the menu also lists is
	// anchored to that row, and a menu drawn over it would cover the facts the
	// popover was opened to read.
	if let Some(popover) = super::detail::detail_float(view, window, cx) {
		columns = columns.child(popover);
	}

	root.child(columns)
}
