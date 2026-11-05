import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { WIN_W, WIN_H } from "./core";
import type { Mood } from "./mood";

import idleImg from "../assets/tianlu/idle.png";
import blinkImg from "../assets/tianlu/blink.png";
import clickHappyImg from "../assets/tianlu/click_happy.png";
import sleepImg from "../assets/tianlu/sleep.png";
import petStrokeImg from "../assets/tianlu/pet_stroke.png";

export interface PetHandle {
  /** 点击：歪头开心帧 + squash & stretch 跳跃 */
  excite: () => void;
  /** 落地：压扁回弹 */
  land: () => void;
  /** 抚摸：享受帧（眯眼） */
  pat: () => void;
}

interface PetProps {
  mood: Mood;
  moodValue: number;
  dragging: boolean;
  falling: boolean;
  walking: boolean;
  facing: 1 | -1;
  showMoodBar: boolean;
  /** 对话进行中：开心帧 + 轻微雀跃 */
  chatting: boolean;
  /** 宠物显示高度（像素） */
  spriteHeight: number;
  /** 久坐提醒：趴下打盹 */
  napping: boolean;
  /** M4：TTS 朗读中，驱动说话律动 */
  speaking?: boolean;
}

/** 帧优先级：悬空/点击/聊天 > 抚摸 > 行走 > 睡觉 > 眨眼 > 待机 */
type Frame =
  | "idle"
  | "blink"
  | "click_happy"
  | "sleep"
  | "pet_stroke";

interface FrameInfo {
  src: string;
  ow: number;
  oh: number;
}

/** 裁剪后的原始尺寸（单位：像素） */
const FRAMES: Record<Frame, FrameInfo> = {
  idle: { src: idleImg, ow: 1222, oh: 1240 },
  blink: { src: blinkImg, ow: 1217, oh: 1242 },
  click_happy: { src: clickHappyImg, ow: 1333, oh: 1264 },
  sleep: { src: sleepImg, ow: 1256, oh: 764 },
  pet_stroke: { src: petStrokeImg, ow: 1001, oh: 1142 },
};

/** 底部贴地留白（像素） */
export const SPRITE_BOTTOM = 46;

const Pet = forwardRef<PetHandle, PetProps>(function Pet(
  { mood, moodValue, dragging, falling, walking, facing, showMoodBar, chatting, spriteHeight, napping, speaking },
  ref,
) {
  const [patted, setPatted] = useState(false);
  const [clicked, setClicked] = useState(false);
  const [blinking, setBlinking] = useState(false);
  const patTimer = useRef(0);
  const clickTimer = useRef(0);
  const spriteRef = useRef<HTMLDivElement>(null);
  const squashRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const lastJumpAt = useRef(0);

  // 预加载全部帧，避免首次切帧时闪白
  useEffect(() => {
    Object.values(FRAMES).forEach(({ src }) => {
      const img = new Image();
      img.src = src;
    });
  }, []);

  // 眨眼：随机间隔 2.8~5.5s 闪一帧（160ms），仅待机时生效
  useEffect(() => {
    let openT = 0;
    let closeT = 0;
    const schedule = () => {
      openT = window.setTimeout(() => {
        setBlinking(true);
        closeT = window.setTimeout(() => {
          setBlinking(false);
          schedule();
        }, 160);
      }, 2800 + Math.random() * 2700);
    };
    schedule();
    return () => {
      window.clearTimeout(openT);
      window.clearTimeout(closeT);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    excite() {
      // 歪头开心帧持续 1.2s，跳跃节流防止双击时抽搐
      setClicked(true);
      window.clearTimeout(clickTimer.current);
      clickTimer.current = window.setTimeout(() => setClicked(false), 1200);

      const now = performance.now();
      if (now - lastJumpAt.current < 400) return;
      lastJumpAt.current = now;

      spriteRef.current?.animate(
        [
          { transform: "translateY(0) scale(1, 1)" },
          { transform: "translateY(4px) scale(1.12, 0.86)", offset: 0.14 },
          { transform: "translateY(-52px) scale(0.92, 1.12)", offset: 0.5 },
          { transform: "translateY(0) scale(1, 1)", offset: 0.8 },
          { transform: "translateY(3px) scale(1.1, 0.88)", offset: 0.9 },
          { transform: "translateY(0) scale(1, 1)" },
        ],
        { duration: 900, easing: "cubic-bezier(.4,.1,.5,1)" },
      );
      shadowRef.current?.animate(
        [
          { transform: "scale(1)", opacity: 1 },
          { transform: "scale(1)", opacity: 1, offset: 0.14 },
          { transform: "scale(0.7)", opacity: 0.55, offset: 0.5 },
          { transform: "scale(1)", opacity: 1, offset: 0.8 },
          { transform: "scale(1)", opacity: 1 },
        ],
        { duration: 900, easing: "ease-in-out" },
      );
    },
    land() {
      squashRef.current?.animate(
        [
          { transform: "scale(1, 1)" },
          { transform: "scale(1.22, 0.74)", offset: 0.32 },
          { transform: "scale(0.95, 1.08)", offset: 0.68 },
          { transform: "scale(1, 1)" },
        ],
        { duration: 460, easing: "ease-out" },
      );
      shadowRef.current?.animate(
        [
          { transform: "scale(1.3)", opacity: 0.9 },
          { transform: "scale(1)", opacity: 1 },
        ],
        { duration: 460, easing: "ease-out" },
      );
    },
    pat() {
      setPatted(true);
      window.clearTimeout(patTimer.current);
      patTimer.current = window.setTimeout(() => setPatted(false), 1500);
    },
  }));

  const airborne = dragging || falling;

  const frame: Frame = airborne || clicked || chatting
    ? "click_happy"
    : patted
      ? "pet_stroke"
      : napping || mood === "sleepy"
        ? "sleep"
        : blinking
          ? "blink"
          : "idle";

  const info = FRAMES[frame];
  const scale = spriteHeight / info.oh;
  const renderW = info.ow * scale;
  const renderH = spriteHeight;
  const left = (WIN_W - renderW) / 2;
  const top = WIN_H - SPRITE_BOTTOM - renderH;

  return (
    <div
      className="pet-hit"
      data-mood={mood}
      data-frame={frame}
      data-facing={facing === 1 ? "right" : "left"}
      data-walking={walking}
      data-dragging={dragging}
      data-falling={falling}
      data-speaking={speaking ? "true" : "false"}
      style={{ width: WIN_W, height: WIN_H }}
    >
      {/* 地面阴影（不随朝向翻转） */}
      <div
        ref={shadowRef}
        className="pet-shadow"
        style={{
          left: WIN_W / 2 - 52,
          top: WIN_H - SPRITE_BOTTOM - 6,
          width: 104,
          height: 20,
        }}
      />

      <div ref={squashRef} className="pet-squash">
        <div
          ref={spriteRef}
          className="pet-sprite"
          style={{
            left,
            top,
            width: renderW,
            height: renderH,
          }}
        >
          <img
            className="pet-frame"
            src={info.src}
            alt="tianlu"
            draggable={false}
            width={renderW}
            height={renderH}
          />
        </div>
      </div>

      {/* 心情值（玻璃拟态胶囊，变化时短暂浮现） */}
      {showMoodBar && (
        <div className="pet-mood-bar">
          <svg className="pet-mood-heart" viewBox="0 0 24 24" width="13" height="13">
            <path
              d="M12 21C7 16.5 2 12.5 2 8.5 2 5.5 4.5 3 7.5 3c1.8 0 3.4 1 4.5 2.5C13.1 4 14.7 3 16.5 3 19.5 3 22 5.5 22 8.5c0 4-5 8-10 12.5z"
              fill="#FF6B81"
            />
          </svg>
          <div className="pet-mood-track">
            <div className="pet-mood-fill" style={{ width: `${moodValue}%` }} />
          </div>
        </div>
      )}
    </div>
  );
});

export default Pet;
