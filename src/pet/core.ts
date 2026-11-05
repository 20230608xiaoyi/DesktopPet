import { invoke } from "@tauri-apps/api/core";

/** 宠物窗口尺寸（逻辑像素）：加高顶部区域用于气泡，底部留心情条空间 */
export const WIN_W = 320;
export const WIN_H = 400;

/** 宠物本体在窗口内的包围盒（逻辑像素，相对窗口左上角） */
export const PET_HITBOX = {
  x: 80,
  y: 96,
  w: 160,
  h: 268,
};

/** 点击穿透轮询间隔（毫秒） */
export const HITBOX_POLL_MS = 100;

export type MonitorInfo = {
  x: number;
  y: number;
  width: number;
  height: number;
  scale_factor: number;
};

/** 获取主显示器工作区（逻辑像素） */
export async function getMonitorInfo(): Promise<MonitorInfo> {
  return invoke<MonitorInfo>("get_monitor_info");
}

/**
 * 判断全局光标是否在宠物本体包围盒内
 * 由 Rust 侧用物理像素精确计算，前端只传逻辑 hitbox
 */
export async function isCursorOverPet(): Promise<boolean> {
  return invoke<boolean>("is_cursor_over_pet", {
    x: PET_HITBOX.x,
    y: PET_HITBOX.y,
    w: PET_HITBOX.w,
    h: PET_HITBOX.h,
  });
}

/** 窗口整体平移（逻辑像素） */
export async function moveWindowBy(dx: number, dy: number): Promise<void> {
  return invoke("move_window_by", { dx, dy });
}

/** 窗口移动到绝对坐标（逻辑像素） */
export async function moveWindowTo(x: number, y: number): Promise<void> {
  return invoke("move_window_to", { x, y });
}

/** 查询窗口当前真实坐标（逻辑像素） */
export async function getWindowPos(): Promise<{ x: number; y: number }> {
  const [x, y] = await invoke<[number, number]>("get_window_pos");
  return { x, y };
}

/** 设置鼠标穿透 */
export async function setIgnoreCursor(ignore: boolean): Promise<void> {
  return invoke("set_ignore_cursor", { ignore });
}

/** 显示 / 隐藏宠物 */
export async function setPetVisible(visible: boolean): Promise<void> {
  return invoke("set_pet_visible", { visible });
}

/** 打开对话面板（聊天 / 设置），tab: "chat" | "settings" */
export async function openPanel(tab: "chat" | "settings"): Promise<void> {
  return invoke("open_panel", { tab });
}

/** 退出 */
export async function quitApp(): Promise<void> {
  return invoke("quit_app");
}

/* ---- 窗口位置持久化（localStorage） ---- */

const POS_KEY = "pet-window-pos";

export type WindowPos = { x: number; y: number };

export function loadWindowPos(): WindowPos | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const pos = JSON.parse(raw) as WindowPos;
    return typeof pos.x === "number" && typeof pos.y === "number" ? pos : null;
  } catch {
    return null;
  }
}

export function saveWindowPos(pos: WindowPos): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* 忽略存储失败 */
  }
}
