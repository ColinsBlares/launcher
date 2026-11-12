import { app, BrowserWindow, ipcMain, shell } from "electron";
import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
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
  discordInviteUrl: string;
  discordSupportUrl: string;
  discordClientId: string;
  discordPresenceEnabled: boolean;
};

const defaults: Settings = {
  mintPath: "D:\\MiNT\\Launcher.exe",
  gameDirectory: "",
  serverAddress: "127.0.0.1:22005",
  playerName: "Player",
  discordInviteUrl: "",
  discordSupportUrl: "",
  discordClientId: "",
  discordPresenceEnabled: false
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
let updateDownloadInProgress = false;
let updateCancellationToken: { cancel: () => void } | null = null;
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
  // NSIS blockmaps are published for versioned installer names. electron-updater
  // downloads only changed byte ranges and falls back to a full installer if a delta fails.
  autoUpdater.disableDifferentialDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on("checking-for-update", () => publishUpdateState({ status: "checking", message: "Проверяем наличие обновлений..." }));
  autoUpdater.on("update-available", (info: UpdateInfo) => publishUpdateState({ status: "available", version: info.version, releaseName: info.releaseName || "", releaseNotes: info.releaseNotes || "", message: `Доступна новая версия ${info.version}` }));
  autoUpdater.on("update-not-available", (info: UpdateInfo) => publishUpdateState({ status: "up-to-date", version: info.version, message: "Установлена последняя версия Remember RP." }));
  autoUpdater.on("download-progress", (progress: ProgressInfo) => publishUpdateState({ status: "downloading", percent: Math.round(progress.percent), transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond, message: "Загружаем обновление..." }));
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => publishUpdateState({ status: "downloaded", version: info.version, percent: 100, message: `Версия ${info.version} готова к установке.` }));
  autoUpdater.on("update-cancelled", (info: UpdateInfo) => publishUpdateState({ status: "cancelled", version: info.version, message: "Загрузка обновления остановлена. Её можно запустить повторно." }));
  autoUpdater.on("error", (error: Error) => {
    if (updateState.status === "cancelled") return;
    publishUpdateState({ status: "error", message: `Не удалось обновиться: ${error.message}` });
  });

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
function normalizeDiscordUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !["discord.gg", "discord.com", "www.discord.com"].includes(host)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function saveSettings(next: Partial<Settings>) {
  settings = {
    ...settings,
    ...next,
    discordInviteUrl: normalizeDiscordUrl(next.discordInviteUrl ?? settings.discordInviteUrl),
    discordSupportUrl: normalizeDiscordUrl(next.discordSupportUrl ?? settings.discordSupportUrl),
    discordClientId: String(next.discordClientId ?? settings.discordClientId ?? "").trim(),
    discordPresenceEnabled: Boolean(next.discordPresenceEnabled ?? settings.discordPresenceEnabled)
  };
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
  configureDiscordPresence();
  return settings;
}
function emit(channel: string, payload: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}


type DiscordRpcPayload = { cmd?: string; evt?: string; data?: any };

let discordRpcSocket: Socket | null = null;
let discordRpcReady = false;
let discordConnectInProgress = false;
let discordShouldConnect = false;
let discordReconnectTimer: NodeJS.Timeout | null = null;
let discordPresenceTimer: NodeJS.Timeout | null = null;
let discordGameState: boolean | null = null;
let rememberRpLaunchActive = false;
let discordActivityStartedAt = Math.floor(Date.now() / 1000);
let discordState: { connected: boolean; message: string } = {
  connected: false,
  message: "Discord Rich Presence отключён."
};

function publishDiscordState(connected: boolean, message: string) {
  discordState = { connected, message };
  emit("discord:status", discordState);
}

function discordFrame(opcode: number, payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header.writeInt32LE(opcode, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function sendDiscordActivity() {
  if (!discordRpcSocket || !discordRpcReady) return;
  const processRunning = isGameRunning();
  const playing = rememberRpLaunchActive && processRunning;
  if (rememberRpLaunchActive && !processRunning) rememberRpLaunchActive = false;
  if (discordGameState !== playing) {
    discordGameState = playing;
    discordActivityStartedAt = Math.floor(Date.now() / 1000);
  }
  const activity = {
    type: 0,
    details: playing ? "Играет на сервере Remember RP" : "В лаунчере Remember RP",
    state: playing ? "GTA V Roleplay" : "Готовится к игре",
    timestamps: { start: discordActivityStartedAt }
  };
  const payload = {
    cmd: "SET_ACTIVITY",
    args: { pid: process.pid, activity },
    nonce: randomUUID()
  };
  discordRpcSocket.write(discordFrame(1, payload));
}

async function connectDiscordRpc() {
  if (!discordShouldConnect || discordRpcSocket || discordConnectInProgress) return;
  const clientId = String(settings.discordClientId || "").trim();
  if (!/^\d{17,20}$/.test(clientId)) {
    publishDiscordState(false, "Укажи Application ID Discord в настройках.");
    return;
  }

  discordConnectInProgress = true;
  try {
    for (let index = 0; index < 10; index += 1) {
      const pipe = "\\\\?\\pipe\\discord-ipc-" + index;
      const socket = createConnection(pipe);
      const connected = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, 1200);
        const onConnect = () => {
          clearTimeout(timeout);
          socket.off("error", onError);
          resolve(true);
        };
        const onError = () => {
          clearTimeout(timeout);
          socket.off("connect", onConnect);
          resolve(false);
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
      });
      if (!connected) continue;

      discordRpcSocket = socket;
      discordRpcReady = false;
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 8) {
          const opcode = buffer.readInt32LE(0);
          const length = buffer.readInt32LE(4);
          if (length < 0 || length > 1024 * 1024) {
            socket.destroy(new Error("Invalid Discord RPC frame."));
            return;
          }
          if (buffer.length < 8 + length) break;
          const body = buffer.subarray(8, 8 + length);
          buffer = buffer.subarray(8 + length);
          if (opcode !== 1) continue;
          try {
            const message = JSON.parse(body.toString("utf8")) as DiscordRpcPayload;
            if (message.evt === "READY" && socket === discordRpcSocket) {
              discordRpcReady = true;
              publishDiscordState(true, "Discord подключён · Rich Presence активен");
              sendDiscordActivity();
            } else if (message.evt === "ERROR") {
              publishDiscordState(false, message.data?.message || "Discord отклонил Rich Presence.");
            }
          } catch {
            // Ignore non-JSON RPC frames.
          }
        }
      });
      socket.on("error", () => {
        if (socket === discordRpcSocket) publishDiscordState(false, "Соединение с Discord прервано.");
      });
      socket.on("close", () => {
        if (socket !== discordRpcSocket) return;
        discordRpcSocket = null;
        discordRpcReady = false;
        publishDiscordState(false, "Ожидаем подключение Discord...");
        if (discordShouldConnect && !discordReconnectTimer) {
          discordReconnectTimer = setTimeout(() => {
            discordReconnectTimer = null;
            void connectDiscordRpc();
          }, 15000);
        }
      });
      socket.write(discordFrame(0, { v: 1, client_id: clientId }));
      publishDiscordState(false, "Подключаемся к Discord...");
      return;
    }
    publishDiscordState(false, "Discord не запущен. Открой Discord и повтори попытку.");
  } finally {
    discordConnectInProgress = false;
  }
}

function configureDiscordPresence() {
  const enabled = Boolean(settings.discordPresenceEnabled);
  const clientId = String(settings.discordClientId || "").trim();
  if (!enabled) {
    discordShouldConnect = false;
    if (discordReconnectTimer) clearTimeout(discordReconnectTimer);
    discordReconnectTimer = null;
    const socket = discordRpcSocket;
    discordRpcSocket = null;
    discordRpcReady = false;
    socket?.end();
    publishDiscordState(false, "Discord Rich Presence отключён.");
    return;
  }
  if (!/^\d{17,20}$/.test(clientId)) {
    discordShouldConnect = false;
    publishDiscordState(false, "Укажи Application ID Discord в настройках.");
    return;
  }
  discordShouldConnect = true;
  void connectDiscordRpc();
}

function startDiscordPresencePolling() {
  if (discordPresenceTimer) clearInterval(discordPresenceTimer);
  discordPresenceTimer = setInterval(() => {
    if (!discordShouldConnect) return;
    if (discordRpcSocket && discordRpcReady) sendDiscordActivity();
    else void connectDiscordRpc();
  }, 5000);
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
  configureDiscordPresence();
  startDiscordPresencePolling();

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
      updateCancellationToken = result.cancellationToken || null;
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
    if (updateState.status !== "available" || updateDownloadInProgress) return updateState;
    if (!updateCancellationToken) {
      const check = await autoUpdater.checkForUpdates();
      updateCancellationToken = check?.cancellationToken || null;
    }
    if (!updateCancellationToken) return updateState;
    updateDownloadInProgress = true;
    try {
      await autoUpdater.downloadUpdate(updateCancellationToken as any);
      return updateState;
    } catch (error) {
      if (updateState.status !== "cancelled") {
        publishUpdateState({ status: "error", message: (error as Error).message });
      }
      return updateState;
    } finally {
      updateDownloadInProgress = false;
      updateCancellationToken = null;
    }
  });
  ipcMain.handle("updater:cancel-download", () => {
    if (updateDownloadInProgress && updateCancellationToken) {
      updateCancellationToken.cancel();
      publishUpdateState({ status: "cancelled", message: "Загрузка остановлена. Для продолжения запусти её повторно." });
    }
    return updateState;
  });
  ipcMain.handle("updater:install", () => {
    if (updateState.status === "downloaded") autoUpdater.quitAndInstall(false, true);
    return true;
  });

  ipcMain.handle("discord:get-status", () => discordState);
  ipcMain.handle("discord:open-link", async (_event, kind: "community" | "support") => {
    const candidate = kind === "community" ? settings.discordInviteUrl : settings.discordSupportUrl;
    const safeUrl = normalizeDiscordUrl(candidate);
    if (!safeUrl) return false;
    await shell.openExternal(safeUrl);
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
      // Rich Presence is shown only for a game launch initiated from this launcher.
      rememberRpLaunchActive = true;
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

app.on("before-quit", () => {
  bridge?.kill();
  discordShouldConnect = false;
  if (discordReconnectTimer) clearTimeout(discordReconnectTimer);
  if (discordPresenceTimer) clearInterval(discordPresenceTimer);
  discordRpcSocket?.end();
  discordRpcSocket = null;
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });