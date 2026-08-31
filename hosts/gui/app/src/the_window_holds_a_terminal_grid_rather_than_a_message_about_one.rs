//! WHY: the terminal emulator, the cell grid, the scrollback and the palette
//! resolution all landed in `core::text::terminal` and `features::terminal`,
//! and the window installed no renderer, so `SurfaceHandles::terminal` was
//! `None` for the life of every process. The terminal dock drew the sentence
//! "The terminal renderer is unavailable" instead of a grid, in every window,
//! attached or not. Every test the emulator had passed, because each one built
//! its own renderer and never asked the window for one.
//!
//! The class is a subsystem reachable only from its own tests: a handle the
//! window declares, a surface reads, and nothing fills. Two assertions close
//! it, because either alone stays green while the feature is unreachable. The
//! window must hold a renderer, and the frame that draws the dock must put the
//! terminals it holds through that renderer rather than past it.
//!
//! Not covered: what a cell looks like once the renderer has it. Colour
//! resolution is `features::terminal`'s palette suite, and appearance is the
//! capture rig, since this window draws into a test platform with no display.

use std::{cell::RefCell, rc::Rc};

use gpui::{AnyElement, App, IntoElement, TestAppContext, div};
use veyyon_gui_core::{
	UiCommand,
	host::{HostEvent, SnapshotSection},
	model::{TerminalId, TerminalPhase, TerminalRunView, Versioned},
	navigation::{BottomTab, Route},
};
use veyyon_gui_features::terminal::{
	GridSize, RendererAdapter, RendererDamage, RendererFont, RendererPalette, ViewportState,
};

use crate::the_keyboard_reaches_every_route::{attached, open_with};

#[gpui::test]
fn a_window_installs_the_renderer_the_terminal_dock_reads(cx: &mut TestAppContext) {
	let (shell, cx) = open_with(cx, attached());
	shell.read_with(cx, |shell, _| {
		assert!(
			shell.handles.terminal.is_some(),
			"a window opened with no renderer, so the terminal dock can only draw a message"
		);
	});
}

#[gpui::test]
fn a_window_that_reached_no_host_installs_it_too(cx: &mut TestAppContext) {
	// A recorded scene opens detached, and the terminal frames in the capture
	// rig are what a reader is shown of this feature. A renderer installed on
	// connection would leave every one of those frames showing the message.
	let (shell, cx) = open_with(cx, Vec::new());
	shell.read_with(cx, |shell, _| {
		assert!(!shell.bridge.is_live(), "a window with no seeded events opens detached");
		assert!(
			shell.handles.terminal.is_some(),
			"the capture rig's windows draw a message where the grid should be"
		);
	});
}

/// An id the model accepts. Constructed through the checked path because the
/// field is private, which is what keeps an empty id out of the store.
fn tid(value: &str) -> TerminalId {
	TerminalId::new(value).expect("a non-empty id")
}

/// A run the host reports, with bytes to interpret.
fn run(id: &str) -> TerminalRunView {
	TerminalRunView {
		id:          tid(id),
		command:     "cargo test".to_owned(),
		cwd:         "/workspace".to_owned(),
		phase:       TerminalPhase::Running,
		output:      b"ok\r\n".to_vec(),
		exit_code:   None,
		signal:      None,
		cancelled:   false,
		truncated:   false,
		total_lines: 1,
		total_bytes: 4,
		error:       None,
		artifact_id: None,
	}
}
/// What the frame put through the renderer. A real renderer's own behaviour is
/// proven where it is implemented; what is unproven here is whether the frame
/// reaches one at all, and this is the only observation the trait offers, since
/// a drawn element cannot be read back on a platform with no display.
#[derive(Default)]
struct Recorded {
	reconciled: usize,
	painted:    Vec<TerminalId>,
}

struct CountingRenderer(Rc<RefCell<Recorded>>);

impl RendererAdapter for CountingRenderer {
	fn reconcile(&mut self, _terminal: &TerminalRunView, _revision: u64) {
		self.0.borrow_mut().reconciled += 1;
	}

	fn apply_palette(&mut self, _terminal: &TerminalId, _palette: RendererPalette) {}

	fn apply_font(&mut self, _terminal: &TerminalId, _font: &RendererFont) {}

	fn apply_output(&mut self, _terminal: &TerminalId, _bytes: &[u8]) {}

	fn apply_damage(&mut self, _terminal: &TerminalId, _damage: RendererDamage<'_>) {}

	fn resize(&mut self, _terminal: &TerminalId, _size: GridSize) {}

	fn selection(&self, _terminal: &TerminalId) -> Option<&str> {
		None
	}

	fn clear_selection(&mut self, _terminal: &TerminalId) {}

	fn viewport(
		&mut self,
		terminal: &TerminalId,
		_state: ViewportState<'_>,
		_cx: &mut App,
	) -> AnyElement {
		self.0.borrow_mut().painted.push(terminal.clone());
		div().into_any_element()
	}
}

#[gpui::test]
fn the_frame_that_draws_the_dock_puts_its_terminals_through_the_renderer(cx: &mut TestAppContext) {
	let mut events = attached();
	events.push(HostEvent::Snapshot(SnapshotSection::Terminals(Versioned {
		revision: 1,
		value:    vec![run("term-1")],
	})));
	let (shell, cx) = open_with(cx, events);

	// The window's own renderer is replaced by one that records, because a
	// retained renderer answers nothing about the frame that drew it. The
	// window still supplies the slot: a `None` here draws the message, and the
	// counts below stay at zero.
	let recorded = Rc::new(RefCell::new(Recorded::default()));
	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| {
			shell.handles.terminal = Some(Box::new(CountingRenderer(Rc::clone(&recorded))));
			shell.perform(UiCommand::Navigate(Route::Conversation), window, cx);
			shell.perform(UiCommand::SetBottomTab(BottomTab::Terminals), window, cx);
			if !shell.store.frontend.panels.bottom_open {
				shell.perform(UiCommand::ToggleBottomDock, window, cx);
			}
		});
	});
	cx.run_until_parked();

	shell.read_with(cx, |shell, _| {
		assert!(shell.store.frontend.panels.bottom_open, "the dock never opened");
		assert_eq!(shell.store.frontend.bottom_tab, BottomTab::Terminals);
	});

	let recorded = recorded.borrow();
	let (reconciled, painted) = (recorded.reconciled, recorded.painted.clone());

	assert!(reconciled > 0, "the frame drew the message instead of reconciling the run");
	assert_eq!(
		painted,
		vec![tid("term-1")],
		"the dock painted no grid for the run the window holds"
	);
}
