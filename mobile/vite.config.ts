import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Shared packages resolved from mobile/node_modules (deduped so the shared
// desktop src/ and mobile src/ use the same instances).
const sharedPackages = [
  "react",
  "react-dom",
  "react-router-dom",
  "react-dropzone",
  "react-i18next",
  "i18next",
  "i18next-browser-languagedetector",
  "zustand",
  "axios",
  "lucide-react",
  "class-variance-authority",
  "clsx",
  "tailwind-merge",
  "@tanstack/react-virtual",
  "@radix-ui/react-alert-dialog",
  "@radix-ui/react-checkbox",
  "@radix-ui/react-dialog",
  "@radix-ui/react-dropdown-menu",
  "@radix-ui/react-hover-card",
  "@radix-ui/react-label",
  "@radix-ui/react-progress",
  "@radix-ui/react-scroll-area",
  "@radix-ui/react-select",
  "@radix-ui/react-separator",
  "@radix-ui/react-slider",
  "@radix-ui/react-slot",
  "@radix-ui/react-switch",
  "@radix-ui/react-tabs",
  "@radix-ui/react-toast",
  "@radix-ui/react-tooltip",
  // Capacitor plugins (used by the platform service)
  "@capacitor/core",
  "@capacitor/preferences",
  "@capacitor/filesystem",
  "@capacitor/browser",
  "@capacitor/share",
  "@capacitor/app",
  "@capacitor/camera",
  "@capacitor/status-bar",
  "@capacitor/splash-screen",
  "@capacitor/keyboard",
];

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mobile-specific overrides (must come before @/)
      "@/pages/SettingsPage": path.resolve(
        __dirname,
        "./src/pages/SettingsPage",
      ),
      // Mobile-specific code (must come before @/ to avoid prefix matching)
      "@mobile": path.resolve(__dirname, "./src"),
      // Share code from the main desktop src directory
      "@": path.resolve(__dirname, "../src"),
    },
    dedupe: sharedPackages,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true,
    },
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router-dom"],
          "ui-vendor": [
            "@radix-ui/react-dialog",
            "@radix-ui/react-select",
            "@radix-ui/react-slider",
          ],
        },
      },
    },
  },
  optimizeDeps: {
    include: sharedPackages,
  },
  server: {
    port: 5173,
    host: true, // allow access from a phone on the LAN for live testing
    fs: {
      allow: [".."], // serve the shared ../src
    },
  },
});
