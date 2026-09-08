//! WHY: Every protocol capability must project to a reachable, observable
//! surface control, and its gate states (Enabled, Unknown, Unavailable,
//! Pending) must reflect truthfully in rendered pixels rather than falling back
//! to resting defaults or generic titlebar marks.
//!
//! CLASS CLOSED: Ledger row A7. Capabilities whose Unavailable or Pending gate
//! states draw identical bytes to Enabled; capabilities registering in-flight
//! requests against incorrect global surfaces rather than point of use;
//! hardcoded capability opt-outs that mask missing surface projections.
//!
//! NOT CAUGHT: Live socket network transport latency; theme font rasterization
//! platform variance.
//!
//! MUTATION PROOF:
//! - Setting Unavailable status to Available causes
//!   `test_unavailable_renders_distinct_from_enabled` to fail.
//! - Omitting Pending request registration causes
//!   `test_pending_renders_distinct_from_enabled` to fail.
//! - Mapping an actionless capability to a dummy action causes
//!   `test_action_of_exhaustively_matches_model_mapping` to fail.

use std::{collections::HashMap, path::PathBuf};

use strum::IntoEnumIterator as _;
use veyyon_desktop::{
	AssetPaths, SessionIndex, StartupBundle, load_startup_bundle, project,
	scene::{
		Assets, SceneWindow,
		build::{action_of, capability_gate},
	},
};
use veyyon_desktop_model::{Capability, CapabilityStatus, Store, action_to_capability};
use veyyon_desktop_scene::{
	Appearance, FixtureSelection, GateVariant, RenderOptions, RequiredState, Scene, StateDescriptor,
	gated_capabilities, headless_context,
};
use veyyon_desktop_surface::{Overlay, PaletteState, ShellState};
fn startup_assets() -> StartupBundle {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens");
	load_startup_bundle(AssetPaths {
		tokens_dir: root.join("tokens"),
		themes_dir: root.join("themes"),
	})
	.expect("load startup bundle")
}

fn render_scene_bytes(
	window: &mut SceneWindow,
	assets: &Assets,
	capability: Capability,
	gate: GateVariant,
) -> Vec<u8> {
	let state = RequiredState::CapabilityGate { capability, gate };
	let scene = Scene {
		name:              state.scene_name(),
		surface:           state.surface().to_string(),
		state:             StateDescriptor::Required(state),
		fixture_selection: FixtureSelection::default(),
	};
	let rendered = window
		.render(assets, &scene)
		.unwrap_or_else(|err| panic!("failed to render {}: {err}", scene.name));
	rendered.captured.frame.as_bytes().to_vec()
}

#[test]
fn test_action_of_exhaustively_matches_model_mapping() {
	let gated = gated_capabilities();

	for capability in Capability::iter() {
		let action = action_of(capability);
		if gated.contains(&capability) {
			let act = action.unwrap_or_else(|| {
				panic!("{capability:?} is in gated_capabilities but action_of returned None")
			});
			assert_eq!(
				action_to_capability(act),
				capability,
				"action {act:?} mapped to wrong capability for {capability:?}"
			);
		} else {
			assert_eq!(
				action, None,
				"actionless capability {capability:?} unexpectedly returned an action"
			);
		}
	}

	// Assert exactly 6 actionless capabilities and 24 gated capabilities
	let actionless: Vec<Capability> = Capability::iter().filter(|c| !gated.contains(c)).collect();
	assert_eq!(
		actionless,
		vec![
			Capability::BackgroundSubmission,
			Capability::Questions,
			Capability::Plans,
			Capability::PendingEdits,
			Capability::Extensions,
			Capability::AgentCommands,
		],
		"exact set of actionless capabilities"
	);
	assert_eq!(Capability::ALL.len(), 30);
	assert_eq!(gated.len(), 24);
}

#[test]
fn test_all_capability_scenes_build_cleanly() {
	let gated = gated_capabilities();
	for capability in Capability::iter() {
		for gate in GateVariant::iter() {
			if gate == GateVariant::Pending && !gated.contains(&capability) {
				continue;
			}
			let name = RequiredState::CapabilityGate { capability, gate }.scene_name();
			let built = capability_gate(&name, capability, gate);
			assert!(built.is_ok(), "failed to build scene {name}: {:?}", built.err());
		}
	}
}

#[test]
fn test_unknown_draws_at_rest_except_panel_tenants() {
	let mut cx = headless_context().expect("headless context available on GPU host");
	let bundle = startup_assets();
	let assets = Assets {
		tokens:       &bundle.tokens,
		theme:        &bundle.theme,
		surface_path: &bundle.surface_path,
	};
	let options = RenderOptions {
		width: 1180,
		height: 800,
		scale_factor: 1.0,
		appearance: Appearance::Dark,
		..RenderOptions::default()
	};
	let mut window = SceneWindow::open(&mut cx, &options).expect("open scene window");

	for capability in Capability::iter() {
		let enabled = render_scene_bytes(&mut window, &assets, capability, GateVariant::Enabled);
		let unknown = render_scene_bytes(&mut window, &assets, capability, GateVariant::Unknown);

		if matches!(capability, Capability::Files | Capability::Changes) {
			assert!(
				unknown != enabled,
				"{capability:?}: UnknownUntilAttached must hide panel tabs (differ from Enabled)"
			);
		} else {
			assert_eq!(
				unknown, enabled,
				"{capability:?}: UnknownUntilAttached must draw at rest identically to Enabled"
			);
		}
	}
}

#[test]
fn test_all_thirty_capabilities_render_distinct_unavailable_bytes() {
	let mut cx = headless_context().expect("headless context available on GPU host");
	let bundle = startup_assets();
	let assets = Assets {
		tokens:       &bundle.tokens,
		theme:        &bundle.theme,
		surface_path: &bundle.surface_path,
	};
	let options = RenderOptions {
		width: 1180,
		height: 800,
		scale_factor: 1.0,
		appearance: Appearance::Dark,
		..RenderOptions::default()
	};
	let mut window = SceneWindow::open(&mut cx, &options).expect("open scene window");

	let mut invisible = Vec::new();
	for capability in Capability::iter() {
		let enabled = render_scene_bytes(&mut window, &assets, capability, GateVariant::Enabled);
		let unavailable =
			render_scene_bytes(&mut window, &assets, capability, GateVariant::Unavailable);

		if unavailable == enabled {
			invisible.push(capability);
		}
	}
	assert_eq!(
		invisible,
		Vec::<Capability>::new(),
		"all 30 capabilities must render distinct bytes when Unavailable (invisible: {invisible:?})"
	);
	println!("Unavailable invisible passed: {invisible:?}");
}

#[test]
fn test_all_gated_capabilities_render_distinct_pending_bytes() {
	let mut cx = headless_context().expect("headless context available on GPU host");
	let bundle = startup_assets();
	let assets = Assets {
		tokens:       &bundle.tokens,
		theme:        &bundle.theme,
		surface_path: &bundle.surface_path,
	};
	let options = RenderOptions {
		width: 1180,
		height: 800,
		scale_factor: 1.0,
		appearance: Appearance::Dark,
		..RenderOptions::default()
	};
	let mut window = SceneWindow::open(&mut cx, &options).expect("open scene window");

	let gated = gated_capabilities();
	let mut invisible = Vec::new();

	for capability in &gated {
		let enabled = render_scene_bytes(&mut window, &assets, *capability, GateVariant::Enabled);
		let pending = render_scene_bytes(&mut window, &assets, *capability, GateVariant::Pending);

		if pending == enabled {
			invisible.push(*capability);
		}
	}

	assert_eq!(
		invisible,
		Vec::<Capability>::new(),
		"all 24 gated capabilities must render distinct bytes when Pending"
	);
}

#[test]
fn test_agent_commands_unavailable_transition_retains_native_commands() {
	let mut store = Store::default();
	let mut index = SessionIndex::default();
	let emulators = HashMap::new();
	let mut state = ShellState::default();

	// The drawer command is offered only where the host runs terminals (§5.13),
	// so this host declares them: the count below then measures the notice
	// alone rather than the drawer's own gate.
	store
		.capabilities
		.set(Capability::Terminals, CapabilityStatus::Available);

	let initial_palette = PaletteState::commands();
	let native_command_count = initial_palette.items().len();
	assert!(native_command_count > 0, "palette must contain native commands");
	state.overlay = Some(Overlay::Palette(initial_palette));

	// 1. Set AgentCommands to Unavailable
	store
		.capabilities
		.set(Capability::AgentCommands, CapabilityStatus::Unavailable {
			reason: "slash-command registry owns discovery".to_string(),
		});
	project(&store, &mut index, &emulators, 0, &mut state);

	let overlay = state.overlay.as_ref().expect("overlay open");
	if let Overlay::Palette(palette) = overlay {
		assert_eq!(palette.notice.as_deref(), Some("slash-command registry owns discovery"));
		assert_eq!(
			palette.items().len(),
			native_command_count,
			"native commands must not be filtered out on Unavailable"
		);
	} else {
		panic!("expected Palette overlay");
	}

	// 2. Transition AgentCommands to Available -> notice clears, native commands
	//    unchanged
	store
		.capabilities
		.set(Capability::AgentCommands, CapabilityStatus::Available);
	project(&store, &mut index, &emulators, 0, &mut state);

	let overlay = state.overlay.as_ref().expect("overlay open");
	if let Overlay::Palette(palette) = overlay {
		assert_eq!(palette.notice, None, "notice must be cleared when AgentCommands is Available");
		assert_eq!(
			palette.items().len(),
			native_command_count,
			"native commands must remain intact when Available"
		);
	} else {
		panic!("expected Palette overlay");
	}

	// 3. Transition back to Unavailable -> notice re-appears, native commands
	//    unchanged
	store
		.capabilities
		.set(Capability::AgentCommands, CapabilityStatus::Unavailable {
			reason: "slash-command registry owns discovery".to_string(),
		});
	project(&store, &mut index, &emulators, 0, &mut state);

	let overlay = state.overlay.as_ref().expect("overlay open");
	if let Overlay::Palette(palette) = overlay {
		assert_eq!(palette.notice.as_deref(), Some("slash-command registry owns discovery"));
		assert_eq!(
			palette.items().len(),
			native_command_count,
			"native commands must remain intact on repeated Unavailable transitions"
		);
	} else {
		panic!("expected Palette overlay");
	}
}
