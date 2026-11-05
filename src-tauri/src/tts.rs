//! M4：双通道 TTS —— 在线（msedge-tts，Edge 神经语音）+ 本地兜底（PowerShell SAPI）
//!
//! mode:
//! - "auto"（默认）：先云端合成（12s 超时），失败/超时自动转本地
//! - "cloud"：仅在线，失败即报错
//! - "local"：仅本地（Windows）
//!
//! 云端返回 base64 mp3，由前端 Web Audio 播放；
//! 本地由 PowerShell 直接播放，子进程结束后广播 pet-speaking {on:false}。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CLOUD_TIMEOUT_SECS: u64 = 12;

/// 本地 TTS 子进程 pid（0 = 无）
static LOCAL_PID: AtomicU32 = AtomicU32::new(0);
/// 缓存晓晓音色（首次联网拉取音色列表，之后离线复用）
static VOICE: OnceLock<msedge_tts::voice::Voice> = OnceLock::new();

/// 依赖图中 rustls 的 ring 与 aws-lc-rs 后端并存时无法自动选择，
/// 不安装默认 Provider 会导致 msedge-tts 建立 WebSocket 时 panic（在线语音不可用）。
fn ensure_crypto_provider() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[derive(Serialize)]
pub struct SpeakResult {
    /// 实际使用的通道："cloud" | "local"
    pub engine: String,
    /// 云端合成时为 base64 mp3；本地播放为 None（后端已直接发声）
    pub audio: Option<String>,
}

/// 朗读文本。mode 缺省视为 auto。
#[tauri::command]
pub async fn tts_speak(
    app: AppHandle,
    text: String,
    mode: Option<String>,
) -> Result<SpeakResult, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("朗读内容为空".into());
    }
    ensure_crypto_provider();

    match mode.as_deref().unwrap_or("auto") {
        "local" => {
            speak_local(app, &text).map(|_| SpeakResult { engine: "local".into(), audio: None })
        }
        "cloud" => {
            let audio = speak_cloud(&text).await?;
            Ok(SpeakResult { engine: "cloud".into(), audio: Some(audio) })
        }
        // auto：云端优先，失败/超时回退本地
        _ => {
            match tokio::time::timeout(
                std::time::Duration::from_secs(CLOUD_TIMEOUT_SECS),
                speak_cloud(&text),
            )
            .await
            {
                Ok(Ok(audio)) => Ok(SpeakResult { engine: "cloud".into(), audio: Some(audio) }),
                _ => {
                    speak_local(app, &text)
                        .map(|_| SpeakResult { engine: "local".into(), audio: None })
                }
            }
        }
    }
}

/// 停止本地 TTS 播放（云端播放由前端停止音频元素）
#[tauri::command]
pub fn tts_stop() {
    #[cfg(windows)]
    {
        let pid = LOCAL_PID.swap(0, Ordering::SeqCst);
        if pid != 0 {
            kill_pid(pid);
        }
    }
    #[cfg(not(windows))]
    {
        LOCAL_PID.store(0, Ordering::SeqCst);
    }
}

/* ================= 云端通道 ================= */

async fn get_voice() -> Result<&'static msedge_tts::voice::Voice, String> {
    if let Some(v) = VOICE.get() {
        return Ok(v);
    }
    let voices = msedge_tts::voice::tokio_runtime::get_voices_list_async()
        .await
        .map_err(|e| format!("获取音色列表失败: {e}"))?;
    let voice = voices
        .into_iter()
        .find(|v| v.name.contains("XiaoxiaoNeural"))
        .ok_or("未找到晓晓音色")?;
    let _ = VOICE.set(voice);
    Ok(VOICE.get().unwrap())
}

async fn speak_cloud(text: &str) -> Result<String, String> {
    let voice = get_voice().await?;
    let config = msedge_tts::tts::SpeechConfig::from(voice);
    let mut client = msedge_tts::tts::client::tokio_runtime::connect_async()
        .await
        .map_err(|e| format!("TTS 连接失败: {e}"))?;
    let audio = client
        .synthesize(text, &config)
        .await
        .map_err(|e| format!("TTS 合成失败: {e}"))?;
    if audio.audio_bytes.is_empty() {
        return Err("TTS 返回空音频".into());
    }
    Ok(B64.encode(&audio.audio_bytes))
}

/* ================= 本地通道（PowerShell System.Speech） ================= */

#[cfg(windows)]
fn speak_local(app: AppHandle, text: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    // System.Speech 同步朗读；单引号转义防脚本注入
    let escaped = text.replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName System.Speech; \
         $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
         $s.SetOutputToDefaultAudioDevice(); $s.Rate = 1; $s.Speak('{}')",
        escaped
    );
    // -EncodedCommand 要求 UTF-16LE 字节流的 base64
    let utf16le: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let encoded = B64.encode(utf16le);

    let mut child = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-EncodedCommand",
            &encoded,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("本地 TTS 启动失败: {e}"))?;

    let pid = child.id();
    LOCAL_PID.store(pid, Ordering::SeqCst);

    // 播放结束（含被停止）后广播说话状态结束
    std::thread::spawn(move || {
        let _ = child.wait();
        LOCAL_PID
            .compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst)
            .ok();
        let _ = app.emit("pet-speaking", serde_json::json!({ "on": false }));
    });

    Ok(())
}

#[cfg(not(windows))]
fn speak_local(_app: AppHandle, _text: &str) -> Result<(), String> {
    Err("本地 TTS 仅支持 Windows".into())
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F", "/T"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}
