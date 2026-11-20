/**
 * audio/synth.js — Web Audio API 피아노 신디사이저
 * 모바일 iOS 무음 해제 처리, 정답/오답/효과음 엔진 포함
 */
const Synth = (() => {
  let ctx = null;
  let masterGain = null;

  const BASE_FREQ = 440;
  const A4_MIDI = 69;

  async function getContext() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.45;
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    return ctx;
  }

  function midiToFreq(midi) {
    return BASE_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
  }

  /**
   * 피아노 ADSR 엔벨로프 + 폴리포닉 사운드를 재생
   * @param {number} midi - MIDI 노트 번호 (B3=59 ~ E5=76)
   * @param {number} duration - 재생 시간 (초)
   * @param {object} opts - { velocity, detune }
   */
  async function playNote(midi, duration = 0.5, opts = {}) {
    const c = await getContext();
    const freq = midiToFreq(midi);
    const vel = opts.velocity ?? 0.7;
    const detuneVal = opts.detune ?? 0;

    // 오실레이터: 메인 톤 (사인) + 따뜻함 (삼각파 미량)
    const osc1 = c.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = freq;
    osc1.detune.value = detuneVal;

    const osc2 = c.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.value = freq;
    osc2.detune.value = detuneVal;

    // Gain: 개별 노트 벨로시티
    const noteGain = c.createGain();
    noteGain.gain.value = 0;

    // ADSR 엔벨로프
    const now = c.currentTime;
    const attack = 0.008;
    const decay = 0.15;
    const sustainLevel = 0.55;
    const release = Math.min(duration * 0.55, 0.3);

    noteGain.gain.setValueAtTime(0, now);
    noteGain.gain.linearRampToValueAtTime(vel, now + attack);
    noteGain.gain.linearRampToValueAtTime(vel * sustainLevel, now + attack + decay);
    noteGain.gain.setValueAtTime(vel * sustainLevel, now + duration - release);
    noteGain.gain.linearRampToValueAtTime(0, now + duration);

    // 필터: 약간의 로우패스 (따뜻함)
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2200 + midi * 30;
    filter.Q.value = 0.7;

    // 이펙터 체인: osc → filter → noteGain → master
    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(noteGain);
    noteGain.connect(masterGain);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + duration + 0.05);
    osc2.stop(now + duration + 0.05);

    return { osc1, osc2, noteGain, filter };
  }

  /**
   * 짧은 타격음 (건반 터치 피드백)
   */
  async function playKeyTap(midi) {
    const c = await getContext();
    const freq = midiToFreq(midi);
    const now = c.currentTime;

    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

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
  async function playCorrect() {
    const c = await getContext();
    const now = c.currentTime;
    const baseFreq = midiToFreq(60); // C4

    [0, 4, 7].forEach((semitone, i) => {
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = baseFreq * Math.pow(2, semitone / 12);

      const g = c.createGain();
      const t = now + i * 0.06;
      g.gain.setValueAtTime(0, t);
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
  async function playWrong() {
    const c = await getContext();
    const now = c.currentTime;

    // 디소넌트: 단2도 + 트라이톤 조합
    [1, 6].forEach((semitone) => {
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = midiToFreq(48) * Math.pow(2, semitone / 12);

      const g = c.createGain();
      const t = now;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);

      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 600;

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
  async function playMelody(melody, onNoteEnd) {
    if (!melody || melody.length === 0) return 0;
    const c = await getContext();
    const now = c.currentTime;
    let t = 0;

    melody.forEach((note, i) => {
      const noteNow = now + t;
      const dur = note.duration ?? 0.4;

      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = midiToFreq(note.midi);

      const osc2 = c.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.value = midiToFreq(note.midi);

      const g = c.createGain();
      g.gain.setValueAtTime(0, noteNow);
      g.gain.linearRampToValueAtTime(0.38, noteNow + 0.015);
      g.gain.linearRampToValueAtTime(0.2, noteNow + 0.12);
      g.gain.setValueAtTime(0.2, noteNow + dur - 0.12);
      g.gain.exponentialRampToValueAtTime(0.001, noteNow + dur);

      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1800 + note.midi * 25;

      osc.connect(filter);
      osc2.connect(filter);
      filter.connect(g);
      g.connect(masterGain);

      osc.start(noteNow);
      osc2.start(noteNow);
      osc.stop(noteNow + dur + 0.03);
      osc2.stop(noteNow + dur + 0.03);

      // 다음 노트까지의 오프셋 (노트 간 간격 포함)
      const gap = (note.gap ?? 0.08);
      t += dur + gap;

      // 노트 종료 콜백 (비동기로 예약)
      const endTimer = setTimeout(() => {
        if (onNoteEnd) onNoteEnd(i, note.midi, dur);
      }, (t - gap) * 1000);
    });

    return t;
  }

  /**
   * 레벨업/클리어 효과음: 상승하는 아르페지오 (neo-pop feel)
   */
  async function playLevelUp() {
    const c = await getContext();
    const now = c.currentTime;
    const base = midiToFreq(52); // B3

    [0, 4, 7, 12].forEach((semitone, i) => {
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = base * Math.pow(2, semitone / 12);

      const g = c.createGain();
      const t = now + i * 0.08;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 3000;

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
  async function playGameOver() {
    const c = await getContext();
    const now = c.currentTime;
    const base = midiToFreq(50);

    [0, 1, 3, 6, 8].forEach((semitone, i) => {
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = base * Math.pow(2, semitone / 12);

      const g = c.createGain();
      const t = now + i * 0.1;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.1, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 800 + i * 200;

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
  async function playComboFlare() {
    const c = await getContext();
    const now = c.currentTime;
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
