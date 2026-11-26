import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ChevronRight, ChevronDown,
  CircleHelp, Gauge, Headphones, Monitor, Newspaper, Play, Users, UsersRound, Store, MessageSquare,
  Settings, X, Zap, Minus, MessageCircle, BookOpen, Wrench, ShieldCheck, LifeBuoy, Download, RefreshCw, CheckCircle2, Lightbulb
} from "lucide-react";

type LogItem = { title: string; detail: string; time: string };
const formatBytes = (n?: number) => n == null ? "" : `${(n / 1024 / 1024).toFixed(1)} MB`;
const timeNow = () => new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const formatSpeed = (n?: number) => {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${Math.round(n)} Б/с`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ/с`;
  return `${(n / 1024 / 1024).toFixed(2)} МБ/с`;
};

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
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [isBooting, setIsBooting] = useState(true);
  const [bootProgress, setBootProgress] = useState(0);
  const [bootMessage, setBootMessage] = useState("ИНИЦИАЛИЗАЦИЯ REMEMBER RP");
  const bootStartedAt = useRef(Date.now());
  const [detectingGame, setDetectingGame] = useState(false);
  const [gameDetectMessage, setGameDetectMessage] = useState("");
  const [activeTab, setActiveTab] = useState("Главная");
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [updateInfo, setUpdateInfo] = useState<any>({ status: "loading", message: "Загружаем состояние обновлений...", currentVersion: "0.1.7" });
  const [updateBusy, setUpdateBusy] = useState(false);
  const [discordInfo, setDiscordInfo] = useState<any>({ connected: false, message: "Проверяем Discord..." });

  const addLog = (title: string, detail: string) => setLogs(old => [{ title, detail, time: timeNow() }, ...old].slice(0, 8));
  const currentServer = serverAddress || settings.serverAddress || "";

  useEffect(() => {
    window.launcher.getUpdateStatus().then(setUpdateInfo).catch(() => undefined);
    const offUpdate = window.launcher.on("updater:status", setUpdateInfo);
    return () => offUpdate();
  }, []);

  useEffect(() => {
    window.launcher.getDiscordStatus().then(setDiscordInfo).catch(() => undefined);
    const offDiscord = window.launcher.on("discord:status", setDiscordInfo);
    return () => offDiscord();
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
    const bootInterval = window.setInterval(() => {
      const elapsed = Date.now() - bootStartedAt.current;
      const percent = Math.min(94, Math.round((elapsed / 4200) * 94));
      setBootProgress(percent);
      if (percent < 16) setBootMessage("ЗАПУСК ЯДРА REMEMBER RP");
      else if (percent < 34) setBootMessage("ПРОВЕРКА ИГРОВЫХ КОМПОНЕНТОВ");
      else if (percent < 54) setBootMessage("ПОИСК УСТАНОВЛЕННОЙ GTA V");
      else if (percent < 80) setBootMessage("ИНИЦИАЛИЗАЦИЯ MiNT CLIENT");
      else setBootMessage("ПОДГОТОВКА ИНТЕРФЕЙСА");
    }, 80);

    const finishBoot = async () => {
      // The visual progress is intentionally staged, but never completes
      // before settings, GTA detection and MiNT initialization are finished.
      const remaining = Math.max(0, 4200 - (Date.now() - bootStartedAt.current));
      if (remaining > 0) {
        await new Promise(resolve => window.setTimeout(resolve, remaining));
      }
      if (active) {
        setBootProgress(100);
        setBootMessage("ЗАГРУЗКА ЗАВЕРШЕНА");
        await new Promise(resolve => window.setTimeout(resolve, 320));
        if (active) setIsBooting(false);
      }
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
        if (status.error) {
          pushError(new Error(status.error));
        } else if (status.installed) {
          await connectMiNT();
        } else {
          pushError(new Error("Игровой клиент не найден. Проверь папку ресурсов Remember RP."));
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
      window.clearInterval(bootInterval);
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
  async function retryUpdateDownload() {
    setUpdateBusy(true);
    try {
      const checked = await window.launcher.checkForUpdates();
      setUpdateInfo(checked);
      if (checked?.status === "available") {
        await window.launcher.downloadUpdate();
      }
    } catch (e: any) {
      setUpdateInfo({ status: "error", message: e?.message || "Не удалось повторно загрузить обновление." });
    } finally {
      setUpdateBusy(false);
    }
  }

  async function stopUpdateDownload() {
    try {
      setUpdateInfo(await window.launcher.cancelUpdateDownload());
    } catch (e: any) {
      setUpdateInfo({ status: "error", message: e?.message || "Не удалось остановить загрузку." });
    }
  }

  async function openDiscordLink(kind: "community" | "support") {
    try {
      const opened = await window.launcher.openDiscordLink(kind);
      if (!opened) setError(kind === "community" ? "Ссылка на Discord-сообщество ещё не настроена." : "Ссылка на Discord-поддержку ещё не настроена.");
    } catch (e: any) {
      setError(e?.message || "Не удалось открыть Discord.");
    }
  }

  async function openUpdateRelease() {
    try { await window.launcher.openUpdateRelease(updateInfo.releaseUrl); }
    catch (e: any) { setUpdateInfo({ status: "error", message: e?.message || "Не удалось открыть страницу релиза." }); }
  }

  async function saveSettings() {
    const saved = await window.launcher.setSettings(settings);
    setSettings(saved);
    const status = await window.launcher.getMintStatus(); setMintStatus(status);
  }

  const nav = [
    { label: "Главная", title: "Играть", icon: Play },
    { label: "Магазин", title: "Магазин", icon: Store },
    { label: "Новости", title: "Новости", icon: Newspaper },
    { label: "Форум", title: "Форум", icon: MessageSquare },
    { label: "Wiki", title: "Wiki", icon: BookOpen },
    { label: "Поддержка", title: "Поддержка", icon: LifeBuoy }
  ];
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">R</div><div><b>REMEMBER<span> RP</span></b></div></div>
      <div className="nav-caption">НАВИГАЦИЯ</div>
      {nav.map(({ label, title, icon: Icon }) => <button key={label} className={`nav-item ${activeTab === label ? "active" : ""}`} onClick={() => setActiveTab(label)}><Icon size={19}/>{title}{label === "Главная" && <i/>}</button>)}
      <button className="nav-item" onClick={() => openDiscordLink("community")}><MessageCircle size={19}/>Дискорд</button>
      <div className="sidebar-bottom">
        <button className={`nav-item ${activeTab === "Настройки" ? "active" : ""}`} onClick={() => setActiveTab("Настройки")}><Settings size={19}/>Настройки</button>
        <div className="profile-card">
          <div className="profile-card-top"><div className="profile-avatar">{(settings.playerName || "P").slice(0,1).toUpperCase()}</div><div className="profile-card-name"><b>{settings.playerName || "Player"}</b><small>Игровой профиль</small></div></div>
          <div className="profile-card-id">REMEMBER RP <span>•</span> ID не привязан</div>
          <div className="profile-card-balance"><b>—</b><span>Донат-счёт</span></div>
          <button className="profile-logout" onClick={() => setShowExitConfirm(true)}>Выход</button>
        </div>
      </div>
    </aside>

    <main className="main page-transition" key={activeTab}>
      <header className="topbar screenshot-topbar"><div className="top-live"><span className="status-dot green"/>{serverStats.players === null ? "СЕРВЕР ONLINE" : `${serverStats.players} игроков`}<span className="top-version">v{updateInfo.currentVersion || "0.1.14"}</span></div><div className="top-right"><div className="window-controls"><button className="window-control" onClick={() => window.launcher.minimizeWindow()} title="Свернуть"><Minus size={17}/></button><button className="window-control close" onClick={() => window.launcher.closeWindow()} title="Закрыть лаунчер"><X size={17}/></button></div></div></header>

      {activeTab === "Главная" ? <>
        <section className="screenshot-hero">
          <div className="screenshot-hero-image"/>
          <div className="screenshot-hero-shade"/>
          <div className="screenshot-hero-copy">
            <div className="screenshot-hero-kicker">REMEMBER RP <span>•</span> LOS SANTOS</div>
            <button className="screenshot-play" onClick={runGame} disabled={busy || gameRunning}>
              <Play size={32} fill="currentColor"/>
              <span>{gameRunning ? "Игра уже запущена" : busy ? "Подготовка игры..." : "Начать игру"}</span>
            </button>
            {busy && <div className="download-progress screenshot-progress" role="status" aria-live="polite">
              <div className="download-progress-head"><span className="download-progress-label">{stage}</span><b>{progress === null ? "ВЫПОЛНЯЕТСЯ" : `${progress}%`}</b></div>
              <div className="download-progress-track"><div className={`download-progress-fill ${progress === null ? "indeterminate" : ""}`} style={progress === null ? undefined : { width: `${Math.max(0, Math.min(100, progress))}%` }}/></div>
            </div>}
          </div>
          <div className="screenshot-hero-stats"><span className="screenshot-live-dot"/><b>{serverStats.players === null ? "Сервер Remember RP" : `${serverStats.players} игроков`}</b><span className="screenshot-version">v{updateInfo.currentVersion || "0.1.14"}</span></div>
        </section>
        <div className="screenshot-content">
          <section className="screenshot-news">
            <div className="screenshot-section-heading"><h2>Недавние новости</h2><span>Все новости <ChevronRight size={15}/></span></div>
            <div className="screenshot-news-grid">
              <article className="screenshot-news-card news-car"><div className="screenshot-news-image"/><div className="screenshot-news-copy"><b>Развитие Remember RP 🚘</b><p>Мы продолжаем работу над игровым миром, системами и возможностями проекта.</p><button onClick={() => setActiveTab("Новости")}>Читать полностью <ChevronRight size={15}/></button></div></article>
              <article className="screenshot-news-card news-city"><div className="screenshot-news-image"/><div className="screenshot-news-copy"><b>Здесь начнётся твоя история</b><p>Создаём место, в котором каждый игрок сможет написать собственную историю.</p><button onClick={() => setActiveTab("Новости")}>Читать полностью <ChevronRight size={15}/></button></div></article>
            </div>
          </section>
          <aside className="screenshot-deals">
            <div className="screenshot-section-heading"><h2>Выгодно</h2></div>
            <div className="screenshot-deal-card"><span className="deal-label">REMEMBER RP</span><b>Твой путь начинается здесь</b><p>Следи за новостями проекта и не пропускай важные события.</p><button onClick={() => setActiveTab("Новости")}>Подробнее <ChevronRight size={15}/></button></div>
            <div className="screenshot-discord-card"><MessageCircle size={19}/><div><b>Наше сообщество</b><small>Общайся с игроками в Discord</small></div><button onClick={() => openDiscordLink("community")}><ChevronRight size={17}/></button></div>
          </aside>
        </div>
            </> : activeTab === "Магазин" ? <section className="inner-page">
        <div className="inner-page-hero shop-page-hero">
          <div className="inner-page-hero-copy"><span className="section-kicker">REMEMBER RP • STORE</span><h1>МАГАЗИН <em>ПРОЕКТА</em></h1><p>Всё для твоей истории в Remember RP. Каталог и покупки появятся здесь после открытия магазина.</p><span className="page-status"><span/> МАГАЗИН ГОТОВИТСЯ К ОТКРЫТИЮ</span></div>
          <div className="inner-page-hero-art"><Store size={74}/><div className="hero-art-ring"/></div>
        </div>
        <div className="inner-page-heading"><div><span className="section-kicker">STORE CATEGORIES</span><h2>Категории магазина</h2></div><span className="page-muted">СКОРО В REMEMBER RP</span></div>
        <div className="feature-card-grid three">
          <article className="feature-card"><div className="feature-card-icon"><Zap size={22}/></div><span className="feature-card-tag">01 / ПРЕМИУМ</span><h3>Премиум-статусы</h3><p>Дополнительные возможности и привилегии на сервере.</p><span className="feature-card-soon">СКОРО</span></article>
          <article className="feature-card"><div className="feature-card-icon"><UsersRound size={22}/></div><span className="feature-card-tag">02 / ПЕРСОНАЖ</span><h3>Персонализация</h3><p>Настрой внешний вид и детали своего игрового образа.</p><span className="feature-card-soon">СКОРО</span></article>
          <article className="feature-card"><div className="feature-card-icon"><ShieldCheck size={22}/></div><span className="feature-card-tag">03 / БОНУСЫ</span><h3>Наборы и бонусы</h3><p>Полезные наборы для комфортного старта в городе.</p><span className="feature-card-soon">СКОРО</span></article>
        </div>
        <div className="page-bottom-banner"><div><b>Следи за запуском магазина</b><p>Объявим об открытии в новостях Remember RP.</p></div><button className="secondary-small" onClick={() => setActiveTab("Новости")}>К новостям <ChevronRight size={15}/></button></div>
      </section> : activeTab === "Новости" ? <section className="inner-page">
        <div className="inner-page-title"><div><span className="section-kicker">REMEMBER RP • NEWSROOM</span><h1>НОВОСТИ <em>ПРОЕКТА</em></h1><p>Последние события и заметки о разработке Remember RP.</p></div><div className="page-title-icon"><Newspaper size={35}/></div></div>
        <div className="news-feature-grid">
          <article className="news-feature-card news-feature-main"><div className="news-feature-image news-car"/><div className="news-feature-overlay"/><div className="news-feature-copy"><span className="feature-card-tag">РАЗРАБОТКА • REMEMBER RP</span><h2>Развитие Remember RP</h2><p>Мы продолжаем работу над игровым миром, системами и возможностями проекта.</p><span className="news-read-label">НОВОСТЬ ПРОЕКТА <ChevronRight size={15}/></span></div></article>
          <article className="news-feature-card"><div className="news-feature-image news-city"/><div className="news-feature-overlay"/><div className="news-feature-copy"><span className="feature-card-tag">МИР • ЛОС-САНТОС</span><h2>Здесь начнётся твоя история</h2><p>Создаём место, в котором каждый игрок сможет написать собственную историю.</p><span className="news-read-label">НОВОСТЬ ПРОЕКТА <ChevronRight size={15}/></span></div></article>
        </div>
        <div className="inner-page-heading"><div><span className="section-kicker">UPDATES</span><h2>Дневник разработки</h2></div><span className="page-muted">REMEMBER RP</span></div>
        <div className="timeline-list"><div className="timeline-item"><span className="timeline-dot"/><div><b>Обновление лаунчера</b><p>Новый интерфейс, улучшенная навигация и подготовка к дальнейшим обновлениям.</p></div><span className="timeline-label">LAUNCHER</span></div><div className="timeline-item"><span className="timeline-dot"/><div><b>Работа над игровым миром</b><p>Продолжаем собирать системы и наполнять проект контентом.</p></div><span className="timeline-label">DEVELOPMENT</span></div></div>
      </section> : activeTab === "Форум" ? <section className="inner-page">
        <div className="inner-page-hero forum-page-hero"><div className="inner-page-hero-copy"><span className="section-kicker">REMEMBER RP • COMMUNITY</span><h1>СООБЩЕСТВО <em>ИГРОКОВ</em></h1><p>Обсуждай обновления, делись идеями и находи единомышленников. Общение с командой и игроками — в нашем Discord.</p><button className="page-primary-action" onClick={() => openDiscordLink("community")}><MessageCircle size={16}/> Перейти в сообщество <ChevronRight size={16}/></button></div><div className="inner-page-hero-art"><MessageSquare size={76}/><div className="hero-art-ring"/></div></div>
        <div className="inner-page-heading"><div><span className="section-kicker">COMMUNITY SPACE</span><h2>Разделы сообщества</h2></div><span className="page-muted">ОБЩАЙСЯ • ПРЕДЛАГАЙ • УЧАСТВУЙ</span></div>
        <div className="feature-card-grid three"><article className="feature-card"><div className="feature-card-icon"><MessageCircle size={22}/></div><span className="feature-card-tag">01 / DISCUSSION</span><h3>Обсуждения</h3><p>Общайся с игроками и обсуждай последние события.</p><button className="feature-card-link" onClick={() => openDiscordLink("community")}>Открыть Discord <ChevronRight size={14}/></button></article><article className="feature-card"><div className="feature-card-icon"><Lightbulb size={22}/></div><span className="feature-card-tag">02 / IDEAS</span><h3>Предложения</h3><p>Делись идеями и помогай развивать Remember RP.</p><button className="feature-card-link" onClick={() => openDiscordLink("community")}>Предложить идею <ChevronRight size={14}/></button></article><article className="feature-card"><div className="feature-card-icon"><Users size={22}/></div><span className="feature-card-tag">03 / COMMUNITY</span><h3>Игроки</h3><p>Знакомься с участниками сообщества и собирай команду.</p><button className="feature-card-link" onClick={() => openDiscordLink("community")}>Найти игроков <ChevronRight size={14}/></button></article></div>
      </section> : activeTab === "Wiki" ? <section className="inner-page">
        <div className="inner-page-title"><div><span className="section-kicker">REMEMBER RP • KNOWLEDGE BASE</span><h1>БАЗА <em>ЗНАНИЙ</em></h1><p>Краткие инструкции, которые помогут подготовиться к игре.</p></div><div className="page-title-icon"><BookOpen size={35}/></div></div>
        <div className="wiki-feature-grid"><article className="wiki-feature-card"><div className="feature-card-icon"><Download size={22}/></div><span className="feature-card-tag">01 / GET STARTED</span><h3>Установка и запуск</h3><p>Как установить лаунчер, указать папку GTA V и запустить клиент.</p><button className="feature-card-link" onClick={() => setActiveTab("Поддержка")}>Инструкция <ChevronRight size={14}/></button></article><article className="wiki-feature-card"><div className="feature-card-icon"><UsersRound size={22}/></div><span className="feature-card-tag">02 / FIRST STEPS</span><h3>Первый вход</h3><p>Подготовка к первому подключению и знакомство с проектом.</p><span className="feature-card-soon">СКОРО</span></article><article className="wiki-feature-card"><div className="feature-card-icon"><ShieldCheck size={22}/></div><span className="feature-card-tag">03 / RULES</span><h3>Правила проекта</h3><p>Основные принципы комфортной игры и общения.</p><span className="feature-card-soon">СКОРО</span></article><article className="wiki-feature-card"><div className="feature-card-icon"><CircleHelp size={22}/></div><span className="feature-card-tag">04 / HELP</span><h3>Решение проблем</h3><p>Ответы на частые вопросы о лаунчере и клиенте.</p><button className="feature-card-link" onClick={() => setActiveTab("Поддержка")}>Центр поддержки <ChevronRight size={14}/></button></article></div>
      </section> : activeTab === "Поддержка" ? <section className="support-page">
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
            <p>Напиши команде Remember RP в Discord. При обращении приложи описание проблемы и скриншот ошибки.</p>
            <div className="support-contact-status"><span/> DISCORD SUPPORT</div>
            <button className="primary-small support-discord-button" onClick={() => openDiscordLink("support")}><MessageCircle size={14}/> Открыть поддержку</button>
            <div className="support-contact-line"/>
            <small>Ссылка на поддержку настраивается в параметрах лаунчера.</small>
          </aside>
        </div>
      </section> : activeTab === "Настройки" ? <section className="settings-page">
        <div className="inner-page-title"><div><span className="section-kicker">REMEMBER RP • CONFIGURATION</span><h1>НАСТРОЙКИ <em>ЛАУНЧЕРА</em></h1><p>Управляй игровыми параметрами, обновлениями и подключением.</p></div><div className="page-title-icon"><Settings size={35}/></div></div>
        <section className="settings-section">
          <div className="settings-section-heading"><div><span className="section-kicker">GAME CLIENT</span><h2>Игровые параметры</h2><p>Путь к игре и данные подключения к серверу.</p></div></div>
          <label className="field-label">ПУТЬ К GTA V</label>
          <div className="game-path-row"><input className="modal-input settings-input" value={settings.gameDirectory} onChange={e => setSettings({ ...settings, gameDirectory: e.target.value })} placeholder="Путь будет найден автоматически или укажи вручную"/><button className="secondary-small detect-game-btn" onClick={autoDetectGame} disabled={detectingGame}>{detectingGame ? "Поиск..." : "Найти GTA V"}</button></div>
          {gameDetectMessage && <div className="detect-message">{gameDetectMessage}</div>}
          <label className="field-label">АДРЕС ОСНОВНОГО СЕРВЕРА</label><input className="modal-input settings-input" value={settings.serverAddress || ""} onChange={e => { setSettings({ ...settings, serverAddress: e.target.value }); setServerAddress(e.target.value); }} placeholder="127.0.0.1:22005 — локальная заглушка"/>
          <label className="field-label">ИГРОВОЕ ИМЯ</label><input className="modal-input settings-input" value={settings.playerName} onChange={e => setSettings({ ...settings, playerName: e.target.value })}/>
        </section>
        <section className="settings-section">
          <div className="settings-section-heading"><div><span className="section-kicker">AUTO UPDATER</span><h2>Обновления</h2><p>Проверка и установка актуальной версии Remember RP.</p></div></div>
          <div className="updater-settings-card">
            <div className="updater-settings-head"><div className="updater-settings-icon"><RefreshCw size={17}/></div><div className="updater-settings-copy"><b>Умное обновление</b><small>Текущая версия: {updateInfo.currentVersion || "0.1.5"}</small></div><span className={`updater-state ${updateInfo.status === "up-to-date" || updateInfo.status === "downloaded" ? "ok" : ""}`}>{updateInfo.status === "available" ? "ДОСТУПНО" : updateInfo.status === "downloaded" ? "ГОТОВО" : updateInfo.status === "up-to-date" ? "АКТУАЛЬНО" : updateInfo.status === "not-configured" ? "ОТКЛЮЧЕНО" : updateInfo.status === "downloading" ? "ЗАГРУЗКА" : updateInfo.status === "cancelled" ? "ОСТАНОВЛЕНО" : updateInfo.status === "error" ? "ОШИБКА" : ""}</span></div>
            <p className="updater-message">{updateInfo.message || "Обновления Remember RP через GitHub Releases."}</p>
            {updateInfo.status === "downloading" && <><div className="updater-progress"><div style={{ width: `${Math.max(0, Math.min(100, updateInfo.percent || 0))}%` }}/></div><div className="updater-download-meta"><span>{updateInfo.percent || 0}%</span><span>{formatBytes(updateInfo.transferred)} / {formatBytes(updateInfo.total)}</span><b>{formatSpeed(updateInfo.bytesPerSecond)}</b></div></>}
            <div className="updater-actions">
              {updateInfo.status === "available" && <button className="primary-small" onClick={async () => { setUpdateBusy(true); try { await window.launcher.downloadUpdate(); } catch (e: any) { setUpdateInfo({ status: "error", message: e?.message || "Не удалось загрузить обновление." }); } finally { setUpdateBusy(false); } }} disabled={updateBusy}><Download size={13}/> Скачать {updateInfo.version}</button>}
              {updateInfo.status === "downloading" && <button className="secondary-small" onClick={stopUpdateDownload}><X size={13}/> Остановить загрузку</button>}
              {(updateInfo.status === "cancelled" || updateInfo.status === "error") && <button className="primary-small" onClick={retryUpdateDownload} disabled={updateBusy}><RefreshCw size={13}/> Повторить загрузку</button>}
              {updateInfo.status === "downloaded" && <button className="primary-small" onClick={() => window.launcher.installUpdate()}><CheckCircle2 size={13}/> Перезапустить и установить</button>}
              <button className="secondary-small" onClick={checkUpdates} disabled={updateBusy || updateInfo.status === "downloading"}>{updateBusy || updateInfo.status === "checking" ? "Проверяем..." : "Проверить обновления"}</button>
            </div>
            <small className="updater-footnote">Используется дифференциальная загрузка блоков, если релиз содержит корректный blockmap. Скорость и прогресс обновляются в реальном времени.</small>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-section-heading"><div><span className="section-kicker">DISCORD COMMUNITY</span><h2>Ссылки сообщества</h2><p>Ссылки для перехода в Discord и обращения в поддержку.</p></div></div>
          <label className="field-label">ССЫЛКА НА DISCORD-СООБЩЕСТВО</label><input className="modal-input settings-input" value={settings.discordInviteUrl || ""} onChange={e => setSettings({ ...settings, discordInviteUrl: e.target.value })} placeholder="https://discord.gg/..."/>
          <label className="field-label">ССЫЛКА НА DISCORD-ПОДДЕРЖКУ</label><input className="modal-input settings-input" value={settings.discordSupportUrl || ""} onChange={e => setSettings({ ...settings, discordSupportUrl: e.target.value })} placeholder="https://discord.com/channels/..."/>
        </section>
        <div className="settings-savebar"><span>Не забудь сохранить изменения перед выходом.</span><button className="primary-small" onClick={saveSettings}>Сохранить настройки</button></div>
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
        <div className="boot-loader-head"><span>ЗАПУСК ЛАУНЧЕРА</span><b className="boot-loading-percent">{bootProgress}%</b></div>
        <div className="boot-loader"><span style={{ width: `${bootProgress}%` }}/></div>
        <div className="boot-caption"><span className="boot-caption-dot"/>{bootMessage}</div>
      </div>
      <div className="boot-version">REMEMBER RP <b>•</b> OFFICIAL LAUNCHER</div>
    </div>}
    {trust && <div className="modal-backdrop"><div className="modal trust-modal"><div className="modal-head"><h2>Изменился ключ сервера</h2><button className="icon-btn" onClick={() => setTrust(null)}><X/></button></div><p>Игровой клиент сообщает, что ключ сервера изменился. Подтверждай только если доверяешь владельцу сервера.</p><div className="key-box"><small>СЕРВЕР</small><b>{trust.server}</b><small>ПРЕДЫДУЩИЙ КЛЮЧ</small><code>{trust.previousKey}</code><small>НОВЫЙ КЛЮЧ</small><code>{trust.candidateKey}</code></div><div className="modal-actions"><button className="secondary-small" onClick={async () => { await window.launcher.confirmTrust({ targetId: trust.id, requestId: trust.requestId, accepted: false }); setTrust(null); }}>Отклонить</button><button className="primary-small" onClick={async () => { await window.launcher.confirmTrust({ targetId: trust.id, requestId: trust.requestId, accepted: true }); setTrust(null); }}>Доверять этому ключу</button></div></div></div>}

  </div>;
}