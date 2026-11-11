import { app, BrowserWindow, ipcMain, shell, net } from "electron";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { MintBridge } from "./mint-bridge";
import { autoUpdater } from "electron-updater";
import type { UpdateInfo, ProgressInfo } from "electron-updater";

type Settings = {
  mintPath: string;
  gameDirectory: string;
  serverAddress: string;
  playerName: string;
};

const defaults: Settings = {
  mintPath: "D:\\MiNT\\Launcher.exe",
  gameDirectory: "",
  serverAddress: "127.0.0.1:22005",
  playerName: "Player"
};

let mainWindow: BrowserWindow | null = null;
let bridge: MintBridge | null = null;
let allowWindowClose = false;
let launchInProgress = false;
let launchPendingUntil = 0;
let settings: Settings = { ...defaults };

// GitHub Releases used by electron-updater. The repository must publish installer assets and latest.yml.
const UPDATE_SOURCE = {
  enabled: true,
  owner: "ColinsBlares",
  repo: "launcher"
};
let updateCheckInProgress = false;
let updateState: Record<string, unknown> = {
  status: "idle",
  currentVersion: app.getVersion(),
  message: "Готов к проверке обновлений на GitHub Releases."
};

function publishUpdateState(next: Record<string, unknown>) {
  updateState = { ...updateState, ...next, currentVersion: app.getVersion() };
  emit("updater:status", updateState);
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on("checking-for-update", () => publishUpdateState({ status: "checking", message: "Проверяем наличие обновлений..." }));
  autoUpdater.on("update-available", (info: UpdateInfo) => publishUpdateState({ status: "available", version: info.version, releaseName: info.releaseName || "", releaseNotes: info.releaseNotes || "", message: `Доступна новая версия ${info.version}` }));
  autoUpdater.on("update-not-available", (info: UpdateInfo) => publishUpdateState({ status: "up-to-date", version: info.version, message: "Установлена последняя версия Remember RP." }));
  autoUpdater.on("download-progress", (progress: ProgressInfo) => publishUpdateState({ status: "downloading", percent: Math.round(progress.percent), transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond, message: "Загружаем обновление..." }));
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => publishUpdateState({ status: "downloaded", version: info.version, percent: 100, message: `Версия ${info.version} готова к установке.` }));
  autoUpdater.on("error", (error: Error) => publishUpdateState({ status: "error", message: `Не удалось обновиться: ${error.message}` }));

  if (!app.isPackaged) {
    publishUpdateState({ status: "development", message: "Проверка обновлений доступна только в установленной версии." });
    return;
  }
  if (!UPDATE_SOURCE.enabled) {
    publishUpdateState({ status: "not-configured", message: "Автообновления отключены в настройках лаунчера." });
    return;
  }
  // Manual checks use GitHub's Releases API below. Do not start electron-updater
  // network work during startup: a slow update server must never affect the UI.
}

function findSiblingMintLauncher() {
  // In an installed build, app.getPath("exe") points to the user's launcher executable.
  // In development, app.getAppPath() points to the project directory.
  const appFolder = app.isPackaged ? dirname(app.getPath("exe")) : app.getAppPath();
  const candidates = [
    join(appFolder, "Launcher.exe"),
    join(appFolder, "MiNT", "Launcher.exe"),
    join(appFolder, "mint", "Launcher.exe"),
    // Development layout and packaged extraResources layout.
    join(appFolder, "mint-runtime", "client", "Launcher.exe"),
    join(appFolder, "resources", "mint-runtime", "client", "Launcher.exe")
  ];
  return candidates.find(candidate => existsSync(candidate)) || "";
}

function settingsFile() {
  return join(app.getPath("userData"), "settings.json");
}
function loadSettings() {
  try {
    const p = settingsFile();
    if (existsSync(p)) settings = { ...defaults, ...JSON.parse(readFileSync(p, "utf8")) };
  } catch (e) { console.error("Cannot read settings:", e); }

  // The installer places MiNT beside this launcher, so prefer that copy.
  const siblingPath = findSiblingMintLauncher();
  if (siblingPath) settings.mintPath = siblingPath;

  if (siblingPath || !existsSync(settings.mintPath)) {
    try {
      mkdirSync(app.getPath("userData"), { recursive: true });
      writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
    } catch (e) { console.error("Cannot save detected MiNT path:", e); }
  }
}
function saveSettings(next: Partial<Settings>) {
  settings = { ...settings, ...next };
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
  return settings;
}
function emit(channel: string, payload: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}


function isGameRunning() {
  if (process.platform !== "win32") return false;
  try {
    // Check the actual GTA process, not the Rockstar/Epic launcher.
    const output = execFileSync("tasklist", ["/FO", "CSV", "/NH"], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
    });
    return output.split(/\r?\n/).some(line => {
      const imageName = line.match(/^"([^"]+)"/i)?.[1]?.toLowerCase();
      return imageName === "gta5.exe" || imageName === "gta5_enhanced.exe";
    });
  } catch {
    return false;
  }
}

function isGameDirectory(candidate: string) {
  if (!candidate) return false;
  const path = candidate.replace(/^"|"$/g, "").trim();
  return existsSync(join(path, "GTA5.exe")) ||
    existsSync(join(path, "PlayGTAV.exe")) ||
    existsSync(join(path, "GTA5_Enhanced.exe"));
}

function readRegistryValue(key: string, valueName: string) {
  if (process.platform !== "win32") return "";
  try {
    const output = execFileSync("reg", ["query", key, "/v", valueName], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
    });
    const line = output.split(/\r?\n/).find(item => item.toLowerCase().includes(valueName.toLowerCase()));
    return line ? line.trim().split(/\s{2,}/).slice(2).join(" ").trim() : "";
  } catch { return ""; }
}

function detectGameDirectory() {
  const candidates = new Set<string>();
  const add = (value?: string) => {
    if (value) candidates.add(value.replace(/^"|"$/g, "").trim());
  };

  // Rockstar Games registry entries (both 64-bit and 32-bit registry views).
  add(readRegistryValue("HKLM\\SOFTWARE\\Rockstar Games\\Grand Theft Auto V", "InstallFolder"));
  add(readRegistryValue("HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\Grand Theft Auto V", "InstallFolder"));
  add(readRegistryValue("HKCU\\SOFTWARE\\Rockstar Games\\Grand Theft Auto V", "InstallFolder"));

  // Steam installation and all configured Steam libraries.
  const steamRoots = [
    readRegistryValue("HKCU\\Software\\Valve\\Steam", "SteamPath"),
    readRegistryValue("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"),
    "C:\\Program Files (x86)\\Steam",
    "C:\\Program Files\\Steam"
  ].filter(Boolean);
  for (const steamRoot of steamRoots) {
    add(join(steamRoot, "steamapps", "common", "Grand Theft Auto V"));
    const libraryFile = join(steamRoot, "steamapps", "libraryfolders.vdf");
    try {
      const vdf = readFileSync(libraryFile, "utf8");
      for (const match of vdf.matchAll(/"path"\s*"([^"]+)"/g)) {
        const library = match[1].replace(/\\\\/g, "\\");
        add(join(library, "steamapps", "common", "Grand Theft Auto V"));
      }
    } catch { /* Steam library list unavailable */ }
  }

  // Epic Games Launcher manifests.
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const manifests = join(programData, "Epic", "EpicGamesLauncher", "Data", "Manifests");
  try {
    for (const file of readdirSync(manifests)) {
      if (!file.endsWith(".item")) continue;
      try {
        const item = JSON.parse(readFileSync(join(manifests, file), "utf8"));
        const identity = `${item.AppName || ""} ${item.DisplayName || ""} ${item.InstallLocation || ""}`.toLowerCase();
        if (identity.includes("grand theft auto") || identity.includes("gtav") || identity.includes("gta v")) {
          add(item.InstallLocation);
        }
      } catch { /* Ignore malformed manifest */ }
    }
  } catch { /* Epic manifest folder not found */ }

  // Common default locations as a final fallback.
  for (const drive of ["C:", "D:", "E:", "F:"]) {
    add(`${drive}\\Program Files\\Rockstar Games\\Grand Theft Auto V`);
    add(`${drive}\\Program Files (x86)\\Rockstar Games\\Grand Theft Auto V`);
    add(`${drive}\\Games\\Grand Theft Auto V`);
    add(`${drive}\\SteamLibrary\\steamapps\\common\\Grand Theft Auto V`);
    add(`${drive}\\Program Files\\Epic Games\\GTAV`);
  }

  for (const candidate of candidates) {
    if (isGameDirectory(candidate)) return candidate;
  }
  return "";
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1280, minHeight: 800, maxWidth: 1280, maxHeight: 800,
    frame: false, resizable: false, maximizable: false, fullscreenable: false, center: true,
    backgroundColor: "#09090b", title: "Remember RP Launcher",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("close", (event) => {
    if (!allowWindowClose) {
      event.preventDefault();
      emit("app:close-requested", {});
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

function getBridge() {
  if (!bridge) {
    bridge = new MintBridge((channel, data) => emit(channel, data));
  }
  return bridge;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  loadSettings();
  createWindow();
  configureAutoUpdater();

  ipcMain.handle("updater:get-status", () => updateState);
  ipcMain.handle("updater:check", async () => {
    if (!app.isPackaged) {
      return publishUpdateState({ status: "development", message: "Проверка обновлений доступна только в установленной версии лаунчера." });
    }
    if (!UPDATE_SOURCE.enabled) {
      return publishUpdateState({ status: "not-configured", message: "Источник обновлений не настроен." });
    }
    if (updateCheckInProgress) return updateState;

    updateCheckInProgress = true;
    publishUpdateState({ status: "checking", message: "Проверяем GitHub Releases..." });
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("Превышено время ожидания ответа GitHub (30 секунд).")), 30000);
      });
      const result = await Promise.race([autoUpdater.checkForUpdates(), timeout]);
      if (!result) return publishUpdateState({ status: "error", message: "GitHub не вернул информацию об обновлении." });
      // electron-updater emits update-available / update-not-available and updates the UI state.
      return updateState;
    } catch (error) {
      const raw = (error as Error)?.message || "Неизвестная ошибка";
      const message = /latest\.yml|404/i.test(raw)
        ? "В последнем GitHub Release нет latest.yml. Опубликуй релиз через GitHub Actions из этого проекта."
        : raw;
      return publishUpdateState({ status: "error", message: `Не удалось проверить обновления: ${message}` });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      updateCheckInProgress = false;
    }
  });
  ipcMain.handle("updater:open-release", async (_event, url?: string) => {
    const safeUrl = typeof url === "string" && /^https:\/\/github\.com\/[^\s]+$/i.test(url)
      ? url : `https://github.com/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/releases/latest`;
    await shell.openExternal(safeUrl);
    return true;
  });
  ipcMain.handle("updater:download", async () => {
    if (updateState.status !== "available") return updateState;
    try { await autoUpdater.downloadUpdate(); return updateState; }
    catch (error) { publishUpdateState({ status: "error", message: (error as Error).message }); return updateState; }
  });
  ipcMain.handle("updater:install", () => {
    if (updateState.status === "downloaded") autoUpdater.quitAndInstall(false, true);
    return true;
  });

  ipcMain.handle("app:get-settings", () => settings);
  ipcMain.handle("app:set-settings", (_e, patch: Partial<Settings>) => saveSettings(patch));
  ipcMain.handle("game:detect", () => detectGameDirectory());
  ipcMain.handle("game:is-running", () => isGameRunning());
  ipcMain.handle("window:minimize", () => { mainWindow?.minimize(); });
  ipcMain.handle("window:close", () => { mainWindow?.close(); });
  ipcMain.handle("window:confirm-close", async () => {
    if (bridge?.isRunning()) {
      await bridge.request("shutdown").catch(() => undefined);
      bridge = null;
    }
    allowWindowClose = true;
    mainWindow?.close();
    return true;
  });
  ipcMain.handle("mint:status", () => ({
    installed: existsSync(settings.mintPath),
    mintPath: settings.mintPath,
    running: getBridge().isRunning()
  }));
  ipcMain.handle("mint:start", async () => {
    if (!existsSync(settings.mintPath)) {
      throw new Error(`MiNT Launcher.exe не найден: ${settings.mintPath}. Установи MiNT и укажи правильный путь.`);
    }
    return getBridge().start(settings.mintPath);
  });
  ipcMain.handle("mint:servers", async () => getBridge().request("servers.list"));
  ipcMain.handle("mint:prepare", async (_e, server: string) => getBridge().request("prepare", { server }));
  ipcMain.handle("mint:launch", async (_e, server: string) => {
    // Main-process mutex prevents rapid repeated clicks or forged IPC calls.
    if (launchInProgress) throw new Error("Запуск уже выполняется. Дождись завершения текущей операции.");
    if (isGameRunning()) throw new Error("GTA V уже запущена. Повторный запуск заблокирован.");
    if (Date.now() < launchPendingUntil) throw new Error("Команда запуска уже отправлена. Подожди, пока GTA V откроется.");
    launchInProgress = true;
    try {
      const args: Record<string, unknown> = { server };
      if (settings.gameDirectory) args.gameDirectory = settings.gameDirectory;
      const result = await getBridge().request("launch", args);
      // Keep a short guard after MiNT accepts the command while GTA is starting up.
      launchPendingUntil = Date.now() + 45_000;
      return result;
    } catch (error) {
      launchPendingUntil = 0;
      throw error;
    } finally {
      launchInProgress = false;
    }
  });
  ipcMain.handle("mint:cancel", async (_e, targetId: number) => getBridge().request("cancel", { targetId }));
  ipcMain.handle("mint:trust-confirm", async (_e, data) => getBridge().request("trust.confirm", data));
  ipcMain.handle("mint:shutdown", async () => {
    if (bridge?.isRunning()) await bridge.request("shutdown").catch(() => undefined);
    bridge = null;
    return true;
  });

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("before-quit", () => { bridge?.kill(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });