//! Preference updates, theme previews, and shell clipboard effects.

use crate::{
	command::UiCommand,
	model::*,
	navigation::*,
	store::{Effects, FocusTarget, ShellEffect, Store},
};

impl Store {
	pub(super) fn dispatch_preferences(
		&mut self,
		command: &UiCommand,
		effects: &mut Effects,
	) -> bool {
		match command {
			UiCommand::SetModelFavorite { provider, model, favorite } => {
				if *favorite {
					self
						.frontend
						.favorite_models
						.insert((provider.clone(), model.clone()));
				} else {
					self
						.frontend
						.favorite_models
						.remove(&(provider.clone(), model.clone()));
				}
			},
			UiCommand::EditSetting { path, value } => {
				self
					.frontend
					.setting_edits
					.insert(path.clone(), value.clone());
			},
			UiCommand::PreviewTheme(id) => self.frontend.theme_preview = Some(id.clone()),
			UiCommand::CancelThemePreview => self.frontend.theme_preview = None,
			UiCommand::SetDarkAppearance(value) => self.frontend.preferences.dark = *value,
			UiCommand::SetFontSize { milli_px } => {
				self.frontend.preferences.font_size_milli_px =
					(*milli_px).clamp(font_size::MIN_MILLI_PX, font_size::MAX_MILLI_PX)
			},
			UiCommand::SetReducedMotion(value) => self.frontend.preferences.reduced_motion = *value,
			UiCommand::SetDiffLayout(value) => self.frontend.preferences.diff_layout = *value,
			UiCommand::SetDiffWrap(value) => self.frontend.preferences.wrap_diff = *value,
			UiCommand::SetDiffWhitespace(value) => self.frontend.preferences.show_whitespace = *value,
			UiCommand::SetGroupSessionsByWorkspace(value) => {
				self.frontend.preferences.group_sessions_by_workspace = *value
			},
			UiCommand::QuitWindow => effects.shell.push(ShellEffect::QuitWindow),
			UiCommand::CopyText(text) => effects.shell.push(ShellEffect::CopyText(text.clone())),
			UiCommand::FocusComposer => effects
				.shell
				.push(ShellEffect::Focus(FocusTarget::Composer)),
			UiCommand::FocusPalette => effects.shell.push(ShellEffect::Focus(FocusTarget::Palette)),
			UiCommand::FocusTerminal(id) => effects
				.shell
				.push(ShellEffect::Focus(FocusTarget::Terminal(id.clone()))),
			UiCommand::CopyEntry(id) => self.copy_entry(id, effects),
			UiCommand::OpenImage { entry, index } => self
				.frontend
				.overlays
				.push(Overlay::ImageViewer { entry: entry.clone(), index: *index }),
			UiCommand::JumpToLatest => effects.shell.push(ShellEffect::ScrollTranscriptToLatest),
			UiCommand::JumpToOldest => effects.shell.push(ShellEffect::ScrollTranscriptToOldest),
			UiCommand::RevealSelectedFile => effects.shell.push(ShellEffect::RevealSelection),
			UiCommand::RevealFile(file) => effects.shell.push(ShellEffect::RevealFile(file.clone())),
			UiCommand::CopyTerminalSelection { text, .. } => {
				effects.shell.push(ShellEffect::CopyText(text.clone()))
			},
			UiCommand::PasteTerminal(id) => effects.shell.push(ShellEffect::RequestPaste(id.clone())),
			UiCommand::CopyDiagnostic(id) => self.copy_diagnostic(id, effects),
			UiCommand::OpenDiagnostic(_) => effects.shell.push(ShellEffect::RevealSelection),
			UiCommand::CopyOutput => self.copy_output(effects),
			_ => return false,
		}
		true
	}

	pub(crate) fn copy_entry(&self, id: &EntryId, effects: &mut Effects) {
		let Some(versioned) = self.replica.transcript.readable() else {
			return;
		};
		let Some(entry) = versioned.value.iter().find(|entry| &entry.id == id) else {
			return;
		};
		let text = entry
			.content
			.iter()
			.filter_map(|block| match block {
				ContentBlock::Text { text }
				| ContentBlock::Thinking { text }
				| ContentBlock::Summary { text, .. } => Some(text.as_str()),
				_ => None,
			})
			.collect::<Vec<_>>()
			.join("\n");
		effects.shell.push(ShellEffect::CopyText(text));
	}

	pub(crate) fn copy_diagnostic(&self, id: &NoticeId, effects: &mut Effects) {
		if let Some(row) = self
			.replica
			.diagnostics
			.readable()
			.and_then(|versioned| versioned.value.notices.iter().find(|row| &row.id == id))
		{
			effects
				.shell
				.push(ShellEffect::CopyText(row.message.clone()));
		}
	}

	pub(crate) fn copy_output(&self, effects: &mut Effects) {
		if let Some(versioned) = self.replica.output.readable() {
			effects.shell.push(ShellEffect::CopyText(
				versioned
					.value
					.iter()
					.map(|record| record.message.as_str())
					.collect::<Vec<_>>()
					.join("\n"),
			));
		}
	}
}
