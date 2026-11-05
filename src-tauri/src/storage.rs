//! 提醒 / 待办 / 笔记 的本地 JSON 存储 + 提醒定时器
//!
//! 文件保存在应用配置目录：
//! - reminders.json  提醒
//! - todos.json      待办
//! - notes.json      笔记

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/* ================= 数据结构 ================= */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reminder {
    pub id: u64,
    pub message: String,
    /// 触发时间（Unix 秒）
    pub at_ts: i64,
    pub created_ts: i64,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Todo {
    pub id: u64,
    pub text: String,
    pub done: bool,
    pub created_ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: u64,
    pub text: String,
    pub created_ts: i64,
}

/* ================= 通用 JSON 文件存取 ================= */

fn data_path(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

fn load<T: for<'de> Deserialize<'de> + Default>(app: &AppHandle, name: &str) -> T {
    std::fs::read_to_string(data_path(app, name).unwrap_or_default())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save<T: Serialize>(app: &AppHandle, name: &str, val: &T) -> Result<(), String> {
    let path = data_path(app, name)?;
    let s = serde_json::to_string_pretty(val).map_err(|e| e.to_string())?;
    std::fs::write(&path, s).map_err(|e| e.to_string())
}

/// 自增 ID 容器：所有列表文件共用结构
#[derive(Debug, Serialize, Deserialize)]
struct IdStore<T> {
    next_id: u64,
    items: Vec<T>,
}

// 手动实现，避免对 T 强加 Default 约束
impl<T> Default for IdStore<T> {
    fn default() -> Self {
        Self { next_id: 0, items: Vec::new() }
    }
}

impl<T> IdStore<T> {
    fn alloc(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }
}

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

/* ================= 待办 ================= */

pub fn add_todo(app: &AppHandle, text: &str) -> Result<Todo, String> {
    let mut store: IdStore<Todo> = load(app, "todos.json");
    let todo = Todo {
        id: store.alloc(),
        text: text.to_string(),
        done: false,
        created_ts: now_ts(),
    };
    store.items.push(todo.clone());
    save(app, "todos.json", &store)?;
    Ok(todo)
}

pub fn list_todo(app: &AppHandle) -> Vec<Todo> {
    let store: IdStore<Todo> = load(app, "todos.json");
    store.items
}

/// 完成待办：按 id 或关键词匹配第一条未完成项；返回完成的文本
pub fn done_todo(app: &AppHandle, id: Option<u64>, keyword: Option<&str>) -> Result<String, String> {
    let mut store: IdStore<Todo> = load(app, "todos.json");
    let item = store
        .items
        .iter_mut()
        .find(|t| {
            if t.done {
                return false;
            }
            match id {
                Some(i) => t.id == i,
                None => keyword
                    .map(|k| t.text.contains(k))
                    .unwrap_or(false),
            }
        })
        .ok_or("没有找到匹配的未完成待办")?;
    item.done = true;
    let text = item.text.clone();
    save(app, "todos.json", &store)?;
    Ok(text)
}

/* ================= 笔记 ================= */

pub fn add_note(app: &AppHandle, text: &str) -> Result<u64, String> {
    let mut store: IdStore<Note> = load(app, "notes.json");
    let id = store.alloc();
    store.items.push(Note {
        id,
        text: text.to_string(),
        created_ts: now_ts(),
    });
    save(app, "notes.json", &store)?;
    Ok(id)
}

/* ================= 提醒 ================= */

#[derive(Debug, Clone, Serialize)]
pub struct ScheduledReminder {
    pub id: u64,
    pub message: String,
    pub at_ts: i64,
}

/// 新增提醒并调度（返回调度信息）
pub fn add_reminder(app: &AppHandle, message: &str, at_ts: i64) -> Result<ScheduledReminder, String> {
    let mut store: IdStore<Reminder> = load(app, "reminders.json");
    let id = store.alloc();
    let r = ScheduledReminder {
        id,
        message: message.to_string(),
        at_ts,
    };
    store.items.push(Reminder {
        id,
        message: message.to_string(),
        at_ts,
        created_ts: now_ts(),
        done: false,
    });
    save(app, "reminders.json", &store)?;

    spawn_reminder_task(app.clone(), id, message.to_string(), at_ts);
    Ok(r)
}

/// 启动时恢复：未过期 → 继续调度；已过期 → 任务内立即触发
pub fn restore_reminders(app: &AppHandle) {
    let store: IdStore<Reminder> = load(app, "reminders.json");
    for r in store.items.iter().filter(|r| !r.done) {
        spawn_reminder_task(app.clone(), r.id, r.message.clone(), r.at_ts);
    }
}

/// 调度单个提醒任务：到点后标记完成并广播事件
fn spawn_reminder_task(app: AppHandle, id: u64, message: String, at_ts: i64) {
    tauri::async_runtime::spawn(async move {
        let now = now_ts();
        if at_ts > now {
            tokio::time::sleep(std::time::Duration::from_secs((at_ts - now) as u64)).await;
        }
        // 标记完成
        {
            let mut store: IdStore<Reminder> = load(&app, "reminders.json");
            if let Some(item) = store.items.iter_mut().find(|r| r.id == id) {
                item.done = true;
            }
            let _ = save(&app, "reminders.json", &store);
        }
        let _ = app.emit("pet-reminder", serde_json::json!({ "id": id, "message": message }));
    });
}
