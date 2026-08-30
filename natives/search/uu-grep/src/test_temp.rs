//! This crate's tests use the workspace-wide scratch owner.
//!
//! There was a `TempTree` here, written when only this crate's tests were known
//! to leak. A workspace scan then found the same hand-built temp path in twenty
//! more files across six crates, so the guard moved to `veyyon-test-scratch`
//! where every crate can dev-depend on it, and this module is the local name
//! for it.
//!
//! `unique_tree` keeps the `veyyon-uu-grep-` shape in the directory name, so a
//! directory stranded by a killed process still says which crate made it.

pub(crate) use veyyon_test_scratch::TempTree;

/// Create a scratch tree for this crate's tests, named after `label`.
pub(crate) fn unique_tree(label: &str) -> TempTree {
	veyyon_test_scratch::scratch_dir(&format!("uu-grep-{label}"))
}
