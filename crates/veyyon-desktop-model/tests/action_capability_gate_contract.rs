use veyyon_desktop_model::{
	Capability, CapabilityMap, CapabilityStatus, Gate, HostActionKind, RequestId, RequestRegistry,
	SurfaceId, action_to_capability, gate_kind,
};

#[test]
fn test_all_actions_mapped_to_capabilities() {
	let all_actions = HostActionKind::ALL;
	let all_capabilities = Capability::ALL;

	// Assert count dynamically from the enum definitions.
	assert_eq!(all_actions.len(), 72, "Expected 72 actions in HostActionKind");
	assert_eq!(all_capabilities.len(), 30, "Expected 30 capabilities in Capability");

	// Sweep every action kind and ensure total mapping to a valid capability.
	for &action in &all_actions {
		let capability = action_to_capability(action);
		assert!(
			all_capabilities.contains(&capability),
			"Action {action:?} mapped to unknown capability {capability:?}"
		);
	}
}

#[test]
fn test_capability_gate_resolves_all_four_states() {
	let mut capabilities = CapabilityMap::new();
	let mut registry = RequestRegistry::new();

	for &action in &HostActionKind::ALL {
		// 1. Initial state: UnknownUntilAttached -> Gate::Unknown
		let initial_gate = gate_kind(action, &capabilities, &registry);
		assert_eq!(
			initial_gate,
			Gate::Unknown,
			"Expected Unknown gate for action {action:?} when capability is unattached"
		);

		// 2. Available state: Gate::Enabled
		let cap = action_to_capability(action);
		capabilities.set(cap, CapabilityStatus::Available);
		let enabled_gate = gate_kind(action, &capabilities, &registry);
		assert_eq!(
			enabled_gate,
			Gate::Enabled,
			"Expected Enabled gate for action {action:?} when capability is Available"
		);

		// 3. Pending state: Gate::Pending when in-flight request exists
		let req_id = RequestId(100);
		registry.register(req_id, action, SurfaceId::GlobalTitlebarLine, 1000, 5000);
		let pending_gate = gate_kind(action, &capabilities, &registry);
		assert_eq!(
			pending_gate,
			Gate::Pending { request: req_id },
			"Expected Pending gate for action {action:?} when in-flight request exists"
		);
		registry.complete(&req_id);

		// 4. Unavailable state: Gate::Unavailable with reason
		let reason = "Feature disabled on host".to_string();
		capabilities.set(cap, CapabilityStatus::Unavailable { reason: reason.clone() });
		let unavailable_gate = gate_kind(action, &capabilities, &registry);
		assert_eq!(
			unavailable_gate,
			Gate::Unavailable { reason: reason.clone() },
			"Expected Unavailable gate for action {action:?} when capability is Unavailable"
		);

		// Reset capability back to unknown
		capabilities.set(cap, CapabilityStatus::UnknownUntilAttached);
	}
}
