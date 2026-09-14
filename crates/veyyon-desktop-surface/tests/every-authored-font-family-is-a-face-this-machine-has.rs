//! WHY: the UI family was never authored, so every proportional run reached
//! GPUI as `.SystemUIFont`. The Linux text system does not resolve that name:
//! each run missed, walked the fallback stack, and built a miss error whose
//! backtrace capture cost more than the frame, which is the 100%-CPU stall
//! observed while the model picker was open.
//!
//! CLASS CLOSED: a family chain the scale authors that the install never
//! resolves against this machine's faces, for every chain in
//! `[type.family]` rather than for the monospace one alone. The sweep reads
//! the authored table at run time, so a third chain fails here until its
//! install path is wired, and each chain is proved through `install_tokens`,
//! the path a window actually starts through.
//!
//! WHAT THIS DOES NOT CATCH: a surface that resolves the family and then draws
//! a run with an unstated family anyway. A shaped run records no family name in
//! a captured frame, so
//! `eighty-columns-of-mono-are-legible-at-the-drawer-default` observes the
//! monospace face through its advance, and
//! `mono-text-is-set-in-a-family-this-machine-has` in the kit owns the
//! chain-walk rules themselves.

use std::{
	collections::BTreeSet,
	path::{Path, PathBuf},
};

use veyyon_desktop_kit::{Tokens, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{ShellView, fixture, install_tokens};
use veyyon_gpui::{App, AppContext};

/// A face no machine carries, substituted for one authored chain so the
/// install has to report the chain it cannot satisfy.
const ABSENT_FACE: &str = "No Such Face";

/// How one authored chain is emptied of every face this machine has.
type EmptyChain = fn(&mut Tokens);

/// The chains the install resolves, and how each one is emptied of every face
/// this machine has. A key the authored table carries and this table does not
/// fails `every_authored_family_chain_is_resolved_by_the_install`.
fn wired_chains() -> Vec<(&'static str, EmptyChain)> {
	vec![
		(
			"mono",
			(|tokens: &mut Tokens| {
				tokens.scale.mono_family = vec![ABSENT_FACE.to_string()];
			}) as EmptyChain,
		),
		("ui", |tokens: &mut Tokens| {
			tokens.scale.ui_family = vec![ABSENT_FACE.to_string()];
		}),
	]
}

/// The keys of `[type.family]` in the authored scale, read at run time so a
/// chain added to the file is a chain this suite sweeps.
fn authored_family_keys() -> BTreeSet<String> {
	let path =
		PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../veyyon-desktop-tokens/tokens/scale.toml");
	let text = std::fs::read_to_string(&path).expect("the authored scale reads");
	let document: toml::Table = text.parse().expect("the authored scale parses");
	document
		.get("type")
		.and_then(toml::Value::as_table)
		.and_then(|type_tbl| type_tbl.get("family"))
		.and_then(toml::Value::as_table)
		.expect("the scale states a [type.family] table")
		.keys()
		.cloned()
		.collect()
}

/// Every authored chain is asked of this machine, and a chain the machine
/// cannot satisfy stops the install naming its own key. A chain that is
/// authored and never resolved leaves GPUI on its unresolvable default, which
/// is what cost a frame its backtrace captures (§9.3).
#[test]
fn every_authored_family_chain_is_resolved_by_the_install() {
	let wired = wired_chains();
	let swept: BTreeSet<String> = wired.iter().map(|(key, _)| (*key).to_string()).collect();
	assert_eq!(
		swept,
		authored_family_keys(),
		"the authored [type.family] chains and the chains this suite proves have diverged"
	);

	let mut cx = headless_context().expect("headless context available");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let options = RenderOptions { width: 800, height: 600, scale_factor: 1.0, ..Default::default() };
	let outcome = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		for (key, absent) in wired {
			let mut tokens = load_bundled_tokens().expect("the bundled tokens load");
			absent(&mut tokens);
			let error = install_tokens(app, &tokens, &theme, Path::new("surface"))
				.expect_err("an install without a face the chain names must fail");
			let message = error.to_string();
			assert!(message.contains(ABSENT_FACE), "the {key} error omits the family: {message}");
			assert!(
				message.contains(&format!("type.family.{key}")),
				"the {key} error omits the key: {message}"
			);
		}

		let tokens = load_bundled_tokens().expect("the bundled tokens load");
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the shipped chains install");
		let available = app.text_system().all_font_names();
		for (key, resolved) in
			[("mono", installed.set.mono_family()), ("ui", installed.set.ui_family())]
		{
			assert!(
				available.iter().any(|have| have == resolved.as_ref()),
				"the install left {key} on {resolved:?}, which this machine does not carry"
			);
		}
		app.new(|_| ShellView::new(installed, fixture::with_drawer()))
	});
	assert!(outcome.is_ok(), "the fixture window opens once the shipped chains are installed");
}
