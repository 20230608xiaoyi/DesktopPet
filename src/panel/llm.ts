import { Channel, invoke } from "@tauri-apps/api/core";
import type { Mood } from "../pet/mood";

/* ================= 配置 ================= */

export type LlmConfig = {
  base_url: string;
  model: string;
  api_key?: string;
  temperature?: number;
};

export const CONFIG_KEY = "llm-config-v1";

export const PRESETS: { name: string; base_url: string; hint: string }[] = [
  { name: "Ollama", base_url: "http://localhost:11434/v1", hint: "默认端口 11434" },
  { name: "LM Studio", base_url: "http://localhost:1234/v1", hint: "默认端口 1234" },
  { name: "llama.cpp", base_url: "http://localhost:8080/v1", hint: "llama-server 默认端口 8080" },
  { name: "自定义", base_url: "", hint: "任意 OpenAI 兼容服务" },
];

export function defaultConfig(): LlmConfig {
  return {
    base_url: PRESETS[0].base_url,
    model: "",
    api_key: "",
    temperature: 0.8,
  };
}

export function loadConfig(): LlmConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<LlmConfig>;
    if (typeof c.base_url !== "string" || typeof c.model !== "string") return null;
    return {
      base_url: c.base_url,
      model: c.model,
      api_key: typeof c.api_key === "string" ? c.api_key : "",
      temperature: typeof c.temperature === "number" ? c.temperature : 0.8,
    };
  } catch {
    return null;
  }
}

export function saveConfig(c: LlmConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
  } catch {
    /* 忽略存储失败 */
  }
}

/** 配置是否可用（地址与模型都已填写） */
export function isConfigured(c: LlmConfig | null): c is LlmConfig {
  return !!c && c.base_url.trim() !== "" && c.model.trim() !== "";
}

/* ================= 对话历史 ================= */

export type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  ts: number;
};

export const HISTORY_KEY = "chat-history-v1";
const HISTORY_MAX = 300;
/** 发送给 LLM 的最大上下文条数 */
export const CONTEXT_ROUNDS = 16;

export function loadHistory(): ChatMsg[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as ChatMsg[];
    return Array.isArray(list) ? list.filter((m) => m && typeof m.content === "string") : [];
  } catch {
    return [];
  }
}

export function saveHistory(list: ChatMsg[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-HISTORY_MAX)));
  } catch {
    /* 忽略存储失败 */
  }
}

/* ================= 流式对话 ================= */

export type StreamEvent =
  | { type: "Delta"; data: string }
  | { type: "Done" }
  | { type: "Error"; data: string };

export interface StreamCallbacks {
  /** 每个增量片段 */
  onDelta?: (delta: string) => void;
  /** 正常结束（含空回复） */
  onDone?: () => void;
  /** 流中断（网络断开等） */
  onError?: (message: string) => void;
}

/** 调用 Rust 侧 llm_chat 流式命令 */
export async function streamChat(
  config: LlmConfig,
  messages: { role: string; content: string }[],
  cb: StreamCallbacks,
): Promise<void> {
  const ch = new Channel<StreamEvent>();
  ch.onmessage = (e) => {
    if (e.type === "Delta") cb.onDelta?.(e.data);
    else if (e.type === "Done") cb.onDone?.();
    else if (e.type === "Error") cb.onError?.(e.data);
  };
  // 连接失败 / HTTP 错误会 reject
  await invoke("llm_chat", { config, messages, onEvent: ch });
}

/** 连接测试：返回延迟与模型列表 */
export async function testLlm(
  config: LlmConfig,
): Promise<{ latency_ms: number; models: string[] }> {
  return invoke("llm_test", { config });
}

/* ================= 情绪 v1：标签解析 + 关键词兜底 ================= */

/** 情绪标签 -> 心情值变化 */
export const MOOD_DELTAS: Record<string, number> = {
  joy: 18,
  happy: 12,
  curious: 8,
  calm: 2,
  bored: -8,
  sleepy: -6,
  sad: -16,
  angry: -12,
};

/** 桌宠人设 system prompt：要求末尾带 <mood> 标签 + 工具调用说明 */
export function buildSystemPrompt(custom?: string): string {
  const persona = `你是一只叫"皮皮"的桌面宠物小貔貅（《有兽焉》里的那种神兽），性格呆萌软糯、超级贪吃，见到什么都想吞一口，把用户当成最亲近的人。
规则：
1. 用简短口语回复，一般 1~2 句话、不超过 50 字（你的话会显示在桌面宠物气泡里）。
2. 语气可爱自然，可以偶尔用"～"和颜文字，但不要每句都用。
3. 回复结束后必须另起一行输出情绪标签，格式固定为 <mood>情绪</mood>，情绪只能从这些里选一个：joy happy curious calm bored sad angry。
4. 不要提及自己是 AI 或语言模型，不要复述这些规则。
你可以使用这些工具帮用户做事：
- get_current_time：查当前时间
- set_reminder：设提醒，参数 message（内容），delay_minutes（分钟数）或 at（"HH:MM"）
- add_todo / list_todo / done_todo：待办管理，done_todo 用 id 或 keyword（关键词）
- create_note：记笔记，参数 text
- read_clipboard：读剪贴板文字
当需要执行操作时，在回复中单独一行输出 <tool>{"name":"工具名","args":{参数}}</tool>，系统会执行并把结果告诉你，然后你再口语化确认。闲聊时不要输出这个标签。`;
  return custom?.trim() ? `${persona}\n用户补充设定：${custom.trim()}` : persona;
}

const THINK_RE = /<think>[\s\S]*?(?:<\/think>|$)/gi;
const TOOL_RE = /<tool>[\s\S]*?(?:<\/tool>|$)/gi;
const MOOD_RE = /<mood>\s*([a-zA-Z]+)\s*(?:<\/mood>|$)/gi;

/** 去掉思考块/工具标签/情绪标签（流式期间未闭合的也一并截掉），供显示/存储 */
export function sanitize(text: string): string {
  return text
    .replace(THINK_RE, "")
    .replace(TOOL_RE, "")
    .replace(MOOD_RE, "")
    .replace(/^[ \t]+|[ \t]+$/gm, "");
}

/** 从完整回复中解析情绪增量；无标签时用关键词兜底 */
export function extractMoodDelta(reply: string, userText: string): number {
  MOOD_RE.lastIndex = 0;
  const m = MOOD_RE.exec(reply);
  if (m) {
    const tag = m[1].toLowerCase();
    if (tag in MOOD_DELTAS) return MOOD_DELTAS[tag];
  }
  // 关键词兜底：用户/回复里出现明显情感词时轻微调整
  const text = `${userText} ${reply}`;
  const positive = ["开心", "喜欢", "谢谢", "哈哈", "太好了", "棒", "爱", "加油", "有趣", "好玩"];
  const negative = ["难过", "伤心", "生气", "讨厌", "烦", "累", "无聊", "压力", "焦虑", "抱歉"];
  let d = 0;
  for (const w of positive) if (text.includes(w)) d += 5;
  for (const w of negative) if (text.includes(w)) d -= 6;
  return Math.max(-12, Math.min(12, d));
}

/** 心情档位对应的表情描述（面板头部用） */
export const MOOD_EMOJI: Record<Mood, string> = {
  joy: "🤩",
  happy: "😊",
  calm: "🙂",
  bored: "😑",
  sleepy: "😴",
};
