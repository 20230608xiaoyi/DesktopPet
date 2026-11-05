import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import Panel from "./panel/Panel";

// 入口分流：
// 桌面端：main = 桌宠本体，panel = 聊天/设置面板
// 移动端：单窗口即聊天/设置面板，悬浮宠物由原生 Kotlin Service 渲染
const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
const Root = isMobile
  ? Panel
  : getCurrentWebviewWindow().label === "panel"
    ? Panel
    : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
