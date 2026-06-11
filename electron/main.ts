import {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  dialog,
  Menu,
  clipboard,
  protocol,
  net,
} from "electron";
import { join, dirname, extname, basename } from "path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  statSync,
  copyFileSync,
  renameSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { readdir, stat } from "fs/promises";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { autoUpdater, UpdateInfo } from "electron-updater";
// NOTE: Use downloadToFile() (net.fetch) instead of http/https for downloads.
// net.fetch uses Chromium's network stack and respects system proxy settings.
import log from "electron-log";

const EXTRACT_FRAME_DEBUG = process.env.WAVESPEED_EXTRACT_FRAME_DEBUG === "1";

if (!EXTRACT_FRAME_DEBUG) {
  app.commandLine.appendSwitch("log-level", "3");
}

function contentTypeForFile(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov" || ext === ".qt") return "video/quicktime";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg" || ext === ".oga") return "audio/ogg";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function parseRangeHeader(
  range: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!match) return null;

  let start: number;
  let end: number;
  if (match[1] === "" && match[2] === "") return null;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

function readFileSlice(filePath: string, start: number, end: number): Buffer {
  const length = end - start + 1;
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buffer;
}

function localAssetResponse(request: Request): Response {
  const filePath = decodeURIComponent(
    request.url.replace("local-asset://", ""),
  );
  if (!existsSync(filePath)) {
    if (EXTRACT_FRAME_DEBUG) {
      console.warn(
        `[ExtractFrame][local-asset] not-found ${JSON.stringify({
          file: filePath,
          range: request.headers.get("range"),
        })}`,
      );
    }
    return new Response("File not found", { status: 404 });
  }

  const size = statSync(filePath).size;
  const contentType = contentTypeForFile(filePath);
  const rangeHeader = request.headers.get("range");
  const shouldLogLocalAsset =
    EXTRACT_FRAME_DEBUG &&
    (Boolean(rangeHeader) ||
      contentType.startsWith("video/") ||
      contentType.startsWith("audio/"));
  const range = parseRangeHeader(rangeHeader, size);
  if (rangeHeader && !range) {
    if (shouldLogLocalAsset) {
      console.warn(
        `[ExtractFrame][local-asset] invalid-range ${JSON.stringify({
          file: basename(filePath),
          size,
          contentType,
          range: rangeHeader,
          status: 416,
        })}`,
      );
    }
    return new Response(null, {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${size}`,
      },
    });
  }

  if (range) {
    const { start, end } = range;
    const chunk = readFileSlice(filePath, start, end);
    if (shouldLogLocalAsset) {
      console.log(
        `[ExtractFrame][local-asset] partial ${JSON.stringify({
          file: basename(filePath),
          size,
          contentType,
          range: rangeHeader,
          start,
          end,
          length: chunk.length,
          status: 206,
        })}`,
      );
    }
    return new Response(new Uint8Array(chunk), {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(chunk.length),
        "Content-Type": contentType,
      },
    });
  }

  if (shouldLogLocalAsset) {
    console.log(
      `[ExtractFrame][local-asset] full ${JSON.stringify({
        file: basename(filePath),
        size,
        contentType,
        range: rangeHeader,
        status: 200,
      })}`,
    );
  }
  return new Response(new Uint8Array(readFileSync(filePath)), {
    status: 200,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Length": String(size),
      "Content-Type": contentType,
    },
  });
}

/**
 * Download a URL to a local file using Electron's net.fetch (Chromium network stack).
 * Respects system proxy settings. Writes to a temp file first, then renames.
 */
async function downloadToFile(
  url: string,
  destPath: string,
): Promise<
  | { success: true; filePath: string; fileSize: number }
  | { success: false; error: string }
> {
  const tempPath = destPath + ".download";
  try {
    const response = await net.fetch(url);
    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status} downloading file`,
      };
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Validate: if server declared Content-Length, actual bytes must match
    if (contentLength > 0 && buffer.length < contentLength) {
      return {
        success: false,
        error: `Truncated download: expected ${contentLength} bytes, got ${buffer.length}`,
      };
    }

    // Reject empty downloads
    if (buffer.length === 0) {
      return { success: false, error: "Downloaded file is empty (0 bytes)" };
    }

    writeFileSync(tempPath, buffer);
    renameSync(tempPath, destPath);
    const stats = statSync(destPath);
    return { success: true, filePath: destPath, fileSize: stats.size };
  } catch (err) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      /* best-effort */
    }
    return { success: false, error: (err as Error).message };
  }
}

// Suppress Chromium's noisy ffmpeg pixel format warnings from video preview decoding.
// Keep them visible when extract-frame debug logging is explicitly enabled.
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (
  chunk: string | Uint8Array,
  ...args: unknown[]
): boolean => {
  const str =
    typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  if (!EXTRACT_FRAME_DEBUG) {
    if (
      str.includes("Unsupported pixel format") ||
      str.includes("ffmpeg_common.cc")
    )
      return true;
  }
  return (originalStderrWrite as (...a: unknown[]) => boolean)(chunk, ...args);
};

// Linux-specific flags
if (process.platform === "linux") {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
}

// Configure electron-log
// Log files location:
// - Windows: %USERPROFILE%\AppData\Roaming\kie-desktop\logs\main.log
// - macOS: ~/Library/Logs/kie-desktop/main.log
// - Linux: ~/.config/kie-desktop/logs/main.log
log.transports.file.level = "info";
log.transports.console.level = is.dev ? "debug" : "info";
log.info("=".repeat(80));
log.info("Application starting...");
log.info("Version:", app.getVersion());
log.info("Platform:", process.platform, process.arch);
log.info("Electron:", process.versions.electron);
log.info("Chrome:", process.versions.chrome);
log.info("Node:", process.versions.node);
log.info("Log file:", log.transports.file.getFile().path);
log.info("=".repeat(80));

// Override console methods to use electron-log
console.log = log.log.bind(log);
console.info = log.info.bind(log);
console.warn = log.warn.bind(log);
console.error = log.error.bind(log);
console.debug = log.debug.bind(log);

// Settings storage
const userDataPath = app.getPath("userData");
const settingsPath = join(userDataPath, "settings.json");

interface Settings {
  apiKey: string;
  theme: "light" | "dark" | "system";
  defaultPollInterval: number;
  defaultTimeout: number;
  updateChannel: "stable" | "nightly";
  autoCheckUpdate: boolean;
  autoSaveAssets: boolean;
  assetsDirectory: string;
  language: string;
}

interface AssetMetadata {
  id: string;
  filePath: string;
  fileName: string;
  type: "image" | "video" | "audio" | "text" | "json";
  modelId: string;
  modelName: string;
  createdAt: string;
  fileSize: number;
  tags: string[];
  favorite: boolean;
  predictionId?: string;
  originalUrl?: string;
  source?: "playground" | "workflow" | "free-tool";
  workflowId?: string;
  workflowName?: string;
  nodeId?: string;
  executionId?: string;
}

// ─── Persistent key-value state (survives app restarts, unlike renderer localStorage) ────
const statePath = join(userDataPath, "renderer-state.json");

function loadState(): Record<string, unknown> {
  try {
    if (existsSync(statePath)) {
      return JSON.parse(readFileSync(statePath, "utf-8"));
    }
  } catch {
    /* corrupted file — start fresh */
  }
  return {};
}

function saveState(state: Record<string, unknown>): void {
  try {
    if (!existsSync(userDataPath)) mkdirSync(userDataPath, { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error("Failed to save renderer state:", error);
  }
}

const defaultAssetsDirectory = join(app.getPath("documents"), "KieDesktop");
const assetsMetadataPath = join(userDataPath, "assets-metadata.json");

const defaultSettings: Settings = {
  apiKey: "",
  theme: "system",
  defaultPollInterval: 1000,
  defaultTimeout: 36000,
  updateChannel: "stable",
  autoCheckUpdate: true,
  autoSaveAssets: true,
  assetsDirectory: defaultAssetsDirectory,
  language: "auto",
};

function loadSettings(): Settings {
  try {
    if (existsSync(settingsPath)) {
      const data = readFileSync(settingsPath, "utf-8");
      return { ...defaultSettings, ...JSON.parse(data) };
    }
  } catch (error) {
    console.error("Failed to load settings:", error);
  }
  return { ...defaultSettings };
}

function saveSettings(settings: Partial<Settings>): void {
  try {
    const currentSettings = loadSettings();
    const newSettings = { ...currentSettings, ...settings };
    if (!existsSync(userDataPath)) {
      mkdirSync(userDataPath, { recursive: true });
    }
    writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2));
  } catch (error) {
    console.error("Failed to save settings:", error);
  }
}

function createWindow(): void {
  const isMac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 520,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    icon: join(__dirname, "../../build/icon.png"),
    backgroundColor: "#080c16",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac ? { trafficLightPosition: { x: 10, y: 8 } } : {}),
    ...(process.platform !== "darwin"
      ? {
          titleBarOverlay: {
            color: "#080c16",
            symbolColor: "#6b7280",
            height: 32,
          },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: !is.dev, // Disable web security in dev mode to bypass CORS
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      const isExpectedRendererNoise =
        message.includes("Electron Security Warning") ||
        message.includes("Insecure Content-Security-Policy") ||
        message.includes("ResizeObserver loop");

      if (isExpectedRendererNoise) {
        return;
      }

      if (
        level >= 2 ||
        (EXTRACT_FRAME_DEBUG && message.includes("[ExtractFrame]"))
      ) {
        console.log(
          `[Renderer][${level}] ${message} ${sourceId ? `(${sourceId}:${line})` : ""}`,
        );
      }
    },
  );

  // macOS: Hide window instead of closing when clicking the red button
  // The app will only quit when user presses Cmd+Q
  if (process.platform === "darwin") {
    mainWindow.on("close", (event) => {
      if (!(app as typeof app & { isQuitting?: boolean }).isQuitting) {
        event.preventDefault();
        if (mainWindow?.isFullScreen()) {
          const targetWindow = mainWindow;
          targetWindow.once("leave-full-screen", () => {
            targetWindow.hide();
          });
          targetWindow.setFullScreen(false);
        } else {
          mainWindow?.hide();
        }
      }
    });
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  // Error handling for renderer
  mainWindow.webContents.on(
    "did-fail-load",
    (_, errorCode, errorDescription, validatedURL) => {
      console.error(
        "Failed to load:",
        errorCode,
        errorDescription,
        validatedURL,
      );
    },
  );

  mainWindow.webContents.on("render-process-gone", (_, details) => {
    console.error("Render process gone:", details);
  });

  // Load the app
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    const indexPath = join(__dirname, "../renderer/index.html");
    console.log("Loading renderer from:", indexPath);
    console.log("File exists:", existsSync(indexPath));
    mainWindow.loadFile(indexPath);
  }

  // Open DevTools with keyboard shortcut (Cmd+Opt+I on Mac, Ctrl+Shift+I on Windows/Linux)
  mainWindow.webContents.on("before-input-event", (_, input) => {
    if (
      (input.meta || input.control) &&
      input.shift &&
      input.key.toLowerCase() === "i"
    ) {
      mainWindow?.webContents.toggleDevTools();
    }
    // Also allow F12
    if (input.key === "F12") {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  // Enable right-click context menu
  mainWindow.webContents.on("context-menu", (_, params) => {
    const menuItems: Electron.MenuItemConstructorOptions[] = [];

    // Add text editing options when in editable field
    if (params.isEditable) {
      menuItems.push(
        { label: "Cut", role: "cut", enabled: params.editFlags.canCut },
        { label: "Copy", role: "copy", enabled: params.editFlags.canCopy },
        { label: "Paste", role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { label: "Select All", role: "selectAll" },
      );
    } else if (params.selectionText) {
      // Add copy option when text is selected
      menuItems.push({ label: "Copy", role: "copy" });
    }

    // Add link options
    if (params.linkURL) {
      if (menuItems.length > 0) menuItems.push({ type: "separator" });
      menuItems.push(
        {
          label: "Open Link in Browser",
          click: () => shell.openExternal(params.linkURL),
        },
        {
          label: "Copy Link",
          click: () => clipboard.writeText(params.linkURL),
        },
      );
    }

    // Add image options
    if (params.mediaType === "image") {
      if (menuItems.length > 0) menuItems.push({ type: "separator" });
      menuItems.push(
        {
          label: "Copy Image",
          click: () => mainWindow?.webContents.copyImageAt(params.x, params.y),
        },
        {
          label: "Open Image in Browser",
          click: () => shell.openExternal(params.srcURL),
        },
      );
    }

    if (menuItems.length > 0) {
      const menu = Menu.buildFromTemplate(menuItems);
      menu.popup();
    }
  });
}

// IPC Handlers

// Update title bar overlay colors when theme changes (Windows only)
ipcMain.handle("update-titlebar-theme", (_, isDark: boolean) => {
  if (process.platform === "darwin" || !mainWindow) return;
  try {
    mainWindow.setTitleBarOverlay({
      color: isDark ? "#080c16" : "#ffffff",
      symbolColor: isDark ? "#9ca3af" : "#6b7280",
      height: 32,
    });
  } catch {
    // setTitleBarOverlay may not be available on all platforms
  }
});

ipcMain.handle("get-api-key", () => {
  const settings = loadSettings();
  return settings.apiKey;
});

ipcMain.handle("set-api-key", (_, apiKey: string) => {
  saveSettings({ apiKey });
  return true;
});

ipcMain.handle("get-settings", () => {
  const settings = loadSettings();
  return {
    theme: settings.theme,
    defaultPollInterval: settings.defaultPollInterval,
    defaultTimeout: settings.defaultTimeout,
    updateChannel: settings.updateChannel,
    autoCheckUpdate: settings.autoCheckUpdate,
    language: settings.language,
  };
});

ipcMain.handle("set-settings", (_, newSettings: Partial<Settings>) => {
  saveSettings(newSettings);
  return true;
});

ipcMain.handle("clear-all-data", () => {
  saveSettings(defaultSettings);
  return true;
});

// Persistent renderer state (key-value, survives restarts)
ipcMain.handle("get-state", (_, key: string) => {
  const state = loadState();
  return state[key] ?? null;
});

ipcMain.handle("set-state", (_, key: string, value: unknown) => {
  const state = loadState();
  if (value === null || value === undefined) {
    delete state[key];
  } else {
    state[key] = value;
  }
  saveState(state);
  return true;
});

ipcMain.handle("remove-state", (_, key: string) => {
  const state = loadState();
  delete state[key];
  saveState(state);
  return true;
});

// Open external URL handler
ipcMain.handle("open-external", async (_, url: string) => {
  await shell.openExternal(url);
});

// Download file handler
ipcMain.handle(
  "download-file",
  async (_, url: string, defaultFilename: string) => {
    const mainWindow = BrowserWindow.getFocusedWindow();
    if (!mainWindow) return { success: false, error: "No focused window" };

    // Show save dialog
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultFilename,
      filters: [
        { name: "All Files", extensions: ["*"] },
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
        { name: "Videos", extensions: ["mp4", "webm", "mov"] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    // Handle local-asset:// URLs (Z-Image local outputs)
    if (url.startsWith("local-asset://")) {
      try {
        const localPath = decodeURIComponent(url.replace("local-asset://", ""));
        if (!existsSync(localPath)) {
          return { success: false, error: "Source file not found" };
        }
        copyFileSync(localPath, result.filePath);
        return { success: true, filePath: result.filePath };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }

    return downloadToFile(url, result.filePath);
  },
);

// Silent file save handler — saves a remote URL to a local directory without dialog
ipcMain.handle(
  "save-file-silent",
  async (_, url: string, dir: string, fileName: string) => {
    try {
      if (!fileName) return { success: false, error: "Missing filename" };
      const targetDir = dir || app.getPath("downloads");
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
      const filePath = join(targetDir, fileName);

      // Handle local-asset:// URLs
      if (url.startsWith("local-asset://")) {
        const localPath = decodeURIComponent(url.replace("local-asset://", ""));
        if (!existsSync(localPath))
          return { success: false, error: "Source file not found" };
        copyFileSync(localPath, filePath);
        return { success: true, filePath };
      }

      // Handle data: URLs
      if (url.startsWith("data:")) {
        const matches = url.match(/^data:[^;]+;base64,(.+)$/);
        if (matches) {
          writeFileSync(filePath, Buffer.from(matches[1], "base64"));
          return { success: true, filePath };
        }
        return { success: false, error: "Invalid data URL" };
      }

      return downloadToFile(url, filePath);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
);

// Assets metadata helpers
function loadAssetsMetadata(): AssetMetadata[] {
  try {
    if (existsSync(assetsMetadataPath)) {
      const data = readFileSync(assetsMetadataPath, "utf-8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("Failed to load assets metadata:", error);
  }
  return [];
}

function saveAssetsMetadata(metadata: AssetMetadata[]): void {
  try {
    if (!existsSync(userDataPath)) {
      mkdirSync(userDataPath, { recursive: true });
    }
    writeFileSync(assetsMetadataPath, JSON.stringify(metadata, null, 2));
  } catch (error) {
    console.error("Failed to save assets metadata:", error);
  }
}

// Assets IPC Handlers
ipcMain.handle("get-assets-settings", () => {
  const settings = loadSettings();
  return {
    autoSaveAssets: settings.autoSaveAssets,
    assetsDirectory: settings.assetsDirectory || defaultAssetsDirectory,
  };
});

ipcMain.handle(
  "set-assets-settings",
  (_, newSettings: { autoSaveAssets?: boolean; assetsDirectory?: string }) => {
    saveSettings(newSettings);
    return true;
  },
);

ipcMain.handle("get-default-assets-directory", () => {
  return defaultAssetsDirectory;
});

ipcMain.handle("select-directory", async () => {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow) return { success: false, error: "No focused window" };

  const result = await dialog.showOpenDialog(focusedWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: "Select Assets Directory",
  });

  if (result.canceled || !result.filePaths[0]) {
    return { success: false, canceled: true };
  }

  return { success: true, path: result.filePaths[0] };
});

// Directory Import node — pick a directory for media scanning
ipcMain.handle("pick-directory", async () => {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow) return { success: false, error: "No focused window" };

  const result = await dialog.showOpenDialog(focusedWindow, {
    properties: ["openDirectory"],
    title: "Select Media Directory",
  });

  if (result.canceled || !result.filePaths[0]) {
    return { success: false, canceled: true };
  }

  return { success: true, path: result.filePaths[0] };
});

// Directory Import node — scan a directory for media files
ipcMain.handle(
  "scan-directory",
  async (_, dirPath: string, allowedExts: string[]) => {
    const { readdirSync } = require("fs");
    const { join, extname } = require("path");

    const extSet = new Set(allowedExts.map((e: string) => e.toLowerCase()));
    const results: string[] = [];
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (extSet.has(ext)) {
            results.push(join(dirPath, entry.name));
          }
        }
      }
    } catch {
      // Skip unreadable
    }
    return results;
  },
);

ipcMain.handle(
  "save-asset",
  async (_, url: string, _type: string, fileName: string, subDir: string) => {
    const settings = loadSettings();
    const baseDir = settings.assetsDirectory || defaultAssetsDirectory;
    const targetDir = join(baseDir, subDir);

    // Ensure directory exists
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    const filePath = join(targetDir, fileName);

    // Handle local-asset:// URLs (Z-Image local outputs)
    if (url.startsWith("local-asset://")) {
      try {
        const localPath = decodeURIComponent(url.replace("local-asset://", ""));
        if (!existsSync(localPath)) {
          return { success: false, error: "Source file not found" };
        }
        copyFileSync(localPath, filePath);
        const stats = statSync(filePath);
        return { success: true, filePath, fileSize: stats.size };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }

    return downloadToFile(url, filePath);
  },
);

ipcMain.handle("delete-asset", async (_, filePath: string) => {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle("delete-assets-bulk", async (_, filePaths: string[]) => {
  let deleted = 0;
  for (const filePath of filePaths) {
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        deleted++;
      }
    } catch (error) {
      console.error("Failed to delete:", filePath, error);
    }
  }
  return { success: true, deleted };
});

ipcMain.handle("get-assets-metadata", () => {
  return loadAssetsMetadata();
});

ipcMain.handle("save-assets-metadata", (_, metadata: AssetMetadata[]) => {
  saveAssetsMetadata(metadata);
  return true;
});

ipcMain.handle("open-file-location", async (_, filePath: string) => {
  if (existsSync(filePath)) {
    shell.showItemInFolder(filePath);
    return { success: true };
  }
  return { success: false, error: "File not found" };
});

ipcMain.handle("check-file-exists", (_, filePath: string) => {
  return existsSync(filePath);
});

ipcMain.handle("open-assets-folder", async () => {
  const settings = loadSettings();
  const assetsDir = settings.assetsDirectory || defaultAssetsDirectory;

  // Ensure directory exists
  if (!existsSync(assetsDir)) {
    mkdirSync(assetsDir, { recursive: true });
  }

  const result = await shell.openPath(assetsDir);
  return { success: !result, error: result || undefined };
});

// Scan assets directory and return all files found (async for non-blocking)
ipcMain.handle("scan-assets-directory", async () => {
  const settings = loadSettings();
  const assetsDir = settings.assetsDirectory || defaultAssetsDirectory;

  const subDirs = ["images", "videos", "audio", "text"];
  const files: Array<{
    filePath: string;
    fileName: string;
    type: "image" | "video" | "audio" | "text";
    fileSize: number;
    createdAt: string;
  }> = [];

  const typeMap: Record<string, "image" | "video" | "audio" | "text"> = {
    images: "image",
    videos: "video",
    audio: "audio",
    text: "text",
  };

  // Process directories in parallel for better performance
  await Promise.all(
    subDirs.map(async (subDir) => {
      const dirPath = join(assetsDir, subDir);
      if (!existsSync(dirPath)) return;

      try {
        const entries = await readdir(dirPath);
        // Process files in parallel batches
        const filePromises = entries.map(async (entry) => {
          const filePath = join(dirPath, entry);
          try {
            const stats = await stat(filePath);
            if (stats.isFile()) {
              return {
                filePath,
                fileName: entry,
                type: typeMap[subDir],
                fileSize: stats.size,
                createdAt: stats.birthtime.toISOString(),
              };
            }
          } catch {
            // Skip files we can't stat
          }
          return null;
        });
        const results = await Promise.all(filePromises);
        files.push(
          ...results.filter((f): f is NonNullable<typeof f> => f !== null),
        );
      } catch {
        // Skip directories we can't read
      }
    }),
  );

  return files;
});

// Auto-updater state
let mainWindow: BrowserWindow | null = null;

// Configure auto-updater
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function sendUpdateStatus(status: string, data?: Record<string, unknown>) {
  if (mainWindow) {
    mainWindow.webContents.send("update-status", { status, ...data });
  }
}

function setupAutoUpdater() {
  if (is.dev) {
    return;
  }

  const updateConfigPath =
    (autoUpdater as typeof autoUpdater & { appUpdateConfigPath?: string })
      .appUpdateConfigPath ?? join(process.resourcesPath, "app-update.yml");
  if (!existsSync(updateConfigPath)) {
    console.warn(
      "[AutoUpdater] app-update.yml not found, skipping auto-updater setup:",
      updateConfigPath,
    );
    return;
  }

  const settings = loadSettings();
  const channel = settings.updateChannel || "stable";

  // Configure update channel
  if (channel === "nightly") {
    autoUpdater.allowPrerelease = true;
    autoUpdater.channel = "nightly";
    // Use generic provider pointing to nightly release assets
    autoUpdater.setFeedURL({
      provider: "generic",
      url: "https://github.com/imwalson/kie-desktop/releases/download/nightly",
    });
  } else {
    autoUpdater.allowPrerelease = false;
    autoUpdater.channel = "latest";
  }

  autoUpdater.on("checking-for-update", () => {
    sendUpdateStatus("checking");
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    sendUpdateStatus("available", {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate,
    });
  });

  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    sendUpdateStatus("not-available", { version: info.version });
  });

  autoUpdater.on("download-progress", (progress) => {
    sendUpdateStatus("downloading", {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    sendUpdateStatus("downloaded", {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on("error", (error) => {
    sendUpdateStatus("error", { message: error.message });
  });
}

// Auto-updater IPC handlers
ipcMain.handle("check-for-updates", async () => {
  if (is.dev) {
    return {
      status: "dev-mode",
      message: "Auto-update disabled in development",
    };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    return { status: "success", updateInfo: result?.updateInfo };
  } catch (error) {
    return { status: "error", message: (error as Error).message };
  }
});

ipcMain.handle("download-update", async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { status: "success" };
  } catch (error) {
    return { status: "error", message: (error as Error).message };
  }
});

ipcMain.handle("install-update", () => {
  // Set quitting flag before calling quitAndInstall so macOS window close handler allows quit
  (app as typeof app & { isQuitting: boolean }).isQuitting = true;
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

ipcMain.handle("get-log-file-path", () => {
  return log.transports.file.getFile().path;
});

ipcMain.handle("open-log-directory", () => {
  const logPath = log.transports.file.getFile().path;
  const logDir = dirname(logPath);
  shell.openPath(logDir);
  return { success: true, path: logDir };
});

ipcMain.handle("set-update-channel", (_, channel: "stable" | "nightly") => {
  saveSettings({ updateChannel: channel });
  // Reconfigure updater with new channel
  if (channel === "nightly") {
    autoUpdater.allowPrerelease = true;
    autoUpdater.channel = "nightly";
    // Use generic provider pointing to nightly release assets
    autoUpdater.setFeedURL({
      provider: "generic",
      url: "https://github.com/imwalson/kie-desktop/releases/download/nightly",
    });
  } else {
    autoUpdater.allowPrerelease = false;
    autoUpdater.channel = "latest";
    autoUpdater.setFeedURL({
      provider: "github",
      owner: "imwalson",
      repo: "kie-desktop",
      releaseType: "release",
    });
  }
  return true;
});

/**
 * Get file size
 */
ipcMain.handle("get-file-size", (_, filePath: string) => {
  try {
    if (existsSync(filePath)) {
      const stats = statSync(filePath);
      return stats.size;
    }
    return 0;
  } catch (error) {
    console.error("Failed to get file size:", error);
    return 0;
  }
});

// Register custom protocol for local asset files (must be before app.whenReady)
protocol.registerSchemesAsPrivileged([
  {
    scheme: "local-asset",
    privileges: {
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

// App lifecycle
app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.imwalson.kiedesktop");

  // Handle local-asset:// protocol for loading local files (videos, images, etc.)
  protocol.handle("local-asset", (request) => {
    return localAssetResponse(request);
  });

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  createWindow();

  // Setup auto-updater after window is created
  setupAutoUpdater();

  // Auto-update disabled: personal build with no release feed.
  // Manual check via Settings still works if a feed is configured later.

  app.on("activate", function () {
    // macOS: Show the hidden window when clicking dock icon
    if (mainWindow) {
      mainWindow.show();
    } else {
      createWindow();
    }
  });
});

// macOS: Set quitting flag so window close handler allows actual quit
app.on("before-quit", () => {
  (app as typeof app & { isQuitting: boolean }).isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
