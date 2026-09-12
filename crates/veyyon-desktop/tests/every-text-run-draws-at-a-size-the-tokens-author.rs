//! WHY THIS SUITE EXISTS:
//! §6.3 authors six text sizes and two mono sizes, and §9.3 forbids a silent
//! fallback. gpui's own default text size is 16px, which is not one of them, so
//! any element that paints text without setting a size from the token set draws
//! at a size the product never authored - and it draws it correctly enough to
//! look deliberate. The count ceiling in §6.6 catches that only once the frame
//! is already over six sizes; this suite catches the size itself, in every
//! scene, however few sizes the frame holds.
//!
//! THE CLASS THIS CLOSES: an unauthored text size reaching a frame. The variant
//! space is the registry at run time, so a new scene is swept without being
//! listed here, and the ladder is read from the loaded token files rather than
//! restated, so an authored change to `scale.toml` moves the assertion with it.
//! A breach names the scene, the size and the rect, which is what locates the
//! element that skipped the token.
//!
//! WHAT IT DOES NOT CATCH: a run that draws at an authored size in the wrong
//! place - 26px lead type on a queue row is authored and wrong, and the surface
//! suites own that. It also says nothing about weight or tracking, which the
//! shaped run does not carry back.

use std::{
	collections::{BTreeMap, BTreeSet},
	path::PathBuf,
};

use veyyon_desktop::{
	AssetPaths, StartupBundle, load_startup_bundle,
	scene::{Assets, SceneBuildError, SceneRenderError, SceneWindow},
};
use veyyon_desktop_scene::{Appearance, RenderOptions, SceneRegistry, headless_context};

/// How close a shaped run's size must be to an authored step to be that step.
/// The shaper rounds to device pixels, so an exact comparison would fail on a
/// fractional scale factor.
const TOLERANCE: f32 = 0.1;

fn startup_assets() -> StartupBundle {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens");
	load_startup_bundle(AssetPaths {
		tokens_dir: root.join("tokens"),
		themes_dir: root.join("themes"),
	})
	.expect("load startup bundle")
}

/// Every size `scale.toml` authors, prose and mono.
fn authored_sizes(bundle: &StartupBundle) -> Vec<f32> {
	let scale = &bundle.tokens.scale;
	scale
		.type_sizes
		.iter()
		.chain(scale.mono_sizes.iter())
		.map(|step| step.size)
		.collect()
}

#[test]
fn every_text_run_in_every_scene_draws_at_an_authored_size() {
	let bundle = startup_assets();
	let ladder = authored_sizes(&bundle);
	assert_eq!(ladder.len(), 8, "§6.3 authors six prose sizes and two mono sizes");

	let mut cx = headless_context().expect("headless context must be available on GPU host");
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
	let mut window = SceneWindow::open(&mut cx, &options).expect("open the scene window");

	// One entry per unauthored size, naming the scenes it reached and the first
	// rect it drew in, so a sweep of the whole catalogue reports the defect once
	// rather than once per scene.
	let mut offenders: BTreeMap<i64, (BTreeSet<String>, String)> = BTreeMap::new();
	let mut measured = 0usize;

	for scene in registry.iter() {
		let rendered = match window.render(&assets, scene) {
			Ok(rendered) => rendered,
			Err(SceneRenderError::Build(SceneBuildError::Unreachable { .. })) => continue,
			Err(error) => panic!("{}: {error}", scene.name),
		};
		for run in &rendered.captured.text_runs {
			let size = f32::from(run.font_size);
			measured += 1;
			if ladder
				.iter()
				.any(|authored| (authored - size).abs() <= TOLERANCE)
			{
				continue;
			}
			let rect = format!(
				"{:.0}x{:.0} at {:.0},{:.0}",
				f32::from(run.bounds.size.width),
				f32::from(run.bounds.size.height),
				f32::from(run.bounds.origin.x),
				f32::from(run.bounds.origin.y)
			);
			let entry = offenders
				.entry(size.round() as i64)
				.or_insert_with(|| (BTreeSet::new(), rect));
			entry.0.insert(scene.name.clone());
		}
	}

	assert!(measured > 0, "the sweep measured no text at all, so it proves nothing");
	assert!(
		offenders.is_empty(),
		"unauthored text sizes reached the frame; the ladder is {ladder:?}: {}",
		offenders
			.iter()
			.map(|(size, (scenes, rect))| format!(
				"{size}px in {} scene(s) (first at {rect}, e.g. {})",
				scenes.len(),
				scenes.iter().next().map_or("", String::as_str)
			))
			.collect::<Vec<_>>()
			.join("; ")
	);
}
