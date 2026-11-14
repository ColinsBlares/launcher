import { app, BrowserWindow, ipcMain, shell } from "electron";
import { createConnection, type Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname, relative, resolve, sep, isAbsolute } from "node:path";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  discordInviteUrl: "https://discord.gg/hgSDY99qyM",
  discordSupportUrl: "https://discord.gg/hgSDY99qyM",
  discordClientId: "1570458984077332561",
  discordPresenceEnabled: true
};

let mainWindow: BrowserWindow | null = null;
let bridge: MintBridge | null = null;
let allowWindowClose = false;
let launchInProgress = false;
let launchPendingUntil = 0;
let mintRuntimeError: string | null = null;
let mintWorkingDirectory = "";
let mintRuntimeSource = "unknown";
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

function findBundledMintRoot() {
  // In packaged builds extraResources are placed under process.resourcesPath.
  // In development, the archive is extracted into the repository root.
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "mint-runtime")]
    : [
        join(app.getAppPath(), "mint-runtime"),
        join(app.getAppPath(), "resources", "mint-runtime"),
        join(process.resourcesPath, "mint-runtime")
      ];
  return candidates.find(root => existsSync(join(root, "client", "Launcher.exe"))) || "";
}

function prepareWritableMintRuntime(sourceRoot: string): { executablePath: string; workingDirectory: string } {
  const sourceExecutable = join(sourceRoot, "client", "Launcher.exe");
  const manifestPath = join(sourceRoot, "runtime-manifest.json");
  if (!existsSync(sourceExecutable)) {
    throw new Error(`В комплекте Remember RP не найден MiNT: ${sourceExecutable}`);
  }

  // The release workflow writes a manifest containing hashes of every bundled
  // runtime file. Older/dev archives fall back to the Launcher.exe checksum.
  const fingerprintInput = existsSync(manifestPath)
    ? readFileSync(manifestPath)
    : readFileSync(sourceExecutable);
  const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex");

  const localAppData = process.env.LOCALAPPDATA || join(app.getPath("home"), "AppData", "Local");
  const cacheRoot = join(localAppData, "Remember RP", "MiNT Runtime");
  const versionRoot = join(cacheRoot, fingerprint);
  const stagingRoot = join(cacheRoot, `.staging-${fingerprint}-${process.pid}`);
  const workingExecutable = join(versionRoot, "client", "Launcher.exe");

  if (!existsSync(workingExecutable)) {
    mkdirSync(cacheRoot, { recursive: true });
    rmSync(stagingRoot, { recursive: true, force: true });
    if (existsSync(versionRoot)) rmSync(versionRoot, { recursive: true, force: true });
    cpSync(sourceRoot, stagingRoot, { recursive: true, force: true, preserveTimestamps: true });

    const stagedExecutable = join(stagingRoot, "client", "Launcher.exe");
    if (!existsSync(stagedExecutable)) {
      rmSync(stagingRoot, { recursive: true, force: true });
      throw new Error("Не удалось скопировать MiNT Runtime: Launcher.exe отсутствует в рабочей копии.");
    }

    try {
      renameSync(stagingRoot, versionRoot);
    } catch (error) {
      // Another launcher instance may have completed the same copy first.
      if (!existsSync(workingExecutable)) {
        rmSync(stagingRoot, { recursive: true, force: true });
        throw error;
      }
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  // The runtime archive has client/Launcher.exe under its root. MiNT's
  // staging/cache layout is rooted beside the client folder, not inside it.
  return { executablePath: workingExecutable, workingDirectory: versionRoot };
}

function isPathInside(candidatePath: string, parentPath: string) {
  const rel = relative(resolve(parentPath), resolve(candidatePath));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function findStandaloneMintExecutable() {
  const localAppData = process.env.LOCALAPPDATA || join(app.getPath("home"), "AppData", "Local");
  const bundledCache = join(localAppData, "Remember RP", "MiNT Runtime");
  const protectedResources = app.isPackaged ? process.resourcesPath : "";

  // Prefer the same standalone MiNT that is used by the VS Code development
  // setup. The settings value can already point to the old bundled cache, so
  // include the development default as an explicit fallback.
  const candidates = [
    settings.mintPath,
    defaults.mintPath,
    join(app.getPath("home"), "MiNT", "Launcher.exe")
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate)) continue;
    if (isPathInside(candidate, bundledCache)) continue;
    if (protectedResources && isPathInside(candidate, protectedResources)) continue;
    return candidate;
  }
  return "";
}

function settingsFile() {
  return join(app.getPath("userData"), "settings.json");
}
function persistSettingsFile() {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
}

function loadSettings() {
  try {
    const p = settingsFile();
    if (existsSync(p)) settings = { ...defaults, ...JSON.parse(readFileSync(p, "utf8")) };
  } catch (e) { console.error("Cannot read settings:", e); }

  // Migrate installations created before Discord was configured. Once an
  // Application ID is saved, keep the user's explicit Rich Presence toggle.
  if (!String(settings.discordClientId || "").trim()) {
    settings.discordClientId = defaults.discordClientId;
    settings.discordPresenceEnabled = defaults.discordPresenceEnabled;
  }
  if (!normalizeDiscordUrl(settings.discordInviteUrl)) settings.discordInviteUrl = defaults.discordInviteUrl;
  if (!normalizeDiscordUrl(settings.discordSupportUrl)) settings.discordSupportUrl = defaults.discordSupportUrl;
}

// Run this from the mint:status IPC request, after the splash screen is visible.
// The first copy can be large, so do not block Electron before creating a window.
function ensureWritableMintRuntime() {
  const previousMintPath = settings.mintPath;
  const previousWorkingDirectory = mintWorkingDirectory;
  const previousRuntimeSource = mintRuntimeSource;
  const standaloneExecutable = findStandaloneMintExecutable();
  const bundledRoot = findBundledMintRoot();
  try {
    // If a standalone MiNT installation exists, use it first. This keeps the
    // installed launcher on the exact same client binary as the working VS
    // Code setup instead of silently switching to a different bundled build.
    if (standaloneExecutable) {
      settings.mintPath = standaloneExecutable;
      mintWorkingDirectory = dirname(standaloneExecutable);
      mintRuntimeSource = "standalone";
      mintRuntimeError = null;
    } else if (bundledRoot) {
      const runtime = prepareWritableMintRuntime(bundledRoot);
      settings.mintPath = runtime.executablePath;
      mintWorkingDirectory = runtime.workingDirectory;
      mintRuntimeSource = "bundled";
      mintRuntimeError = null;
    } else {
      mintRuntimeError = "Не найден MiNT: нет отдельной установки и встроенного MiNT Runtime.";
      settings.mintPath = "";
      mintWorkingDirectory = "";
      mintRuntimeSource = "missing";
    }
  } catch (error) {
    mintRuntimeError = `Не удалось подготовить MiNT: ${error instanceof Error ? error.message : String(error)}`;
    settings.mintPath = "";
    mintWorkingDirectory = "";
    mintRuntimeSource = "error";
    console.error(mintRuntimeError);
  }

  if (settings.mintPath !== previousMintPath || mintWorkingDirectory !== previousWorkingDirectory ||
      mintRuntimeSource !== previousRuntimeSource || !existsSync(settingsFile())) {
    try { persistSettingsFile(); }
    catch (error) { console.error("Cannot save selected MiNT path:", error); }
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
let rememberRpLaunchRequestedAt = 0;
let activeDiscordClientId = "";
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
  const waitingForGameStart = rememberRpLaunchActive && !processRunning && Date.now() - rememberRpLaunchRequestedAt < 90_000;
  const playing = rememberRpLaunchActive && (processRunning || waitingForGameStart);
  if (rememberRpLaunchActive && !processRunning && !waitingForGameStart) rememberRpLaunchActive = false;
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
      activeDiscordClientId = clientId;
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
    activeDiscordClientId = "";
    socket?.end();
    publishDiscordState(false, "Discord Rich Presence отключён.");
    return;
  }
  if (!/^\d{17,20}$/.test(clientId)) {
    discordShouldConnect = false;
    const previous = discordRpcSocket;
    discordRpcSocket = null;
    discordRpcReady = false;
    activeDiscordClientId = "";
    previous?.end();
    publishDiscordState(false, "Укажи Application ID Discord в настройках.");
    return;
  }
  if (activeDiscordClientId && activeDiscordClientId !== clientId) {
    const previous = discordRpcSocket;
    discordRpcSocket = null;
    discordRpcReady = false;
    activeDiscordClientId = "";
    previous?.end();
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
      if ((updateState.status as string) !== "cancelled") {
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
  ipcMain.handle("mint:status", () => {
    ensureWritableMintRuntime();
    return {
      installed: Boolean(settings.mintPath && existsSync(settings.mintPath)),
      mintPath: settings.mintPath,
      running: getBridge().isRunning(),
      error: mintRuntimeError || undefined
    };
  });
  ipcMain.handle("mint:start", async () => {
    ensureWritableMintRuntime();
    if (mintRuntimeError) throw new Error(mintRuntimeError);
    if (!settings.mintPath || !existsSync(settings.mintPath)) {
      throw new Error(`MiNT Launcher.exe не найден: ${settings.mintPath || "путь не настроен"}. Установи Remember RP заново или проверь ресурсы клиента.`);
    }
    const workingDirectory = mintWorkingDirectory || dirname(settings.mintPath);
    const diagnostic = `[MiNT launch] source=${mintRuntimeSource}; executable=${settings.mintPath}; cwd=${workingDirectory}; packaged=${app.isPackaged}; appPath=${app.getAppPath()}; resourcesPath=${process.resourcesPath}`;
    console.info(diagnostic);
    emit("mint:log", diagnostic);
    return getBridge().start(settings.mintPath, workingDirectory);
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
      rememberRpLaunchRequestedAt = Date.now();
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