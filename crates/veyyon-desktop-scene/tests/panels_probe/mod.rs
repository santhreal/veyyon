//! Probe module for surface.panels dead-token sweep.
//!
//! Seeds the panel and drawer states that render each measure of
//! `PanelsSurfaceTokens`: the right panel inline in diff and tree views,
//! the panel in overlay mode, the terminal drawer open at constrained heights,
//! a process list with active rows, and a tab strip with multiple long tabs.

use std::path::Path;

use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_desktop_scene::{Headless, HeadlessSession};
use veyyon_desktop_surface::{
	ShellView,
	controls::Availability,
	drawer::{DrawerTab, ProcessRow},
	fixture::{populated, with_drawer},
	install_tokens,
	layout::{LabelState, ShedInput, shell_widths},
	right_panel::PanelTab,
};
use veyyon_desktop_tokens::{Tokens, load_bundled_theme};
use veyyon_gpui::{AppContext, Point};

use crate::dead_token_probe::{
	Observation, frame_observation,
	shell::{Seeded, render, sized, wide},
};
fn seeded_diff_inline() -> Seeded {
	let mut state = populated();
	state.keymap.panel_collapsed = false;
	state.panel.active_tab = PanelTab::Diff;
	let sid = SurfaceId::RightPanelDiffTab(SessionId::from(state.current_id.to_string()));
	state.controls.set_availability(sid, Availability::Pending);
	Seeded { name: "panel_diff_inline", options: wide(), state }
}

fn seeded_tree_inline() -> Seeded {
	let mut state = populated();
	state.keymap.panel_collapsed = false;
	state.panel.active_tab = PanelTab::Tree;
	Seeded { name: "panel_tree_inline", options: wide(), state }
}

fn seeded_panel_overlay() -> Seeded {
	let mut state = populated();
	state.keymap.panel_collapsed = false;
	state.panel.active_tab = PanelTab::Diff;
	Seeded { name: "panel_overlay", options: sized(960, 800), state }
}

fn seeded_drawer_ratio() -> Seeded {
	let mut state = with_drawer();
	state.keymap.panel_collapsed = true;
	Seeded { name: "drawer_viewport_ratio", options: sized(1600, 320), state }
}

fn seeded_drawer_small_grid() -> Seeded {
	let mut state = with_drawer();
	state.keymap.panel_collapsed = true;
	Seeded { name: "drawer_small_grid", options: sized(400, 220), state }
}

fn seeded_process_list() -> Seeded {
	let mut state = with_drawer();
	state.keymap.panel_collapsed = true;
	state.drawer.tabs = vec![DrawerTab::terminal("term-1", "Terminal"), DrawerTab::Processes];
	state.drawer.active_tab = 1;
	state.drawer.processes = vec![
		ProcessRow {
			name:          "dev-server".to_string(),
			pid:           Some(4092),
			status:        "running".to_string(),
			elapsed_label: "1m 30s".to_string(),
			terminated_by: None,
			exit_code:     None,
		},
		ProcessRow {
			name:          "worker-proc".to_string(),
			pid:           Some(4093),
			status:        "failed".to_string(),
			elapsed_label: "45s".to_string(),
			terminated_by: None,
			exit_code:     Some(1),
		},
	];
	Seeded { name: "drawer_process_list", options: wide(), state }
}

fn seeded_long_tabs() -> Seeded {
	let mut state = with_drawer();
	state.keymap.panel_collapsed = true;
	state.drawer.tabs = vec![
		DrawerTab::terminal("term-1", "A Very Long Terminal Tab Title Exceeding Max Width"),
		DrawerTab::terminal("term-2", "Second Long Terminal Title For Drawer Tab Strip"),
		DrawerTab::terminal("term-3", "Third Long Terminal Title For Drawer Tab Strip"),
		DrawerTab::terminal("term-4", "Fourth Long Terminal Title For Drawer Tab Strip"),
		DrawerTab::Process { name: "build-proc".to_string() },
	];
	state.drawer.active_tab = 0;
	let sid1 = SurfaceId::ProcessLogsTab(SessionId::from("0"), "build-proc".to_string());
	let sid2 = SurfaceId::ProcessLogsTab(
		SessionId::from(state.current_id.to_string()),
		"build-proc".to_string(),
	);
	state.controls.set_availability(sid1, Availability::Pending);
	state.controls.set_availability(sid2, Availability::Pending);
	Seeded { name: "drawer_long_tabs", options: wide(), state }
}

/// Renders all seeded panel and drawer states against `tokens`.
pub fn observations(cx: &mut Headless, tokens: &Tokens) -> Vec<Observation> {
	let states = vec![
		seeded_diff_inline(),
		seeded_tree_inline(),
		seeded_panel_overlay(),
		seeded_drawer_ratio(),
		seeded_drawer_small_grid(),
		seeded_process_list(),
		seeded_long_tabs(),
	];
	let mut obs = render(cx, tokens, states);

	// Tab hover observation for close button measure (§5.6)
	let theme = load_bundled_theme("dark").expect("a bundled theme must load");
	let mut hover_state = populated();
	hover_state.keymap.panel_collapsed = false;
	let mut session = HeadlessSession::open(cx, &wide(), move |_window, app| {
		let installed = install_tokens(app, tokens, &theme, Path::new("surface"))
			.expect("the bundled token set must install");
		app.new(|_cx| ShellView::new(installed, hover_state))
	})
	.expect("hover session must open");
	let initial = session.frame().expect("initial frame must capture");
	let tab_run = initial
		.text_runs
		.iter()
		.find(|run| run.text.as_ref().trim() == "Changes")
		.expect("Changes tab run must exist");
	let tab_pt = Point {
		x: tab_run.bounds.origin.x + tab_run.bounds.size.width / 2.0,
		y: tab_run.bounds.origin.y + tab_run.bounds.size.height / 2.0,
	};
	session.hover(tab_pt).expect("hovering tab must succeed");
	let hovered = session.frame().expect("hovered frame must capture");
	obs.push(frame_observation("panel_tab_hovered", &hovered.frame));

	// Layout constraint reports for measures where the container/viewport bound
	// dictates the size (§5.6, §5.7).
	let surface = &tokens.surface;
	let panels = &surface.panels;

	// 1. Ratio ceiling constraint: wide viewport where
	//    right_panel_max_viewport_ratio binds.
	let ratio_state = shell_widths(
		ShedInput {
			viewport_px:        2000.0,
			viewport_height_px: 1000.0,
			chrome_height_px:   40.0,
			gutter_px:          8.0,
			queue_collapsed:    true,
			queue_float_open:   false,
			panel_open:         true,
			queue_width:        None,
			panel_width:        Some(1600.0),
			labels:             LabelState::default(),
		},
		surface,
	);
	obs.push(Observation::Report {
		name: "panel_ratio_ceiling",
		text: format!("{:?}", ratio_state.right_panel),
	});

	// 2. Container margin constraint: narrow split where
	//    right_panel_container_margin_px binds.
	let margin_state = shell_widths(
		ShedInput {
			viewport_px:        1440.0,
			viewport_height_px: 1000.0,
			chrome_height_px:   40.0,
			gutter_px:          8.0,
			queue_collapsed:    false,
			queue_float_open:   false,
			panel_open:         true,
			queue_width:        None,
			panel_width:        Some(900.0),
			labels:             LabelState::default(),
		},
		surface,
	);
	obs.push(Observation::Report {
		name: "panel_container_margin",
		text: format!("{:?}", margin_state.right_panel),
	});

	// 3. Fallback default width constraint: overlay width from line 331.
	let default_overlay = panels
		.right_panel_default_width_px
		.min(2000.0 * panels.right_panel_max_viewport_ratio);
	obs.push(Observation::Report {
		name: "panel_default_width",
		text: format!("default_w: {default_overlay:.1}"),
	});

	// 4. Terminal grid floors: minimum columns and rows from drawer/grid.rs:97-98.
	let grid_min_w = panels.terminal_cell_width_px * panels.terminal_min_columns as f32;
	let grid_min_h = panels.terminal_cell_height_px * panels.terminal_min_rows as f32;
	obs.push(Observation::Report {
		name: "terminal_min_columns",
		text: format!("min_col_w: {grid_min_w:.1}"),
	});
	obs.push(Observation::Report {
		name: "terminal_min_rows",
		text: format!("min_row_h: {grid_min_h:.1}"),
	});

	obs
}
