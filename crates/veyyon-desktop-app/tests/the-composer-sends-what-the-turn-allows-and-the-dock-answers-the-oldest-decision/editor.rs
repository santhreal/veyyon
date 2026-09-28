//! The composer edits its draft in the editor `$VISUAL` or `$EDITOR` names.
//!
//! WHY: the draft could not be opened in an external editor, so the key
//! reached for did nothing. An edit whose text lands in whatever thread is
//! shown when the editor exits puts one thread's prompt in another's draft;
//! one applied after the editor failed replaces the draft with the file as
//! it was left; a second press while the editor is open opens a second
//! editor over the same draft; a graphical editor started without its wait
//! flag returns at once and the draft comes back unchanged.
//!
//! Gap: the editor is a script the test writes, so no graphical editor runs;
//! its wait flag is read from the arguments the script receives. The editor
//! command the environment sets is not read here.

use std::{fs, os::unix::fs::PermissionsExt as _, path::Path};

use gpui::{Action as _, TestAppContext};
use veyyon_desktop_app::{actions::composer::EditDraftExternally, composer::external};
use veyyon_test_scratch::scratch_dir;

use super::{Win, other, sid, window};

/// An editor at `dir/name` that records its arguments in `dir/runs`, copies
/// the file it was given to `dir/seen` and leaves `edited` in it, exiting
/// with `status`.
fn editor(dir: &Path, name: &str, edited: &str, status: u8) -> String {
	let path = dir.join(name);
	let script = format!(
		"#!/bin/sh\ndir=$(dirname \"$0\")\nfor last; do :; done\nprintf '%s\\n' \"$*\" >> \
		 \"$dir/runs\"\ncp \"$last\" \"$dir/seen\"\nprintf '{edited}' > \"$last\"\nexit {status}\n"
	);
	fs::write(&path, script).expect("the scratch directory is writable");
	fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("the script is ours");
	path.display().to_string()
}

/// Opens drafts in `command`, writing their files in `drafts`.
fn use_editor(w: &mut Win<'_>, command: Option<String>, drafts: &Path) {
	let drafts = drafts.to_path_buf();
	w.cx.update(|_, cx| external::install(command, drafts, cx));
}

/// The argument lines the editor at `dir` was run with, each without the
/// file it was given, which must lie in `drafts`.
fn runs(dir: &Path, drafts: &Path) -> Vec<String> {
	let runs = fs::read_to_string(dir.join("runs")).unwrap_or_default();
	runs
		.lines()
		.map(|line| {
			let (args, file) = line.rsplit_once(' ').unwrap_or(("", line));
			assert!(Path::new(file).starts_with(drafts), "{file} is written in the drafts directory");
			args.to_owned()
		})
		.collect()
}

fn notice(w: &Win<'_>) -> Option<String> {
	w.composer
		.read_with(&*w.cx, |composer, _| composer.notice().map(str::to_owned))
}

#[gpui::test]
fn the_text_the_editor_saves_replaces_the_draft_and_a_failed_edit_leaves_it(
	app: &mut TestAppContext,
) {
	let tree = scratch_dir("composer-edits-externally");
	let drafts = tree.join("drafts");
	let mut w = window(app, Vec::new());
	use_editor(&mut w, Some(editor(&tree, "ed", "from the editor\n", 0)), &drafts);
	w.write("typed here");
	w.focus();
	w.keys("ctrl-g");
	assert_eq!(fs::read_to_string(tree.join("seen")).ok().as_deref(), Some("typed here"));
	assert_eq!(w.draft(), "from the editor", "one trailing newline is dropped");
	assert_eq!(w.saved(&sid()).map(|draft| draft.draft_text).as_deref(), Some("from the editor"));
	assert_eq!(runs(&tree, &drafts), vec![String::new()]);
	assert_eq!(fs::read_dir(&drafts).map(Iterator::count).ok(), Some(0), "the file is removed");
	assert_eq!(notice(&w), None);

	use_editor(&mut w, Some(editor(&tree, "ed", "half written", 3)), &drafts);
	w.keys("ctrl-g");
	assert_eq!(w.draft(), "from the editor", "an editor that failed leaves the draft");
	let stated = notice(&w).unwrap_or_default();
	assert!(stated.contains("exited") && stated.contains('3'), "{stated}");

	use_editor(&mut w, Some(tree.join("absent").display().to_string()), &drafts);
	w.keys("ctrl-g");
	let stated = notice(&w).unwrap_or_default();
	assert!(stated.starts_with("Cannot edit the draft in"), "{stated}");
	use_editor(&mut w, None, &drafts);
	w.keys("ctrl-g");
	assert_eq!(notice(&w).as_deref(), Some("No editor is set: set $VISUAL or $EDITOR."));
	assert_eq!(w.draft(), "from the editor");
}

#[gpui::test]
fn an_editor_that_forks_is_kept_open_and_one_told_to_wait_is_not_told_twice(
	app: &mut TestAppContext,
) {
	let tree = scratch_dir("composer-editor-waits");
	let drafts = tree.join("drafts");
	let mut w = window(app, Vec::new());
	let code = editor(&tree, "code", "x", 0);
	w.write("draft");
	w.focus();
	use_editor(&mut w, Some(code.clone()), &drafts);
	w.keys("ctrl-g");
	use_editor(&mut w, Some(format!("{code} -w")), &drafts);
	w.keys("ctrl-g");
	assert_eq!(runs(&tree, &drafts), vec!["--wait".to_owned(), "-w".to_owned()]);
}

#[gpui::test]
fn an_edit_saved_after_its_thread_was_left_lands_in_that_thread_and_opens_once(
	app: &mut TestAppContext,
) {
	let tree = scratch_dir("composer-edit-follows-its-thread");
	let drafts = tree.join("drafts");
	let mut w = window(app, Vec::new());
	use_editor(&mut w, Some(editor(&tree, "ed", "for s", 0)), &drafts);
	w.write("draft of s");
	w.focus();
	w.cx.update(|window, cx| {
		window.dispatch_action(EditDraftExternally.boxed_clone(), cx);
		window.dispatch_action(EditDraftExternally.boxed_clone(), cx);
	});
	w.state.update(w.cx, |state, cx| {
		state.open_session(other(), cx);
	});
	w.cx.run_until_parked();
	assert_eq!(runs(&tree, &drafts).len(), 1, "a second press opens no second editor");
	assert_eq!(w.draft(), "", "the thread shown now keeps its own draft");
	assert_eq!(
		w.saved(&other())
			.map(|draft| draft.draft_text)
			.unwrap_or_default(),
		""
	);
	assert_eq!(w.saved(&sid()).map(|draft| draft.draft_text).as_deref(), Some("for s"));
	w.show(sid());
	assert_eq!(w.draft(), "for s");
}
