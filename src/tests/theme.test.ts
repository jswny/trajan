import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { themePreference } from "../theme";

it("reads and writes the prepaint script's theme format and falls back to Auto without storage", () => {
	const saved = new Map([["trajan-theme", "dark"]]);
	const dataset = { theme: "dark" };
	vi.stubGlobal("document", { documentElement: { dataset } });
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => saved.get(key) ?? null,
		setItem: (key: string, value: string) => saved.set(key, value),
	});
	const registry = AtomRegistry.make();
	const unavailableStorage = AtomRegistry.make();
	try {
		expect(registry.get(themePreference)).toBe("dark");
		registry.set(themePreference, "light");
		expect(registry.get(themePreference)).toBe("light");
		expect(dataset.theme).toBe("light");
		expect(saved.get("trajan-theme")).toBe("light");

		vi.stubGlobal("localStorage", undefined);
		expect(unavailableStorage.get(themePreference)).toBe("auto");
		unavailableStorage.set(themePreference, "dark");
		expect(unavailableStorage.get(themePreference)).toBe("dark");
		expect(dataset.theme).toBe("dark");
	} finally {
		registry.dispose();
		unavailableStorage.dispose();
		vi.unstubAllGlobals();
	}
});
