//! Host action emission and capability checks.

mod service;
mod session;
mod system;

use crate::{
	command::UiCommand,
	host::HostAction,
	model::*,
	store::{CommandTarget, Completion, Effects, ShellEffect, Store},
};

impl Store {
	pub(super) fn dispatch_host(&mut self, command: UiCommand, effects: &mut Effects) {
		let mapped = self
			.map_session_action(&command)
			.or_else(|| self.map_system_action(command.clone(), effects))
			.or_else(|| self.map_service_action(command));
		if let Some((action, target, completion, capability)) = mapped {
			self.emit_checked(action, target, completion, capability, effects);
		}
	}

	pub(crate) fn emit_checked(
		&mut self,
		action: HostAction,
		target: CommandTarget,
		completion: Completion,
		capability: Option<Capability>,
		effects: &mut Effects,
	) {
		if let Some(capability) = capability {
			if !self.connection.is_connected() {
				effects.shell.push(ShellEffect::Notify {
					message: "Connect before using this action".to_owned(),
				});
				return;
			}
			match self.replica.capability(capability) {
				CapabilityStatus::Available => {},
				CapabilityStatus::Unavailable { reason } => {
					effects
						.shell
						.push(ShellEffect::Notify { message: reason.clone() });
					return;
				},
				CapabilityStatus::UnknownUntilAttached => {
					effects.shell.push(ShellEffect::Notify {
						message: "Host has not reported this capability".to_owned(),
					});
					return;
				},
			}
		}
		self.emit(action, target, completion, effects);
	}
}
