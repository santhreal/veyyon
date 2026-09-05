//! WHY THIS SUITE EXISTS:
//! §9.4 makes the scene catalogue the operator loop's unit of proof: a scene
//! is a name the CLI turns into a frame with no hand-authored fixture. The
//! defect this closes is a scene the registry lists that the desktop cannot
//! render, or a scene whose frame shows nothing of the state it names.
//!
//! THE CLASS THIS CLOSES:
//! - A protocol enum grows a variant, the registry starts requiring a scene for
//!   it, and `build` has no state for it (`SceneBuildError::Unbuilt`).
//! - A gate that draws nothing: a capability's `Unavailable` or `Pending` scene
//!   renders the same bytes as its `Enabled` scene, so the window has no
//!   control that shows that capability's gate (§1.2, §4.3).
//! - An error that lands nowhere: an `ErrorScope` scene renders the same bytes
//!   as the attached window at rest, so the scope's fallback target draws no
//!   hairline (§4.4).
//! - Two names for one state that nobody recorded: every duplicate outside the
//!   pinned alias list is red.
//! - A control that reads an availability no projection set (§1.2 item 3):
//!   `ControlStates::unprojected` is asserted empty over every scene.
//! - An unreachable state added or removed without the decision being recorded:
//!   the set is pinned by exact equality.
//!
//! Every pin below is shrink-only. `GATES_STILL_INVISIBLE` and
//! `ERRORS_STILL_INVISIBLE` are ledger rows A7 and A8, not decisions: a fix
//! that makes one visible turns the pin red until the row is removed here.
//!
//! WHAT IT DOES NOT CATCH:
//! - A scene that renders the wrong state, as long as the bytes differ from the
//!   baseline. Per-scene geometry belongs in the surface suites.
//! - Non-determinism across processes: one context renders every scene once.

use std::{
	collections::{BTreeMap, BTreeSet},
	path::PathBuf,
};

use strum::IntoEnumIterator as _;
use veyyon_desktop::{
	AssetPaths, StartupBundle, load_startup_bundle,
	scene::{Assets, SceneBuildError, SceneRenderError, SceneWindow, build},
};
use veyyon_desktop_model::{Capability, ErrorScope};
use veyyon_desktop_scene::{
	Appearance, GateVariant, RenderOptions, RequiredState, SceneRegistry, gated_capabilities,
	headless_context,
};

/// The attached window with one live session and one prose exchange, which is
/// what every gate and error scene shows around the thing it names.
const BASELINE: &str = "queue-card/rest";

/// Capabilities whose gate has no control on the frame their scene renders,
/// so `Unavailable` and `Pending` draw the same bytes as `Enabled`. Ledger row
/// A7. Shrink-only.
const GATES_STILL_INVISIBLE: &[Capability] = &[
	Capability::Sessions,
	Capability::SessionDeletion,
	Capability::SessionTreeNavigation,
	Capability::Transcript,
	Capability::BackgroundSubmission,
	Capability::Tools,
	Capability::Approvals,
	Capability::Questions,
	Capability::Plans,
	Capability::Files,
	Capability::Changes,
	Capability::PendingEdits,
	Capability::Terminals,
	Capability::ProcessSupervisor,
	Capability::Providers,
	Capability::Authentication,
	Capability::Mcp,
	Capability::Extensions,
	Capability::Agents,
	Capability::AgentCommands,
	Capability::Tasks,
	Capability::Settings,
	Capability::Themes,
	Capability::Keybindings,
	Capability::Diagnostics,
	Capability::Usage,
	Capability::ContextBreakdown,
	Capability::Lifecycle,
];

/// Scopes whose `request: None` fallback target draws no hairline, so the
/// error scene is the baseline. Ledger row A8. Shrink-only.
const ERRORS_STILL_INVISIBLE: &[ErrorScope] = &[
	ErrorScope::Tool,
	ErrorScope::Interaction,
	ErrorScope::Plan,
	ErrorScope::Terminal,
	ErrorScope::Mcp,
	ErrorScope::Extension,
	ErrorScope::Settings,
	ErrorScope::Diagnostic,
	ErrorScope::Usage,
];

/// Names that are one state on purpose, and names that are one state because
/// the role register draws no label (ledger row A9). Each group is pinned by
/// exact membership.
const ALIASES: &[&[&str]] = &[
	// The attached window before any exchange: the opening line is what the
	// composer and the live section rest against.
	&["composer/rest", "opening-line/rest", "queue-section/live"],
	// The baseline frame, from catalogue entries with the same prose exchange.
	&[BASELINE, "transcript-block/text"],
	// A badge is a card in the live partition with that badge.
	&["queue-badge/watching", "queue-card/watching"],
	&["queue-badge/working", "queue-card/working"],
	// A9: the "noted" and "did" registers draw no role label.
	&["transcript-role/assistant", "transcript-role/custom", "transcript-role/developer"],
	&["transcript-role/branch-summary", "transcript-role/compaction-summary"],
	&["transcript-role/bash-execution", "transcript-role/python-execution"],
];

fn startup_assets() -> StartupBundle {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens");
	load_startup_bundle(AssetPaths {
		tokens_dir: root.join("tokens"),
		themes_dir: root.join("themes"),
	})
	.expect("load startup bundle")
}

#[test]
fn every_scene_builds_except_the_pinned_unreachable_set() {
	let registry = SceneRegistry::new();
	let mut unreachable = Vec::new();
	for scene in registry.iter() {
		match build(scene) {
			Ok(_) => {},
			Err(SceneBuildError::Unreachable { scene, .. }) => unreachable.push(scene),
			Err(error) => panic!("{error}"),
		}
	}
	// A required state nothing in the protocol produces. Adding one here is a
	// decision that the state stays unproven; removing one is a decision that
	// the protocol now reaches it.
	assert_eq!(unreachable, Vec::<String>::new());
}

/// Every scene's bytes, keyed by name, plus the ids every shell scene read
/// without a projection having set them.
fn render_all() -> (BTreeMap<String, Vec<u8>>, BTreeSet<String>) {
	let mut cx = headless_context().expect("headless context must be available on GPU host");
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
	let registry = SceneRegistry::new();
	let mut frames = BTreeMap::new();
	let mut unprojected = BTreeSet::new();
	let mut window = SceneWindow::open(&mut cx, &options).expect("open the scene window");
	for scene in registry.iter() {
		// A renderer crash takes the process with it; under --nocapture this
		// line is what names the scene that crashed.
		eprintln!("rendering {}", scene.name);
		let rendered = match window.render(&assets, scene) {
			Ok(rendered) => rendered,
			Err(SceneRenderError::Build(SceneBuildError::Unreachable { .. })) => continue,
			Err(error) => panic!("{}: {error}", scene.name),
		};
		assert!(
			rendered.captured.layout.iter().next().is_some(),
			"{} rendered no layout boxes, so nothing of it is measurable",
			scene.name
		);
		for id in rendered.unprojected {
			unprojected.insert(format!("{}: {id:?}", scene.name));
		}
		frames.insert(scene.name.clone(), rendered.captured.frame.as_bytes().to_vec());
	}
	(frames, unprojected)
}

fn gate_scene(capability: Capability, gate: GateVariant) -> String {
	RequiredState::CapabilityGate { capability, gate }.scene_name()
}

#[test]
fn every_scene_shows_the_state_it_names() {
	let (frames, unprojected) = render_all();
	let baseline = frames.get(BASELINE).expect("baseline scene renders");
	let gated = gated_capabilities();

	// §1.2 item 2: Unknown draws at rest, so its bytes are Enabled's.
	// §4.3: Unavailable and Pending draw differently from Enabled.
	let mut invisible = Vec::new();
	for capability in Capability::iter() {
		let enabled = &frames[&gate_scene(capability, GateVariant::Enabled)];
		assert_eq!(
			&frames[&gate_scene(capability, GateVariant::Unknown)],
			enabled,
			"{capability:?}: Unknown must draw at rest, as Enabled does"
		);
		let mut visible = &frames[&gate_scene(capability, GateVariant::Unavailable)] != enabled;
		if gated.contains(&capability) {
			visible &= &frames[&gate_scene(capability, GateVariant::Pending)] != enabled;
		}
		if !visible {
			invisible.push(capability);
		}
	}
	assert_eq!(invisible, GATES_STILL_INVISIBLE, "capabilities whose gate draws nothing");

	// §4.4: an error with no request lands on the scope's fallback target.
	let mut invisible = Vec::new();
	for scope in ErrorScope::iter() {
		if &frames[&RequiredState::Error(scope).scene_name()] == baseline {
			invisible.push(scope);
		}
	}
	assert_eq!(invisible, ERRORS_STILL_INVISIBLE, "scopes whose error lands nowhere visible");

	// Every remaining duplicate is a pinned alias group.
	let gate_names: BTreeSet<String> = Capability::iter()
		.flat_map(|c| GateVariant::iter().map(move |g| gate_scene(c, g)))
		.collect();
	let error_names: BTreeSet<String> = ErrorScope::iter()
		.map(|s| RequiredState::Error(s).scene_name())
		.collect();
	let mut by_bytes: BTreeMap<&[u8], Vec<&str>> = BTreeMap::new();
	for (name, bytes) in &frames {
		if gate_names.contains(name) || error_names.contains(name) {
			continue;
		}
		by_bytes.entry(bytes).or_default().push(name);
	}
	let mut duplicates: Vec<Vec<&str>> = by_bytes
		.into_values()
		.filter(|group| group.len() > 1)
		.collect();
	duplicates.sort();
	let mut aliases: Vec<Vec<&str>> = ALIASES.iter().map(|group| group.to_vec()).collect();
	for group in &mut aliases {
		group.sort_unstable();
	}
	aliases.sort();
	assert_eq!(duplicates, aliases, "scenes that render identical bytes");

	// §1.2 item 3: no control reads an availability the projection did not set.
	assert_eq!(unprojected, BTreeSet::new(), "controls read with no projection");
}
