//! 番茄钟计时源（后端驱动）：桌面 / Android 通用
//!
//! 计时逻辑原来在桌面宠物窗口（App.tsx 的 setInterval）里，移动端单窗口
//! （Panel）根本不挂载该组件导致 Android 上番茄钟失效；且 WebView 退后台
//! 时 JS 定时器会被暂停。现在统一由 Rust 侧驱动：
//!
//! - 命令：pomodoro_start / pomodoro_stop / pomodoro_set / pomodoro_get_state
//! - 每秒广播 `pomodoro-state` { phase, remain }（倒计时显示）
//! - 阶段切换时广播 `pomodoro-phase` { from, to, focus_min, break_min }
//!   （宠物动画 + 语音播报）

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Idle,
    Focus,
    Break,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Focus => "focus",
            Phase::Break => "break",
        }
    }
}

struct Inner {
    phase: Phase,
    /// 当前阶段截止时刻（idle 时无意义）
    ends_at: Instant,
    focus_min: u32,
    break_min: u32,
}

fn pomo() -> &'static Mutex<Inner> {
    static POMO: std::sync::OnceLock<Mutex<Inner>> = std::sync::OnceLock::new();
    POMO.get_or_init(|| {
        Mutex::new(Inner {
            phase: Phase::Idle,
            ends_at: Instant::now(),
            focus_min: 25,
            break_min: 5,
        })
    })
}

/// 时长入参收敛到 1~180 分钟（与前端 clampPomoMin 对齐）
fn clamp_min(v: u32) -> u32 {
    v.clamp(1, 180)
}

fn remain_secs(g: &Inner) -> u64 {
    g.ends_at.saturating_duration_since(Instant::now()).as_secs()
}

#[derive(Serialize)]
pub struct PomoState {
    pub phase: &'static str,
    pub remain: u64,
}

fn emit_state(app: &AppHandle) {
    let g = pomo().lock().unwrap();
    let state = PomoState { phase: g.phase.as_str(), remain: remain_secs(&g) };
    let _ = app.emit("pomodoro-state", &state);
}

/// 启动番茄钟（仅 idle 时生效，与原前端行为一致）
#[tauri::command]
pub fn pomodoro_start(app: AppHandle, focus_min: u32, break_min: u32) -> Result<(), String> {
    let mut g = pomo().lock().unwrap();
    if g.phase != Phase::Idle {
        return Ok(());
    }
    g.focus_min = clamp_min(focus_min);
    g.break_min = clamp_min(break_min);
    g.phase = Phase::Focus;
    g.ends_at = Instant::now() + Duration::from_secs(g.focus_min as u64 * 60);
    let (fm, bm) = (g.focus_min, g.break_min);
    drop(g);
    let _ = app.emit(
        "pomodoro-phase",
        serde_json::json!({ "from": "idle", "to": "focus", "focus_min": fm, "break_min": bm }),
    );
    emit_state(&app);
    Ok(())
}

/// 结束番茄钟
#[tauri::command]
pub fn pomodoro_stop(app: AppHandle) -> Result<(), String> {
    let mut g = pomo().lock().unwrap();
    if g.phase == Phase::Idle {
        return Ok(());
    }
    g.phase = Phase::Idle;
    drop(g);
    let _ = app.emit(
        "pomodoro-phase",
        serde_json::json!({ "from": "-", "to": "idle", "focus_min": 0, "break_min": 0 }),
    );
    emit_state(&app);
    Ok(())
}

/// 更新专注 / 休息时长（当前阶段不变，下一阶段生效）
#[tauri::command]
pub fn pomodoro_set(focus_min: u32, break_min: u32) -> Result<(), String> {
    let mut g = pomo().lock().unwrap();
    g.focus_min = clamp_min(focus_min);
    g.break_min = clamp_min(break_min);
    Ok(())
}

/// 查询当前状态（面板打开 / 页面恢复可见时同步用）
#[tauri::command]
pub fn pomodoro_get_state() -> PomoState {
    let g = pomo().lock().unwrap();
    PomoState { phase: g.phase.as_str(), remain: remain_secs(&g) }
}

/// 每秒 tick：推进剩余时间、到点切换阶段并广播。
/// setup 时启动一次，全平台常驻（进程由桌面窗口 / Android 前台服务保活）。
pub fn start_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let mut switched: Option<(Phase, Phase)> = None;
            {
                let mut g = pomo().lock().unwrap();
                if g.phase == Phase::Idle {
                    continue;
                }
                if Instant::now() >= g.ends_at {
                    let from = g.phase;
                    let (next, mins) = match g.phase {
                        Phase::Focus => (Phase::Break, g.break_min),
                        _ => (Phase::Focus, g.focus_min),
                    };
                    g.phase = next;
                    g.ends_at = Instant::now() + Duration::from_secs(mins as u64 * 60);
                    switched = Some((from, next));
                }
            }
            emit_state(&app);
            if let Some((from, to)) = switched {
                let g = pomo().lock().unwrap();
                let _ = app.emit(
                    "pomodoro-phase",
                    serde_json::json!({
                        "from": from.as_str(),
                        "to": to.as_str(),
                        "focus_min": g.focus_min,
                        "break_min": g.break_min,
                    }),
                );
                // Android：WebView 退后台时前端播报不可达，到点发系统通知
                #[cfg(target_os = "android")]
                {
                    let (title, body) = if to == Phase::Break {
                        ("🍅 番茄完成", format!("专注结束，休息 {} 分钟吧～", g.break_min))
                    } else {
                        ("☕ 休息结束", format!("开始新的番茄（{} 分钟）吧！", g.focus_min))
                    };
                    crate::system_notify(&app, title, &body);
                }
            }
        }
    });
}
