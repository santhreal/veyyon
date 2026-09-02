//! Shell rendering implementation (§4.2).

use veyyon_desktop_kit::{ColorRole, SpacingStep};
use veyyon_desktop_model::SurfaceId;
use veyyon_gpui::{
	Context, InteractiveElement, IntoElement, ParentElement, Styled, Window, div, px,
};

use super::{
	connection::connection_banner,
	keys::bind_global_keys,
	overlay::overlay_scrim,
	session::session_surface,
	titlebar::{TitlebarState, attention_strip, attention_strip_height, titlebar},
};
use crate::{
	ShellView,
	attach::{ConnectionPhase, render_attach_screen},
	damage::Region,
	layout::{RightPanelPlacement, ShedInput, shell_widths},
	panel::right_panel,
	queue::queue_rail,
};

/// Renders the root shell view.
pub fn render_shell(
	view: &mut ShellView,
	window: &mut Window,
	cx: &mut Context<ShellView>,
) -> impl IntoElement {
	view.ensure_composer(cx);

	let chrome_px = view.installed().surface.shell.titlebar_height_px
		+ if view.has_notice() {
			attention_strip_height(&view.installed().set)
		} else {
			0.0
		};
	let keymap = &view.state().keymap;
	let panel_available = !view.state().panel.is_empty();
	let widths = shell_widths(
		ShedInput {
			viewport_px:        f32::from(window.viewport_size().width),
			viewport_height_px: f32::from(window.viewport_size().height),
			chrome_height_px:   chrome_px,
			gutter_px:          f32::from(view.installed().set.spacing(SpacingStep::S4)),
			queue_collapsed:    keymap.queue_collapsed,
			panel_open:         panel_available && !keymap.panel_collapsed,
			labels:             view.labels(),
		},
		&view.installed().surface,
	);
	view.set_labels(widths.labels);

	let focus_handle = view
		.focus_handle
		.get_or_insert_with(|| cx.focus_handle())
		.clone();
	if window.focused(cx).is_none() {
		window.focus(&focus_handle, cx);
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
		.overflow_hidden()
		.child(titlebar(
			TitlebarState {
				title: &view.state().title,
				connection: &view.state().connection,
				queue_collapsed: view.state().keymap.queue_collapsed,
				panel_available,
				panel_collapsed: view.state().keymap.panel_collapsed,
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

	if let Some(banner) = connection_banner(&view.state().connection, view.clock_ms(), &tokens, cx) {
		root = root.child(banner);
	}

	if matches!(view.state().connection, ConnectionPhase::Reconnecting { .. }) {
		cx.spawn(async move |this, cx| {
			cx.background_executor()
				.timer(std::time::Duration::from_secs(1))
				.await;
			let _ = this.update(cx, |_view, cx| {
				cx.notify();
			});
		})
		.detach();
	}

	if let Some(notice) = view.notice() {
		root = root.child(attention_strip(notice, &tokens));
	} else if let Some(err) = view.state().controls.error(&SurfaceId::GlobalTitlebarLine) {
		root = root.child(attention_strip(&err.message, &tokens));
	}

	if !view.state().connection.is_attached()
		&& !matches!(view.state().connection, ConnectionPhase::Reconnecting { .. })
	{
		let attach_screen = render_attach_screen(&view.state().connection, &tokens, cx);
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
		columns = columns.child(queue_rail(
			&view.state.sections,
			view.state.current_id,
			queue_px,
			widths.columns_px,
			&surface.queue,
			&tokens,
			&mut view.rail_motion,
			cx,
		));
		column_regions.push(Some(Region::Queue));
	}
	column_regions.push(None);

	let has_text = view.has_composer_text();
	columns = columns.child(session_surface(
		view.state(),
		view.composer(),
		view.composer_local(),
		has_text,
		&widths,
		view.installed(),
		view.laid_out(),
		cx,
	));

	let panel = &view.state().panel;
	columns = match widths.right_panel {
		RightPanelPlacement::Absent => columns,
		RightPanelPlacement::Inline { width_px } => {
			column_regions.push(Some(Region::Panel));
			columns.child(right_panel(panel, width_px, panels, &tokens, cx))
		},
		// The panel takes its width from the window rather than from the
		// transcript, over a blurred scrim stating that what it covers is
		// still there (§5.6).
		RightPanelPlacement::Overlay { width_px } => {
			column_regions.push(Some(Region::Panel));
			columns.child(
				div()
					.absolute()
					.inset_0()
					.flex()
					.flex_row()
					.justify_end()
					.backdrop_blur(px(panels.right_panel_overlay_scrim_blur_px))
					.bg(tokens.scrim())
					.child(right_panel(panel, width_px, panels, &tokens, cx)),
			)
		},
	};
	let mut columns = view
		.laid_out()
		.track_children(columns, move |index| column_regions.get(index).copied().flatten());
	if let Some(overlay) = &view.state().overlay {
		columns = columns.child(overlay_scrim(overlay, panels, &surface, &tokens, cx));
	}

	root.child(columns)
}
