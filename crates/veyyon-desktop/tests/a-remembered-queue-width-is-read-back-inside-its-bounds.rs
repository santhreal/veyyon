//! WHY: the queue rail's width joined `PanelsStore` after the store already
//! shipped, so a record written by an earlier build carries no width at all,
//! and the file an operator can open in an editor carries whatever number was
//! typed into it. A width read back unchecked reaches the layout as a rail
//! narrower than its own minimum, or wider than the window it sits in.
//!
//! THE CLASS THIS CLOSES: a persisted measure served to the layout without the
//! bounds the token file authors. Both ends are covered — a record from before
//! the field existed loads at the default rather than at zero, and a value
//! outside the authored range is clamped on read rather than on write, so a
//! file edited between two launches is corrected by the launch that reads it.
//!
//! WHAT IT DOES NOT CATCH: the debounced writer that puts the width back on
//! disk, which `the-shape-a-window-was-left-in-comes-back-when-it-opens`
//! drives through the real window, and the rail's own drawn width, which the
//! queue measure sweep rasterises.

use veyyon_desktop_model::SessionId;

#[test]
fn a_stale_record_without_queue_width_loads_at_default() {
	let v2_json = r#"{
		"version": 2,
		"right_panel_visible": false,
		"right_panel_width": null,
		"drawer_visible": false,
		"drawer_height": null,
		"active_right_tab": null,
		"active_drawer_tab": null,
		"diff_mode": "unified"
	}"#;
	let (store, err) =
		veyyon_desktop_model::load_or_default::<veyyon_desktop_model::PanelsStore>(v2_json);
	assert!(err.is_some(), "version 2 is stale when CURRENT_VERSION is 3");
	assert_eq!(store.queue_width, None, "stale record loads default");
	let mut state = veyyon_desktop_model::PersistedState::default();
	let session_id = SessionId::from("sess-1");
	state.panels.insert(session_id.clone(), store);
	let shape = veyyon_desktop::state::session_shape(&state, Some(&session_id));
	assert_eq!(shape.queue_width_px, None, "stale record leaves queue width at default");
}

#[test]
fn a_hand_edited_record_outside_bounds_is_clamped_on_read() {
	let mut state = veyyon_desktop_model::PersistedState::default();
	let session_id = SessionId::from("sess-2");
	let panels = veyyon_desktop_model::PanelsStore {
		queue_width: Some(50),
		..veyyon_desktop_model::PanelsStore::default()
	};
	state.panels.insert(session_id.clone(), panels);
	let shape = veyyon_desktop::state::session_shape(&state, Some(&session_id));
	let tokens = veyyon_desktop_tokens::load_bundled_tokens().expect("bundled tokens");
	assert_eq!(
		shape.queue_width_px,
		Some(tokens.surface.queue.width_min_px),
		"hand-edited value below min is clamped to width_min_px"
	);
}

#[test]
fn a_width_wider_than_the_window_is_clamped_to_the_ceiling_the_tokens_state() {
	let tokens = veyyon_desktop_tokens::load_bundled_tokens().expect("bundled tokens");
	let queue = &tokens.surface.queue;
	let mut state = veyyon_desktop_model::PersistedState::default();
	state.window.width = 1180;
	let session_id = SessionId::from("sess-3");
	state
		.panels
		.insert(session_id.clone(), veyyon_desktop_model::PanelsStore {
			queue_width: Some(4000),
			..veyyon_desktop_model::PanelsStore::default()
		});
	let shape = veyyon_desktop::state::session_shape(&state, Some(&session_id));
	let ceiling = (1180.0 - queue.width_max_viewport_delta_px).max(queue.width_floor_max_px);
	assert_eq!(
		shape.queue_width_px,
		Some(ceiling),
		"a width past the viewport allowance is clamped to the ceiling, not served whole"
	);
}
