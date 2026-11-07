# 桌宠 AI 智伴（DesktopPet）

一只住在桌面的 AI 小貔貅"皮皮"。基于 **Tauri 2 + React 19 + TypeScript** 实现，透明置顶、点击穿透，能摸头、能聊天、会记待办设提醒，还会到点催你起来活动。

> 版本：0.4.0

## 功能特性

### 桌面宠物（桌面端）
- **透明无边框置顶窗口**：只占屏幕一小块，`skipTaskbar` 不抢任务栏；光标压在宠物本体上才响应，其余区域点击穿透到下层应用
- **情绪系统**：`joy / happy / calm / bored / sleepy` 五档，由心情值驱动，会随互动、对话情绪、番茄完成、久坐被忽略而变化；困了会冒 Zzz
- **互动**：拖拽移动（带倾斜反馈）、空中松手重力掉落并扬起尘土、悬停摸头、单击跳起冒爱心、双击隐藏宠物
- **摸头连击彩蛋**：8 秒内摸满 4 次触发超开心反应并语音播报
- **细节**：瞳孔跟随鼠标、气泡台词、爱心/星光/尘土/Zzz 粒子特效、位置自动记忆
- **体型切换**：小 180px / 中 240px / 大 300px / 特大 360px
- **右键原生菜单**：聊天、设置、大小、显示/隐藏、退出；系统托盘提供同样的入口
- **开机自启**：首次运行默认开启，之后尊重用户的开关状态

### AI 对话
- 接入**任意 OpenAI 兼容接口**，内置 Ollama / LM Studio / llama.cpp 预设，也可填自定义地址
- **流式输出**：请求由 Rust 侧 `reqwest` 发起，通过 Tauri Channel 逐段回传，桌宠气泡以打字机效果追平
- **人设**：内置"皮皮"小貔貅 system prompt（简短口语、50 字内），支持用户追加自定义设定
- **情绪联动**：模型输出 `<mood>joy</mood>` 等标签，解析后驱动桌宠心情；无标签时用关键词兜底
- **连接测试**：一键测延迟并拉取模型列表
- 支持一键复制回复；聊天记录本地保存最近 300 条，携带最近 16 轮上下文

### Agent 工具（原生 function calling）
模型可调用以下工具完成实际操作，结果回灌后再口语化确认：

| 工具 | 作用 |
| --- | --- |
| `get_current_time` | 查询当前日期、时间与星期 |
| `set_reminder` | 设置提醒（`delay_minutes` 或 `at="HH:MM"`），到点举牌 + 语音播报 |
| `add_todo` / `list_todo` / `done_todo` | 待办增查改，完成时宠物庆祝并加心情 |
| `create_note` | 记录快速笔记 |
| `read_clipboard` | 读取剪贴板文本 |

同时兼容模型直接输出 `<tool>{"name":"...","args":{...}}</tool>` 标签的调用方式。

### 语音播报（TTS）
- **双通道**：在线使用 `msedge-tts`（Edge 神经语音），失败或超时后自动降级到 Windows 本地 SAPI 语音
- 三种模式：`auto`（默认，先云后本地）/ `cloud`（仅在线）/ `local`（仅本地）
- 播放时桌宠有说话律动；新的思考会打断上一段朗读，避免叠音

### 番茄钟
- 计时源在 **Rust 后端**，前端仅消费事件广播，窗口切后台也不会走偏
- 默认 25 分钟专注 + 5 分钟休息，时长可调并本地记忆
- 桌宠头顶显示倒计时胶囊，阶段切换时气泡、动画与语音同步提示

### 久坐提醒
- **Windows**：轮询系统键鼠空闲时间，连续 60 分钟无输入触发提醒（宠物趴下打盹 + 气泡）；再 15 分钟仍无操作则心情 -5，本周期内不再打扰；检测到用户回来即重置
- **Android**：无系统级空闲 API，降级为每 60 分钟固定提醒，并走系统通知
- 设置面板可整体关闭

### Android 悬浮宠物
- 本地 Tauri 插件 `petfloat`：Rust 桥接层 + Kotlin `ForegroundService` 绘制悬浮窗
- 系统通知兜底：WebView 退后台后 JS 定时器暂停，番茄钟与久坐提醒改由 Rust 侧直接发通知

## 技术栈

| 层 | 选型 |
| --- | --- |
| 应用框架 | Tauri 2（多窗口 + 托盘 + 插件） |
| 前端 | React 19、TypeScript、Vite |
| 后端 | Rust 2021，`reqwest` + `rustls`，`tokio` |
| 语音 | `msedge-tts`（在线）/ PowerShell SAPI（本地） |
| 其他 | `arboard`（剪贴板）、`tauri-plugin-autostart`、`tauri-plugin-notification` |

## 目录结构

```
desktop-pet/
├─ src/                     # 前端
│  ├─ App.tsx               # 主窗口：宠物行为、心情、拖拽、事件编排
│  ├─ pet/                  # Pet 渲染、心情引擎、窗口与坐标工具
│  ├─ panel/                # 对话面板（聊天 / 设置）、LLM 调用与人设
│  ├─ tts.ts                # 语音播报前端封装
│  └─ assets/tianlu/        # 宠物立绘
├─ src-tauri/
│  ├─ src/
│  │  ├─ lib.rs             # 窗口/穿透/托盘/菜单 + LLM 流式对话
│  │  ├─ tools.rs           # Agent 工具 schema 与执行器
│  │  ├─ pomodoro.rs        # 番茄钟计时与广播
│  │  ├─ idle.rs            # 久坐检测
│  │  ├─ tts.rs             # 双通道语音
│  │  ├─ storage.rs         # 待办 / 笔记 / 提醒的 JSON 读写
│  │  └─ config.rs          # 宠物大小等配置
│  ├─ plugins/petfloat/     # Android 悬浮宠物插件（Rust + Kotlin）
│  └─ tauri.conf.json       # 窗口、打包、图标配置
└─ package.json
```

## 快速开始

### 环境要求
- Node.js 18+
- Rust stable（含 `cargo`）
- Windows 需 VS Build Tools（C++ 桌面开发）与 WebView2 Runtime
- 构建 Android 另需 Android SDK / NDK 与 JDK

### 安装与运行

```bash
npm install
npm run tauri dev
```

前端单独调试可用 `npm run dev`（Vite 监听 `1420` 端口）。

### 打包

```bash
# 桌面端（Windows 输出 NSIS 安装包，中文界面、当前用户安装）
npm run tauri build

# Android（仓库未包含 gen/android，首次执行会自动生成）
npm run tauri android init
npm run tauri android build
```

> `src-tauri/gen/android`、`src-tauri/target`、`node_modules`、`dist` 以及 apk/安装包等构建产物均已在 `.gitignore` 中排除。

## 使用说明

1. 启动后桌宠出现在屏幕底部，**右键宠物**或**点击托盘图标**打开菜单
2. 进入「设置」页填写模型：
   - 本地模型：选 Ollama（`http://localhost:11434/v1`）/ LM Studio（`http://localhost:1234/v1`）等预设，填模型名
   - 在线服务：填任意 OpenAI 兼容的 `base_url`、模型名与 API Key
   - 可先点「测试连接」确认可用
3. 切到「聊天」页对话；回复会同时出现在面板和桌面气泡里，并驱动心情变化
4. 双击宠物可隐藏，通过托盘菜单重新显示

## 数据存储

- 配置与业务数据（`config.json`、待办、笔记、提醒）以 JSON 文件形式存放在应用配置目录：
  - Windows：`%APPDATA%\com.desktop-pet.ai-companion\`
- LLM 连接配置与聊天记录保存在 WebView `localStorage`；API Key 仅存于本机，不经过任何中转服务

## 已知限制

- 久坐检测依赖 `GetLastInputInfo`，仅 Windows 生效；Android 为固定间隔提醒
- 本地语音兜底（PowerShell SAPI）仅 Windows 可用，macOS / Linux 依赖在线语音
- 在线语音需要联网，首次会拉取音色列表，之后离线复用缓存

## 许可证

本项目采用 [MIT License](LICENSE) 开源，可自由使用、修改、分发与商用，请保留版权声明。
