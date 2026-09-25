//! WHY THIS SUITE EXISTS:
//! §4.3 and §1.2 define the capability gate rendering policy across four
//! variants:
//! - `Enabled`: at rest.
//! - `Unknown`: at rest, activation attaches then acts; never drawn disabled
//!   (§1.2 item 2, §4.3). Therefore, `Enabled` and `Unknown` render IDENTICALLY
//!   by design.
//! - `Pending`: in place, at 0.6 strength, activation suppressed, no spinner
//!   under 400ms. Renders distinctly from `Enabled` and `Unknown`.
//! - `Unavailable`: muted, with the reason readable at the control and no retry
//!   (§1.2 item 1). Renders distinctly from `Enabled`, `Unknown`, and
//!   `Pending`.
//!
//! For capabilities that gate no host action, no request can ever be in flight
//! (§9.5), so `Pending` is unreachable and returns
//! `SceneBuildError::Unreachable`. Their declared partition is `Enabled =
//! Unknown | Unavailable`.
//!
//! THE CLASS THIS CLOSES:
//! - A capability whose `Unknown` state draws disabled or missing instead of at
//!   rest.
//! - A capability whose `Unavailable` state renders identically to `Enabled`,
//!   concealing the unavailable reason from the operator.
//! - A capability whose `Pending` state draws identically to `Enabled` or
//!   `Unavailable`, or where four distinct visual states are drawn instead of
//!   three.
//! - A new capability added to `Capability` without an explicit gate decision
//!   or whose surface fails to render the declared partition.
//! - A capability silently losing its host action mapping and pending state.
//!
//! THE FOUR MEASURED DEFECTS IT WOULD HAVE CAUGHT
//! (.internal/capability-gate-findings.md):
//! 1. `changes` drew `Unknown` as `Unavailable` (`enabled | pending |
//!    unavailable=unknown`), withholding the diff tab before attach and causing
//!    layout shift (§1.2 item 2). Caught by `Enabled == Unknown`.
//! 2. `files` drew `Unknown` as `Unavailable` (`enabled | pending |
//!    unavailable=unknown`), withholding the files and tree tabs before attach
//!    (§1.2 item 2). Caught by `Enabled == Unknown`.
//! 3. `pending-edits` rendered `Unavailable` identically to `Enabled`
//!    (`enabled=unavailable=unknown`), failing to display the unavailable
//!    reason on any surface (§1.2 item 1). Caught by `Unavailable != Enabled`.
//! 4. `process-supervisor` drew `Unknown` distinctly from `Enabled` (`enabled |
//!    pending | unavailable | unknown`), producing four distinct variants
//!    instead of drawing `Unknown` at rest (§4.3). Caught by `Enabled ==
//!    Unknown`.
//!
//! WHAT IT DOES NOT CATCH:
//! - Pixel identity proves two variants render the same; it does not prove
//!   either renders correctly. A capability whose variants are all wrong in the
//!   same way partitions as identical here.
//! - Measured in dark mode at 1180x800 only.
//! - Does not assert exact geometry or token contrast levels; surface suites
//!   test specific element positions and styling.

use std::{
	collections::{BTreeMap, BTreeSet},
	path::PathBuf,
};

use strum::IntoEnumIterator as _;
use veyyon_desktop::{
	AssetPaths, StartupBundle, load_startup_bundle,
	scene::{Assets, SceneBuildError, SceneRoot, SceneWindow, build::capability_gate},
};
use veyyon_desktop_model::Capability;
use veyyon_desktop_scene::{
	Appearance, GateVariant, RenderOptions, RequiredState, gated_capabilities, headless_context,
};

/// Capabilities that gate no host action (§9.5), so no request can be in flight
/// and `GateVariant::Pending` is unreachable. Their partition is
/// `enabled=unknown | unavailable`.
const DECLARED_PENDING_OPT_OUTS: &[Capability] = &[
	Capability::BackgroundSubmission,
	Capability::Extensions,
	Capability::PendingEdits,
	Capability::Plans,
	Capability::Questions,
	Capability::Todo,
];

fn startup_assets() -> StartupBundle {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens");
	load_startup_bundle(AssetPaths {
		tokens_dir: root.join("tokens"),
		themes_dir: root.join("themes"),
	})
	.expect("load startup bundle")
}

const fn gate_variant_name(gate: GateVariant) -> &'static str {
	match gate {
		GateVariant::Enabled => "enabled",
		GateVariant::Pending => "pending",
		GateVariant::Unavailable => "unavailable",
		GateVariant::Unknown => "unknown",
	}
}

const fn variant_rank(gate: GateVariant) -> u8 {
	match gate {
		GateVariant::Enabled => 0,
		GateVariant::Pending => 1,
		GateVariant::Unavailable => 2,
		GateVariant::Unknown => 3,
	}
}

/// Computes the human-readable partition string (e.g. `enabled=unknown |
/// pending | unavailable`) from rendered gate variant frame byte slices.
fn compute_partition(variants: &[(GateVariant, &[u8])]) -> String {
	let mut groups: Vec<Vec<GateVariant>> = Vec::new();
	let mut group_bytes: Vec<&[u8]> = Vec::new();

	for &(variant, bytes) in variants {
		if let Some(idx) = group_bytes.iter().position(|&b| b == bytes) {
			groups[idx].push(variant);
		} else {
			groups.push(vec![variant]);
			group_bytes.push(bytes);
		}
	}

	for group in &mut groups {
		group.sort_by_key(|&g| variant_rank(g));
	}

	groups.sort_by_key(|g| g.first().map_or(255, |&v| variant_rank(v)));

	groups
		.iter()
		.map(|g| {
			g.iter()
				.map(|&v| gate_variant_name(v))
				.collect::<Vec<_>>()
				.join("=")
		})
		.collect::<Vec<_>>()
		.join(" | ")
}

#[test]
fn every_capability_renders_its_gate_variants_in_the_declared_partition() {
	let gated = gated_capabilities();
	let expected_opt_outs: BTreeSet<Capability> =
		Capability::iter().filter(|c| !gated.contains(c)).collect();

	let declared_opt_outs: BTreeSet<Capability> =
		DECLARED_PENDING_OPT_OUTS.iter().copied().collect();
	assert_eq!(
		expected_opt_outs, declared_opt_outs,
		"pending opt-out set computed from action_to_capability must match DECLARED_PENDING_OPT_OUTS"
	);

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
	let mut window = SceneWindow::open(&mut cx, &options).expect("open the scene window");

	let mut pending_opt_outs = BTreeSet::new();
	let mut unconstructable = BTreeSet::new();
	let mut partition_failures = Vec::new();

	for capability in Capability::iter() {
		let mut frames: BTreeMap<GateVariant, Vec<u8>> = BTreeMap::new();

		for gate in GateVariant::iter() {
			let name = RequiredState::CapabilityGate { capability, gate }.scene_name();
			match capability_gate(&name, capability, gate) {
				Ok(built) => {
					let root = SceneRoot::Shell(Box::new(built));
					let rendered = window
						.render_root(&assets, root)
						.unwrap_or_else(|error| panic!("render {name}: {error}"));
					frames.insert(gate, rendered.captured.frame.as_bytes().to_vec());
				},
				Err(SceneBuildError::Unreachable { .. }) => {
					if gate == GateVariant::Pending {
						pending_opt_outs.insert(capability);
					} else {
						unconstructable.insert((capability, gate));
					}
				},
				Err(error) => {
					panic!("build {name}: {error}");
				},
			}
		}

		let Some(enabled) = frames.get(&GateVariant::Enabled).map(Vec::as_slice) else {
			unconstructable.insert((capability, GateVariant::Enabled));
			continue;
		};
		let Some(unknown) = frames.get(&GateVariant::Unknown).map(Vec::as_slice) else {
			unconstructable.insert((capability, GateVariant::Unknown));
			continue;
		};
		let Some(unavailable) = frames.get(&GateVariant::Unavailable).map(Vec::as_slice) else {
			unconstructable.insert((capability, GateVariant::Unavailable));
			continue;
		};
		let pending = frames.get(&GateVariant::Pending).map(|f| f.as_slice());

		let mut variant_slices = vec![
			(GateVariant::Enabled, enabled),
			(GateVariant::Unknown, unknown),
			(GateVariant::Unavailable, unavailable),
		];
		if let Some(p) = pending {
			variant_slices.push((GateVariant::Pending, p));
		}

		let actual_partition = compute_partition(&variant_slices);

		let expected_partition = if expected_opt_outs.contains(&capability) {
			"enabled=unknown | unavailable"
		} else {
			"enabled=unknown | pending | unavailable"
		};

		let mut cap_failures = Vec::new();
		if enabled != unknown {
			cap_failures.push(
				"Enabled and Unknown must render identically (Unknown rendered at rest)".to_string(),
			);
		}
		if unavailable == enabled {
			cap_failures.push(
				"Unavailable must differ from Enabled (reason must be readable at control)".to_string(),
			);
		}
		if unavailable == unknown {
			cap_failures.push("Unavailable must differ from Unknown".to_string());
		}
		if let Some(p) = pending {
			if p == enabled {
				cap_failures
					.push("Pending must differ from Enabled (in place at 0.6 strength)".to_string());
			}
			if p == unknown {
				cap_failures.push("Pending must differ from Unknown".to_string());
			}
			if unavailable == p {
				cap_failures.push("Unavailable must differ from Pending".to_string());
			}
		}

		if !cap_failures.is_empty() || actual_partition != expected_partition {
			partition_failures.push(format!(
				"{capability:?}:\n  actual partition:   '{actual_partition}'\n  expected partition: \
				 '{expected_partition}'\n  violations: {}",
				cap_failures.join(", ")
			));
		}
	}

	assert!(
		unconstructable.is_empty(),
		"capabilities the harness cannot construct at all: {unconstructable:?}"
	);

	assert_eq!(
		pending_opt_outs, expected_opt_outs,
		"pending opt-out set must match gated_capabilities complement by exact equality"
	);

	assert!(
		partition_failures.is_empty(),
		"Capability gate partition policy violations ({} of {} capabilities failed):\n\n{}",
		partition_failures.len(),
		Capability::iter().count(),
		partition_failures.join("\n\n")
	);
}
