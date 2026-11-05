mod config;
mod idle;
mod pomodoro;
mod storage;
mod tools;
mod tts;

use std::time::{Duration, Instant};

use config::{PetSize, get_pet_size as cfg_get_pet_size, set_pet_size as cfg_set_pet_size};
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

// ---- 桌面专属：菜单 / 托盘 / 窗口操控（移动端无这些概念）----
#[cfg(desktop)]
use tauri::{
    Manager,
    menu::{CheckMenuItem, ContextMenu, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    WebviewWindow,
};

/// 主显示器信息（逻辑像素，供前端做边界钳制与闲逛范围）
#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
struct MonitorInfo {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
}

#[cfg(desktop)]
#[tauri::command]
fn get_monitor_info(window: WebviewWindow) -> Result<MonitorInfo, String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("no monitor")?;
    let p = monitor.position();
    let s = monitor.size();
    let sc = monitor.scale_factor();
    Ok(MonitorInfo {
        x: p.x as f64 / sc,
        y: p.y as f64 / sc,
        width: s.width as f64 / sc,
        height: s.height as f64 / sc,
        scale_factor: sc,
    })
}

/// 判断全局光标是否落在宠物本体包围盒内（传入逻辑像素 hitbox，内部换算物理像素）
/// 返回 false 时应保持鼠标穿透，true 时允许交互（点击/拖拽）
#[cfg(desktop)]
#[tauri::command]
fn is_cursor_over_pet(window: WebviewWindow, x: f64, y: f64, w: f64, h: f64) -> bool {
    // cursor_position 与 outer_position 同为桌面坐标系（物理像素），可直接相减
    let Ok(cursor) = window.cursor_position() else {
        return false;
    };
    let Ok(win) = window.outer_position() else {
        return false;
    };
    let Ok(sc) = window.scale_factor() else {
        return false;
    };

    // 光标相对窗口的局部物理坐标
    let lx = cursor.x - win.x as f64;
    let ly = cursor.y - win.y as f64;
    // 逻辑 hitbox -> 物理
    let x0 = x * sc;
    let y0 = y * sc;
    let x1 = (x + w) * sc;
    let y1 = (y + h) * sc;

    (x0..=x1).contains(&lx) && (y0..=y1).contains(&ly)
}

/// 窗口整体平移 dx/dy 逻辑像素（用于宠物闲逛 / 行走），并钳制在显示器工作区内
#[cfg(desktop)]
#[tauri::command]
fn move_window_by(window: WebviewWindow, dx: f64, dy: f64) -> Result<(), String> {
    let sc = window.scale_factor().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let nx = pos.x as f64 / sc + dx;
    let ny = pos.y as f64 / sc + dy;
    clamp_and_set_position(&window, nx, ny)
}

/// 窗口移动到绝对坐标（逻辑像素，用于启动时恢复上次位置）
#[cfg(desktop)]
#[tauri::command]
fn move_window_to(window: WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    clamp_and_set_position(&window, x, y)
}

/// 查询窗口当前坐标（逻辑像素，用于拖拽后同步真实位置 / 判断掉落）
#[cfg(desktop)]
#[tauri::command]
fn get_window_pos(window: WebviewWindow) -> Result<(f64, f64), String> {
    let sc = window.scale_factor().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    Ok((pos.x as f64 / sc, pos.y as f64 / sc))
}

/// 钳制到当前显示器工作区内并设置窗口位置
#[cfg(desktop)]
fn clamp_and_set_position(window: &WebviewWindow, mut nx: f64, mut ny: f64) -> Result<(), String> {
    let sc = window.scale_factor().map_err(|e| e.to_string())?;

    if let Ok(Some(monitor)) = window.current_monitor() {
        let p = monitor.position();
        let s = monitor.size();
        let sc = monitor.scale_factor();
        let w = s.width as f64 / sc;
        let h = s.height as f64 / sc;
        let left = p.x as f64 / sc;
        let top = p.y as f64 / sc;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let ws = size.width as f64 / sc;
        let wh = size.height as f64 / sc;
        nx = nx.clamp(left, (left + w - ws).max(left));
        ny = ny.clamp(top, (top + h - wh).max(top));
    }

    let _ = window
        .set_position(tauri::PhysicalPosition::new((nx * sc) as i32, (ny * sc) as i32));
    Ok(())
}

/// 设置鼠标穿透（宠物本体外区域不拦截鼠标）
#[cfg(desktop)]
#[tauri::command]
fn set_ignore_cursor(window: WebviewWindow, ignore: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}

/// 显示 / 隐藏宠物（隐藏时恢复穿透，避免隐形窗口挡鼠标）
#[cfg(desktop)]
#[tauri::command]
fn set_pet_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window not found")?;
    if visible {
        window.show().map_err(|e| e.to_string())?;
    } else {
        window.hide().map_err(|e| e.to_string())?;
    }
    window
        .set_ignore_cursor_events(!visible)
        .map_err(|e| e.to_string())
}

/// 退出应用
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Android：由 Rust 侧直接发系统通知。
/// WebView 退后台时 JS 定时器暂停、前端语音/气泡不可达，
/// 番茄钟到点与久坐提醒必须走系统通知才能触达用户。
#[cfg(target_os = "android")]
pub(crate) fn system_notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

/* ================= 宠物大小设置 ================= */

#[tauri::command]
fn get_pet_size(app: AppHandle) -> Result<(String, u32), String> {
    let size = cfg_get_pet_size(&app);
    Ok((format!("{:?}", size).to_lowercase(), size.as_px()))
}

#[tauri::command]
fn set_pet_size(app: AppHandle, size_id: String) -> Result<(String, u32), String> {
    let size = PetSize::from_id(&size_id).ok_or("未知大小")?;
    cfg_set_pet_size(&app, size.clone())?;
    let _ = app.emit("pet-size-changed", json!({"id": size_id, "px": size.as_px()}));
    Ok((size_id, size.as_px()))
}

#[cfg(desktop)]
fn size_menu_items(
    app: &AppHandle,
    current: &PetSize,
) -> Result<Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>>, String> {
    let sizes = [PetSize::Small, PetSize::Medium, PetSize::Large];
    sizes
        .iter()
        .map(|s| {
            let id = format!("{:?}", s).to_lowercase();
            let item = CheckMenuItem::with_id(
                app,
                &id,
                s.as_label(),
                true,
                s == current,
                None::<&str>,
            )
            .map_err(|e| e.to_string())?;
            Ok(Box::new(item) as Box<dyn tauri::menu::IsMenuItem<_>>)
        })
        .collect()
}

/// 在宠物主窗口弹出右键菜单（聊天 / 设置 / 大小）
#[cfg(desktop)]
#[tauri::command]
fn show_pet_context_menu(window: tauri::Window) -> Result<(), String> {
    let app = window.app_handle();
    let current_size = cfg_get_pet_size(app);
    let size_items = size_menu_items(app, &current_size)?;
    let size_submenu = Submenu::with_items(
        app,
        "大小",
        true,
        &size_items.iter().map(|i| i.as_ref()).collect::<Vec<_>>(),
    ).map_err(|e| e.to_string())?;
    let chat_item = MenuItem::with_id(app, "chat", "聊天…", true, None::<&str>).map_err(|e| e.to_string())?;
    let settings_item = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>).map_err(|e| e.to_string())?;
    let show_item = MenuItem::with_id(app, "show", "显示宠物", true, None::<&str>).map_err(|e| e.to_string())?;
    let hide_item = MenuItem::with_id(app, "hide", "隐藏宠物", true, None::<&str>).map_err(|e| e.to_string())?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>).map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;

    let menu = Menu::with_items(
        app,
        &[
            &chat_item,
            &settings_item,
            &size_submenu,
            &sep,
            &show_item,
            &hide_item,
            &quit_item,
        ],
    ).map_err(|e| e.to_string())?;

    menu.popup(window).map_err(|e| e.to_string())?;
    Ok(())
}

/* ================= 本地 LLM（OpenAI 兼容协议） ================= */

/// 前端传入的 LLM 连接配置
#[derive(Clone, Debug, serde::Deserialize)]
struct LlmConfig {
    base_url: String,
    model: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    temperature: Option<f64>,
}

/// 流式事件：增量文本 / 完成 / 运行中错误
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", content = "data")]
enum LlmStreamEvent {
    Delta(String),
    Done,
    Error(String),
}

fn llm_base(config: &LlmConfig) -> String {
    config.base_url.trim().trim_end_matches('/').to_string()
}

fn apply_auth(mut req: reqwest::RequestBuilder, config: &LlmConfig) -> reqwest::RequestBuilder {
    if let Some(key) = config
        .api_key
        .as_ref()
        .map(|k| k.trim())
        .filter(|k| !k.is_empty())
    {
        req = req.bearer_auth(key);
    }
    req
}

/// 从错误响应体里尽量提取 error.message，失败则返回原文（截断）
async fn error_body(status: reqwest::StatusCode, body: String) -> String {
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.get("error"))
                .or_else(|| v.get("message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or(body);
    let detail = if detail.chars().count() > 200 {
        detail.chars().take(200).collect::<String>()
    } else {
        detail
    };
    format!("HTTP {status}: {detail}")
}

/// 一轮流式请求的结果：完整文本 + 累积的原生 tool_calls
struct StreamRound {
    content: String,
    tool_calls: Vec<Value>,
    sent_any: bool,
}

/// 单轮流式请求：POST {url}（stream: true）
/// - use_tools=true 时携带 tools 参数（原生 function calling）
/// - content 增量通过 Channel 实时回推；tool_calls 增量只累积不上屏
/// - 服务端忽略 stream 参数时兜底解析完整 JSON
async fn stream_once(
    client: &Client,
    url: &str,
    config: &LlmConfig,
    messages: &[Value],
    use_tools: bool,
    on_event: &tauri::ipc::Channel<LlmStreamEvent>,
) -> Result<StreamRound, String> {
    let mut body = json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
        "temperature": config.temperature.unwrap_or(0.8),
    });
    if use_tools {
        body["tools"] = tools::tool_schemas();
        body["tool_choice"] = json!("auto");
    }

    let resp = apply_auth(client.post(url).json(&body), config)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        return Err(error_body(status, err_body).await);
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut round = StreamRound {
        content: String::new(),
        tool_calls: Vec::new(),
        sent_any: false,
    };
    // 原生 tool_calls 流式累积槽：(id, name 片段, arguments 片段)
    let mut pending: Vec<Option<(String, String, String)>> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = on_event.send(LlmStreamEvent::Error(e.to_string()));
                return Ok(round);
            }
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));

        // 逐行解析 SSE：data: {...}
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            let line = line.trim();
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            // 文本增量
            if let Some(delta) = v
                .pointer("/choices/0/delta/content")
                .and_then(|c| c.as_str())
                .filter(|s| !s.is_empty())
            {
                round.sent_any = true;
                round.content.push_str(delta);
                let _ = on_event.send(LlmStreamEvent::Delta(delta.to_string()));
            }
            // 工具调用增量（按 index 槽位累积）
            if let Some(tcs) = v
                .pointer("/choices/0/delta/tool_calls")
                .and_then(|t| t.as_array())
            {
                round.sent_any = true;
                for tc in tcs {
                    let idx = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                    if pending.len() <= idx {
                        pending.resize(idx + 1, None);
                    }
                    let slot = pending[idx].get_or_insert_with(|| (String::new(), String::new(), String::new()));
                    if let Some(id) = tc.get("id").and_then(|i| i.as_str()).filter(|s| !s.is_empty()) {
                        slot.0 = id.to_string();
                    }
                    if let Some(n) = tc.pointer("/function/name").and_then(|n| n.as_str()) {
                        slot.1.push_str(n);
                    }
                    if let Some(a) = tc.pointer("/function/arguments").and_then(|a| a.as_str()) {
                        slot.2.push_str(a);
                    }
                }
            }
        }
    }

    // 兜底：服务端忽略 stream 参数直接回了完整 JSON
    if !round.sent_any {
        if let Ok(v) = serde_json::from_str::<Value>(&buf) {
            if let Some(content) = v
                .pointer("/choices/0/message/content")
                .and_then(|c| c.as_str())
                .filter(|s| !s.is_empty())
            {
                round.content.push_str(content);
                let _ = on_event.send(LlmStreamEvent::Delta(content.to_string()));
            }
            if let Some(tcs) = v
                .pointer("/choices/0/message/tool_calls")
                .and_then(|t| t.as_array())
            {
                for tc in tcs {
                    pending.push(Some((
                        tc.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string(),
                        tc.pointer("/function/name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                        tc.pointer("/function/arguments").and_then(|a| a.as_str()).unwrap_or("{}").to_string(),
                    )));
                }
            }
        }
    }

    for (id, name, args) in pending.into_iter().flatten() {
        round.tool_calls.push(json!({
            "id": id,
            "type": "function",
            "function": { "name": name, "arguments": args }
        }));
    }
    Ok(round)
}

/// 标签兜底：从完整回复里提取 <tool>{"name":"x","args":{...}}</tool> 调用
fn parse_tool_tags(content: &str) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("<tool>") {
        let after = &rest[start + "<tool>".len()..];
        let Some(end) = after.find("</tool>") else {
            break;
        };
        let body = after[..end].trim();
        rest = &after[end + "</tool>".len()..];
        if let Ok(v) = serde_json::from_str::<Value>(body) {
            let name = v
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let args = v
                .get("args")
                .or_else(|| v.get("arguments"))
                .cloned()
                .unwrap_or(json!({}));
            if !name.is_empty() {
                out.push((name, args));
            }
        }
    }
    out
}

/// Agent 对话主循环（双通道工具调用）：
/// 1. 优先原生 function calling（请求携带 tools）；服务端不支持时自动降级标签模式
/// 2. 标签模式：模型输出 <tool>{...}</tool>，前端 sanitize 剥离不展示
/// 3. 工具执行结果回传 → 继续生成口语化确认；最多 4 轮
#[tauri::command]
async fn llm_chat(
    app: AppHandle,
    config: LlmConfig,
    messages: Vec<Value>,
    on_event: tauri::ipc::Channel<LlmStreamEvent>,
) -> Result<(), String> {
    const MAX_TOOL_ROUNDS: usize = 4;
    let url = format!("{}/chat/completions", llm_base(&config));
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    let mut msgs: Vec<Value> = messages;
    let mut native_ok = true;

    for _round in 0..=MAX_TOOL_ROUNDS {
        let result = stream_once(&client, &url, &config, &msgs, native_ok, &on_event).await;
        // 原生模式失败（服务端可能不认 tools 参数）→ 降级标签模式重试一次
        let mut round = match result {
            Ok(r) => r,
            Err(_e) if native_ok => {
                native_ok = false;
                stream_once(&client, &url, &config, &msgs, false, &on_event).await?
            }
            Err(e) => return Err(e),
        };

        // ---- 通道 1：原生 tool_calls ----
        if !round.tool_calls.is_empty() {
            let content = std::mem::take(&mut round.content);
            let mut assistant = json!({
                "role": "assistant",
                "content": if content.is_empty() { Value::Null } else { Value::String(content) },
            });
            assistant["tool_calls"] = Value::Array(std::mem::take(&mut round.tool_calls));
            let calls = assistant["tool_calls"].as_array().cloned().unwrap_or_default();
            msgs.push(assistant);

            for tc in &calls {
                let name = tc.pointer("/function/name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                let args_str = tc.pointer("/function/arguments").and_then(|a| a.as_str()).unwrap_or("{}").to_string();
                let args: Value = serde_json::from_str(&args_str).unwrap_or(json!({}));
                let outcome = match tools::execute(&app, &name, &args) {
                    Ok(v) => v.to_string(),
                    Err(e) => json!({ "error": e }).to_string(),
                };
                msgs.push(json!({
                    "role": "tool",
                    "tool_call_id": tc.get("id").cloned().unwrap_or(Value::Null),
                    "content": outcome,
                }));
            }
            continue;
        }

        // ---- 通道 2：<tool> 标签兜底 ----
        let tag_calls = parse_tool_tags(&round.content);
        if !tag_calls.is_empty() {
            msgs.push(json!({ "role": "assistant", "content": round.content }));
            let mut lines = Vec::new();
            for (name, args) in tag_calls {
                let outcome = match tools::execute(&app, &name, &args) {
                    Ok(v) => v.to_string(),
                    Err(e) => json!({ "error": e }).to_string(),
                };
                lines.push(format!("[{name}] {outcome}"));
            }
            msgs.push(json!({
                "role": "system",
                "content": format!("工具执行结果：\n{}", lines.join("\n")),
            }));
            continue;
        }

        // ---- 无工具调用：最终回复 ----
        let _ = on_event.send(LlmStreamEvent::Done);
        return Ok(());
    }

    // 超出轮次上限：强制收尾
    let _ = on_event.send(LlmStreamEvent::Done);
    Ok(())
}

/// 连接测试：GET {base}/models，返回延迟与模型列表
#[derive(serde::Serialize)]
struct LlmTestResult {
    latency_ms: u64,
    models: Vec<String>,
}

#[tauri::command]
async fn llm_test(config: LlmConfig) -> Result<LlmTestResult, String> {
    let url = format!("{}/models", llm_base(&config));
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let start = Instant::now();
    let resp = apply_auth(client.get(&url), &config)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(error_body(status, body).await);
    }

    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let models = body
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    Ok(LlmTestResult {
        latency_ms: start.elapsed().as_millis() as u64,
        models,
    })
}

/* ================= M4：设置项 ================= */

/// 久坐提醒开关（设置面板）
#[tauri::command]
fn set_sedentary_enabled(enabled: bool) {
    idle::set_enabled(enabled);
}

#[tauri::command]
fn get_sedentary_enabled() -> bool {
    idle::is_enabled()
}

/// 复制文本到系统剪贴板（对话面板一键复制）
#[cfg(desktop)]
#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut cb| cb.set_text(text))
        .map_err(|e| e.to_string())
}

/* ================= 对话面板窗口 ================= */

/// 显示对话面板（聊天 / 设置），tab: "chat" | "settings"
#[cfg(desktop)]
#[tauri::command]
fn open_panel(app: AppHandle, tab: Option<String>) -> Result<(), String> {
    let panel = match app.get_webview_window("panel") {
        Some(w) => w,
        None => {
            // 兜底重建（正常情况下关闭被拦截为隐藏，不会走到这里）
            tauri::WebviewWindowBuilder::new(
                &app,
                "panel",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("桌宠 · 对话")
            .inner_size(400.0, 640.0)
            .min_inner_size(360.0, 520.0)
            .center()
            .build()
            .map_err(|e| e.to_string())?
        }
    };
    let _ = panel.show();
    let _ = panel.unminimize();
    let _ = panel.set_focus();
    if let Some(tab) = tab {
        let _ = app.emit("panel-tab", tab);
    }
    Ok(())
}

// Android：初始化 rustls-platform-verifier 的 JNI 组件。
// reqwest 默认 rustls TLS 在 Android 上依赖 APK 内的 Kotlin 类
// org.rustls.platformverifier.CertificateVerifier，且必须在任意 TLS
// 连接发生前用 activity/application context 初始化全局状态。
#[cfg(target_os = "android")]
fn init_rustls_platform_verifier() {
    let ctx = ndk_context::android_context();
    let (vm_raw, ctx_raw) = (ctx.vm(), ctx.context());
    if vm_raw.is_null() || ctx_raw.is_null() {
        log::warn!("[tts] ndk-context 未就绪，跳过 rustls-platform-verifier 初始化");
        return;
    }
    unsafe {
        let vm = jni::JavaVM::from_raw(vm_raw as *mut jni::sys::JavaVM);
        match vm.attach_current_thread(|env| {
            let context =
                jni::objects::JObject::from_raw(env, ctx_raw as jni::sys::jobject);
            rustls_platform_verifier::android::init_with_env(env, context)
        }) {
            Ok(()) => log::info!("[tts] rustls-platform-verifier 初始化成功"),
            Err(e) => log::warn!("[tts] rustls-platform-verifier 初始化失败: {e:?}"),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 必须在 Builder 启动前初始化（首个 HTTPS 请求来自启动流程自身）
    #[cfg(target_os = "android")]
    init_rustls_platform_verifier();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());

    // 桌面专属插件：开机自启（移动端无此概念）
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));

    // Android 专属插件：悬浮桌宠（原生 Kotlin Foreground Service + 悬浮窗）
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_petfloat::init());

    let builder = builder.setup(|app| {
        // ---- 桌面专属初始化：置顶穿透 / 自启 / 面板 / 托盘 ----
        #[cfg(desktop)]
        {
            // 初始状态：置顶 + 鼠标穿透
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
                let _ = window.set_ignore_cursor_events(true);
            }

            // 开机自启：首次运行默认开启（写入标记，之后尊重用户手动开关）；
            // 已开启时刷新注册表里的启动路径（重装/换目录后保持有效）
            use tauri_plugin_autostart::ManagerExt;
            let marker = app
                .path()
                .app_config_dir()
                .ok()
                .map(|d| d.join("autostart_inited"));
            let autolaunch = app.autolaunch();
            if !marker.as_ref().map(|p| p.exists()).unwrap_or(false) {
                let _ = autolaunch.enable();
                if let Some(p) = marker {
                    let _ = std::fs::write(p, b"1");
                }
            } else if autolaunch.is_enabled().unwrap_or(false) {
                let _ = autolaunch.enable();
            }

            // 对话面板：点关闭仅隐藏，保留状态与监听
            if let Some(panel) = app.get_webview_window("panel") {
                let p = panel.clone();
                panel.on_window_event(move |e| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        let _ = p.hide();
                    }
                });
            }

            // 系统托盘
            let chat_item = MenuItem::with_id(app, "chat", "聊天…", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let show_item = MenuItem::with_id(app, "show", "显示宠物", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "隐藏宠物", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let app_handle = app.handle().clone();
            let current_size = cfg_get_pet_size(&app_handle);
            let size_items = size_menu_items(&app_handle, &current_size)?;
            let size_submenu = Submenu::with_items(app, "大小", true, &size_items.iter().map(|i| i.as_ref()).collect::<Vec<_>>())?;
            let menu = Menu::with_items(
                app,
                &[
                    &chat_item,
                    &settings_item,
                    &size_submenu,
                    &sep,
                    &show_item,
                    &hide_item,
                    &quit_item,
                ],
            )?;
            TrayIconBuilder::with_id("pet-tray")
                .icon(app.default_window_icon().cloned().expect("app icon missing"))
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "chat" => {
                        let _ = open_panel(app.clone(), Some("chat".into()));
                    }
                    "settings" => {
                        let _ = open_panel(app.clone(), Some("settings".into()));
                    }
                    "small" | "medium" | "large" | "xlarge" => {
                        let id = event.id.as_ref().to_string();
                        let _ = set_pet_size(app.clone(), id);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                            let _ = window.set_ignore_cursor_events(true);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
        }

        // ---- 跨平台初始化：恢复提醒 + 久坐检测（idle 内部已按平台守卫）+ 番茄钟 ----
        let handle = app.handle().clone();
        storage::restore_reminders(&handle);
        idle::start_watcher(handle.clone());
        pomodoro::start_watcher(handle);

        Ok(())
    });

    // 桌面：完整命令集（窗口操控 / 托盘菜单 / 剪贴板 / 多窗口面板）
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_monitor_info,
        is_cursor_over_pet,
        move_window_by,
        move_window_to,
        get_window_pos,
        set_ignore_cursor,
        set_pet_visible,
        quit_app,
        get_pet_size,
        set_pet_size,
        show_pet_context_menu,
        llm_chat,
        llm_test,
        open_panel,
        tts::tts_speak,
        tts::tts_stop,
        set_sedentary_enabled,
        get_sedentary_enabled,
        pomodoro::pomodoro_start,
        pomodoro::pomodoro_stop,
        pomodoro::pomodoro_set,
        pomodoro::pomodoro_get_state,
        copy_to_clipboard
    ]);

    // 移动端：单窗口模式，仅注册跨平台命令（悬浮宠物由原生 Kotlin Service 负责）
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        quit_app,
        get_pet_size,
        set_pet_size,
        llm_chat,
        llm_test,
        tts::tts_speak,
        tts::tts_stop,
        set_sedentary_enabled,
        get_sedentary_enabled,
        pomodoro::pomodoro_start,
        pomodoro::pomodoro_stop,
        pomodoro::pomodoro_set,
        pomodoro::pomodoro_get_state
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
