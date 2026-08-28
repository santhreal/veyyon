import type { ThemePreference } from "@veyyon/utils/theme-store";
import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";

export type { ThemePreference };

export const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
	system: "light",
	light: "dark",
	dark: "system",
};

export const PREFERENCE_ICON: Record<ThemePreference, LucideIcon> = {
	system: Monitor,
	light: Sun,
	dark: Moon,
};

export const PREFERENCE_LABEL: Record<ThemePreference, string> = {
	system: "System theme",
	light: "Light theme",
	dark: "Dark theme",
};

export interface ThemeToggleProps {
	preference: ThemePreference;
	setPreference: (next: ThemePreference) => void;
	className?: string;
}

export function ThemeToggle({ preference, setPreference, className }: ThemeToggleProps) {
	const Icon = PREFERENCE_ICON[preference];

	return (
		<button
			type="button"
			className={className}
			onClick={() => setPreference(NEXT_PREFERENCE[preference])}
			aria-label={`${PREFERENCE_LABEL[preference]} (click to switch)`}
			title={`${PREFERENCE_LABEL[preference]} — click to switch`}
		>
			<Icon size={16} />
		</button>
	);
}
