//! 久坐检测（Windows）：轮询系统键鼠最后输入时间
//!
//! 状态机：
//! - 用户活跃（空闲 < 5 分钟）→ 重置
//! - 空闲 ≥ 60 分钟 → 广播 warn（宠物举牌提醒）
//! - 提醒后仍空闲 ≥ 15 分钟 → 广播 ignored（心情 -5），本周期不再打扰
//! - 用户回来后重新计时

use std::sync::atomic::{AtomicBool, Ordering};

/// M4：久坐检测开关（设置面板可关闭）
static SEDENTARY_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_enabled(on: bool) {
    SEDENTARY_ENABLED.store(on, Ordering::SeqCst);
}

pub fn is_enabled() -> bool {
    SEDENTARY_ENABLED.load(Ordering::SeqCst)
}

#[cfg(windows)]
pub fn start_watcher(app: tauri::AppHandle) {
    use tauri::Emitter;

    tauri::async_runtime::spawn(async move {
        // 阈值（毫秒）
        const ACTIVE_RESET: u64 = 5 * 60 * 1000; // 5 分钟内有输入 = 活跃
        const IDLE_WARN: u64 = 60 * 60 * 1000; // 60 分钟 = 久坐
        const IDLE_IGNORED: u64 = 75 * 60 * 1000; // 提醒后 15 分钟仍不动
        const POLL_MS: u64 = 30 * 1000;

        let mut warned = false;
        let mut ignored = false;

        loop {
            // 开关关闭时只轮询等待，不检测
            if !is_enabled() {
                tokio::time::sleep(std::time::Duration::from_millis(POLL_MS)).await;
                continue;
            }

            let idle = idle_ms();

            if idle < ACTIVE_RESET {
                // 用户回来了：重置周期
                warned = false;
                ignored = false;
            } else if !warned && idle >= IDLE_WARN {
                warned = true;
                let _ = app.emit("pet-sedentary", serde_json::json!({ "stage": "warn", "idle_minutes": idle / 60_000 }));
            } else if warned && !ignored && idle >= IDLE_IGNORED {
                ignored = true;
                let _ = app.emit("pet-sedentary", serde_json::json!({ "stage": "ignored", "idle_minutes": idle / 60_000 }));
            }

            tokio::time::sleep(std::time::Duration::from_millis(POLL_MS)).await;
        }
    });
}

#[cfg(target_os = "android")]
pub fn start_watcher(app: tauri::AppHandle) {
    use tauri::Emitter;

    tauri::async_runtime::spawn(async move {
        // Android 无公开的系统级键鼠空闲 API（GetLastInputInfo 仅 Windows），
        // 降级为固定间隔活动提醒：每 60 分钟广播一次 warn。
        const INTERVAL_SECS: u64 = 60 * 60;
        const POLL_SECS: u64 = 30;

        let mut elapsed: u64 = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(POLL_SECS)).await;
            if !is_enabled() {
                elapsed = 0;
                continue;
            }
            elapsed += POLL_SECS;
            if elapsed >= INTERVAL_SECS {
                elapsed = 0;
                let _ = app.emit(
                    "pet-sedentary",
                    serde_json::json!({ "stage": "warn", "idle_minutes": INTERVAL_SECS / 60 }),
                );
                // WebView 退后台时前端播报不可达，到点发系统通知
                crate::system_notify(&app, "🪑 久坐提醒", "已经坐了 60 分钟啦，起来活动一下吧～");
            }
        }
    });
}

// 其余平台（iOS 等）暂无久坐检测实现
#[cfg(not(any(windows, target_os = "android")))]
pub fn start_watcher(_app: tauri::AppHandle) {}

/// 系统键鼠空闲毫秒数（GetTickCount 溢出周期约 49.7 天，忽略不计）
#[cfg(windows)]
fn idle_ms() -> u64 {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info) == 0 {
            return 0;
        }
        let now = GetTickCount();
        // 处理回绕
        let idle = now.wrapping_sub(info.dwTime);
        idle as u64
    }
}
