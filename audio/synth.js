/**
 * audio/synth.js — Web Audio API 피아노 신디사이저
 * 모바일 iOS/안드로이드 무음 해제 처리, 동기식 즉시 발음, 정답/오답/효과음 엔진 포함
 */
const Synth = (() => {
  let ctx = null;
  let masterGain = null;

  const BASE_FREQ = 440;
  const A4_MIDI = 69;

  /**
   * AudioContext 인스턴스를 동기적으로 반환하고, suspended 상태인 경우 백그라운드 resume을 시도
   * @returns {AudioContext|null}
   */
  function getContext() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.45;
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  function midiToFreq(midi) {
    return BASE_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
  }

  /**
   * 피아노 ADSR 엔벨로프 + 폴리포닉 사운드를 즉각 동기식으로 재생
   * 안전 룩어헤드 버퍼(5ms)와 시간 역전 방지 클램핑 적용
   * @param {number} midi - MIDI 노트 번호 (B3=59 ~ E5=76)
   * @param {number} duration - 재생 시간 (초)
   * @param {object} opts - { velocity, detune }
   */
  function playNote(midi, duration = 0.5, opts = {}) {
    const c = getContext();
    if (!c) return null;

    const freq = midiToFreq(midi);
    const vel = opts.velocity ?? 0.7;
    const detuneVal = opts.detune ?? 0;

    // 안전 룩어헤드 버퍼 (5ms): 브라우저 DOM 렌더링 등으로 인해 과거 시점으로 평가되어 사운드가 드롭되는 현상 원천 차단
    const now = Math.max(c.currentTime, c.currentTime + 0.005);
    const safeDur = Math.max(0.12, duration);

    // 오실레이터: 메인 톤 (사인) + 따뜻함 (삼각파 미량)
    const osc1 = c.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(freq, now);
    if (detuneVal) osc1.detune.setValueAtTime(detuneVal, now);

    const osc2 = c.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(freq, now);
    if (detuneVal) osc2.detune.setValueAtTime(detuneVal, now);

    // Gain: 개별 노트 벨로시티
    const noteGain = c.createGain();
    noteGain.gain.setValueAtTime(0, now);

    // ADSR 엔벨로프 (시간 역전 방지 클램핑: 모든 스케줄링 시점이 직전 시점보다 최소 5ms 뒤에 위치하도록 강제)
    const attack = 0.008;
    const decay = Math.min(0.12, safeDur * 0.3);
    const sustainLevel = 0.55;
    const release = Math.min(0.2, safeDur * 0.4);

    const tAttack = now + attack;
    const tDecay = Math.max(tAttack + 0.005, now + attack + decay);
    const tSustainEnd = Math.max(tDecay + 0.005, now + safeDur - release);
    const tEnd = Math.max(tSustainEnd + 0.005, now + safeDur);

    noteGain.gain.linearRampToValueAtTime(vel, tAttack);
    noteGain.gain.linearRampToValueAtTime(vel * sustainLevel, tDecay);
    noteGain.gain.setValueAtTime(vel * sustainLevel, tSustainEnd);
    noteGain.gain.linearRampToValueAtTime(0, tEnd);

    // 필터: 약간의 로우패스 (따뜻한 피아노 톤)
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2200 + midi * 30, now);
    filter.Q.setValueAtTime(0.7, now);

    // 이펙터 체인: osc → filter → noteGain → master
    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(noteGain);
    noteGain.connect(masterGain);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(tEnd + 0.05);
    osc2.stop(tEnd + 0.05);

    return { osc1, osc2, noteGain, filter };
  }

  /**
   * 짧은 타격음 (건반 터치 피드백)
   */
  function playKeyTap(midi) {
    const c = getContext();
    if (!c) return;
    const freq = midiToFreq(midi);
    const now = Math.max(c.currentTime, c.currentTime + 0.005);

    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);

    const g = c.createGain();
    g.gain.setValueAtTime(0.28, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    osc.connect(g);
    g.connect(masterGain);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  /**
   * 정답음: 따뜻한 장3화음 아르페지오 상향
   */
  function playCorrect() {
    const c = getContext();
    if (!c) return;
    const now = Math.max(c.currentTime, c.currentTime + 0.005);
    const baseFreq = midiToFreq(60); // C4

    [0, 4, 7].forEach((semitone, i) => {
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(baseFreq * Math.pow(2, semitone / 12), now);

      const g = c.createGain();
      const t = now + i * 0.06;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.22, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

      osc.connect(g);
      g.connect(masterGain);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  }

  /**
   * 오답음: 낮고 거친 디소넌트 버즈
   */
  function playWrong() {
    const c = getContext();
    if (!c) return;
    const now = Math.max(c.currentTime, c.currentTime + 0.005);

    // 디소넌트: 단2도 + 트라이톤 조합
    [1, 6].forEach((semitone) => {
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(midiToFreq(48) * Math.pow(2, semitone / 12), now);

      const g = c.createGain();
      const t = now;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);

      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(600, now);

      osc.connect(filter);
      filter.connect(g);
      g.connect(masterGain);
      osc.start(t);
      osc.stop(t + 0.35);
    });
  }

  /**
   * 멜로디 재생: 배열에 따라 순차적으로 노트 재생
   * @param {Array<{midi:number, duration:number}>} melody
   * @param {function} onNoteEnd - 각 노트 종료 시 호출
   * @returns {number} 총 재생 시간 (초)
   */
  function playMelody(melody, onNoteEnd) {
    if (!melody || melody.length === 0) return 0;
    const c = getContext();
    if (!c) return 0;
    const now = Math.max(c.currentTime, c.currentTime + 0.005);
    let t = 0;

    melody.forEach((note, i) => {
      const noteNow = now + t;
      const dur = note.duration ?? 0.4;

      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(midiToFreq(note.midi), noteNow);

      const osc2 = c.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(midiToFreq(note.midi), noteNow);

      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, noteNow);
      g.gain.linearRampToValueAtTime(0.38, noteNow + 0.015);
      g.gain.linearRampToValueAtTime(0.2, noteNow + 0.12);
      g.gain.setValueAtTime(0.2, Math.max(noteNow + 0.13, noteNow + dur - 0.12));
      g.gain.exponentialRampToValueAtTime(0.001, noteNow + dur);

      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1800 + note.midi * 25, noteNow);

      osc.connect(filter);
      osc2.connect(filter);
      filter.connect(g);
      g.connect(masterGain);

      osc.start(noteNow);
      osc2.start(noteNow);
      osc.stop(noteNow + dur + 0.03);
      osc2.stop(noteNow + dur + 0.03);

      const gap = (note.gap ?? 0.08);
      t += dur + gap;

      setTimeout(() => {
        if (onNoteEnd) onNoteEnd(i, note.midi, dur);
      }, (t - gap) * 1000);
    });

    return t;
  }

  /**
   * 레벨업/클리어 효과음: 상승하는 아르페지오 (neo-pop feel)
   */
  function playLevelUp() {
    const c = getContext();
    if (!c) return;
    const now = Math.max(c.currentTime, c.currentTime + 0.005);
    const base = midiToFreq(52); // B3

    [0, 4, 7, 12].forEach((semitone, i) => {
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base * Math.pow(2, semitone / 12), now);

      const g = c.createGain();
      const t = now + i * 0.08;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(3000, now);

      osc.connect(filter);
      filter.connect(g);
      g.connect(masterGain);
      osc.start(t);
      osc.stop(t + 0.45);
    });
  }

  /**
   * 게임 오버 효과음: 하향 디소넌트
   */
  function playGameOver() {
    const c = getContext();
    if (!c) return;
    const now = Math.max(c.currentTime, c.currentTime + 0.005);
    const base = midiToFreq(50);

    [0, 1, 3, 6, 8].forEach((semitone, i) => {
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(base * Math.pow(2, semitone / 12), now);

      const g = c.createGain();
      const t = now + i * 0.1;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.1, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(800 + i * 200, now);

      osc.connect(filter);
      filter.connect(g);
      g.connect(masterGain);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  }

  /**
   * 콤보 점화 효과음: 짧은 치립
   */
  function playComboFlare() {
    const c = getContext();
    if (!c) return;
    const now = Math.max(c.currentTime, c.currentTime + 0.005);
    const freq = midiToFreq(72);

    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.linearRampToValueAtTime(freq * 1.5, now + 0.12);

    const g = c.createGain();
    g.gain.setValueAtTime(0.15, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(g);
    g.connect(masterGain);
    osc.start(now);
    osc.stop(now + 0.18);
  }

  return {
    getContext,
    playNote,
    playKeyTap,
    playCorrect,
    playWrong,
    playMelody,
    playLevelUp,
    playGameOver,
    playComboFlare,
    midiToFreq,
  };
})();

// export for production (ES Modules)
if (typeof exportModules === 'function') {
  exportModules('synth', Synth);
}
window.Synth = Synth;

export { Synth };
