/** 宠物心情等级（M1 简化版，M2 接入 LLM 情绪后扩展） */
export type Mood = "joy" | "happy" | "calm" | "bored" | "sleepy";

/** 心情值 0~100，抚摸/点击增加，随时间衰减 */
export class MoodEngine {
  private _value: number;
  private decayTimer: number;

  constructor(initial = 70, private onChange: (value: number, mood: Mood) => void) {
    this._value = initial;
    this.decayTimer = window.setInterval(() => this.decay(), 30_000);
    this.emit();
  }

  /** 当前心情值 */
  get value(): number {
    return this._value;
  }

  /** 当前心情档位 */
  mood(): Mood {
    const v = this._value;
    if (v >= 85) return "joy";
    if (v >= 60) return "happy";
    if (v >= 35) return "calm";
    if (v >= 15) return "bored";
    return "sleepy";
  }

  /** 增减心情（自动钳制 0~100） */
  add(delta: number) {
    this._value = Math.min(100, Math.max(0, this._value + delta));
    this.emit();
  }

  private decay() {
    if (this._value > 0) this.add(-1.5);
  }

  private emit() {
    this.onChange(this._value, this.mood());
  }

  dispose() {
    window.clearInterval(this.decayTimer);
  }
}
