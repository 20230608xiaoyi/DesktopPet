package com.petfloat.plugin

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/// start 命令参数（字段名与 Rust 侧 StartArgs 的 camelCase 序列化对应）
@InvokeArg
class StartArgs {
  var spriteHeight: Float = 0f
}

/**
 * 悬浮桌宠插件 Kotlin 侧入口。
 * 由 Tauri 反射注册；前端通过 invoke("plugin:petfloat|start", ...) 调用，
 * 经 Rust 桥 run_mobile_plugin 转发到这里。
 */
@TauriPlugin
class PetFloatPlugin(private val activity: Activity) : Plugin(activity) {

  /** 开启悬浮桌宠；未授予悬浮窗权限时先引导去系统设置页，并 reject 让前端感知 */
  @Command
  fun start(invoke: Invoke) {
    val args = invoke.parseArgs(StartArgs::class.java)
    if (!Settings.canDrawOverlays(activity)) {
      openOverlaySettings()
      invoke.reject("OVERLAY_PERMISSION_REQUIRED")
      return
    }
    val intent = Intent(activity, PetFloatService::class.java)
    intent.putExtra(PetFloatService.EXTRA_SPRITE_HEIGHT, args.spriteHeight)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      activity.startForegroundService(intent)
    } else {
      activity.startService(intent)
    }
    invoke.resolve()
  }

  /** 关闭悬浮桌宠（停止前台服务并移除悬浮窗） */
  @Command
  fun stop(invoke: Invoke) {
    activity.stopService(Intent(activity, PetFloatService::class.java))
    invoke.resolve()
  }

  /** 查询悬浮桌宠是否正在运行 */
  @Command
  fun isRunning(invoke: Invoke) {
    val ret = JSObject()
    ret.put("running", PetFloatService.isRunning)
    invoke.resolve(ret)
  }

  /** 打开系统「显示在其他应用上层」设置页（国产 ROM 悬浮窗权限引导） */
  @Command
  fun openOverlaySettings(invoke: Invoke) {
    openOverlaySettings()
    invoke.resolve()
  }

  private fun openOverlaySettings() {
    val intent = Intent(
      Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
      Uri.parse("package:${activity.packageName}"),
    )
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    activity.startActivity(intent)
  }
}
