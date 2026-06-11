import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export const languages = [
  { code: "auto", name: "Auto (System)", nativeName: "Auto" },
  { code: "en", name: "English", nativeName: "English" },
  { code: "zh-CN", name: "Chinese (Simplified)", nativeName: "简体中文" },
];

const resources = {
  en: { translation: en },
  "zh-CN": { translation: zhCN },
};

// Get saved language from localStorage
const savedLanguage = localStorage.getItem("kie_language");

// If 'auto' or not set, let the detector decide based on browser language
const effectiveLanguage = savedLanguage === "auto" ? undefined : savedLanguage;

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    lng: effectiveLanguage || undefined, // Use saved language or let detector decide
    fallbackLng: "en",
    interpolation: {
      escapeValue: false, // React already escapes
    },
    detection: {
      order: ["navigator"], // Only use navigator when auto mode
      caches: [], // Don't cache when in auto mode
    },
  });

export default i18n;
