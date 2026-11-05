package com.petfloat.plugin

import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.WindowManager
import android.view.animation.AccelerateInterpolator
import kotlin.math.roundToInt

/**
 * 悬浮桌宠前台服务。
 * 通过 WindowManager.addView + TYPE_APPLICATION_OVERLAY 在任意界面上层显示宠物；
 * 前台通知用于满足 Android 8+ 后台运行要求（manifest 声明 specialUse 类型）。
 */
class PetFloatService : Service() {

  companion object {
    const val EXTRA_SPRITE_HEIGHT = "spriteHeight" // 精灵高度（dp），<=0 时用默认值
    private const val CHANNEL_ID = "pet_float_channel"
    private const val NOTIFICATION_ID = 1001
    private const val DEFAULT_HEIGHT_DP = 96f
    private const val MARGIN_X_DP = 12f
    private const val REST_Y_DP = 16f // 落地停靠时距屏幕底部的距离

    @Volatile
    var isRunning = false
      private set
  }

  private lateinit var windowManager: WindowManager
  private lateinit var params: WindowManager.LayoutParams
  private var petView: FloatingPetView? = null
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    startForeground(NOTIFICATION_ID, buildNotification())
    windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // 无悬浮窗权限直接退出（正常流程在插件层已拦截并引导授权）
    if (!Settings.canDrawOverlays(this)) {
      stopSelf()
      return START_NOT_STICKY
    }
    val heightDp = intent?.getFloatExtra(EXTRA_SPRITE_HEIGHT, 0f) ?: 0f
    val heightPx = dpToPx(if (heightDp > 0f) heightDp else DEFAULT_HEIGHT_DP)
    showPet(heightPx)
    return START_STICKY
  }

  private fun showPet(heightPx: Int) {
    val existing = petView
    if (existing != null) {
      existing.setSpriteHeight(heightPx)
      return
    }

    petView = FloatingPetView(
      this,
      heightPx,
      object : FloatingPetView.Callbacks {
        override fun onDragBy(dx: Float, dy: Float) {
          params.x += dx.roundToInt()
          // gravity=BOTTOM 时 y 为距底边的向上偏移，与触摸 dy 方向相反
          params.y -= dy.roundToInt()
          clampPosition()
          safeUpdateLayout()
        }

        override fun onTap() {
          launchApp()
        }

        override fun onDropped(onLanded: () -> Unit) {
          animateFallTo(onLanded)
        }
      },
    )

    params = WindowManager.LayoutParams(
      WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.WRAP_CONTENT,
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
      } else {
        @Suppress("DEPRECATION")
        WindowManager.LayoutParams.TYPE_PHONE
      },
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
      PixelFormat.TRANSLUCENT,
    )
    params.gravity = Gravity.BOTTOM or Gravity.START
    params.x = dpToPx(MARGIN_X_DP)
    params.y = dpToPx(REST_Y_DP)

    windowManager.addView(petView, params)
    isRunning = true
  }

  /** 松手后从当前位置落到屏幕底部停靠位（模拟重力加速） */
  private fun animateFallTo(onLanded: () -> Unit) {
    val from = params.y.toFloat()
    val to = dpToPx(REST_Y_DP).toFloat()
    // 已在底部附近：直接吸附
    if (from - to <= dpToPx(2f)) {
      params.y = to.roundToInt()
      safeUpdateLayout()
      mainHandler.post { onLanded() }
      return
    }
    val distanceDp = (from - to) / resources.displayMetrics.density
    val duration = (350 + distanceDp * 3).toLong().coerceIn(350, 900)
    val anim = ValueAnimator.ofFloat(from, to)
    anim.duration = duration
    anim.interpolator = AccelerateInterpolator(1.6f)
    anim.addUpdateListener { a ->
      params.y = (a.animatedValue as Float).roundToInt()
      safeUpdateLayout()
    }
    anim.addListener(object : AnimatorListenerAdapter() {
      override fun onAnimationEnd(animation: android.animation.Animator) {
        mainHandler.post { onLanded() }
      }
    })
    anim.start()
  }

  /** 限制悬浮窗不漂出屏幕 */
  private fun clampPosition() {
    val metrics = resources.displayMetrics
    val view = petView ?: return
    val w = view.measuredWidth
    val h = view.measuredHeight
    params.x = params.x.coerceIn(0, (metrics.widthPixels - w).coerceAtLeast(0))
    params.y = params.y.coerceIn(-h / 2, (metrics.heightPixels - h / 2).coerceAtLeast(0))
  }

  private fun safeUpdateLayout() {
    val view = petView ?: return
    try {
      windowManager.updateViewLayout(view, params)
    } catch (_: Exception) {
      // 窗口已移除等场景，忽略
    }
  }

  /** 点击宠物 → 打开应用主窗口（持有悬浮窗权限可从后台启动 Activity） */
  private fun launchApp() {
    val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    startActivity(intent)
  }

  override fun onDestroy() {
    isRunning = false
    try {
      petView?.let { windowManager.removeView(it) }
    } catch (_: Exception) {
    }
    petView?.release()
    petView = null
    mainHandler.removeCallbacksAndMessages(null)
    super.onDestroy()
  }

  private fun buildNotification(): Notification {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "悬浮桌宠", NotificationManager.IMPORTANCE_LOW).apply {
          setShowBadge(false)
        },
      )
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setContentTitle("皮皮正在陪着你")
      .setContentText("点按这里回到应用，可在设置中关闭悬浮宠物")
      .setSmallIcon(android.R.drawable.ic_menu_myplaces)
      .setOngoing(true)
      .setContentIntent(pendingOpenApp())
      .build()
  }

  private fun pendingOpenApp(): PendingIntent? {
    val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    return PendingIntent.getActivity(
      this,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun dpToPx(dp: Float): Int = (dp * resources.displayMetrics.density + 0.5f).toInt()
}
