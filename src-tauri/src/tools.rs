//! Agent 工具集：schema 定义（原生 function calling）+ 统一执行器
//!
//! 工具列表：
//! - get_current_time  查询当前时间
//! - set_reminder      设置提醒（delay_minutes 或 at=HH:MM）
//! - add_todo          新增待办
//! - list_todo         列出待办
//! - done_todo         完成待办（id 或关键词）
//! - create_note       新建笔记
//! - read_clipboard    读取剪贴板文本

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use chrono::{Datelike, TimeZone};

use crate::storage;

/* ================= 工具 schema（OpenAI tools 协议） ================= */

pub fn tool_schemas() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "get_current_time",
                "description": "获取当前日期时间与星期",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "set_reminder",
                "description": "设置一个定时提醒。delay_minutes 与 at 二选一。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "message": { "type": "string", "description": "提醒内容" },
                        "delay_minutes": { "type": "number", "description": "多少分钟后提醒（与 at 二选一）" },
                        "at": { "type": "string", "description": "HH:MM 格式的今天/明天时刻（24 小时制，与 delay_minutes 二选一）" }
                    },
                    "required": ["message"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "add_todo",
                "description": "新增一条待办事项",
                "parameters": {
                    "type": "object",
                    "properties": { "text": { "type": "string", "description": "待办内容" } },
                    "required": ["text"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_todo",
                "description": "列出所有待办事项",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "done_todo",
                "description": "把一条待办标记为完成。id 与 keyword 二选一，keyword 是待办文字中包含的关键词。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "number", "description": "待办 id" },
                        "keyword": { "type": "string", "description": "待办关键词" }
                    },
                    "required": []
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "create_note",
                "description": "记录一条快速笔记（备忘）",
                "parameters": {
                    "type": "object",
                    "properties": { "text": { "type": "string", "description": "笔记内容" } },
                    "required": ["text"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_clipboard",
                "description": "读取当前剪贴板中的文本内容",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        }
    ])
}

/* ================= 执行器 ================= */

/// 执行工具，返回给 LLM 的结果 JSON；副作用事件在此统一广播
pub fn execute(app: &AppHandle, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "get_current_time" => {
            let now = chrono::Local::now();
            let weekday = match now.weekday() {
                chrono::Weekday::Mon => "周一",
                chrono::Weekday::Tue => "周二",
                chrono::Weekday::Wed => "周三",
                chrono::Weekday::Thu => "周四",
                chrono::Weekday::Fri => "周五",
                chrono::Weekday::Sat => "周六",
                chrono::Weekday::Sun => "周日",
            };
            Ok(json!({
                "now": now.format("%Y-%m-%d %H:%M:%S").to_string(),
                "weekday": weekday
            }))
        }
        "set_reminder" => {
            let message = args
                .get("message")
                .and_then(|v| v.as_str())
                .ok_or("缺少 message")?;
            let at_ts = parse_target_ts(args)?;
            let r = storage::add_reminder(app, message, at_ts)?;
            let local = chrono::Local
                .timestamp_opt(r.at_ts, 0)
                .single()
                .map(|t| t.format("%H:%M").to_string())
                .unwrap_or_default();
            Ok(json!({ "ok": true, "id": r.id, "will_fire_at": local }))
        }
        "add_todo" => {
            let text = args.get("text").and_then(|v| v.as_str()).ok_or("缺少 text")?;
            let t = storage::add_todo(app, text)?;
            Ok(json!({ "ok": true, "id": t.id, "text": t.text }))
        }
        "list_todo" => {
            let items = storage::list_todo(app);
            let unfinished: Vec<&storage::Todo> = items.iter().filter(|t| !t.done).collect();
            Ok(json!({ "items": unfinished, "unfinished_count": unfinished.len() }))
        }
        "done_todo" => {
            let id = args.get("id").and_then(|v| v.as_u64());
            let keyword = args.get("keyword").and_then(|v| v.as_str());
            let text = storage::done_todo(app, id, keyword)?;
            // 广播给宠物前端：任务完成 → 庆祝 + 心情 +10
            let _ = app.emit("pet-tool", json!({ "tool": "done_todo", "text": text }));
            Ok(json!({ "ok": true, "completed": text }))
        }
        "create_note" => {
            let text = args.get("text").and_then(|v| v.as_str()).ok_or("缺少 text")?;
            let id = storage::add_note(app, text)?;
            Ok(json!({ "ok": true, "id": id }))
        }
        "read_clipboard" => {
            #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
            {
                let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
                let text = cb.get_text().map_err(|e| format!("剪贴板不可用: {e}"))?;
                let truncated: String = text.chars().take(2000).collect();
                Ok(json!({ "text": truncated }))
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
            {
                Err("当前平台不支持剪贴板".into())
            }
        }
        _ => Err(format!("未知工具: {name}")),
    }
}

/// 解析提醒目标时间：delay_minutes 或 at（HH:MM，已过则算明天）
fn parse_target_ts(args: &Value) -> Result<i64, String> {
    let now = chrono::Local::now();
    if let Some(mins) = args.get("delay_minutes").and_then(|v| v.as_f64()) {
        if !(0.1..=60.0 * 24.0 * 30.0).contains(&mins) {
            return Err("delay_minutes 超出范围".into());
        }
        return Ok((now + chrono::Duration::milliseconds((mins * 60_000.0) as i64)).timestamp());
    }
    if let Some(at) = args.get("at").and_then(|v| v.as_str()) {
        let parts: Vec<&str> = at.split(':').collect();
        if parts.len() != 2 {
            return Err("at 格式应为 HH:MM".into());
        }
        let h: u32 = parts[0].trim().parse().map_err(|_| "小时解析失败")?;
        let m: u32 = parts[1].trim().parse().map_err(|_| "分钟解析失败")?;
        if h > 23 || m > 59 {
            return Err("at 时间不合法".into());
        }
        let today = now.date_naive().and_hms_opt(h, m, 0).ok_or("时间构造失败")?;
        let target = today.and_local_timezone(now.timezone()).single().ok_or("时区转换失败")?;
        let ts = target.timestamp();
        // 已过 → 明天同时刻
        if ts <= now.timestamp() {
            return Ok(ts + 86_400);
        }
        return Ok(ts);
    }
    Err("需要 delay_minutes 或 at".into())
}
