//! Pinned opt-out list for commands excluded from the application menu bar.

use super::{
	OptOut, opt_outs_editor::editor_opt_outs, opt_outs_host::host_opt_outs,
	opt_outs_navigation::navigation_opt_outs,
};

/// Every command excluded from the menu bar with its stated rationale.
pub fn opt_outs() -> Vec<OptOut> {
	let mut all = Vec::new();
	all.extend_from_slice(editor_opt_outs());
	all.extend_from_slice(navigation_opt_outs());
	all.extend_from_slice(host_opt_outs());
	all
}
