//! 悬浮桌宠插件（Android 专属）：
//! Rust 侧桥接层，把前端 invoke 转发到原生 Kotlin Plugin，由 Kotlin Foreground Service 绘制悬浮窗宠物。
//!
//! 前端调用方式：
//! - `invoke("plugin:petfloat|start", { args: { spriteHeight: 240 } })`
//! - `invoke("plugin:petfloat|stop")`
//! - `invoke("plugin:petfloat|is_running")`
//! - `invoke("plugin:petfloat|open_overlay_settings")`

use serde::{Deserialize, Serialize};
use tauri::{plugin::{Builder, PluginHandle}, AppHandle, Manager, Runtime};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.petfloat.plugin";

/// start 命令参数（需实现 Serialize：run_mobile_plugin 以 JSON 转发到 Kotlin）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    /// 悬浮宠物显示高度（dp）
    pub sprite_height: Option<f32>,
}

/// is_running 命令返回（需实现 Deserialize：解析 Kotlin 返回的 JSON）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunningState {
    pub running: bool,
}

/// 插件句柄（注册后 manage 进 state，命令通过 `petfloat()` 扩展访问）
#[derive(Clone)]
pub struct PetFloat<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> PetFloat<R> {
    pub fn start(&self, args: StartArgs) -> Result<(), String> {
        self.0.run_mobile_plugin("start", args).map_err(|e| e.to_string())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.0.run_mobile_plugin("stop", ()).map_err(|e| e.to_string())
    }

    pub fn is_running(&self) -> Result<RunningState, String> {
        self.0.run_mobile_plugin("isRunning", ()).map_err(|e| e.to_string())
    }

    pub fn open_overlay_settings(&self) -> Result<(), String> {
        self.0.run_mobile_plugin("openOverlaySettings", ()).map_err(|e| e.to_string())
    }
}

pub trait PetFloatExt<R: Runtime> {
    fn petfloat(&self) -> &PetFloat<R>;
}

impl<R: Runtime, T: Manager<R>> PetFloatExt<R> for T {
    fn petfloat(&self) -> &PetFloat<R> {
        self.state::<PetFloat<R>>().inner()
    }
}

#[tauri::command]
async fn start<R: Runtime>(app: AppHandle<R>, args: StartArgs) -> Result<(), String> {
    app.petfloat().start(args).map_err(|e| e.to_string())
}

#[tauri::command]
async fn stop<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.petfloat().stop().map_err(|e| e.to_string())
}

#[tauri::command]
async fn is_running<R: Runtime>(app: AppHandle<R>) -> Result<RunningState, String> {
    app.petfloat().is_running().map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_overlay_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.petfloat()
        .open_overlay_settings()
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    Builder::new("petfloat")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "PetFloatPlugin")?;
            app.manage(PetFloat(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start,
            stop,
            is_running,
            open_overlay_settings
        ])
        .build()
}

// 该插件只在 Android target 被主工程依赖；其余平台提供空实现以便独立检查编译
#[cfg(not(target_os = "android"))]
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    Builder::new("petfloat").build()
}
