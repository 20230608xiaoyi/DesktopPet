import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import Pet, { SPRITE_BOTTOM, type PetHandle } from "./pet/Pet";
import { MoodEngine, type Mood } from "./pet/mood";
import {
  HITBOX_POLL_MS,
  WIN_H,
  isCursorOverPet,
  moveWindowBy,
  moveWindowTo,
  setIgnoreCursor,
  setPetVisible,
  getMonitorInfo,
  getWindowPos,
  loadWindowPos,
  saveWindowPos,
  type MonitorInfo,
} from "./pet/core";
import { isConfigured, loadConfig } from "./panel/llm";
import { speak, stopSpeak } from "./tts";
import "./App.css";

/* ---- 台词 ---- */
const MOOD_LINES: Record<Mood, string[]> = {
  joy: ["太开心啦！", "蹦蹦跳跳～", "你是最好的人！", "耶耶耶～"],
  happy: ["嗨！我在呢～", "陪我聊聊天吧～", "摸摸我嘛～", "今天天气真好呀～"],
  calm: ["呼～真安逸", "记得休息眼睛哦！", "发会儿呆……", "今天也要加油鸭！"],
  bored: ["好无聊啊……", "陪我玩会儿嘛……", "有什么好玩的吗……", "哼，不理你了……"],
  sleepy: ["Zzz……", "困了……", "眼睛睁不开了……", "让我睡会儿……"],
};
const PAT_LINES = ["好舒服～", "再摸摸嘛～", "嘿嘿～", "最喜欢你了～"];
/** 连击摸头彩蛋台词 */
const PAT_HAPPY_LINES = ["呜呜太痒啦～", "好幸福呀～", "最爱主人了～", "头要被摸秃啦～"];
const ARRIVE_LINES = ["到啦！", "呼……走累了", "这边风景不错～"];
const FALL_LINES = ["呀——！", "我要飞起来啦！", "放我下来～"];
const LAND_LINES = ["哎哟！", "好晕……", "安全着陆！"];

/** 判定拖拽的最小移动距离（px） */
const DRAG_THRESHOLD = 8;
/** 连击摸头彩蛋：8 秒内摸满此次数触发 */
const PAT_STREAK_NEED = 4;
/** 宠物贴地的窗口 y 坐标距屏幕底部的余量（避开任务栏） */
const FLOOR_MARGIN = 12;
/** 行走位移累积到该值才真正移动窗口（限制 IPC 频率，同时保证平滑） */
const WALK_FLUSH_PX = 1.2;

/** 眼睛中心在窗口内的坐标（瞳孔跟随鼠标用） */
const EYE_CENTER = { x: 160, y: 152 };

type ParticleKind = "heart" | "spark" | "dust" | "z";
type Particle = {
  id: number;
  kind: ParticleKind;
  x: number;
  y: number;
  dx: number;
  dy: number;
  dur: number;
  delay: number;
  size: number;
};

type LocoMode = "idle" | "walk" | "fall";

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 秒 -> mm:ss */
function fmtPomo(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function App() {
  const petRef = useRef<PetHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [moodValue, setMoodValue] = useState(70);
  const [mood, setMood] = useState<Mood>("happy");
  const [bubble, setBubble] = useState<{ text: string; phase: "in" | "out" } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [falling, setFalling] = useState(false);
  const [walking, setWalking] = useState(false);
  const [facing, setFacing] = useState<1 | -1>(1);
  const [particles, setParticles] = useState<Particle[]>([]);
  const [showMoodBar, setShowMoodBar] = useState(false);
  /** 对话进行中（思考 / 流式输出），宠物表现专注开心 */
  const [chatting, setChatting] = useState(false);
  /** 宠物显示高度（像素） */
  const [spriteHeight, setSpriteHeight] = useState(300);
  /** 久坐提醒：趴下打盹 30s */
  const [napping, setNapping] = useState(false);
  /** M4：TTS 朗读中（说话律动） */
  const [speaking, setSpeaking] = useState(false);
  /** 番茄钟阶段与剩余秒数（计时源在 Rust 后端，面板/宠物窗口通过事件同步） */
  const [pomoPhase, setPomoPhase] = useState<"idle" | "focus" | "break">("idle");
  const [pomoRemain, setPomoRemain] = useState(0);
  /** 同步读取当前高度（供事件回调内计算头顶坐标） */
  const spriteHRef = useRef(300);
  spriteHRef.current = spriteHeight;

  /** 宠物顶部 y 坐标（窗口内，底部贴地） */
  const petTopY = () => WIN_H - SPRITE_BOTTOM - spriteHRef.current;

  const moodEngine = useRef<MoodEngine | null>(null);
  const moodRef = useRef<Mood>("happy");
  const facingRef = useRef<1 | -1>(1);

  // 拖拽状态
  const drag = useRef({ moved: 0, active: false });
  // 窗口位置估计（逻辑像素）
  const winPos = useRef({ x: 0, y: 0 });
  const monitorRef = useRef<MonitorInfo | null>(null);
  const bubbleTimer = useRef(0);
  const bubbleTimer2 = useRef(0);

  // 运动引擎：闲逛 / 行走 / 掉落
  const loco = useRef({
    mode: "idle" as LocoMode,
    target: { x: 0, y: 0 },
    nextAt: 0,
    pauseUntil: 0,
    vy: 0,
    accX: 0,
    accY: 0,
  });

  // 抚摸检测
  const hoverDist = useRef(0);
  const lastPatAt = useRef(0);
  // 连击摸头检测（8 秒窗口内累计次数）
  const patStreak = useRef(0);
  const patStreakAt = useRef(0);

  // 流式气泡状态机（打字机）：target 为面板推来的最新全文
  const streamRef = useRef({
    active: false,
    target: "",
    shown: 0,
    finished: false,
    holdUntil: 0,
  });

  /** 宠物贴地时窗口的 y 坐标 */
  const floorY = useCallback(() => {
    const m = monitorRef.current;
    return m ? m.y + m.height - WIN_H - FLOOR_MARGIN : Number.MAX_SAFE_INTEGER;
  }, []);

  const updateFacing = useCallback((f: 1 | -1) => {
    if (facingRef.current !== f) {
      facingRef.current = f;
      setFacing(f);
    }
  }, []);

  /* ---- 粒子 ---- */
  const spawn = useCallback(
    (kind: ParticleKind, count: number, x: number, y: number, spread = 40) => {
      const items: Particle[] = [];
      for (let i = 0; i < count; i++) {
        const id = Date.now() * 1000 + i + Math.floor(Math.random() * 1000);
        items.push({
          id,
          kind,
          x: x + (Math.random() - 0.5) * spread,
          y: y + (Math.random() - 0.5) * spread * 0.6,
          dx:
            kind === "dust"
              ? (Math.random() - 0.5) * 100
              : kind === "z"
                ? 22 + Math.random() * 14
                : (Math.random() - 0.5) * 26,
          dy:
            kind === "dust"
              ? -(10 + Math.random() * 18)
              : -(45 + Math.random() * 45),
          dur: 0.9 + Math.random() * 0.7,
          delay: Math.random() * 0.15,
          size: kind === "dust" ? 10 + Math.random() * 8 : 14 + Math.random() * 8,
        });
      }
      setParticles((p) => [...p, ...items]);
      const maxEnd = Math.max(...items.map((i) => i.dur + i.delay));
      window.setTimeout(() => {
        const ids = new Set(items.map((i) => i.id));
        setParticles((p) => p.filter((q) => !ids.has(q.id)));
      }, (maxEnd + 0.3) * 1000);
    },
    [],
  );

  /* ---- 气泡 ---- */
  const showBubble = useCallback((text: string) => {
    window.clearTimeout(bubbleTimer.current);
    window.clearTimeout(bubbleTimer2.current);
    setBubble({ text, phase: "in" });
    bubbleTimer.current = window.setTimeout(() => {
      setBubble((b) => (b ? { ...b, phase: "out" } : null));
      bubbleTimer2.current = window.setTimeout(() => setBubble(null), 320);
    }, 3200);
  }, []);

  /* ---- 番茄钟：计时源在 Rust 后端，宠物窗口只消费广播 ---- */
  // 每秒状态广播 -> 倒计时徽章
  useEffect(() => {
    const un = listen<{ phase: "idle" | "focus" | "break"; remain: number }>(
      "pomodoro-state",
      (e) => {
        setPomoPhase(e.payload.phase);
        setPomoRemain(e.payload.remain);
      },
    );
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // 阶段切换广播 -> 气泡 + 语音 + 宠物动画
  useEffect(() => {
    const un = listen<{
      from: string;
      to: "idle" | "focus" | "break";
      focus_min: number;
      break_min: number;
    }>("pomodoro-phase", (e) => {
      const { from, to, focus_min, break_min } = e.payload;
      if (to === "focus" && from === "idle") {
        showBubble(`开始专注！${focus_min} 分钟后叫我～`);
        void speak(`开始专注，${focus_min}分钟后叫我`).catch(() => {});
      } else if (to === "break") {
        petRef.current?.excite();
        spawn("heart", 6, 160, petTopY() + spriteHRef.current * 0.25, 88);
        moodEngine.current?.add(6);
        showBubble(`🍅 番茄完成！休息 ${break_min} 分钟吧～`);
        void speak(`番茄完成！休息${break_min}分钟吧`).catch(() => {});
      } else if (to === "focus") {
        showBubble("☕ 休息结束，开始新的番茄吧！");
        void speak("休息结束，开始新的番茄吧").catch(() => {});
      } else {
        showBubble("番茄钟结束啦，注意休息眼睛～");
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [showBubble, spawn]);

  /* ---- 心情引擎 ---- */
  useEffect(() => {
      moodEngine.current = new MoodEngine(70, (v, m) => {
        setMoodValue(v);
        setMood(m);
        moodRef.current = m;
        // 广播给对话面板（头部心情展示）
        void emit("pet-mood", { value: v, mood: m });
      });
      // 读取本地保存的宠物大小
      void invoke<[string, number]>("get_pet_size")
        .then(([, px]) => setSpriteHeight(px))
        .catch(() => {});
      return () => moodEngine.current?.dispose();
    }, []);

  /* ---- 心情值变化时短暂显示心情条 ---- */
  useEffect(() => {
    setShowMoodBar(true);
    const t = window.setTimeout(() => setShowMoodBar(false), 3000);
    return () => window.clearTimeout(t);
  }, [moodValue]);

  /* ---- 困倦时冒 Zzz ---- */
  useEffect(() => {
    if (mood !== "sleepy") return;
    const t = window.setInterval(
      () => spawn("z", 1, 208, petTopY() + spriteHRef.current * 0.22, 10),
      2600,
    );
    return () => window.clearInterval(t);
  }, [mood, spawn]);

  /* ---- 点击穿透：光标在宠物本体上时解除穿透，离开时恢复 ---- */
  useEffect(() => {
    let stopped = false;

    async function poll() {
      if (stopped) return;
      try {
        const over = await isCursorOverPet();
        if (!drag.current.active) void setIgnoreCursor(!over);
      } catch {
        /* 忽略瞬时错误 */
      }
      if (!stopped) window.setTimeout(poll, HITBOX_POLL_MS);
    }
    void setIgnoreCursor(true);
    window.setTimeout(poll, HITBOX_POLL_MS);
    return () => {
      stopped = true;
    };
  }, []);

  /* ---- 拖拽 / 抚摸 / 点击 ---- */
  useEffect(() => {
    function setTilt(deg: number) {
      rootRef.current?.style.setProperty("--tilt", `${deg}deg`);
    }

    function trackEyes(e: MouseEvent) {
      const root = rootRef.current;
      if (!root) return;
      const lx = clamp((e.clientX - EYE_CENTER.x) / 50, -1, 1) * 2.5;
      const ly = clamp((e.clientY - EYE_CENTER.y) / 80, -1, 1) * 2;
      root.style.setProperty("--lx", `${lx}px`);
      root.style.setProperty("--ly", `${ly}px`);
    }

    function onMouseDown(e: MouseEvent) {
      if (e.button !== 0) return;
      // 按下即中止闲逛 / 掉落
      loco.current.mode = "idle";
      setWalking(false);
      setFalling(false);
      drag.current = { moved: 0, active: true };
    }

    function onMouseMove(e: MouseEvent) {
      const d = drag.current;
      if (!d.active) {
        // 悬停抚摸：无按键移动累积到阈值触发「摸头」
        hoverDist.current += Math.abs(e.movementX) + Math.abs(e.movementY);
        trackEyes(e);
        rootRef.current?.setAttribute("data-cursor", "on");
        const now = performance.now();
        if (hoverDist.current > 110 && now - lastPatAt.current > 1600) {
          hoverDist.current = 0;
          lastPatAt.current = now;
          petRef.current?.pat();
          moodEngine.current?.add(4);
          spawn("spark", 3, 160, petTopY() + spriteHRef.current * 0.21, 76);

          // 连击彩蛋：8 秒内摸满 4 次 -> 超开心反应 + 必播报
          patStreak.current = now - patStreakAt.current < 8000 ? patStreak.current + 1 : 1;
          patStreakAt.current = now;
          if (patStreak.current >= PAT_STREAK_NEED) {
            patStreak.current = 0;
            petRef.current?.excite();
            spawn("heart", 8, 160, petTopY() + spriteHRef.current * 0.25, 96);
            moodEngine.current?.add(8);
            const happyLine = pick(PAT_HAPPY_LINES);
            showBubble(happyLine);
            void speak(happyLine).catch(() => {});
          } else if (Math.random() < 0.4) {
            // 普通摸头：概率气泡 + 同步语音，让摸头更有回应
            const line = pick(PAT_LINES);
            showBubble(line);
            void speak(line).catch(() => {});
          }
        }
        return;
      }

      const dx = e.movementX;
      const dy = e.movementY;
      d.moved += Math.abs(dx) + Math.abs(dy);
      if (d.moved > DRAG_THRESHOLD) {
        setDragging(true);
        if (dx !== 0 || dy !== 0) void moveWindowBy(dx, dy);
        winPos.current.x += dx;
        winPos.current.y += dy;
        if (Math.abs(dx) > 2) updateFacing(dx > 0 ? 1 : -1);
        // 拖拽倾斜（跟随水平施力方向）
        setTilt(clamp(dx * 0.9, -14, 14));
      }
    }

    async function onMouseUp() {
      const d = drag.current;
      const wasDrag = d.active && d.moved > DRAG_THRESHOLD;
      d.active = false;
      setTilt(0);

      if (wasDrag) {
        setDragging(false);
        // 同步真实位置（拖拽可能被屏幕边缘钳制）
        try {
          winPos.current = await getWindowPos();
        } catch {
          /* 保守使用估计值 */
        }
        if (winPos.current.y < floorY() - 10) {
          // 空中松手：重力掉落
          loco.current.mode = "fall";
          loco.current.vy = 40;
          setFalling(true);
          if (Math.random() < 0.5) showBubble(pick(FALL_LINES));
        } else {
          loco.current.nextAt = performance.now() + 4000 + Math.random() * 6000;
        }
        saveWindowPos(winPos.current);
        return;
      }

      // 未移动 = 单击：开心跳 + 爱心 + 心情提升
      petRef.current?.excite();
      moodEngine.current?.add(6);
      spawn("heart", 5, 160, petTopY() + spriteHRef.current * 0.25, 88);
      showBubble(pick(MOOD_LINES[moodRef.current]));
    }

    function onMouseLeave() {
      if (drag.current.active) drag.current.active = false;
      setDragging(false);
      setTilt(0);
      rootRef.current?.setAttribute("data-cursor", "off");
      rootRef.current?.style.setProperty("--lx", "0px");
      rootRef.current?.style.setProperty("--ly", "0px");
    }

    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    document.addEventListener("mouseleave", onMouseLeave);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mouseleave", onMouseLeave);
    };
  }, [floorY, showBubble, spawn, updateFacing]);

  /* ---- 双击：隐藏宠物（托盘可找回） ---- */
  useEffect(() => {
    let lastClick = 0;
    function onClick() {
      const now = Date.now();
      if (now - lastClick < 350) void setPetVisible(false);
      lastClick = now;
    }
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, []);

  /* ---- 右键宠物：弹出原生上下文菜单（聊天 / 设置 / 大小 / 显示 / 隐藏 / 退出） ---- */
  useEffect(() => {
    function onCtx(e: MouseEvent) {
      e.preventDefault();
      void invoke("show_pet_context_menu");
    }
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  /* ---- M2 对话闭环：面板事件 -> 流式气泡 / 心情联动 ---- */
  useEffect(() => {
    const unlistens: Promise<UnlistenFn>[] = [];

    function clearStaticBubble() {
      window.clearTimeout(bubbleTimer.current);
      window.clearTimeout(bubbleTimer2.current);
    }

    function startStream() {
      clearStaticBubble();
      const s = streamRef.current;
      s.active = true;
      s.target = "";
      s.shown = 0;
      s.finished = false;
      s.holdUntil = 0;
      setChatting(true);
      setBubble({ text: "", phase: "in" }); // 空文本 -> 气泡内渲染思考点点
    }

    unlistens.push(
      listen<null>("chat-thinking", () => {
        stopSpeak(); // M4：打断上一段朗读，防叠音
        startStream();
      }),
    );

    unlistens.push(
      listen<{ text: string }>("chat-delta", (e) => {
        const s = streamRef.current;
        if (!s.active) startStream();
        s.target = e.payload.text;
      }),
    );

    unlistens.push(
      listen<{ text: string }>("chat-done", (e) => {
        const s = streamRef.current;
        if (!s.active) return;
        if (e.payload.text) s.target = e.payload.text;
        s.finished = true; // 打字机追平后由定时器收尾
      }),
    );

    unlistens.push(
      listen<{ message: string }>("chat-error", (e) => {
        streamRef.current.active = false;
        setChatting(false);
        showBubble(`呜…连不上模型：${e.payload.message.slice(0, 40)}`);
      }),
    );

    // 心情 v1：对话情绪 -> 心情引擎
    unlistens.push(
      listen<{ delta: number }>("chat-mood", (e) => {
        if (e.payload.delta) moodEngine.current?.add(e.payload.delta);
      }),
    );

    // 面板打开时回一份当前心情
    unlistens.push(
      listen<null>("panel-opened", () => {
        const eng = moodEngine.current;
        if (eng) void emit("pet-mood", { value: eng.value, mood: eng.mood() });
      }),
    );

    // 托盘/设置修改宠物大小时同步
    unlistens.push(
      listen<{ id: string; px: number }>("pet-size-changed", (e) => {
        setSpriteHeight(e.payload.px);
      }),
    );

    /* ---- M3 Agent 事件 ---- */
    // 提醒到点：举牌开心 + 爱心
    unlistens.push(
      listen<{ id: number; message: string }>("pet-reminder", (e) => {
        petRef.current?.excite();
        spawn("heart", 5, 160, petTopY() + spriteHRef.current * 0.25, 88);
        showBubble(`⏰ 叮！${e.payload.message}`);
        moodEngine.current?.add(2);
        // M4：语音播报提醒内容
        void speak(e.payload.message).catch(() => {});
      }),
    );
    // 久坐检测：先趴下提醒，被忽略则心情 -5
    unlistens.push(
      listen<{ stage: "warn" | "ignored"; idle_minutes: number }>("pet-sedentary", (e) => {
        if (e.payload.stage === "warn") {
          setNapping(true);
          window.setTimeout(() => setNapping(false), 30_000);
          showBubble("坐了好久啦，起来活动一下嘛～");
        } else {
          moodEngine.current?.add(-5);
          showBubble("呜……叫你活动你不听……");
        }
      }),
    );
    // 待办完成：庆祝 + 心情 +10
    unlistens.push(
      listen<{ tool: string; text: string }>("pet-tool", (e) => {
        if (e.payload.tool !== "done_todo") return;
        petRef.current?.excite();
        spawn("heart", 6, 160, petTopY() + spriteHRef.current * 0.25, 88);
        moodEngine.current?.add(10);
      }),
    );

    // M4：TTS 说话状态 -> 说话律动
    unlistens.push(
      listen<{ on: boolean }>("pet-speaking", (e) => {
        setSpeaking(e.payload.on);
      }),
    );

    return () => {
      for (const p of unlistens) void p.then((f) => f());
    };
  }, [showBubble]);

  /* ---- 打字机驱动：追平目标文本 -> 停留 -> 淡出 ---- */
  useEffect(() => {
    const t = window.setInterval(() => {
      const s = streamRef.current;
      if (!s.active) return;
      if (s.shown < s.target.length) {
        // 有积压时加速，保持跟手
        const backlog = s.target.length - s.shown;
        const step = Math.max(1, Math.ceil(backlog / 14));
        s.shown = Math.min(s.target.length, s.shown + step);
        setBubble({ text: s.target.slice(0, s.shown), phase: "in" });
      } else if (s.finished && !s.holdUntil) {
        s.holdUntil = performance.now() + 3400;
      } else if (s.holdUntil && performance.now() >= s.holdUntil) {
        s.active = false;
        setBubble((b) => (b ? { ...b, phase: "out" } : null));
        window.setTimeout(() => {
          setBubble(null);
          setChatting(false);
        }, 320);
      }
    }, 40);
    return () => window.clearInterval(t);
  }, []);

  /* ---- 首次使用引导：未配置模型时提示入口 ---- */
  useEffect(() => {
    if (isConfigured(loadConfig())) return;
    const t = window.setTimeout(
      () => showBubble("右键我或点托盘图标，配置本地模型就能聊天啦～"),
      1800,
    );
    return () => window.clearTimeout(t);
    // 仅启动时判断一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- 运动引擎：rAF 驱动的闲逛 / 行走 / 掉落 ---- */
  useEffect(() => {
    getMonitorInfo()
      .then((m) => {
        monitorRef.current = m;
        const saved = loadWindowPos();
        winPos.current = saved ?? {
          x: m.x + 40,
          y: m.y + m.height - WIN_H - FLOOR_MARGIN,
        };
        void moveWindowTo(winPos.current.x, winPos.current.y);
      })
      .catch(() => {});

    loco.current.nextAt = performance.now() + 2500;

    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const L = loco.current;
      if (drag.current.active) return;
      const m = monitorRef.current;
      if (!m) return;

      const fl = m.y + m.height - WIN_H - FLOOR_MARGIN;

      if (L.mode === "idle") {
        // 走动行为已隐藏：idle 不再切换为 walk，宠物原地待机
        if (now >= L.nextAt) {
          L.nextAt = now + 6000 + Math.random() * 8000;
        }
      } else if (L.mode === "walk") {
        // 已去掉左右行走帧：宠物平移时仍显示 idle
        if (now >= L.pauseUntil) {
          const speed =
            moodRef.current === "joy"
              ? 62
              : moodRef.current === "happy"
                ? 48
                : moodRef.current === "sleepy"
                  ? 24
                  : 38;
          const dx = L.target.x - winPos.current.x;
          const dy = L.target.y - winPos.current.y;
          const dist = Math.hypot(dx, dy);
          const step = Math.min(speed * dt, dist);
          if (step >= dist) {
            L.accX += dx;
            L.accY += dy;
            winPos.current = { ...L.target };
            L.mode = "idle";
            setWalking(false);
            L.nextAt = now + 7000 + Math.random() * 9000;
            saveWindowPos(winPos.current);
            if (Math.random() < 0.35) showBubble(pick(ARRIVE_LINES));
          } else {
            const mx = (dx / dist) * step;
            const my = (dy / dist) * step;
            L.accX += mx;
            L.accY += my;
            winPos.current.x += mx;
            winPos.current.y += my;
            if (Math.abs(dx) > 1) updateFacing(dx > 0 ? 1 : -1);
          }
        }
      } else if (L.mode === "fall") {
        L.vy += 1500 * dt;
        const ny = winPos.current.y + L.vy * dt;
        if (ny >= fl) {
          L.accY += fl - winPos.current.y;
          winPos.current.y = fl;
          L.mode = "idle";
          L.vy = 0;
          setFalling(false);
          L.nextAt = now + 5000 + Math.random() * 8000;
          petRef.current?.land();
          spawn("dust", 6, 160, 344, 46);
          saveWindowPos(winPos.current);
          if (Math.random() < 0.6) showBubble(pick(LAND_LINES));
        } else {
          L.accY += L.vy * dt;
          winPos.current.y = ny;
        }
      }

      // 位移累积后批量提交，兼顾平滑与 IPC 频率
      if (Math.abs(L.accX) + Math.abs(L.accY) >= WALK_FLUSH_PX) {
        void moveWindowBy(L.accX, L.accY);
        L.accX = 0;
        L.accY = 0;
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [showBubble, spawn, updateFacing]);

  return (
    <div
      className="pet-root"
      ref={rootRef}
      style={{ ["--pet-h" as string]: `${spriteHeight}px` }}
    >
      {/* 番茄钟倒计时胶囊（专注橙红 / 休息绿） */}
      {pomoPhase !== "idle" && (
        <div className="pomodoro-badge" data-break={pomoPhase === "break"}>
          <span className="pomo-ico">{pomoPhase === "focus" ? "🍅" : "☕"}</span>
          {fmtPomo(pomoRemain)}
        </div>
      )}

      {bubble && (
        <div className={`pet-bubble pet-bubble-${bubble.phase}`}>
          {bubble.text === "" ? (
            <span className="bubble-dots">
              <i />
              <i />
              <i />
            </span>
          ) : (
            bubble.text
          )}
        </div>
      )}

      {particles.map((p) => (
        <span
          key={p.id}
          className={`pp pp-${p.kind}`}
          style={{
            left: p.x,
            top: p.y,
            fontSize: p.size,
            ["--dx" as string]: `${p.dx}px`,
            ["--dy" as string]: `${p.dy}px`,
            ["--dur" as string]: `${p.dur}s`,
            ["--delay" as string]: `${p.delay}s`,
            ["--w" as string]: `${p.size}px`,
          }}
        >
          {p.kind === "heart" ? "♥" : p.kind === "spark" ? "✦" : p.kind === "z" ? "Z" : ""}
        </span>
      ))}

      <Pet
        ref={petRef}
        mood={mood}
        moodValue={moodValue}
        dragging={dragging}
        falling={falling}
        walking={walking}
        facing={facing}
        showMoodBar={showMoodBar}
        chatting={chatting}
        spriteHeight={spriteHeight}
        napping={napping}
        speaking={speaking}
      />
    </div>
  );
}

export default App;
