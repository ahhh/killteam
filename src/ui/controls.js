/**
 * Playback clock (§26).
 *
 * Drives the engine's step function on a timer. The clock owns pacing only —
 * it has no opinion about the rules, and instant mode runs the identical
 * steps with the delay removed, so speed never changes the outcome.
 */
export const SPEEDS = {
  1: 900,
  2: 450,
  4: 200,
  0: 0,     // instant
};

export class PlaybackClock {
  /**
   * @param {{onStep:Function, onFinish:Function, onTick:Function}} handlers
   */
  constructor({ onStep, onFinish, onTick }) {
    this.onStep = onStep;
    this.onFinish = onFinish;
    this.onTick = onTick;
    this.speed = 4;
    this.playing = false;
    this._timer = null;
  }

  get delay() {
    return SPEEDS[this.speed] ?? 200;
  }

  setSpeed(speed) {
    this.speed = speed;
    if (this.playing) { this.pause(); this.play(); }
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.onTick?.();
    if (this.delay === 0) {
      // Instant: run to completion without yielding a frame per step.
      let guard = 0;
      while (this.playing && guard++ < 5000) {
        if (this.onStep()?.done) { this._finish(); return; }
      }
      this._finish();
      return;
    }
    this._schedule();
  }

  _schedule() {
    this._timer = setTimeout(() => {
      if (!this.playing) return;
      const result = this.onStep();
      if (result?.done) { this._finish(); return; }
      // A step may stop the clock from inside the handler — semi-manual play
      // suspends an activation to ask the player what it does. Rescheduling
      // regardless would leave a timer behind that fires as soon as playback
      // resumes, and the battle would take two steps for one tick.
      if (!this.playing) return;
      this._schedule();
    }, this.delay);
  }

  pause() {
    this.playing = false;
    clearTimeout(this._timer);
    this._timer = null;
    this.onTick?.();
  }

  /** One step regardless of play state. */
  stepOnce() {
    const result = this.onStep();
    if (result?.done) this._finish();
    return result;
  }

  _finish() {
    this.playing = false;
    clearTimeout(this._timer);
    this._timer = null;
    this.onTick?.();
    this.onFinish?.();
  }

  destroy() {
    this.pause();
  }
}
