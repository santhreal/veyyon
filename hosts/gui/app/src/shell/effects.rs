//! Shell effect execution and panel animation retargeting.

use gpui::{ClipboardItem, Context, Window};
use veyyon_gui_core::{Effects, ShellEffect, UiCommand, navigation::PanelState};
use veyyon_gui_features::shell::{PanelSizes, bottom_height, inspector_width, sidebar_width};
use veyyon_gui_kit::{
	motion::{Damage, Priority, spec},
	paint,
};

use super::Shell;

impl Shell {
	pub(super) fn perform_effects(
		&mut self,
		effects: Effects,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.perform_shell_effects(effects.shell, window, cx);
	}

	pub(super) fn perform_shell_effects(
		&mut self,
		effects: Vec<ShellEffect>,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		for effect in effects {
			match effect {
				ShellEffect::Focus(target) => self.take_the_keyboard(target, window, cx),
				ShellEffect::ChooseAttachments { .. } => {},
				ShellEffect::QuitWindow => cx.quit(),
				ShellEffect::CopyText(text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
				ShellEffect::RevealSelection => self.handles.scrolls.changes_view.scroll_to_bottom(),
				ShellEffect::RevealFile(_) => self.handles.scrolls.files_tree.scroll_to_bottom(),
				ShellEffect::ScrollTranscriptToLatest => self
					.handles
					.timeline
					.update(cx, |timeline, cx| timeline.jump_to_latest(cx)),
				ShellEffect::ScrollTranscriptToOldest => self
					.handles
					.timeline
					.update(cx, |timeline, cx| timeline.jump_to_oldest(cx)),
				ShellEffect::RequestPaste(terminal) => {
					if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
						let _ = self
							.store
							.dispatch(UiCommand::WriteTerminal { terminal, bytes: text.into_bytes() });
					}
				},
				ShellEffect::Notify { message } => self.notice = Some(message),
			}
		}
	}

	/// Send each panel's size to the value this frame should draw it at.
	///
	/// Only a panel whose rest size moved is retargeted, so a command that
	/// leaves the panels alone neither allocates a track nor dirties layout.
	pub(super) fn retarget_panels(&mut self, before: &PanelState, cx: &mut Context<Self>) {
		let was = PanelSizes::rest(before);
		let now = PanelSizes::rest(&self.store.frontend.panels);
		for (key, old, new) in [
			(sidebar_width(), was.sidebar, now.sidebar),
			(inspector_width(), was.inspector, now.inspector),
			(bottom_height(), was.bottom, now.bottom),
		] {
			if (old - new).abs() > f32::EPSILON {
				let _ = paint::retarget(cx, key, spec::LAYOUT, new, Priority::Shell, Damage::Layout(0));
			}
		}
	}
}
