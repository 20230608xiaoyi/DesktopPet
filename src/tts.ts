/**
 * M4：TTS 客户端 —— 双通道
 * - 云端：后端合成 mp3 → 前端 Web Audio 播放
 * - 本地：后端 PowerShell 直接播放，结束事件由后端广播
 * 播放期间广播 pet-speaking { on: boolean } 驱动宠物说话律动
 */
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

export type TtsMode = "auto" | "cloud" | "local";
export type TtsSettings = { enabled: boolean; mode: TtsMode };

const STORE_KEY = "tts-settings-v1";

export function loadTtsSettings(): TtsSettings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed.enabled === "boolean" &&
        ["auto", "cloud", "local"].includes(parsed.mode)
      ) {
        return parsed as TtsSettings;
      }
    }
  } catch {
    /* 忽略损坏配置 */
  }
  return { enabled: true, mode: "auto" };
}

export function saveTtsSettings(s: TtsSettings): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}

/** 当前云端播放的音频元素 */
let currentAudio: HTMLAudioElement | null = null;

/** 停止一切语音（云端音频 + 本地后端播放） */
export function stopSpeak(): void {
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = null;
  }
  invoke("tts_stop").catch(() => {});
  emit("pet-speaking", { on: false }).catch(() => {});
}

/** 清洗朗读文本：去 markdown 记号、合并空白、截断 */
function cleanForSpeech(text: string): string {
  return text
    .replace(/[#*`>~[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** 朗读一段文本；未启用 TTS 或文本为空时静默返回 */
export async function speak(text: string, settings?: TtsSettings): Promise<void> {
  const conf = settings ?? loadTtsSettings();
  if (!conf.enabled) return;
  const clean = cleanForSpeech(text);
  if (!clean) return;

  stopSpeak();

  const r = await invoke<{ engine: string; audio: string | null }>("tts_speak", {
    text: clean,
    mode: conf.mode,
  });

  if (r.audio) {
    // 云端：前端播放 mp3
    const audio = new Audio(`data:audio/mpeg;base64,${r.audio}`);
    currentAudio = audio;
    audio.onended = () => {
      if (currentAudio === audio) currentAudio = null;
      emit("pet-speaking", { on: false }).catch(() => {});
    };
    audio.onerror = () => {
      if (currentAudio === audio) currentAudio = null;
      emit("pet-speaking", { on: false }).catch(() => {});
    };
    emit("pet-speaking", { on: true }).catch(() => {});
    try {
      await audio.play();
    } catch {
      if (currentAudio === audio) currentAudio = null;
      emit("pet-speaking", { on: false }).catch(() => {});
    }
  } else {
    // 本地：后端已开始发声，结束事件由后端 watcher 广播
    emit("pet-speaking", { on: true }).catch(() => {});
  }
}
