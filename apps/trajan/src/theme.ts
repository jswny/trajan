import { Schema } from "effect";
import { Atom } from "effect/reactivity";
import { readPreference, writePreference } from "./browser-storage";

// The startup script in index.html reads the same key before the first paint.
const THEME_KEY = "trajan-theme";
const ThemeMode = Schema.Literals(["auto", "light", "dark"]);
const isThemeMode = Schema.is(ThemeMode);

export const themePreference = Atom.writable<typeof ThemeMode.Type, string>(
	() => {
		const saved = readPreference(THEME_KEY);
		return isThemeMode(saved) ? saved : "auto";
	},
	(ctx, mode) => {
		if (!isThemeMode(mode)) {
			return;
		}
		document.documentElement.dataset.theme = mode;
		writePreference(THEME_KEY, mode);
		ctx.setSelf(mode);
	},
).pipe(Atom.keepAlive);
