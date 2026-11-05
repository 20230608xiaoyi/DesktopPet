import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import type { Mood } from "../pet/mood";
import { loadTtsSettings, saveTtsSettings, speak, stopSpeak, type TtsMode, type TtsSettings } from "../tts";
import {
  buildSystemPrompt,
  CONTEXT_ROUNDS,
  defaultConfig,
  extractMoodDelta,
  isConfigured,
  loadConfig,
  loadHistory,
  MOOD_EMOJI,
  PRESETS,
  sanitize,
  saveConfig,
  saveHistory,
  streamChat,
  testLlm,
  type ChatMsg,
  type LlmConfig,
} from "./llm";
import "./Panel.css";

type Tab = "chat" | "settings";

/** 是否移动端（Android/iOS 单窗口 = 面板，悬浮宠物走原生 Service） */
const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);

/** 移动端悬浮宠物精灵高度（dp），与桌面「宠物大小」三档对应 */
const FLOAT_HEIGHT_DP: Record<string, number> = { small: 72, medium: 96, large: 128 };

/** 发给宠物气泡的文本上限（超长截断，完整内容看聊天窗） */
const BUBBLE_MAX = 150;

/** 秒 -> mm:ss（番茄钟剩余时间展示） */
function fmtPomo(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 番茄钟时长收敛到 1~180 分钟 */
function clampPomoMin(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 180 ? n : fallback;
}

const POMO_DUR_KEY = "pomodoro-duration";

/** 读取上次的番茄钟时长（本地记忆，默认 25+5） */
function loadPomoDur(): { focus: number; break: number } {
  try {
    const raw = localStorage.getItem(POMO_DUR_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { focus?: number; break?: number };
      return { focus: clampPomoMin(p.focus, 25), break: clampPomoMin(p.break, 5) };
    }
  } catch {
    /* 忽略坏数据 */
  }
  return { focus: 25, break: 5 };
}

function Panel() {
  const [tab, setTab] = useState<Tab>(() => (isConfigured(loadConfig()) ? "chat" : "settings"));
  const [config, setConfig] = useState<LlmConfig>(() => loadConfig() ?? defaultConfig());
  const [messages, setMessages] = useState<ChatMsg[]>(() => loadHistory());
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [petMood, setPetMood] = useState<{ value: number; mood: Mood } | null>(null);

  // 设置页状态
  const [models, setModels] = useState<string[]>([]);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: true; latency: number; count: number } | { ok: false; message: string } | null
  >(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [showPersona, setShowPersona] = useState(false);

  // M4 设置页状态
  const [tts, setTts] = useState<TtsSettings>(() => loadTtsSettings());
  const [ttsTesting, setTtsTesting] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [petSize, setPetSize] = useState("small");
  const [autostart, setAutostart] = useState(false);
  const [sedentary, setSedentary] = useState(true);
  // 移动端：悬浮桌宠开关（原生 Service 渲染）
  const [petOverlay, setPetOverlay] = useState(false);
  const [overlayHint, setOverlayHint] = useState<string | null>(null);
  // 番茄钟状态（计时源在宠物窗口，这里只做展示与控制）
  const [pomoPhase, setPomoPhase] = useState<"idle" | "focus" | "break">("idle");
  const [pomoRemain, setPomoRemain] = useState(0);
  const [pomoDur, setPomoDur] = useState(() => loadPomoDur());
  // 一键复制：记录刚复制成功的消息下标，用于短暂显示「✓ 已复制」
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelBoxRef = useRef<HTMLDivElement>(null);
  const baseInputRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef(0);

  // 流式累积（原始文本，含 mood 标签；展示/存储前 sanitize）
  const rawRef = useRef("");
  const emitTimer = useRef(0);
  const lastEmit = useRef("");
  const abortMsgRef = useRef(false);

  /* ---- 托盘 / 宠物窗口请求切换 Tab ---- */
  useEffect(() => {
    const un = listen<string>("panel-tab", (e) => {
      if (e.payload === "chat" || e.payload === "settings") setTab(e.payload);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  /* ---- 头部心情：向宠物要一次初值，之后监听变化 ---- */
  useEffect(() => {
    const un1 = listen<{ value: number; mood: Mood }>("pet-mood", (e) => setPetMood(e.payload));
    void emit("panel-opened", null);
    return () => {
      void un1.then((f) => f());
    };
  }, []);

  /* ---- 配置自动保存（防抖） ---- */
  useEffect(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveConfig(config);
      const t = new Date();
      setSavedAt(
        `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(
          t.getSeconds(),
        ).padStart(2, "0")}`,
      );
    }, 400);
  }, [config]);

  /* ---- M4：TTS 设置自动保存 ---- */
  useEffect(() => {
    saveTtsSettings(tts);
  }, [tts]);

  /* ---- 模型下拉：点击外部关闭 ---- */
  useEffect(() => {
    if (!modelsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modelBoxRef.current && !modelBoxRef.current.contains(e.target as Node)) {
        setModelsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modelsOpen]);

  /* ---- M4：读取开关初始状态 ---- */
  useEffect(() => {
    void invoke<boolean>("plugin:autostart|is_enabled").then(setAutostart).catch(() => {});
    void invoke<boolean>("get_sedentary_enabled").then(setSedentary).catch(() => {});
    void invoke<[string, number]>("get_pet_size")
      .then(([id]) => {
        if (id) setPetSize(id);
      })
      .catch(() => {});
    // 移动端：查询悬浮桌宠运行状态（Service 可能因重启残留）
    if (isMobile) {
      void invoke<{ running: boolean }>("plugin:petfloat|is_running")
        .then((s) => setPetOverlay(s.running))
        .catch(() => {});
    }
  }, []);

  /* ---- 移动端：请求系统通知权限（Android 13+ 需运行时授权，后台到点提醒依赖） ---- */
  useEffect(() => {
    if (!isMobile) return;
    void isPermissionGranted()
      .then((granted) => (granted ? undefined : requestPermission()))
      .catch(() => {});
  }, []);

  /* ---- 番茄钟：计时源在 Rust 后端，跟随广播状态；打开/恢复可见时同步一次 ---- */
  useEffect(() => {
    const sync = () => {
      void invoke<{ phase: "idle" | "focus" | "break"; remain: number }>("pomodoro_get_state")
        .then((s) => {
          setPomoPhase(s.phase);
          setPomoRemain(s.remain);
        })
        .catch(() => {});
    };
    const un = listen<{ phase: "idle" | "focus" | "break"; remain: number }>(
      "pomodoro-state",
      (e) => {
        setPomoPhase(e.payload.phase);
        setPomoRemain(e.payload.remain);
      },
    );
    sync();
    // Android 退后台时 WebView 暂停会漏掉广播，回到前台时补一次状态
    if (isMobile) document.addEventListener("visibilitychange", sync);
    return () => {
      if (isMobile) document.removeEventListener("visibilitychange", sync);
      void un.then((f) => f());
    };
  }, []);

  /* ---- 移动端：阶段切换 / 久坐语音播报（桌面由宠物窗口播报，避免叠音） ---- */
  useEffect(() => {
    if (!isMobile) return;
    const unlistens = [
      listen<{ from: string; to: "idle" | "focus" | "break"; focus_min: number; break_min: number }>(
        "pomodoro-phase",
        (e) => {
          const { from, to, focus_min, break_min } = e.payload;
          if (to === "focus" && from === "idle") {
            void speak(`开始专注，${focus_min}分钟后叫我`).catch(() => {});
          } else if (to === "break") {
            void speak(`番茄完成！休息${break_min}分钟吧`).catch(() => {});
          } else if (to === "focus") {
            void speak("休息结束，开始新的番茄吧").catch(() => {});
          }
        },
      ),
      // Android 久坐提醒：后端按固定间隔广播 warn
      listen<{ stage: "warn" | "ignored" }>("pet-sedentary", (e) => {
        if (e.payload.stage === "warn") {
          void speak("坐了好久啦，起来活动一下嘛～").catch(() => {});
        }
      }),
    ];
    return () => {
      for (const un of unlistens) void un.then((f) => f());
    };
  }, []);

  /* ---- 番茄钟时长：本地记忆 + 下发后端（下一阶段生效） ---- */
  useEffect(() => {
    localStorage.setItem(POMO_DUR_KEY, JSON.stringify(pomoDur));
    void invoke("pomodoro_set", { focusMin: pomoDur.focus, breakMin: pomoDur.break }).catch(() => {});
  }, [pomoDur]);

  /** 控制后端番茄钟 */
  function controlPomo(action: "start" | "stop") {
    void invoke(
      action === "start" ? "pomodoro_start" : "pomodoro_stop",
      action === "start" ? { focusMin: pomoDur.focus, breakMin: pomoDur.break } : {},
    ).catch(() => {});
  }

  /** 一键复制 AI 回复到系统剪贴板 */
  async function copyMsg(i: number, text: string) {
    try {
      await invoke("copy_to_clipboard", { text });
      setCopiedIdx(i);
      window.setTimeout(() => setCopiedIdx((cur) => (cur === i ? null : cur)), 1200);
    } catch {
      /* 复制失败静默 */
    }
  }

  /* ---- 聊天列表自动滚底 ---- */
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, tab]);

  /* ---- 发送 ---- */
  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    if (!isConfigured(config)) {
      setTab("settings");
      setError("请先在设置中配置本地模型（服务地址 + 模型名）");
      return;
    }

    setError(null);
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";

    const userMsg: ChatMsg = { role: "user", content: text, ts: Date.now() };
    const assistantMsg: ChatMsg = { role: "assistant", content: "", ts: Date.now() };
    const next = [...messages, userMsg, assistantMsg];
    setMessages(next);

    // 宠物侧：进入思考状态
    setStreaming(true);
    rawRef.current = "";
    abortMsgRef.current = false;
    void emit("chat-thinking", null);

    // 组装上下文：system + 最近 N 条
    const context = next
      .slice(0, -1) // 去掉占位的空 assistant
      .slice(-CONTEXT_ROUNDS)
      .map((m) => ({ role: m.role, content: m.content }));
    const payload = [
      { role: "system", content: buildSystemPrompt(localStorage.getItem("llm-persona-v1") ?? "") },
      ...context,
    ];

    // 定时把最新文本推给宠物气泡（节流，避免每个 token 一次 IPC 广播）
    window.clearInterval(emitTimer.current);
    emitTimer.current = window.setInterval(() => {
      const clean = sanitize(rawRef.current);
      if (clean !== lastEmit.current) {
        lastEmit.current = clean;
        void emit("chat-delta", { text: clean.slice(0, BUBBLE_MAX) });
      }
    }, 60);

    const fail = (message: string) => {
      window.clearInterval(emitTimer.current);
      setStreaming(false);
      setError(message);
      // 占位的空回复改成错误提示气泡
      setMessages((list) => {
        const copy = [...list];
        const i = copy.length - 1;
        if (i >= 0 && copy[i].role === "assistant" && copy[i].content === "") {
          copy[i] = { ...copy[i], content: "（连接模型失败，请检查设置）" };
        }
        return copy;
      });
      saveHistory([...messages, userMsg]);
      void emit("chat-error", { message });
    };

    try {
      await streamChat(config, payload, {
        onDelta: (delta) => {
          rawRef.current += delta;
          const clean = sanitize(rawRef.current);
          setMessages((list) => {
            const copy = [...list];
            const i = copy.length - 1;
            if (i >= 0 && copy[i].role === "assistant") {
              copy[i] = { ...copy[i], content: clean };
            }
            return copy;
          });
        },
        onDone: () => {
          window.clearInterval(emitTimer.current);
          const raw = rawRef.current;
          const clean = sanitize(raw);
          // 空回复按错误处理
          if (!clean.trim()) {
            if (!abortMsgRef.current) {
              abortMsgRef.current = true;
              fail("模型没有返回内容，换一个模型试试？");
            }
            return;
          }
          setStreaming(false);
          setMessages((list) => {
            const copy = [...list];
            const i = copy.length - 1;
            if (i >= 0 && copy[i].role === "assistant") {
              copy[i] = { ...copy[i], content: clean };
            }
            return copy;
          });
          const finalList = [...messages, userMsg, { ...assistantMsg, content: clean }];
          saveHistory(finalList);
          // 心情 v1：情绪标签 -> 宠物心情联动
          const delta = extractMoodDelta(raw, text);
          void emit("chat-mood", { delta });
          void emit("chat-done", { text: clean.slice(0, BUBBLE_MAX) });
          // M4：TTS 朗读回复（关闭时静默跳过）
          void speak(clean).catch(() => {});
        },
        onError: (message) => {
          if (!abortMsgRef.current) {
            abortMsgRef.current = true;
            fail(`连接中断：${message}`);
          }
        },
      });
    } catch (e) {
      if (!abortMsgRef.current) {
        abortMsgRef.current = true;
        fail(String(e));
      }
    }
  }

  /* ---- 输入框自适应高度 ---- */
  function onInput(e: React.FormEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  function clearHistory() {
    if (!window.confirm("清空全部聊天记录？")) return;
    setMessages([]);
    saveHistory([]);
  }

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testLlm(config);
      setModels(r.models);
      setTestResult({ ok: true, latency: r.latency_ms, count: r.models.length });
      // 获取成功后展开完整模型列表，方便直接选择
      if (r.models.length > 0) {
        setModelsOpen(true);
      }
      // 模型为空且列表非空时自动选第一个
      if (!config.model.trim() && r.models.length > 0) {
        setConfig((c) => ({ ...c, model: r.models[0] }));
      }
    } catch (e) {
      setTestResult({ ok: false, message: String(e) });
    } finally {
      setTesting(false);
    }
  }

  /* ---- M4：设置操作 ---- */

  async function previewTts() {
    setTtsTesting(true);
    setTtsError(null);
    try {
      await speak("你好呀，我是皮皮，一只贪吃的小貔貅，很高兴见到你！", tts);
    } catch (e) {
      setTtsError(String(e));
    } finally {
      setTtsTesting(false);
    }
  }

  async function changeSize(id: string) {
    setPetSize(id);
    try {
      await invoke("set_pet_size", { sizeId: id });
    } catch {
      /* 宠物窗口会广播实际大小 */
    }
    // 移动端：悬浮宠物显示中时同步更新精灵高度（Service 收到 start 会幂等更新）
    const dp = FLOAT_HEIGHT_DP[id];
    if (isMobile && petOverlay && dp) {
      void invoke("plugin:petfloat|start", { args: { spriteHeight: dp } }).catch(() => {});
    }
  }

  /** 移动端：开关悬浮桌宠（未授权悬浮窗时引导去系统设置页） */
  async function togglePetOverlay() {
    const next = !petOverlay;
    if (!next) {
      try {
        await invoke("plugin:petfloat|stop");
      } catch {
        /* 静默 */
      }
      setPetOverlay(false);
      setOverlayHint(null);
      return;
    }
    const dp = FLOAT_HEIGHT_DP[petSize] ?? 96;
    try {
      await invoke("plugin:petfloat|start", { args: { spriteHeight: dp } });
      setPetOverlay(true);
      setOverlayHint(null);
    } catch (e) {
      setPetOverlay(false);
      setOverlayHint(
        String(e).includes("OVERLAY_PERMISSION_REQUIRED")
          ? "请在系统设置中允许本应用「显示在其他应用上层」，回来后再打开开关"
          : `启动悬浮宠物失败：${e}`,
      );
    }
  }

  async function toggleAutostart() {
    const next = !autostart;
    try {
      await invoke(next ? "plugin:autostart|enable" : "plugin:autostart|disable");
      setAutostart(next);
    } catch {
      /* 权限或系统限制，静默失败 */
    }
  }

  async function toggleSedentary() {
    const next = !sedentary;
    try {
      await invoke("set_sedentary_enabled", { enabled: next });
      setSedentary(next);
    } catch {
      /* 静默失败 */
    }
  }

  const configured = isConfigured(config);
  const persona = localStorage.getItem("llm-persona-v1") ?? "";

  return (
    <div className="panel-root">
      {/* 头部 */}
      <header className="panel-header">
        <div className="panel-title">
          <span className="panel-avatar">🐲</span>
          <div>
            <div className="panel-name">皮皮</div>
            {petMood && (
              <div className="panel-mood">
                {MOOD_EMOJI[petMood.mood]} 心情 {Math.round(petMood.value)}
              </div>
            )}
          </div>
        </div>
        <nav className="panel-tabs">
          <button
            className={tab === "chat" ? "on" : ""}
            onClick={() => setTab("chat")}
            title="聊天"
          >
            💬 聊天
          </button>
          <button
            className={tab === "settings" ? "on" : ""}
            onClick={() => setTab("settings")}
            title="设置"
          >
            ⚙️ 设置
          </button>
        </nav>
      </header>

      {/* 聊天 */}
      {tab === "chat" && (
        <>
          {!configured && (
            <div className="panel-warn" onClick={() => setTab("settings")}>
              ⚠️ 还没配置本地模型，点这里去设置（Ollama / LM Studio 均可）
            </div>
          )}
          <div className="panel-list" ref={listRef}>
            {messages.length === 0 && (
              <div className="panel-empty">
                <div className="panel-empty-emoji">🐲</div>
                <div className="panel-empty-title">和皮皮聊聊天吧</div>
                <div className="panel-empty-sub">
                  回复会实时显示在桌宠气泡上，
                  <br />
                  皮皮的心情也会跟着对话变化哦～
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`msg msg-${m.role}`}>
                {m.role === "assistant" && <span className="msg-avatar">🐲</span>}
                <div className="msg-bubble">
                  {m.role === "assistant" && m.content !== "" && (
                    <button
                      className="msg-copy"
                      title="复制本条回复"
                      onClick={() => void copyMsg(i, m.content)}
                    >
                      {copiedIdx === i ? "✓ 已复制" : "⧉ 复制"}
                    </button>
                  )}
                  {m.content === "" && streaming && i === messages.length - 1 ? (
                    <span className="msg-dots">
                      <i /> <i /> <i />
                    </span>
                  ) : (
                    <>
                      {m.content || "…"}
                      {streaming && i === messages.length - 1 && m.role === "assistant" && (
                        <span className="msg-cursor" />
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <footer className="panel-input">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              placeholder={configured ? "跟皮皮说点什么…（Enter 发送）" : "先去「设置」配置模型才能聊天"}
              onInput={onInput}
              onKeyDown={onKeyDown}
              onChange={(e) => setInput(e.target.value)}
            />
            <button className="panel-send" disabled={!input.trim() || streaming} onClick={() => void send()}>
              {streaming ? "回复中" : "发送"}
            </button>
          </footer>
          <div className="panel-footbar">
            {error ? (
              <span className="panel-error" title={error}>
                ⚠️ {error}
              </span>
            ) : (
              <span>Enter 发送 · Shift+Enter 换行 · 右键桌宠也能打开这里</span>
            )}
            {messages.length > 0 && (
              <button className="panel-clear" onClick={clearHistory}>
                清空记录
              </button>
            )}
          </div>
        </>
      )}

      {/* 设置 */}
      {tab === "settings" && (
        <div className="panel-settings">
          <section>
            <label>服务预设</label>
            <div className="preset-row">
              {PRESETS.map((p) => (
                <button
                  key={p.name}
                  className={
                    p.name === "自定义" && !PRESETS.slice(0, 3).some((x) => x.base_url === config.base_url)
                      ? "on"
                      : p.base_url === config.base_url
                        ? "on"
                        : ""
                  }
                  onClick={() => {
                    if (p.name === "自定义") {
                      setConfig((c) => ({ ...c, base_url: "" }));
                      baseInputRef.current?.focus();
                      return;
                    }
                    setConfig((c) => ({ ...c, base_url: p.base_url }));
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </section>

          <section>
            <label>服务地址（OpenAI 兼容）</label>
            <input
              ref={baseInputRef}
              value={config.base_url}
              placeholder="http://localhost:11434/v1"
              onChange={(e) => setConfig((c) => ({ ...c, base_url: e.target.value.trim() }))}
            />
          </section>

          <section>
            <label>模型</label>
            <div className="model-row" ref={modelBoxRef}>
              <input
                value={config.model}
                placeholder="如 qwen2.5:1.5b"
                onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value.trim() }))}
              />
              <button
                type="button"
                className="model-arrow"
                title={models.length > 0 ? "查看已获取的模型" : "请先点击右侧按钮获取模型"}
                disabled={models.length === 0}
                onClick={() => setModelsOpen((v) => !v)}
              >
                ▾
              </button>
              <button className="panel-btn" onClick={() => void runTest()} disabled={testing}>
                {testing ? "测试中…" : "测试并获取模型"}
              </button>
              {modelsOpen && models.length > 0 && (
                <ul className="model-list">
                  {models.map((m) => (
                    <li key={m}>
                      <button
                        type="button"
                        className={m === config.model ? "on" : ""}
                        onClick={() => {
                          setConfig((c) => ({ ...c, model: m }));
                          setModelsOpen(false);
                        }}
                      >
                        {m}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {testResult &&
              (testResult.ok ? (
                <p className="hint ok">
                  ✓ 连接成功 · {testResult.latency}ms · {testResult.count} 个模型
                </p>
              ) : (
                <p className="hint err" title={testResult.message}>
                  ✗ {testResult.message}
                </p>
              ))}
          </section>

          <section>
            <label>API Key（本地服务一般不需要）</label>
            <input
              type="password"
              value={config.api_key ?? ""}
              placeholder="留空即可"
              onChange={(e) => setConfig((c) => ({ ...c, api_key: e.target.value }))}
            />
          </section>

          <section>
            <label> Temperature：{config.temperature?.toFixed(1) ?? "0.8"}</label>
            <input
              className="slider"
              type="range"
              min={0}
              max={1.5}
              step={0.1}
              value={config.temperature ?? 0.8}
              onChange={(e) => setConfig((c) => ({ ...c, temperature: Number(e.target.value) }))}
            />
          </section>

          <section>
            <label className="persona-label">
              补充人设（可选）
              <button className="link" onClick={() => setShowPersona((v) => !v)}>
                {showPersona ? "收起" : "展开"}
              </button>
            </label>
            {showPersona && (
              <textarea
                className="persona"
                rows={3}
                defaultValue={persona}
                placeholder={'例如：说话软萌呆萌，特别贪吃，最爱吞宝贝'}
                onBlur={(e) =>
                  localStorage.setItem("llm-persona-v1", e.target.value)
                }
              />
            )}
          </section>

          {/* M4：语音朗读 */}
          <section>
            <label>语音朗读（TTS）</label>
            <div className="preset-row">
              <button
                className={tts.enabled ? "on" : ""}
                onClick={() => setTts((s) => ({ ...s, enabled: true }))}
              >
                开启
              </button>
              <button
                className={!tts.enabled ? "on" : ""}
                onClick={() => {
                  stopSpeak();
                  setTts((s) => ({ ...s, enabled: false }));
                }}
              >
                关闭
              </button>
              <button
                className="panel-btn"
                onClick={() => void previewTts()}
                disabled={ttsTesting || !tts.enabled}
              >
                {ttsTesting ? "试听中…" : "🔊 试听"}
              </button>
            </div>
            {tts.enabled && (
              <div className="preset-row">
                {(["auto", "cloud", "local"] as TtsMode[]).map((m) => (
                  <button
                    key={m}
                    className={tts.mode === m ? "on" : ""}
                    onClick={() => setTts((s) => ({ ...s, mode: m }))}
                  >
                    {m === "auto" ? "自动（推荐）" : m === "cloud" ? "在线语音" : "本地语音"}
                  </button>
                ))}
              </div>
            )}
            {tts.enabled && (
              <p className="hint">在线用微软晓晓音色更自然；本地用系统语音离线可用；自动模式失败会兜底</p>
            )}
            {ttsError && <p className="hint err">✗ {ttsError}</p>}
          </section>

          {/* M4：宠物大小 */}
          <section>
            <label>宠物大小</label>
            <div className="preset-row">
              {[
                ["small", "小"],
                ["medium", "中"],
                ["large", "大"],
              ].map(([id, name]) => (
                <button
                  key={id}
                  className={petSize === id ? "on" : ""}
                  onClick={() => void changeSize(id)}
                >
                  {name}
                </button>
              ))}
            </div>
          </section>

          {/* 移动端：悬浮桌宠开关（原生 Service 渲染） */}
          {isMobile && (
            <section>
              <label>悬浮桌宠</label>
              <div className="preset-row">
                <button className={petOverlay ? "on" : ""} onClick={() => void togglePetOverlay()}>
                  {petOverlay
                    ? "✓ 皮皮正在桌面上陪你（点击关闭）"
                    : "未开启（点击开启悬浮宠物）"}
                </button>
              </div>
              {overlayHint && <p className="hint err">{overlayHint}</p>}
              <p className="hint">
                开启后皮皮会悬浮在手机任意界面上：可拖动，单击打开本应用，长按会撒娇
              </p>
            </section>
          )}

          {/* M4：开机自启（桌面专属） */}
          {!isMobile && (
            <section>
              <label>开机自启</label>
              <div className="preset-row">
                <button className={autostart ? "on" : ""} onClick={() => void toggleAutostart()}>
                  {autostart ? "✓ 已开启（点击关闭）" : "未开启（点击开启）"}
                </button>
              </div>
            </section>
          )}

          {/* M4：久坐提醒 */}
          <section>
            <label>久坐提醒</label>
            <div className="preset-row">
              <button className={sedentary ? "on" : ""} onClick={() => void toggleSedentary()}>
                {sedentary ? "✓ 已开启（久坐 60 分钟提醒）" : "未开启（点击开启）"}
              </button>
            </div>
          </section>

          {/* 番茄钟：宠物窗口计时，这里展示与控制 */}
          <section>
            <label>番茄钟</label>
            <div className="preset-row pomo-dur">
              <span className="pomo-dur-item">
                专注
                <input
                  type="number"
                  min={1}
                  max={180}
                  value={pomoDur.focus}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) setPomoDur((d) => ({ ...d, focus: clampPomoMin(n, d.focus) }));
                  }}
                />
                分钟
              </span>
              <span className="pomo-dur-item">
                休息
                <input
                  type="number"
                  min={1}
                  max={180}
                  value={pomoDur.break}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) setPomoDur((d) => ({ ...d, break: clampPomoMin(n, d.break) }));
                  }}
                />
                分钟
              </span>
            </div>
            <div className="preset-row">
              {pomoPhase === "idle" ? (
                <button className="on" onClick={() => controlPomo("start")}>
                  ▶ 开始专注（{pomoDur.focus} 分钟）
                </button>
              ) : (
                <>
                  <span className={`pomo-status ${pomoPhase}`}>
                    {pomoPhase === "focus" ? "🍅 专注中" : "☕ 休息中"} {fmtPomo(pomoRemain)}
                  </span>
                  <button onClick={() => controlPomo("stop")}>■ 结束</button>
                </>
              )}
            </div>
            <p className="hint">
              按上方时长循环专注与休息（1~180 分钟）；运行中修改将从下一阶段生效
            </p>
          </section>

          {/* 版权与免责声明 */}
          <section className="about">
            <label>关于说明</label>
            <div className="about-note">
              本软件为【星河梦xiaoyi】制作，为非官方粉丝作品，与《有兽焉》原作者及版权方无任何隶属或合作授权关系，相关角色形象素材版权归原权利人所有，本软件仅供学习交流，完全免费、不作任何商业用途。
              <br />
              如有侵权请联系：<a href="mailto:2876433130@qq.com">2876433130@qq.com</a>
              <br />
              线上小站：
              <a href="https://www.xiaoyineat.cn/" target="_blank" rel="noopener noreferrer">
                https://www.xiaoyineat.cn/
              </a>
            </div>
          </section>

          <p className="saved-at">{savedAt ? `已自动保存 · ${savedAt}` : "修改即自动保存"}</p>
        </div>
      )}
    </div>
  );
}

export default Panel;
