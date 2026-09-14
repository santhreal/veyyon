//! WHY: §5.14 gives every chord a scope, and GPUI resolves a scoped binding
//! against the key contexts on the focus path. A region therefore needs two
//! things for its chords to exist at all: an element carrying the scope's key
//! context, and a focus handle that element tracks so the context can reach
//! the path. The right panel had neither. Its three chords -- the tab walk in
//! both directions and the diff-mode toggle -- were declared in the shipped
//! table, listed on the keybindings page, wired to `on_action` listeners on
//! the panel container, and dead: the container carried no `Panel` context and
//! held no handle, so a keystroke matched no binding and nothing dispatched.
//! The same two omissions had already killed all seven queue chords once, and
//! the transcript's eight had them too.
//!
//! The composer failed the other way round. It carried the context and the
//! editor inside it held a handle, but gpui transfers focus to every focusable
//! element under the pointer during the bubble phase, and the window root is
//! focusable: a press on the composer's own padding or its row of controls
//! missed the editor's hitbox, so the root took the keyboard, the draft was
//! blurred, the next keystroke went nowhere, and every composer chord went
//! with it.
//!
//! A region needs the handle and the context and nothing else. gpui hands the
//! keyboard to the focusable element under a press during the bubble phase, so
//! a container that tracks a handle takes the focus from a press on a queue
//! row, a panel tab or a tree row on its own; the explicit press handlers the
//! three rails carried were dead, and deleting them leaves this suite green.
//! The composer is the exception, because the handle it needs on the path
//! belongs to the editor inside it and a press on the padding or the controls
//! misses the editor's hitbox.
//!
//! CLASS CLOSED: a scope whose surface cannot take the focus its context rides
//! on, and a surface that loses the focus to a press inside its own box. The
//! sweeps read the shipped table at run time, so a fourth panel chord or a
//! sixth scope is covered the moment it is declared, and the scope-to-surface
//! map is an exhaustive `match`, so a new `Scope` variant fails to compile
//! until whoever added it states which surface takes its focus. The panel
//! sweep also states the negative: with the composer focused, a panel chord
//! must NOT dispatch, which is what makes the context predicate real rather
//! than a label on a binding that would fire from anywhere. The press sweeps
//! walk each region's whole box rather than one point, because the defect
//! lived in the bands a centre-of-the-box click never lands on.
//!
//! NOT CAUGHT: which intent a chord dispatches -- that is each surface's own
//! suite -- and a composer chord swallowed by the editor's own input handler,
//! which reports as handled whether or not the binding resolved. The sweep's
//! composer presses therefore prove the context reachable through a chord no
//! editor consumes, and the draft through the text that arrives in it. The
//! sweep also cannot tell the composer's capture-phase press handler from a
//! bubble-phase one, because no control in the fixture stops propagation;
//! capture is what is wired, so a control that answers a press cannot strand
//! the draft. A press that opens an overlay is exempt by design, so a control
//! that opens a picker and then fails to give the keyboard back on dismissal
//! is the palette suite's ground, not this one's.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Keymap, Scope, ShellView, damage::Region, fixture, install_tokens, keymap::resolve_chord,
	right_panel::PanelTab,
};
use veyyon_gpui::{App, AppContext, Pixels, Point, px};

/// Opens the populated shell at the standard row with the shipped keymap
/// bound, which is what makes a keystroke resolve to an action at all.
fn open_shell(cx: &mut Headless) -> HeadlessSession<'_, ShellView> {
	let tokens = load_bundled_tokens().expect("bundled tokens load");
	let theme = load_bundled_theme("dark").expect("bundled dark theme loads");
	let options =
		RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() };
	HeadlessSession::open(cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, fixture::populated()))
	})
	.expect("session opens offscreen")
}

/// The centre of the box the last frame recorded `region` in.
fn center_of(session: &mut HeadlessSession<'_, ShellView>, region: Region) -> Point<Pixels> {
	let bounds = session
		.update(|view, _window, _cx| view.laid_out().bounds(region))
		.expect("the view is live")
		.unwrap_or_else(|| panic!("the frame recorded no box for {region:?}"));
	bounds.center()
}

/// Every chord the shipped table declares in `scope`, in the spelling a
/// keystroke is parsed from.
fn chords_of(scope: Scope) -> Vec<String> {
	Keymap::default()
		.rows()
		.into_iter()
		.filter(|row| row.scope == scope)
		.map(|row| resolve_chord(&row.chord))
		.collect()
}

/// Dispatches `chord` and reports whether the window handled it and whether
/// anything the shell owns changed: a chord can reach an action as an intent a
/// host must answer or as a window-local change, so an empty intent queue is
/// not silence.
fn dispatch(session: &mut HeadlessSession<'_, ShellView>, chord: &str) -> (bool, bool) {
	let before = session
		.update(|view, _window, _cx| {
			let _ = view.drain_intents();
			view.state().clone()
		})
		.expect("state before the chord");
	let handled = session.keystroke(chord).expect("chord dispatches");
	let observed = session
		.update(|view, _window, _cx| !view.drain_intents().is_empty() || *view.state() != before)
		.expect("effect read");
	(handled, observed)
}

#[test]
fn every_panel_chord_reaches_the_panel_the_pointer_focused() {
	let chords = chords_of(Scope::Panel);
	assert!(
		chords.len() >= 3,
		"the shipped table declares the panel scope's chords; found {chords:?}"
	);

	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_shell(&mut cx);
	session.frame().expect("the first frame renders");
	let panel = center_of(&mut session, Region::Panel);
	let composer = center_of(&mut session, Region::Composer);

	let mut reached_from_the_composer: Vec<String> = Vec::new();
	let mut unreachable: Vec<String> = Vec::new();
	for chord in &chords {
		// A scoped chord is scoped: with the composer holding the focus the
		// panel's context is off the path and the chord resolves to nothing.
		session
			.click(composer)
			.expect("the pointer focuses the composer");
		session.frame().expect("the frame after the press renders");
		let (handled, observed) = dispatch(&mut session, chord);
		if handled || observed {
			reached_from_the_composer
				.push(format!("{chord} (handled={handled}, observed={observed})"));
		}

		session.click(panel).expect("the pointer focuses the panel");
		session.frame().expect("the frame after the press renders");
		let (handled, observed) = dispatch(&mut session, chord);
		if !handled || !observed {
			unreachable.push(format!("{chord} (handled={handled}, observed={observed})"));
		}
	}

	assert_eq!(
		reached_from_the_composer,
		Vec::<String>::new(),
		"a panel chord must not dispatch while the composer holds the focus"
	);
	assert_eq!(
		unreachable,
		Vec::<String>::new(),
		"every chord the table declares in the panel scope must reach the shell once the pointer \
		 focused the panel"
	);
}

#[test]
fn a_press_anywhere_in_a_region_leaves_its_chords_on_the_focus_path() {
	// A region is a box of children that answer presses of their own: a tab
	// selects itself, a tree row opens a file, a queue row selects a session,
	// a turn discloses a block. A press that lands on one of those, rather
	// than on the empty ground a centre press finds, is where the focus was
	// lost. Every scope with a surface is swept down its box at two columns --
	// the leading edge its labels start at, and its middle.
	//
	// A press that opens an overlay is exempt and counted apart: the model
	// chip and the thinking chip hand the keyboard to the catalogue they open,
	// which is the point of pressing them. Every other press has to leave the
	// region's context where a chord can still find it, and the count of
	// those is asserted, so a sweep cannot pass by opening a picker every
	// time.
	let mut lost: Vec<String> = Vec::new();
	let mut swept: Vec<(Scope, usize)> = Vec::new();
	for scope in Scope::iter() {
		let (Some(region), chord) = probe(scope) else {
			continue;
		};
		let chord = resolve_chord(chord);
		// The height decides the step, so the composer's short box is swept as
		// finely as the transcript's tall one: a band 48px high is a row of
		// controls, and a sweep that steps over one proves nothing about it.
		let height = {
			let mut cx = headless_context().expect("headless renderer is required");
			let mut session = open_shell(&mut cx);
			session.frame().expect("the first frame renders");
			let bounds = session
				.update(|view, _window, _cx| view.laid_out().drawn_bounds(region))
				.expect("the view is live")
				.unwrap_or_else(|| panic!("the frame recorded no box for {region:?}"));
			f32::from(bounds.size.height)
		};
		let rows = ((height / 48.0).ceil() as usize).clamp(8, 16);
		let stride = (height - 2.0) / (rows - 1) as f32;
		let mut presses = 0_usize;
		let mut handed_off = 0_usize;
		for step in 0..rows {
			for column in [0.08_f32, 0.5] {
				// A fresh window per press: an overlay or a selection one
				// press left behind must not decide the next.
				let mut cx = headless_context().expect("headless renderer is required");
				let mut session = open_shell(&mut cx);
				session.frame().expect("the first frame renders");
				let bounds = session
					.update(|view, _window, _cx| view.laid_out().drawn_bounds(region))
					.expect("the view is live")
					.unwrap_or_else(|| panic!("the frame recorded no box for {region:?}"));
				let y = (step as f32).mul_add(stride, f32::from(bounds.origin.y) + 1.0);
				let x = f32::from(bounds.size.width).mul_add(column, f32::from(bounds.origin.x));
				session
					.click(Point::new(px(x), px(y)))
					.expect("the pointer presses the region");
				session.frame().expect("the frame after the press renders");
				presses += 1;
				let opened = session
					.update(|view, _window, _cx| view.state().overlay.is_some())
					.expect("the view is live");
				if opened {
					handed_off += 1;
					continue;
				}
				// The composer's own claim is the draft: the keyboard has to be
				// in the editor, not merely somewhere under the `Composer`
				// context, or the press blurred the text it was aimed at.
				if scope == Scope::Composer {
					session.type_text("typed").expect("the keystrokes dispatch");
					let draft = session
						.update(|view, _window, _cx| view.composer_text().to_owned())
						.expect("the view is live");
					if draft != "typed" {
						lost.push(format!("Composer at x={x} y={y} left the draft {draft:?}"));
					}
				}
				let (handled, observed) = dispatch(&mut session, &chord);
				if !handled || !observed {
					lost.push(format!(
						"{scope:?} at x={x} y={y} via {chord} (handled={handled}, observed={observed})"
					));
				}
			}
		}
		swept.push((scope, presses - handed_off));
	}

	for (scope, grounded) in &swept {
		assert!(
			*grounded >= 8,
			"the sweep of {scope:?} must land on its own ground, not only on controls that open an \
			 overlay; {grounded} presses kept the keyboard in the region"
		);
	}
	assert_eq!(
		lost,
		Vec::<String>::new(),
		"a press inside a region's box must leave that region's key context on the focus path"
	);
}

#[test]
fn the_tab_walk_moves_the_panel_through_its_own_tabs_in_both_directions() {
	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_shell(&mut cx);
	session.frame().expect("the first frame renders");
	let panel = center_of(&mut session, Region::Panel);
	session.click(panel).expect("the pointer focuses the panel");
	session.frame().expect("the frame after the press renders");

	let tabs = session
		.update(|view, _window, _cx| view.state().panel.tabs.clone())
		.expect("the view is live");
	assert!(tabs.len() > 1, "the tab walk needs more than one tab; found {tabs:?}");

	// Forward through every tab and back round to the first, then one step
	// backward off the first, which wraps to the last: a walk that clamps
	// instead of wrapping strands the operator on an end tab.
	let mut seen: Vec<PanelTab> = Vec::new();
	for _ in 0..tabs.len() {
		assert!(
			session
				.keystroke(&resolve_chord("primary-alt-]"))
				.expect("the forward chord dispatches"),
			"the forward tab chord must resolve while the panel holds the focus"
		);
		session.frame().expect("the frame after the walk renders");
		seen.push(
			session
				.update(|view, _window, _cx| view.state().panel.active_tab)
				.expect("the view is live"),
		);
	}
	let mut expected: Vec<PanelTab> = tabs[1..].to_vec();
	expected.push(tabs[0]);
	assert_eq!(seen, expected, "the forward walk visits every tab once and wraps to the first");

	assert!(
		session
			.keystroke(&resolve_chord("primary-alt-["))
			.expect("the backward chord dispatches"),
		"the backward tab chord must resolve while the panel holds the focus"
	);
	session.frame().expect("the frame after the walk renders");
	let wrapped = session
		.update(|view, _window, _cx| view.state().panel.active_tab)
		.expect("the view is live");
	assert_eq!(
		wrapped,
		*tabs.last().expect("the panel has tabs"),
		"a backward step off the first tab wraps to the last"
	);
}

/// The surface whose focus carries `scope`'s key context, and a chord of that
/// scope no other handler consumes.
///
/// The `match` is exhaustive on purpose: a new scope cannot be declared
/// without stating the surface that takes its focus, so a scope with no
/// surface fails here at compile time rather than shipping as three dead
/// chords.
const fn probe(scope: Scope) -> (Option<Region>, &'static str) {
	match scope {
		// Global bindings carry no context predicate, so they resolve from
		// whatever holds the focus.
		Scope::Global => (None, "primary-k"),
		// A selection move clamps at the ends of the rail and observes as
		// nothing there; the pin toggle changes the partition whatever row is
		// selected.
		Scope::Queue => (Some(Region::Queue), "p"),
		Scope::Transcript => (Some(Region::Transcript), "primary-f"),
		// Every printable and Enter reaches the composer's editor, which
		// reports them handled whether or not a binding resolved; the model
		// picker is a chord no editor consumes.
		Scope::Composer => (Some(Region::Composer), "primary-shift-m"),
		Scope::Panel => (Some(Region::Panel), "primary-alt-]"),
	}
}

#[test]
fn every_scope_the_keyboard_table_declares_has_a_surface_that_takes_its_focus() {
	let mut unreachable: Vec<String> = Vec::new();
	for scope in Scope::iter() {
		let declared = chords_of(scope);
		assert!(
			!declared.is_empty(),
			"the shipped table declares no chord in the {scope:?} scope, so either the scope or its \
			 bindings are dead"
		);
		let (region, chord) = probe(scope);
		let chord = resolve_chord(chord);
		assert!(
			declared.contains(&chord),
			"the probe chord {chord} is not one the {scope:?} scope declares: {declared:?}"
		);
		// A fresh window per scope, so an overlay or a focus one arm left
		// behind cannot decide the next one.
		let mut cx = headless_context().expect("headless renderer is required");
		let mut session = open_shell(&mut cx);
		session.frame().expect("the first frame renders");
		if let Some(region) = region {
			let at = center_of(&mut session, region);
			session.click(at).expect("the pointer focuses the surface");
			session.frame().expect("the frame after the press renders");
		}
		let (handled, observed) = dispatch(&mut session, &chord);
		if !handled || !observed {
			unreachable
				.push(format!("{scope:?} via {chord} (handled={handled}, observed={observed})"));
		}
	}

	assert_eq!(
		unreachable,
		Vec::<String>::new(),
		"every scope the table declares must have a surface whose focus carries its key context"
	);
}
