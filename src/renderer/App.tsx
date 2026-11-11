import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ChevronRight, ChevronDown,
  CircleHelp, Gauge, Headphones, Monitor, Newspaper, Play, Users, UsersRound,
  Settings, X, Zap, Minus, MessageCircle, BookOpen, Wrench, ShieldCheck, LifeBuoy, Download, RefreshCw, CheckCircle2
} from "lucide-react";

type LogItem = { title: string; detail: string; time: string };
const formatBytes = (n?: number) => n == null ? "" : `${(n / 1024 / 1024).toFixed(1)} MB`;
const timeNow = () => new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

export default function App() {
  const [settings, setSettings] = useState<any>({ mintPath: "D:\\MiNT\\Launcher.exe", gameDirectory: "", serverAddress: "127.0.0.1:22005", playerName: "Player" });
  const [mintStatus, setMintStatus] = useState<any>({ installed: false, running: false });
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const launchLock = useRef(false);
  const [gameRunning, setGameRunning] = useState(false);
  const [stage, setStage] = useState("Ожидание запуска");
  const [progress, setProgress] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [serverAddress, setServerAddress] = useState("");
  const [serverStats, setServerStats] = useState<{ players: number | null; slots: number | null }>({ players: null, slots: null });
  const [error, setError] = useState("");
  const [trust, setTrust] = useState<any>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [isBooting, setIsBooting] = useState(true);
  const bootStartedAt = useRef(Date.now());
  const [detectingGame, setDetectingGame] = useState(false);
  const [gameDetectMessage, setGameDetectMessage] = useState("");
  const [activeTab, setActiveTab] = useState("Главная");
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [updateInfo, setUpdateInfo] = useState<any>({ status: "loading", message: "Загружаем состояние обновлений...", currentVersion: "0.1.0" });
  const [updateBusy, setUpdateBusy] = useState(false);

  const addLog = (title: string, detail: string) => setLogs(old => [{ title, detail, time: timeNow() }, ...old].slice(0, 8));
  const currentServer = serverAddress || settings.serverAddress || "";

  useEffect(() => {
    window.launcher.getUpdateStatus().then(setUpdateInfo).catch(() => undefined);
    const offUpdate = window.launcher.on("updater:status", setUpdateInfo);
    return () => offUpdate();
  }, []);

  useEffect(() => {
    let active = true;
    const refreshGameState = async () => {
      try {
        const running = await window.launcher.isGameRunning();
        if (active) setGameRunning(running);
      } catch { /* Process check is best-effort; launch is guarded again in main. */ }
    };
    refreshGameState();
    const timer = window.setInterval(refreshGameState, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let active = true;
    const finishBoot = async () => {
      // Keep the cinematic intro visible for at least 1.6 seconds, even when
      // settings and MiNT initialization complete almost instantly.
      const remaining = Math.max(0, 1600 - (Date.now() - bootStartedAt.current));
      if (remaining > 0) {
        await new Promise(resolve => window.setTimeout(resolve, remaining));
      }
      if (active) setIsBooting(false);
    };

    window.launcher.getSettings().then(async s => {
      const loaded = { ...s, serverAddress: s.serverAddress || "127.0.0.1:22005" };
      if (!loaded.gameDirectory) {
        try {
          const detected = await window.launcher.detectGameDirectory();
          if (detected) {
            loaded.gameDirectory = detected;
            await window.launcher.setSettings({ gameDirectory: detected });
          }
        } catch { /* GTA path can still be selected manually in Settings. */ }
      }
      setSettings(loaded);
      setServerAddress(loaded.serverAddress);

      // Initialize MiNT automatically before revealing the main interface.
      try {
        const status = await window.launcher.getMintStatus();
        setMintStatus(status);
        if (status.installed) {
          await connectMiNT(loaded.serverAddress);
        } else {
          pushError(new Error("Игровой клиент не найден рядом с лаунчером."));
        }
      } catch (e) {
        pushError(e);
      } finally {
        await finishBoot();
      }
    }).catch(async e => {
      pushError(e);
      await finishBoot();
    });
    const offState = window.launcher.on("mint:state", (data) => {
      setConnected(data.state === "ready");
      setMintStatus((old: any) => ({ ...old, running: data.state === "ready" }));
      addLog(data.state === "ready" ? "Игровой клиент готов" : "Состояние клиента", data.state);
    });
    const offEvent = window.launcher.on("mint:event", (data) => {
      if (data.event === "progress") {
        const pct = data.totalBytes > 0 ? Math.round(data.completedBytes / data.totalBytes * 100) : null;
        setProgress(pct);
        const labels: any = { update: "Обновление клиента", prepare: "Подготовка ресурсов", launch: "Запуск игры" };
        setStage(`${labels[data.stage] || data.stage}: ${data.phase || data.message || "выполняется"}`);
      }
      if (data.event === "trust.required") setTrust(data);
    });
    const offTrust = window.launcher.on("mint:trust-required", setTrust);
    const offLog = window.launcher.on("mint:log", (line) => addLog("Журнал клиента", String(line)));
    const offClose = window.launcher.on("app:close-requested", () => setShowExitConfirm(true));
    return () => {
      active = false;
      offState(); offEvent(); offTrust(); offLog(); offClose();
    };
  }, []);

  const pushError = (e: any) => {
    const message = e?.message || String(e);
    setError(message); addLog("Ошибка", message); setBusy(false);
  };

  async function connectMiNT() {
    setError("");
    try {
      await window.launcher.startMint();
      setConnected(true); setMintStatus((s: any) => ({ ...s, installed: true, running: true }));
      addLog("Соединение установлено", "Игровой клиент API");
      // MiNT allows only one long-running operation at a time. Do not call
      // servers.list during startup: update/prepare may already be in progress.
      // Player counters will be populated later from the dedicated game-server API.
      setServerStats({ players: null, slots: null });
      return true;
    } catch (e) { pushError(e); return false; }
  }
  async function runGame() {
    // Synchronous renderer-side lock closes the tiny gap before React updates state.
    if (launchLock.current) return;
    launchLock.current = true;
    setBusy(true);
    try {
      const alreadyRunning = await window.launcher.isGameRunning();
      setGameRunning(alreadyRunning);
      if (alreadyRunning) { setError("GTA V уже запущена. Повторный запуск заблокирован."); return; }
      if (!currentServer.trim()) { setError("Укажи адрес сервера в формате host:port."); return; }
      if (!connected) { const ok = await connectMiNT(); if (!ok) return; }
      setError(""); setProgress(null); setStage("Подготовка запуска");
      await window.launcher.setSettings({ serverAddress: currentServer, playerName: settings.playerName });
      const result = await window.launcher.launch(currentServer.trim());
      setStage(result?.status === "handedOff" ? "Передано игровому клиенту" : "Операция завершена");
      addLog("Запуск", result?.status || "Выполнено");
    } catch (e) { pushError(e); }
    finally { launchLock.current = false; setBusy(false); setProgress(null); }
  }
  async function autoDetectGame() {
    setDetectingGame(true);
    setGameDetectMessage("Ищем установленную GTA V...");
    try {
      const detected = await window.launcher.detectGameDirectory();
      if (detected) {
        setSettings((old: any) => ({ ...old, gameDirectory: detected }));
        setGameDetectMessage("GTA V найдена. Путь подставлен автоматически.");
      } else {
        setGameDetectMessage("Не удалось найти GTA V автоматически. Укажи путь вручную.");
      }
    } catch (e: any) {
      setGameDetectMessage(e?.message || "Ошибка автоматического поиска GTA V.");
    } finally {
      setDetectingGame(false);
    }
  }

  async function checkUpdates() {
    setUpdateBusy(true);
    try { setUpdateInfo(await window.launcher.checkForUpdates()); }
    catch (e: any) { setUpdateInfo({ status: "error", message: e?.message || "Ошибка проверки обновлений." }); }
    finally { setUpdateBusy(false); }
  }
  async function openUpdateRelease() {
    try { await window.launcher.openUpdateRelease(updateInfo.releaseUrl); }
    catch (e: any) { setUpdateInfo({ status: "error", message: e?.message || "Не удалось открыть страницу релиза." }); }
  }

  async function saveSettings() {
    const saved = await window.launcher.setSettings(settings);
    setSettings(saved); setShowSettings(false);
    const status = await window.launcher.getMintStatus(); setMintStatus(status);
  }

  const nav = [
    { label: "Главная", icon: Gauge }, { label: "Новости", icon: Newspaper },
    { label: "Поддержка", icon: Headphones }
  ];
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">R</div><div><b>REMEMBER<span> RP</span></b><small>ROLEPLAY PROJECT</small></div></div>
      <div className="nav-caption">МЕНЮ</div>
      {nav.map(({ label, icon: Icon }) => <button key={label} className={`nav-item ${activeTab === label ? "active" : ""}`} onClick={() => setActiveTab(label)}><Icon size={18}/>{label}{label === "Главная" && <i/>}</button>)}
      <div className="sidebar-bottom">
        <button className="nav-item" onClick={() => setShowSettings(true)}><Settings size={18}/>Настройки</button>
        <div className="profile"><div className="avatar">P</div><div><b>{settings.playerName || "Player"}</b><small>Игровой профиль</small></div><button className="icon-btn" onClick={() => setShowSettings(true)}><Settings size={17}/></button></div>
      </div>
    </aside>

    <main className="main page-transition" key={activeTab}>
      <header className="topbar"><div className="crumb">REMEMBER RP <ChevronRight size={14}/> <b>{activeTab.toUpperCase()}</b></div><div className="top-right"><span className="top-status"><span className={`status-dot ${connected ? "green" : ""}`}/>{connected ? "СИСТЕМА ГОТОВА" : "ОЖИДАНИЕ"}</span><button className="icon-btn" onClick={() => setShowSettings(true)} title="Настройки"><Settings size={18}/></button><div className="window-controls"><button className="window-control" onClick={() => window.launcher.minimizeWindow()} title="Свернуть"><Minus size={15}/></button><button className="window-control close" onClick={() => window.launcher.closeWindow()} title="Закрыть лаунчер"><X size={16}/></button></div></div></header>

      {activeTab === "Главная" ? <>
        <section className="hero">
          <div className="hero-bg"/>
          <div className="hero-content">
            <div className="eyebrow"><span/> LOS SANTOS ROLEPLAY</div>
            <h1>ТВОЯ ИСТОРИЯ.<br/><em>ТВОИ ПРАВИЛА.</em></h1>
            <p>Добро пожаловать в мир, где каждый выбор имеет значение.<br/>Подключайся и создавай собственную историю.</p>
            <div className="hero-actions">
              <button className="play-btn" onClick={runGame} disabled={busy || gameRunning}><Play size={18} fill="currentColor"/>{gameRunning ? "GTA V ЗАПУЩЕНА" : busy ? "ЗАПУСК..." : "ИГРАТЬ"}</button>
            </div>
            {busy && <div className="download-progress" role="status" aria-live="polite">
              <div className="download-progress-head">
                <span className="download-progress-label">{stage}</span>
                <b>{progress === null ? "ВЫПОЛНЯЕТСЯ" : `${progress}%`}</b>
              </div>
              <div className="download-progress-track">
                <div className={`download-progress-fill ${progress === null ? "indeterminate" : ""}`} style={progress === null ? undefined : { width: `${Math.max(0, Math.min(100, progress))}%` }}/>
              </div>
              <div className="download-progress-foot">Загрузка и подготовка игровых ресурсов</div>
            </div>}
          </div>
          <div className="hero-side">
            <div className="server-live-label"><span className="live-indicator"/> LIVE SERVER STATUS</div>
            <div className="hero-stat-grid">
              <div className="hero-stat">
                <div className="hero-stat-icon"><Users size={17}/></div>
                <strong>{serverStats.players === null ? "—" : serverStats.players.toLocaleString("ru-RU")}</strong>
                <span>ИГРОКОВ ОНЛАЙН</span>
              </div>
              <div className="hero-stat">
                <div className="hero-stat-icon"><UsersRound size={17}/></div>
                <strong>{serverStats.slots === null ? "—" : serverStats.slots.toLocaleString("ru-RU")}</strong>
                <span>ВСЕГО СЛОТОВ</span>
              </div>
            </div>
            <div className="hero-server-foot"><span className="status-dot green"/> ОСНОВНОЙ СЕРВЕР</div>
          </div>
        </section>

        <div className="content-grid single-server-home">
          <section className="panel news-panel">
            <div className="panel-title"><div><span className="section-kicker">LATEST UPDATES</span><h2>Последние новости</h2></div><Newspaper size={19} className="muted-icon"/></div>
            <div className="news-item"><div className="news-date">10.11.2026 <span>LAUNCHER</span></div><b>Первый запуск проекта</b><p>Настраиваем клиент и готовим инфраструктуру для подключения к игровому миру.</p></div>
            <div className="news-item"><div className="news-date">DEVLOG <span>TECH</span></div><b>Игровой клиент Remember RP</b><p>Собственный интерфейс запуска игры и подготовки ресурсов.</p></div>
          </section>
        </div>
      </> : activeTab === "Поддержка" ? <section className="support-page">
        <div className="support-hero">
          <div className="support-hero-copy">
            <span className="section-kicker">REMEMBER RP • HELP CENTER</span>
            <h1>ЦЕНТР <em>ПОДДЕРЖКИ</em></h1>
            <p>Возникли сложности с запуском или подключением? Здесь собрали ответы на частые вопросы и полезные подсказки.</p>
            <div className="support-hero-meta"><span><LifeBuoy size={14}/> Помощь по лаунчеру</span><span><ShieldCheck size={14}/> Безопасность аккаунта</span></div>
          </div>
          <div className="support-hero-art"><div className="support-orbit orbit-one"/><div className="support-orbit orbit-two"/><div className="support-headset"><Headphones size={54}/></div><span className="support-art-dot dot-a"/><span className="support-art-dot dot-b"/></div>
        </div>
        <div className="support-section-heading"><div><span className="section-kicker">ЧЕМ МЫ МОЖЕМ ПОМОЧЬ</span><h2>Выбери тему обращения</h2></div><span className="support-section-note">БЫСТРЫЕ ПОДСКАЗКИ</span></div>
        <div className="support-topic-grid">
          <div className="support-topic"><div className="support-topic-icon"><Monitor size={20}/></div><div><b>Проблемы с запуском</b><p>Если игра не запускается или зависает загрузка.</p></div><span className="support-topic-arrow"><ChevronRight size={16}/></span></div>
          <div className="support-topic"><div className="support-topic-icon"><Wrench size={20}/></div><div><b>Установка и обновление</b><p>Игровые файлы и обновления клиента.</p></div><span className="support-topic-arrow"><ChevronRight size={16}/></span></div>
          <div className="support-topic"><div className="support-topic-icon"><ShieldCheck size={20}/></div><div><b>Аккаунт и безопасность</b><p>Защита данных и безопасное подключение.</p></div><span className="support-topic-arrow"><ChevronRight size={16}/></span></div>
        </div>
        <div className="support-lower-grid">
          <section className="panel support-faq-panel">
            <div className="panel-title"><div><span className="section-kicker">FAQ</span><h2>Частые вопросы</h2></div><CircleHelp size={19} className="muted-icon"/></div>
            {[
              {q:"Что делать, если GTA V не найдена?",a:"Открой настройки лаунчера и нажми «Найти GTA V». Если автоматический поиск не помог, укажи папку игры вручную — в ней должен находиться файл GTA5.exe."},
              {q:"Почему кнопка «Играть» недоступна?",a:"Проверь, не запущена ли уже GTA V. Лаунчер блокирует повторный запуск, пока игровой процесс активен. Если игра закрыта, подожди пару секунд — статус обновится автоматически."},
              {q:"Игровой клиент не запускается или показывает ошибку",a:"Убедись, что игровые компоненты установлены вместе с лаунчером и содержат Launcher.exe и сопутствующие файлы. Не удаляй DLL и папки ресурсов клиента."},
              {q:"Загрузка долго стоит на одном месте",a:"Подготовка ресурсов может занимать время в зависимости от объёма обновления и скорости соединения. Не закрывай лаунчер во время активной операции."}
            ].map((item, index) => <div className={`support-faq-item ${openFaq === index ? "expanded" : ""}`} key={item.q}>
              <button className="support-faq-question" onClick={() => setOpenFaq(openFaq === index ? null : index)} aria-expanded={openFaq === index}><span>{item.q}</span><ChevronDown size={17}/></button>
              {openFaq === index && <p className="support-faq-answer">{item.a}</p>}
            </div>)}
          </section>
          <aside className="support-contact-card">
            <div className="support-contact-icon"><MessageCircle size={22}/></div>
            <span className="section-kicker">НУЖНА ПОМОЩЬ?</span>
            <h2>Не нашёл<br/>ответ на вопрос?</h2>
            <p>Канал связи с командой поддержки появится здесь после подключения сайта проекта.</p>
            <div className="support-contact-status"><span/> КАНАЛ ПОДДЕРЖКИ ГОТОВИТСЯ</div>
            <div className="support-contact-line"/>
            <small>При обращении подготовь описание проблемы и скриншот ошибки.</small>
          </aside>
        </div>
      </section> : <section className="placeholder-page"><div className="stat-icon"><CircleHelp size={24}/></div><span className="section-kicker">COMING SOON</span><h1>{activeTab}</h1><p>Раздел будет подключён на следующем этапе разработки.</p><button className="secondary-small" onClick={() => setActiveTab("Главная")}>Вернуться на главную</button></section>}
      <footer><span>© 2026 REMEMBER RP PROJECT</span><span>REMEMBER RP • OFFICIAL LAUNCHER</span></footer>
    </main>

    {error && <div className="toast error-toast"><AlertTriangle size={18}/><span>{error}</span><button onClick={() => setError("")}><X size={16}/></button></div>}
    {showExitConfirm && <div className="modal-backdrop exit-confirm-backdrop">
      <div className="modal exit-confirm-modal">
        <div className="exit-confirm-icon"><X size={22}/></div>
        <span className="section-kicker">REMEMBER RP LAUNCHER</span>
        <h2>Закрыть лаунчер?</h2>
        <p>Ты действительно хочешь выйти? Игровой клиент будет корректно остановлен.</p>
        <div className="modal-actions">
          <button className="secondary-small" onClick={() => setShowExitConfirm(false)}>Остаться</button>
          <button className="primary-small" onClick={() => window.launcher.confirmCloseWindow()}>Выйти из лаунчера</button>
        </div>
      </div>
    </div>}
    {isBooting && <div className="boot-screen">
      <div className="boot-grid"/>
      <div className="boot-scanline"/>
      <div className="boot-glow"/>
      <div className="boot-emblem-wrap">
        <div className="boot-orbit boot-orbit-outer"><i/><i/><i/></div>
        <div className="boot-orbit boot-orbit-inner"><i/></div>
        <div className="boot-emblem-shadow"/>
        <div className="boot-brand">
          <div className="boot-logo"><span>R</span><i/></div>
          <div className="boot-wordmark">REMEMBER<span> RP</span></div>
          <div className="boot-subtitle">ROLEPLAY MULTIPLAYER</div>
        </div>
      </div>
      <div className="boot-loading-block">
        <div className="boot-loader-head"><span>ЗАПУСК СИСТЕМЫ</span><span className="boot-loading-dots">•••</span></div>
        <div className="boot-loader"><span/></div>
        <div className="boot-caption"><span className="boot-caption-dot"/>ПОДГОТОВКА ИГРОВОГО КЛИЕНТА</div>
      </div>
      <div className="boot-version">REMEMBER RP <b>•</b> OFFICIAL LAUNCHER</div>
    </div>}
    {trust && <div className="modal-backdrop"><div className="modal trust-modal"><div className="modal-head"><h2>Изменился ключ сервера</h2><button className="icon-btn" onClick={() => setTrust(null)}><X/></button></div><p>Игровой клиент сообщает, что ключ сервера изменился. Подтверждай только если доверяешь владельцу сервера.</p><div className="key-box"><small>СЕРВЕР</small><b>{trust.server}</b><small>ПРЕДЫДУЩИЙ КЛЮЧ</small><code>{trust.previousKey}</code><small>НОВЫЙ КЛЮЧ</small><code>{trust.candidateKey}</code></div><div className="modal-actions"><button className="secondary-small" onClick={async () => { await window.launcher.confirmTrust({ targetId: trust.id, requestId: trust.requestId, accepted: false }); setTrust(null); }}>Отклонить</button><button className="primary-small" onClick={async () => { await window.launcher.confirmTrust({ targetId: trust.id, requestId: trust.requestId, accepted: true }); setTrust(null); }}>Доверять этому ключу</button></div></div></div>}
    {showSettings && <div className="modal-backdrop"><div className="modal"><div className="modal-head"><div><span className="section-kicker">CONFIGURATION</span><h2>Настройки лаунчера</h2></div><button className="icon-btn" onClick={() => setShowSettings(false)}><X/></button></div>
      <div className="updater-settings-card">
        <div className="updater-settings-head">
          <div className="updater-settings-icon"><RefreshCw size={17}/></div>
          <div className="updater-settings-copy"><b>Обновления лаунчера</b><small>Текущая версия: {updateInfo.currentVersion || "0.1.0"}</small></div>
          <span className={`updater-state ${updateInfo.status === "up-to-date" || updateInfo.status === "downloaded" ? "ok" : ""}`}>{updateInfo.status === "available" ? "ДОСТУПНО" : updateInfo.status === "downloaded" ? "ГОТОВО" : updateInfo.status === "up-to-date" ? "АКТУАЛЬНО" : updateInfo.status === "not-configured" ? "ОТКЛЮЧЕНО" : updateInfo.status === "downloading" ? "ЗАГРУЗКА" : ""}</span>
        </div>
        <p className="updater-message">{updateInfo.message || "Проверка обновлений через GitHub Releases."}</p>
        {updateInfo.status === "downloading" && <div className="updater-progress"><div style={{ width: `${Math.max(0, Math.min(100, updateInfo.percent || 0))}%` }}/></div>}
        <div className="updater-actions">
          {updateInfo.status === "available" ? <button className="primary-small" onClick={async () => { setUpdateBusy(true); try { await window.launcher.downloadUpdate(); } catch (e: any) { setUpdateInfo({ status: "error", message: e?.message || "Не удалось загрузить обновление." }); } finally { setUpdateBusy(false); } }} disabled={updateBusy}><Download size={13}/> Скачать {updateInfo.version}</button> : null}
          {updateInfo.status === "downloaded" ? <button className="primary-small" onClick={() => window.launcher.installUpdate()}><CheckCircle2 size={13}/> Перезапустить и установить</button> : null}
          <button className="secondary-small" onClick={checkUpdates} disabled={updateBusy || updateInfo.status === "downloading"}>{updateBusy || updateInfo.status === "checking" ? "Проверяем..." : "Проверить обновления"}</button>
        </div>
        <small className="updater-footnote">Источник обновлений: GitHub Releases · ColinsBlares/launcher.</small>
      </div>
      <label className="field-label">ПУТЬ К GTA V</label>
      <div className="game-path-row">
        <input className="modal-input" value={settings.gameDirectory} onChange={e => setSettings({ ...settings, gameDirectory: e.target.value })} placeholder="Путь будет найден автоматически или укажи вручную"/>
        <button className="secondary-small detect-game-btn" onClick={autoDetectGame} disabled={detectingGame}>{detectingGame ? "Поиск..." : "Найти GTA V"}</button>
      </div>
      {gameDetectMessage && <div className="detect-message">{gameDetectMessage}</div>}
      <label className="field-label">АДРЕС ОСНОВНОГО СЕРВЕРА</label><input className="modal-input" value={settings.serverAddress || ""} onChange={e => { setSettings({ ...settings, serverAddress: e.target.value }); setServerAddress(e.target.value); }} placeholder="127.0.0.1:22005 — локальная заглушка"/>
      <label className="field-label">ИГРОВОЕ ИМЯ</label><input className="modal-input" value={settings.playerName} onChange={e => setSettings({ ...settings, playerName: e.target.value })}/>
      <div className="modal-actions"><button className="secondary-small" onClick={() => setShowSettings(false)}>Отмена</button><button className="primary-small" onClick={saveSettings}>Сохранить настройки</button></div>
    </div></div>}
  </div>;
}