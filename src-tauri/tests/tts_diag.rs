//! 回归测试：在线 TTS 云端链路（音色列表 → WebSocket → 合成）
//! 前置：需手动安装 rustls 默认 CryptoProvider（与应用 tts::ensure_crypto_provider 相同），
//! 否则依赖图中 ring 与 aws-lc-rs 并存会导致 rustls panic。

use msedge_tts::tts::SpeechConfig;
use msedge_tts::voice;

#[tokio::test]
async fn cloud_tts_synthesize() {
    // 与应用 tts.rs 中 ensure_crypto_provider 相同的修复
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();

    // 1. 音色列表
    let voices = voice::tokio_runtime::get_voices_list_async()
        .await
        .expect("音色列表获取失败");
    assert!(!voices.is_empty(), "音色列表为空");

    // 2. 晓晓音色
    let voice = voices
        .into_iter()
        .find(|v| v.name.contains("XiaoxiaoNeural"))
        .expect("未找到晓晓音色");

    // 3. 连接 + 合成
    let config = SpeechConfig::from(&voice);
    let mut client = msedge_tts::tts::client::tokio_runtime::connect_async()
        .await
        .expect("TTS WebSocket 连接失败");
    let audio = client
        .synthesize("你好，这是在线语音测试。", &config)
        .await
        .expect("TTS 合成失败");
    assert!(!audio.audio_bytes.is_empty(), "返回空音频");
}
