fn main() {
    // 传入插件的全部 #[tauri::command] 命令名，用于自动生成 ACL 权限
    // android_path 让 tauri-cli 识别插件的 Android 工程，自动注册到 Gradle 并合并 Manifest
    tauri_plugin::Builder::new(&["start", "stop", "is_running", "open_overlay_settings"])
        .android_path("android")
        .build()
}
