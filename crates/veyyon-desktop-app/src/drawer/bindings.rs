//! The App-level listeners of the drawer's actions, so a binding or the
//! palette reaches the window's drawer wherever the focus is.

use veyyon_gpui::{App, Context, Global, WeakEntity};

use super::{DrawerTab, TerminalDrawer, terminal::Control};
use crate::{actions::drawer as act, workspace::WorkspaceLayout};

/// The drawer the App-level drawer actions reach.
pub(super) struct DrawerHandle(pub(super) WeakEntity<TerminalDrawer>);

impl Global for DrawerHandle {}

/// Registers the drawer's App-level action listeners.
pub fn init(cx: &mut App) {
	on(cx, |_: &act::NewTerminal, drawer, cx| drawer.new_terminal(cx));
	on(cx, |_: &act::CloseTerminal, drawer, cx| drawer.terminal_control(Control::Close, cx));
	on(cx, |_: &act::ClearTerminal, drawer, cx| drawer.terminal_control(Control::Clear, cx));
	on(cx, |_: &act::RestartTerminal, drawer, cx| drawer.terminal_control(Control::Restart, cx));
	on(cx, |_: &act::NextTab, drawer, cx| drawer.step(1, cx));
	on(cx, |_: &act::PreviousTab, drawer, cx| drawer.step(-1, cx));
	on(cx, |_: &act::ShowProcesses, drawer, cx| {
		WorkspaceLayout::update(cx, |layout| layout.drawer_open = true);
		drawer.show(DrawerTab::Processes, cx);
	});
	on(cx, |_: &act::RefreshProcesses, drawer, cx| drawer.refresh_processes(cx));
	on(cx, |_: &act::Copy, drawer, cx| drawer.copy(cx));
	on(cx, |_: &act::Paste, drawer, cx| drawer.paste(cx));
}

/// Runs `run` on the window's drawer when `A` is dispatched.
fn on<A: gpui::Action>(
	cx: &mut App,
	run: impl Fn(&A, &mut TerminalDrawer, &mut Context<TerminalDrawer>) + 'static,
) {
	cx.on_action(move |action: &A, cx| {
		if let Some(drawer) = cx
			.try_global::<DrawerHandle>()
			.and_then(|handle| handle.0.upgrade())
		{
			drawer.update(cx, |drawer, cx| run(action, drawer, cx));
		}
	});
}
