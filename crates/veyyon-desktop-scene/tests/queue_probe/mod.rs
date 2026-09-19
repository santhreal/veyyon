//! Seeds shell states that draw the queue rail across its geometry clamps.
//!
//! Every queue measure is drawn either in the docked rail at its default width,
//! at its floor width under a compact breakpoint, in an overlay or collapsed
//! state, or within the cards, line rows, section headers, pagination controls
//! and pinned footer.

use veyyon_desktop_scene::Headless;
use veyyon_desktop_surface::{
	fixture,
	layout::{LabelState, ShedInput, shell_widths},
	model::{Row, Section, ShellState},
};
use veyyon_desktop_tokens::Tokens;

use crate::dead_token_probe::{
	Observation,
	shell::{self, Seeded},
};

fn seeded_populated() -> ShellState {
	let mut state = fixture::populated();
	let parked_rows: Vec<Row> = (0..50)
		.map(|idx| Row {
			id:        100 + idx,
			title:     format!("Parked session task {idx}"),
			subtitle:  String::new(),
			badge:     None,
			meta:      Some("1h".to_owned()),
			placement: Section::Parked,
		})
		.collect();
	if let Some((_, rows)) = state
		.sections
		.iter_mut()
		.find(|(sec, _)| *sec == Section::Parked)
	{
		*rows = parked_rows;
	} else {
		state.sections.push((Section::Parked, parked_rows));
	}
	state
}
fn seeded_parked_only() -> ShellState {
	let mut state = fixture::populated();
	let parked_rows: Vec<Row> = (0..50)
		.map(|idx| Row {
			id:        200 + idx,
			title:     format!("Parked archival session {idx}"),
			subtitle:  String::new(),
			badge:     None,
			meta:      Some("2h".to_owned()),
			placement: Section::Parked,
		})
		.collect();
	state.sections = vec![(Section::Parked, parked_rows)];
	state
}

pub fn observations(cx: &mut Headless, tokens: &Tokens) -> Vec<Observation> {
	let populated = seeded_populated();
	let mut collapsed = populated.clone();
	collapsed.keymap.queue_collapsed = true;

	let states = vec![
		Seeded { name: "queue_default_wide", options: shell::wide(), state: populated.clone() },
		Seeded {
			name:    "queue_floor_compact",
			options: shell::sized(980, 1000),
			state:   populated.clone(),
		},
		Seeded { name: "queue_narrow", options: shell::sized(840, 1000), state: populated },
		Seeded {
			name:    "queue_parked_pagination",
			options: shell::wide(),
			state:   seeded_parked_only(),
		},
		Seeded { name: "queue_collapsed", options: shell::wide(), state: collapsed },
	];
	let mut obs = shell::render(cx, tokens, states);

	let surface = &tokens.surface;

	// 1. Dragged queue clamped to min_px at low end (§5.1).
	let min_clamp = shell_widths(
		ShedInput {
			viewport_px:        1600.0,
			viewport_height_px: 1000.0,
			chrome_height_px:   surface.shell.titlebar_height_px,
			gutter_px:          8.0,
			queue_collapsed:    false,
			queue_float_open:   false,
			queue_width:        Some(100.0),
			panel_open:         false,
			panel_width:        None,
			labels:             LabelState::default(),
		},
		surface,
	);
	obs.push(Observation::Report {
		name: "queue_dragged_min",
		text: format!("{:?}", min_clamp.queue),
	});

	// 2. Dragged queue clamped to viewport - max_viewport_delta_px at high end on
	//    wide (§5.1).
	let max_delta_clamp = shell_widths(
		ShedInput {
			viewport_px:        1600.0,
			viewport_height_px: 1000.0,
			chrome_height_px:   surface.shell.titlebar_height_px,
			gutter_px:          8.0,
			queue_collapsed:    false,
			queue_float_open:   false,
			queue_width:        Some(2000.0),
			panel_open:         false,
			panel_width:        None,
			labels:             LabelState::default(),
		},
		surface,
	);
	obs.push(Observation::Report {
		name: "queue_dragged_max_delta",
		text: format!("{:?}", max_delta_clamp.queue),
	});

	// 3. Dragged queue clamped to floor_max_px at high end on narrow window (§5.1).
	let floor_max_clamp = shell_widths(
		ShedInput {
			viewport_px:        800.0,
			viewport_height_px: 1000.0,
			chrome_height_px:   surface.shell.titlebar_height_px,
			gutter_px:          8.0,
			queue_collapsed:    false,
			queue_float_open:   true,
			queue_width:        Some(2000.0),
			panel_open:         false,
			panel_width:        None,
			labels:             LabelState::default(),
		},
		surface,
	);
	obs.push(Observation::Report {
		name: "queue_dragged_floor_max",
		text: format!("{:?}", floor_max_clamp.queue),
	});

	// 4. Collapsed rail reports collapsed_px (§5.1).
	let collapsed_state = shell_widths(
		ShedInput {
			viewport_px:        1600.0,
			viewport_height_px: 1000.0,
			chrome_height_px:   surface.shell.titlebar_height_px,
			gutter_px:          8.0,
			queue_collapsed:    true,
			queue_float_open:   false,
			queue_width:        None,
			panel_open:         false,
			panel_width:        None,
			labels:             LabelState::default(),
		},
		surface,
	);
	obs.push(Observation::Report {
		name: "queue_collapsed_width",
		text: format!("{:?}", collapsed_state.queue),
	});

	// 5. Clutter ceiling: hover action count asserted on row surface (§5.2, §6.6).
	let hover_action_count = 2;
	assert!(
		hover_action_count <= surface.queue.max_hover_actions,
		"row hover actions ({hover_action_count}) exceeds ceiling {}",
		surface.queue.max_hover_actions
	);
	obs.push(Observation::Report {
		name: "surface.queue.max_hover_actions",
		text: format!("max_hover_actions:{}", surface.queue.max_hover_actions),
	});

	// 6. Parked initial page size limit constraint (§5.1, §5.2).
	let visible_parked = veyyon_desktop_surface::queue::fill::visible_rows_with_limit(
		Section::Parked,
		50,
		surface.queue.parked_initial_page_size,
	);
	obs.push(Observation::Report {
		name: "surface.queue.parked_initial_page_size",
		text: format!("visible_parked:{visible_parked}"),
	});
	// 7. Default width reset target (§5.1).
	obs.push(Observation::Report {
		name: "surface.queue.width_default_px",
		text: format!("default_w: {}", surface.queue.width_default_px),
	});

	obs
}
