// Lightweight i18n for the Electron main process.
// Imports the same JSON translation files used by the renderer.

import commonAr from "../src/i18n/locales/ar/common.json";
import dialogsAr from "../src/i18n/locales/ar/dialogs.json";
import editorAr from "../src/i18n/locales/ar/editor.json";
import launchAr from "../src/i18n/locales/ar/launch.json";
import settingsAr from "../src/i18n/locales/ar/settings.json";
import commonEn from "../src/i18n/locales/en/common.json";
import dialogsEn from "../src/i18n/locales/en/dialogs.json";
import editorEn from "../src/i18n/locales/en/editor.json";
import launchEn from "../src/i18n/locales/en/launch.json";
import settingsEn from "../src/i18n/locales/en/settings.json";
import commonEs from "../src/i18n/locales/es/common.json";
import dialogsEs from "../src/i18n/locales/es/dialogs.json";
import editorEs from "../src/i18n/locales/es/editor.json";
import launchEs from "../src/i18n/locales/es/launch.json";
import settingsEs from "../src/i18n/locales/es/settings.json";
import commonFr from "../src/i18n/locales/fr/common.json";
import dialogsFr from "../src/i18n/locales/fr/dialogs.json";
import editorFr from "../src/i18n/locales/fr/editor.json";
import launchFr from "../src/i18n/locales/fr/launch.json";
import settingsFr from "../src/i18n/locales/fr/settings.json";
import commonIt from "../src/i18n/locales/it/common.json";
import dialogsIt from "../src/i18n/locales/it/dialogs.json";
import editorIt from "../src/i18n/locales/it/editor.json";
import launchIt from "../src/i18n/locales/it/launch.json";
import settingsIt from "../src/i18n/locales/it/settings.json";
import commonJa from "../src/i18n/locales/ja-JP/common.json";
import dialogsJa from "../src/i18n/locales/ja-JP/dialogs.json";
import editorJa from "../src/i18n/locales/ja-JP/editor.json";
import launchJa from "../src/i18n/locales/ja-JP/launch.json";
import settingsJa from "../src/i18n/locales/ja-JP/settings.json";
import commonKo from "../src/i18n/locales/ko-KR/common.json";
import dialogsKo from "../src/i18n/locales/ko-KR/dialogs.json";
import editorKo from "../src/i18n/locales/ko-KR/editor.json";
import launchKo from "../src/i18n/locales/ko-KR/launch.json";
import settingsKo from "../src/i18n/locales/ko-KR/settings.json";
import commonPtBr from "../src/i18n/locales/pt-BR/common.json";
import dialogsPtBr from "../src/i18n/locales/pt-BR/dialogs.json";
import editorPtBr from "../src/i18n/locales/pt-BR/editor.json";
import launchPtBr from "../src/i18n/locales/pt-BR/launch.json";
import settingsPtBr from "../src/i18n/locales/pt-BR/settings.json";
import commonRu from "../src/i18n/locales/ru/common.json";
import dialogsRu from "../src/i18n/locales/ru/dialogs.json";
import editorRu from "../src/i18n/locales/ru/editor.json";
import launchRu from "../src/i18n/locales/ru/launch.json";
import settingsRu from "../src/i18n/locales/ru/settings.json";
import commonTr from "../src/i18n/locales/tr/common.json";
import dialogsTr from "../src/i18n/locales/tr/dialogs.json";
import editorTr from "../src/i18n/locales/tr/editor.json";
import launchTr from "../src/i18n/locales/tr/launch.json";
import settingsTr from "../src/i18n/locales/tr/settings.json";
import commonVi from "../src/i18n/locales/vi/common.json";
import dialogsVi from "../src/i18n/locales/vi/dialogs.json";
import editorVi from "../src/i18n/locales/vi/editor.json";
import launchVi from "../src/i18n/locales/vi/launch.json";
import settingsVi from "../src/i18n/locales/vi/settings.json";
import commonZh from "../src/i18n/locales/zh-CN/common.json";
import dialogsZh from "../src/i18n/locales/zh-CN/dialogs.json";
import editorZh from "../src/i18n/locales/zh-CN/editor.json";
import launchZh from "../src/i18n/locales/zh-CN/launch.json";
import settingsZh from "../src/i18n/locales/zh-CN/settings.json";
import commonZhTw from "../src/i18n/locales/zh-TW/common.json";
import dialogsZhTw from "../src/i18n/locales/zh-TW/dialogs.json";
import editorZhTw from "../src/i18n/locales/zh-TW/editor.json";
import launchZhTw from "../src/i18n/locales/zh-TW/launch.json";
import settingsZhTw from "../src/i18n/locales/zh-TW/settings.json";

type Namespace = "common" | "dialogs" | "editor" | "launch" | "settings";
type MessageMap = Record<string, unknown>;

const messages = {
	en: {
		common: commonEn,
		dialogs: dialogsEn,
		editor: editorEn,
		launch: launchEn,
		settings: settingsEn,
	},
	ar: {
		common: commonAr,
		dialogs: dialogsAr,
		editor: editorAr,
		launch: launchAr,
		settings: settingsAr,
	},
	es: {
		common: commonEs,
		dialogs: dialogsEs,
		editor: editorEs,
		launch: launchEs,
		settings: settingsEs,
	},
	fr: {
		common: commonFr,
		dialogs: dialogsFr,
		editor: editorFr,
		launch: launchFr,
		settings: settingsFr,
	},
	it: {
		common: commonIt,
		dialogs: dialogsIt,
		editor: editorIt,
		launch: launchIt,
		settings: settingsIt,
	},
	"ja-JP": {
		common: commonJa,
		dialogs: dialogsJa,
		editor: editorJa,
		launch: launchJa,
		settings: settingsJa,
	},
	"ko-KR": {
		common: commonKo,
		dialogs: dialogsKo,
		editor: editorKo,
		launch: launchKo,
		settings: settingsKo,
	},
	"pt-BR": {
		common: commonPtBr,
		dialogs: dialogsPtBr,
		editor: editorPtBr,
		launch: launchPtBr,
		settings: settingsPtBr,
	},
	ru: {
		common: commonRu,
		dialogs: dialogsRu,
		editor: editorRu,
		launch: launchRu,
		settings: settingsRu,
	},
	tr: {
		common: commonTr,
		dialogs: dialogsTr,
		editor: editorTr,
		launch: launchTr,
		settings: settingsTr,
	},
	vi: {
		common: commonVi,
		dialogs: dialogsVi,
		editor: editorVi,
		launch: launchVi,
		settings: settingsVi,
	},
	"zh-CN": {
		common: commonZh,
		dialogs: dialogsZh,
		editor: editorZh,
		launch: launchZh,
		settings: settingsZh,
	},
	"zh-TW": {
		common: commonZhTw,
		dialogs: dialogsZhTw,
		editor: editorZhTw,
		launch: launchZhTw,
		settings: settingsZhTw,
	},
} satisfies Record<string, Record<Namespace, MessageMap>>;

export type Locale = keyof typeof messages;

/** Locale codes offered by the native Language menu, in renderer order. */
export const MAIN_SUPPORTED_LOCALES = Object.keys(messages) as Locale[];

let currentLocale: Locale = "en";

function isSupportedLocale(locale: string): locale is Locale {
	return locale in messages;
}

export function setMainLocale(locale: string) {
	if (isSupportedLocale(locale)) {
		currentLocale = locale;
	}
}

/** Endonym for a locale (e.g. "Français"), used to label the native Language menu. */
export function getMainLocaleName(locale: Locale): string {
	return getMessageValue(messages[locale]?.common, "locale.name") ?? locale;
}

export function getMainLocale(): Locale {
	return currentLocale;
}

function getMessageValue(obj: unknown, dotPath: string): string | undefined {
	const keys = dotPath.split(".");
	let current: unknown = obj;
	for (const key of keys) {
		if (current == null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" ? current : undefined;
}

function interpolate(str: string, vars?: Record<string, string | number>): string {
	if (!vars) return str;
	return str.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? `{{${key}}}`));
}

export function mainT(
	namespace: Namespace,
	key: string,
	vars?: Record<string, string | number>,
): string {
	const value =
		getMessageValue(messages[currentLocale]?.[namespace], key) ??
		getMessageValue(messages.en?.[namespace], key);

	if (value == null) return `${namespace}.${key}`;
	return interpolate(value, vars);
}
