import { contextBridge, ipcRenderer } from "electron";

interface Settings {
  theme: "light" | "dark" | "system";
  defaultPollInterval: number;
  defaultTimeout: number;
  updateChannel: "stable" | "nightly";
  autoCheckUpdate: boolean;
  language?: string;
}

interface UpdateStatus {
  status: string;
  version?: string;
  releaseNotes?: string | null;
  releaseDate?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  message?: string;
}

interface UpdateCheckResult {
  status: string;
  updateInfo?: {
    version: string;
    releaseNotes?: string | null;
  };
  message?: string;
}

interface DownloadResult {
  success: boolean;
  filePath?: string;
  error?: string;
  canceled?: boolean;
}

interface AssetsSettings {
  autoSaveAssets: boolean;
  assetsDirectory: string;
}

interface SaveAssetResult {
  success: boolean;
  filePath?: string;
  fileSize?: number;
  error?: string;
}

interface DeleteAssetResult {
  success: boolean;
  error?: string;
}

interface DeleteAssetsBulkResult {
  success: boolean;
  deleted: number;
}

interface SelectDirectoryResult {
  success: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
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
}

const electronAPI = {
  getApiKey: (): Promise<string> => ipcRenderer.invoke("get-api-key"),
  setApiKey: (apiKey: string): Promise<boolean> =>
    ipcRenderer.invoke("set-api-key", apiKey),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke("get-settings"),
  setSettings: (settings: Partial<Settings>): Promise<boolean> =>
    ipcRenderer.invoke("set-settings", settings),
  clearAllData: (): Promise<boolean> => ipcRenderer.invoke("clear-all-data"),
  downloadFile: (
    url: string,
    defaultFilename: string,
  ): Promise<DownloadResult> =>
    ipcRenderer.invoke("download-file", url, defaultFilename),
  saveFileSilent: (
    url: string,
    dir: string,
    fileName: string,
  ): Promise<DownloadResult> =>
    ipcRenderer.invoke("save-file-silent", url, dir, fileName),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("open-external", url),

  // Title bar theme
  updateTitlebarTheme: (isDark: boolean): Promise<void> =>
    ipcRenderer.invoke("update-titlebar-theme", isDark),

  // Auto-updater APIs
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("get-app-version"),
  getLogFilePath: (): Promise<string> =>
    ipcRenderer.invoke("get-log-file-path"),
  openLogDirectory: (): Promise<{ success: boolean; path: string }> =>
    ipcRenderer.invoke("open-log-directory"),
  checkForUpdates: (): Promise<UpdateCheckResult> =>
    ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: (): Promise<{ status: string; message?: string }> =>
    ipcRenderer.invoke("download-update"),
  installUpdate: (): void => {
    ipcRenderer.invoke("install-update");
  },
  setUpdateChannel: (channel: "stable" | "nightly"): Promise<boolean> =>
    ipcRenderer.invoke("set-update-channel", channel),
  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
    const handler = (_: unknown, status: UpdateStatus) => callback(status);
    ipcRenderer.on("update-status", handler);
    return () => ipcRenderer.removeListener("update-status", handler);
  },

  // Assets APIs
  getAssetsSettings: (): Promise<AssetsSettings> =>
    ipcRenderer.invoke("get-assets-settings"),
  setAssetsSettings: (settings: Partial<AssetsSettings>): Promise<boolean> =>
    ipcRenderer.invoke("set-assets-settings", settings),
  getDefaultAssetsDirectory: (): Promise<string> =>
    ipcRenderer.invoke("get-default-assets-directory"),
  selectDirectory: (): Promise<SelectDirectoryResult> =>
    ipcRenderer.invoke("select-directory"),
  pickDirectory: (): Promise<SelectDirectoryResult> =>
    ipcRenderer.invoke("pick-directory"),
  scanDirectory: (dirPath: string, allowedExts: string[]): Promise<string[]> =>
    ipcRenderer.invoke("scan-directory", dirPath, allowedExts),
  saveAsset: (
    url: string,
    type: string,
    fileName: string,
    subDir: string,
  ): Promise<SaveAssetResult> =>
    ipcRenderer.invoke("save-asset", url, type, fileName, subDir),
  deleteAsset: (filePath: string): Promise<DeleteAssetResult> =>
    ipcRenderer.invoke("delete-asset", filePath),
  deleteAssetsBulk: (filePaths: string[]): Promise<DeleteAssetsBulkResult> =>
    ipcRenderer.invoke("delete-assets-bulk", filePaths),
  getAssetsMetadata: (): Promise<AssetMetadata[]> =>
    ipcRenderer.invoke("get-assets-metadata"),
  saveAssetsMetadata: (metadata: AssetMetadata[]): Promise<boolean> =>
    ipcRenderer.invoke("save-assets-metadata", metadata),
  openFileLocation: (filePath: string): Promise<DeleteAssetResult> =>
    ipcRenderer.invoke("open-file-location", filePath),
  checkFileExists: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke("check-file-exists", filePath),
  openAssetsFolder: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("open-assets-folder"),
  scanAssetsDirectory: (): Promise<
    Array<{
      filePath: string;
      fileName: string;
      type: "image" | "video" | "audio" | "text";
      fileSize: number;
      createdAt: string;
    }>
  > => ipcRenderer.invoke("scan-assets-directory"),
  getFileSize: (filePath: string): Promise<number> =>
    ipcRenderer.invoke("get-file-size", filePath),

  // Persistent key-value state (survives app restarts, unlike renderer localStorage)
  getState: (key: string): Promise<unknown> =>
    ipcRenderer.invoke("get-state", key),
  setState: (key: string, value: unknown): Promise<boolean> =>
    ipcRenderer.invoke("set-state", key, value),
  removeState: (key: string): Promise<boolean> =>
    ipcRenderer.invoke("remove-state", key),

  // Assets event listener (workflow executor pushes new assets)
  onAssetsNewAsset: (callback: (asset: unknown) => void): (() => void) => {
    const handler = (_: unknown, asset: unknown) => callback(asset);
    ipcRenderer.on("assets:new-asset", handler);
    return () => ipcRenderer.removeListener("assets:new-asset", handler);
  },

  // Prediction inputs listener (workflow executor pushes node params for Customize)
  onSavePredictionInputs: (
    callback: (data: {
      predictionId: string;
      modelId: string;
      modelName: string;
      inputs: Record<string, unknown>;
    }) => void,
  ): (() => void) => {
    const handler = (_: unknown, data: unknown) =>
      callback(
        data as {
          predictionId: string;
          modelId: string;
          modelName: string;
          inputs: Record<string, unknown>;
        },
      );
    ipcRenderer.on("assets:save-prediction-inputs", handler);
    return () =>
      ipcRenderer.removeListener("assets:save-prediction-inputs", handler);
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electronAPI", electronAPI);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore - fallback for non-isolated context
  window.electronAPI = electronAPI;
}
