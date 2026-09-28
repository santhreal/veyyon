//! The model the shown thread runs on: the model picker, stepping through
//! the host's list and the priority service tier.
//!
//! A model picked from `composer::OpenModelPicker` becomes the default; one
//! picked from `composer::OpenThreadModelPicker`, or stepped to with
//! `composer::NextModel` and `composer::PreviousModel`, is held for the shown
//! thread only.

use gpui::{Context, Window};
use veyyon_desktop_model::{HostAction, HostActionKind, SurfaceId};
use veyyon_desktop_ui::overlays::{MenuItem, MenuRow};

use super::{Pick, row};
use crate::composer::Composer;

impl Composer {
	/// `composer::OpenModelPicker` for `persist`, or
	/// `composer::OpenThreadModelPicker` otherwise: lists the catalog, asking
	/// the host for it when none has arrived, while the host takes a model.
	pub(in crate::composer) fn open_models(
		&mut self,
		persist: bool,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if self.refusal(HostActionKind::SelectModel, cx).is_some() {
			return;
		}
		self.pickers.persist = persist;
		let empty = self
			.app
			.read(cx)
			.store()
			.domains
			.models
			.as_ref()
			.is_none_or(|models| models.models.is_empty());
		if empty {
			self.send_for_session(
				|session| (HostAction::RefreshModels, SurfaceId::ComposerModelSelector(session)),
				cx,
			);
		}
		self.fill_models(cx);
		self.open_picker(|pickers| &pickers.models, window, cx);
	}

	pub(super) fn fill_models(&mut self, cx: &mut Context<Self>) {
		let mut rows = Vec::new();
		if let Some(models) = &self.app.read(cx).store().domains.models {
			let mut provider = None;
			for model in &models.models {
				if provider != Some(model.provider.as_str()) {
					provider = Some(model.provider.as_str());
					rows.push((MenuItem::header(model.provider.clone()), None));
				}
				let current = models
					.current
					.as_ref()
					.is_some_and(|current| current.provider == model.provider && current.id == model.id);
				let pick = Pick::Model { provider: model.provider.clone(), id: model.id.clone() };
				rows.push((row(model.name.clone(), current).into(), Some(pick)));
			}
		}
		if !rows.is_empty() {
			rows.push((MenuItem::Separator, None));
		}
		rows.push((MenuRow::new("Toggle fast mode").hint("/fast").into(), Some(Pick::ToggleFast)));
		rows.push((MenuRow::new("Refresh models").into(), Some(Pick::RefreshModels)));
		self.pickers.models.fill(rows, cx);
	}

	/// `composer::NextModel` for `forward`, or `composer::PreviousModel`: holds
	/// the model beside the current one in the host's list for the shown
	/// thread. A list of one model steps nowhere.
	pub(in crate::composer) fn cycle_model(&self, forward: bool, cx: &mut Context<Self>) {
		let next = self
			.app
			.read(cx)
			.store()
			.domains
			.models
			.as_ref()
			.and_then(|models| {
				let list = &models.models;
				if list.len() <= 1 {
					return None;
				}
				let at = models
					.current
					.as_ref()
					.and_then(|current| {
						list
							.iter()
							.position(|model| model.provider == current.provider && model.id == current.id)
					})
					.unwrap_or(0);
				let step = if forward { 1 } else { list.len() - 1 };
				list
					.get((at + step) % list.len())
					.map(|model| (model.provider.clone(), model.id.clone()))
			});
		if let Some((provider, model)) = next {
			self.select_model(provider, model, false, cx);
		}
	}

	/// Makes `provider`/`model` the default model for `persist`, or holds it
	/// for the shown thread only.
	pub(super) fn select_model(
		&self,
		provider: String,
		model: String,
		persist: bool,
		cx: &mut Context<Self>,
	) {
		self.send_for_session(
			|session| {
				(
					HostAction::SelectModel { provider, model, persist },
					SurfaceId::ComposerModelSelector(session),
				)
			},
			cx,
		);
	}

	/// `composer::ToggleFast`: flips the priority service tier.
	pub(in crate::composer) fn toggle_fast(&self, cx: &mut Context<Self>) {
		self.send_for_session(
			|session| {
				let action =
					HostAction::RunCommand { session: session.clone(), text: "/fast".to_owned() };
				(action, SurfaceId::ComposerModelSelector(session))
			},
			cx,
		);
	}
}
