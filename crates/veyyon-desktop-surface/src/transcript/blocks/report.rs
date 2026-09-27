//! A recorded message that is neither a prompt nor a model reply (§5.2).
//!
//! The host states what the message IS — a background job that finished, late
//! diagnostics, a guest's prompt, a skill invocation, agent-to-agent traffic,
//! an advisor note, a dispatched tangent, a handoff summary — as a view, and
//! this draws it with the renderer every tool's output already goes through. No
//! row ceiling: the host bounds the body and counts what it held back, so
//! a second cut here would drop rows the card says it is showing.

use veyyon_desktop_kit::TokenSet;
use veyyon_desktop_model::tool_view::ToolView;
use veyyon_gpui::{App, Div, ParentElement, Styled, WeakEntity, div};

use crate::{
	Intent, ShellView,
	tool_view::{ToolViewCallbacks, render_tool_view},
};

/// Sends an intent through the shell that owns this block, if one is attached.
fn dispatch_to_shell(view: Option<&WeakEntity<ShellView>>, intent: Intent, cx: &mut App) {
	if let Some(shell) = view {
		let _ = shell.update(cx, |shell, cx| shell.dispatch(intent, cx));
	}
}

/// Renders one recorded report from the view its kind states.
///
/// A path or a URL the view names stays reachable: a skill card names the file
/// it read and a diagnostic names the line that failed, and a card a reader
/// cannot follow states an address nobody can use.
pub fn render_report_block(
	view: &ToolView,
	tokens: &TokenSet,
	shell: Option<&WeakEntity<ShellView>>,
) -> Div {
	let target_shell = shell.cloned();
	let callbacks = ToolViewCallbacks::new().on_target(move |target, _window, cx| {
		dispatch_to_shell(target_shell.as_ref(), Intent::OpenToolTarget(target), cx);
	});
	div()
		.flex()
		.flex_col()
		.w_full()
		.child(render_tool_view(view, tokens, None, &callbacks))
}
