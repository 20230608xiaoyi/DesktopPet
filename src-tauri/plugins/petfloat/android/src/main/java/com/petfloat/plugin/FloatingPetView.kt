package com.petfloat.plugin

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.animation.OvershootInterpolator
import java.util.Random
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * 悬浮宠物渲染与手势视图。
 * 复刻桌面端前端逻辑：
 * - 单帧 PNG 按状态切换（帧优先级：拖拽/点击开心 > 长按抚摸 > 眨眼 > 站立）
 * - 随机眨眼：2.8~5.5 秒间隔，每次闪 160ms
 * - squash & stretch：点击弹跳、落地压扁
 * - 拖拽（由 Service updateViewLayout 完成窗口移动）+ 松手落地动画
 * - 底部椭圆软阴影（悬浮时变小变淡）
 */
class FloatingPetView(
  context: Context,
  private var spriteHeightPx: Int,
  private val callbacks: Callbacks,
) : View(context) {

  interface Callbacks {
    /** 拖拽位移（原始像素） */
    fun onDragBy(dx: Float, dy: Float)

    /** 单击（未拖动）→ 打开应用 */
    fun onTap()

    /** 松手 → Service 播放落地动画，结束时回调 */
    fun onDropped(onLanded: () -> Unit)
  }

  companion object {
    // 帧素材（assets/pet/ 下），值为源 PNG 实际宽高，用于计算显示比例
    private val FRAMES = linkedMapOf(
      "idle" to intArrayOf(1222, 1240),
      "blink" to intArrayOf(1217, 1242),
      "click_happy" to intArrayOf(1333, 1264),
      "pet_stroke" to intArrayOf(1001, 1142),
    )
    private const val BLINK_MIN_MS = 2800L
    private const val BLINK_MAX_MS = 5500L
    private const val BLINK_MS = 160L
    private const val HAPPY_MS = 1200L
    private const val LAND_MS = 500L
    private const val LONG_PRESS_MS = 450L
    private const val SHADOW_H_DP = 7f
    private const val GAP_DP = 6f // 精灵脚底与阴影的间距
  }

  private val handler = Handler(Looper.getMainLooper())
  private val density = resources.displayMetrics.density
  private val random = Random()

  private val frameBmps = HashMap<String, Bitmap>()
  private var scale = 1f
  private var viewW = 1
  private var viewH = 1

  // 渲染状态
  private var blinking = false
  private var airborne = false // 拖拽/下落中
  private var stroking = false // 长按抚摸中
  private var happyUntil = 0L
  private var shadowScale = 1f

  private val shadowPaint = Paint(Paint.ANTI_ALIAS_FLAG)

  // 手势状态
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
  private var downRawX = 0f
  private var downRawY = 0f
  private var lastRawX = 0f
  private var lastRawY = 0f
  private var dragging = false
  private val longPressRunnable = Runnable {
    if (!dragging && !airborne) {
      stroking = true
      invalidate()
    }
  }

  private val blinkRunnable = object : Runnable {
    override fun run() {
      blinking = true
      invalidate()
      handler.postDelayed(
        {
          blinking = false
          invalidate()
          handler.postDelayed(this, nextBlinkDelay())
        },
        BLINK_MS,
      )
    }
  }

  init {
    computeSize()
    loadFrames()
  }

  /* ---- 素材加载 ---- */

  private fun loadFrames() {
    for ((name, wh) in FRAMES) {
      frameBmps[name] = decodeAsset("pet/$name.png", wh)
    }
  }

  /** 按显示高度解码，inSampleSize 降采样省内存 */
  private fun decodeAsset(path: String, original: IntArray): Bitmap {
    val targetH = (original[1] * scale).roundToInt().coerceAtLeast(1)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.assets.open(path).use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (bounds.outHeight / (sample * 2) >= targetH) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    return context.assets.open(path).use { BitmapFactory.decodeStream(it, null, opts) }
      ?: Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
  }

  /** 调整精灵显示高度（设置页改大小后重新解码） */
  fun setSpriteHeight(heightPx: Int) {
    spriteHeightPx = heightPx
    computeSize()
    frameBmps.values.forEach { if (!it.isRecycled) it.recycle() }
    frameBmps.clear()
    loadFrames()
    requestLayout()
    invalidate()
  }

  /* ---- 尺寸 ---- */

  private fun computeSize() {
    val idleH = FRAMES["idle"]!![1].toFloat()
    scale = spriteHeightPx / idleH
    viewW = FRAMES.values.maxOf { (it[0] * scale).roundToInt() }.coerceAtLeast(1)
    val shadowH = (SHADOW_H_DP * density).roundToInt()
    val gap = (GAP_DP * density).roundToInt()
    viewH = spriteHeightPx + gap + shadowH
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(viewW, viewH)
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    // squash 变形以底部中心为轴（脚踩地面效果）
    pivotX = w / 2f
    pivotY = h.toFloat()
  }

  /* ---- 帧优先级（与桌面端前端一致） ---- */

  private fun currentFrame(): String = when {
    airborne || SystemClock.uptimeMillis() < happyUntil -> "click_happy"
    stroking -> "pet_stroke"
    blinking -> "blink"
    else -> "idle"
  }

  /* ---- 绘制 ---- */

  override fun onDraw(canvas: Canvas) {
    val name = currentFrame()
    val bmp = frameBmps[name] ?: return
    val wh = FRAMES[name] ?: return
    val drawW = wh[0] * scale
    val drawH = wh[1] * scale
    val left = (viewW - drawW) / 2f
    val gap = GAP_DP * density
    val shadowH = SHADOW_H_DP * density
    val top = viewH - gap - shadowH - drawH

    drawShadow(canvas)

    // 缩放变形交给 View 属性（pivot 底部中心），这里只按目标矩形绘制
    canvas.drawBitmap(bmp, null, RectF(left, top, left + drawW, top + drawH), null)
  }

  private fun drawShadow(canvas: Canvas) {
    val shadowH = SHADOW_H_DP * density
    val cx = viewW / 2f
    val cy = viewH - shadowH / 2f
    val rx = viewW * 0.38f * shadowScale
    val ry = shadowH / 2f * shadowScale
    shadowPaint.shader = RadialGradient(
      cx, cy, max(rx, ry),
      intArrayOf(0x59000000, 0x00000000),
      floatArrayOf(0f, 1f),
      Shader.TileMode.CLAMP,
    )
    // 悬浮越高影子越小越淡
    shadowPaint.alpha = if (airborne) 130 else 255
    canvas.drawOval(cx - rx, cy - ry, cx + rx, cy + ry, shadowPaint)
  }

  /* ---- 手势 ---- */

  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downRawX = event.rawX
        downRawY = event.rawY
        lastRawX = downRawX
        lastRawY = downRawY
        dragging = false
        stroking = false
        handler.postDelayed(longPressRunnable, LONG_PRESS_MS)
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        val dx = event.rawX - lastRawX
        val dy = event.rawY - lastRawY
        lastRawX = event.rawX
        lastRawY = event.rawY
        if (!dragging &&
          (abs(event.rawX - downRawX) > touchSlop || abs(event.rawY - downRawY) > touchSlop)
        ) {
          dragging = true
          stroking = false
          airborne = true
          shadowScale = 0.72f
          handler.removeCallbacks(longPressRunnable)
          // 拖起：轻微拉伸
          animate().scaleX(0.95f).scaleY(1.05f).setDuration(110).start()
        }
        if (dragging) {
          callbacks.onDragBy(dx, dy)
          invalidate()
        }
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        handler.removeCallbacks(longPressRunnable)
        if (dragging) {
          dragging = false
          if (event.actionMasked == MotionEvent.ACTION_UP) {
            callbacks.onDropped {
              airborne = false
              shadowScale = 1f
              happyUntil = SystemClock.uptimeMillis() + LAND_MS
              playSquash(1.22f, 0.74f)
              invalidate()
            }
          } else {
            airborne = false
            shadowScale = 1f
            invalidate()
          }
        } else if (event.actionMasked == MotionEvent.ACTION_UP) {
          // 点击：开心 1.2s + 弹跳 + 打开应用
          happyUntil = SystemClock.uptimeMillis() + HAPPY_MS
          stroking = false
          playSquash(1.1f, 0.86f)
          invalidate()
          callbacks.onTap()
        } else {
          stroking = false
          invalidate()
        }
        return true
      }
    }
    return super.onTouchEvent(event)
  }

  /** squash & stretch：先压/拉到目标比例，再带过冲弹回 1:1 */
  private fun playSquash(sx: Float, sy: Float) {
    animate()
      .scaleX(sx).scaleY(sy).setDuration(110)
      .withEndAction {
        animate()
          .scaleX(1f).scaleY(1f)
          .setDuration(220)
          .setInterpolator(OvershootInterpolator(1.8f))
          .start()
      }
      .start()
  }

  /* ---- 眨眼循环 ---- */

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    handler.postDelayed(blinkRunnable, nextBlinkDelay())
  }

  override fun onDetachedFromWindow() {
    handler.removeCallbacksAndMessages(null)
    super.onDetachedFromWindow()
  }

  private fun nextBlinkDelay(): Long =
    BLINK_MIN_MS + random.nextInt((BLINK_MAX_MS - BLINK_MIN_MS).toInt())

  /** 释放位图与回调（Service 销毁时调用） */
  fun release() {
    handler.removeCallbacksAndMessages(null)
    frameBmps.values.forEach { if (!it.isRecycled) it.recycle() }
    frameBmps.clear()
  }
}
