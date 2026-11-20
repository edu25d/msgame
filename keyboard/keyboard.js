/**
 * battle-game/keyboard/keyboard.js
 * 모바일 가로 모드 최적화 B3~E5 11건반 모듈
 * 
 * - 흰건반 11개 (B3=59 ~ E5=76)
 * - 검은건반 7개 + A#3 왼쪽 반건반
 * - 잡다한 설정 버튼 일절 없음, 계이름 라벨(도·레·미...)만 건반에 내장
 * - 멀티터치 및 정밀 터치 피드백 지원
 */

export const Keyboard = (() => {
  const WHITE_KEYS = [
    { name: '시', midi: 59, note: 'B3', isDo: false },
    { name: '도', midi: 60, note: 'C4', isDo: true  },
    { name: '레', midi: 62, note: 'D4', isDo: false },
    { name: '미', midi: 64, note: 'E4', isDo: false },
    { name: '파', midi: 65, note: 'F4', isDo: false },
    { name: '솔', midi: 67, note: 'G4', isDo: false },
    { name: '라', midi: 69, note: 'A4', isDo: false },
    { name: '시', midi: 71, note: 'B4', isDo: false },
    { name: '도', midi: 72, note: 'C5', isDo: true  },
    { name: '레', midi: 74, note: 'D5', isDo: false },
    { name: '미', midi: 76, note: 'E5', isDo: false },
  ];

  const BLACK_KEYS = [
    { whiteIndex: 0, name: 'A#3', midi: 58 },
    { whiteIndex: 1, name: 'C#4', midi: 61 },
    { whiteIndex: 2, name: 'D#4', midi: 63 },
    { whiteIndex: 4, name: 'F#4', midi: 66 },
    { whiteIndex: 5, name: 'G#4', midi: 68 },
    { whiteIndex: 6, name: 'A#4', midi: 70 },
    { whiteIndex: 8, name: 'C#5', midi: 73 },
    { whiteIndex: 9, name: 'D#5', midi: 75 },
  ];

  let container = null;
  let onKeyDown = null;
  let onKeyUp = null;
  let activeTouches = new Map(); // identifier -> midi
  let keyElements = new Map();   // midi -> HTMLElement
  let highlightMidis = new Set();
  let stepHintMidis = new Set();
  let accidentalCueTimer = null;

  function init(opts = {}) {
    container = opts.container || document.getElementById('keyboard-container');
    onKeyDown = opts.onKeyDown || (() => {});
    onKeyUp = opts.onKeyUp || (() => {});
    render();
    window.addEventListener('resize', handleResize);
  }

  function handleResize() {
    render();
  }

  function render() {
    if (!container) return;
    container.innerHTML = '';

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || 180;

    const wrapper = document.createElement('div');
    wrapper.className = 'kb-wrapper';

    const keysRow = document.createElement('div');
    keysRow.className = 'kb-row';

    // 2-Layer 분리 구조: 흰 건반 베이스 레이어 + 검은 건반 오버레이 레이어
    const whiteLayer = document.createElement('div');
    whiteLayer.className = 'kb-white-keys-layer';

    const blackLayer = document.createElement('div');
    blackLayer.className = 'kb-black-keys-layer';

    keyElements.clear();

    const whiteKeyCount = WHITE_KEYS.length; // 11
    const whiteKeyWidth = width / whiteKeyCount;
    const blackKeyWidth = Math.round(whiteKeyWidth * 0.62);
    const blackKeyHeight = Math.round(height * 0.60);

    // ── 1. 흰건반 생성 (흰 건반 레이어) ──────────────────────────
    WHITE_KEYS.forEach((k, idx) => {
      const el = document.createElement('div');
      el.className = `kb-white-key ${k.isDo ? 'is-do' : ''}`;
      el.dataset.midi = k.midi;

      const label = document.createElement('span');
      label.className = `kb-label ${k.isDo ? 'do-label' : ''}`;
      label.textContent = k.name;
      el.appendChild(label);

      whiteLayer.appendChild(el);
      keyElements.set(k.midi, el);
    });

    // ── 2. 검은건반 생성 (검은 건반 오버레이 레이어) ──────────────
    BLACK_KEYS.forEach(bk => {
      const el = document.createElement('div');
      el.className = 'kb-black-key';
      el.dataset.midi = bk.midi;
      el.style.width = `${blackKeyWidth}px`;
      el.style.height = `${blackKeyHeight}px`;

      // 위치 계산: whiteIndex 흰건반의 오른쪽 경계가 중심
      if (bk.whiteIndex === 0) {
        // A#3 특수 처리: 맨 왼쪽 가장자리에 걸침
        el.style.left = `0px`;
        el.style.width = `${Math.round(blackKeyWidth * 0.55)}px`;
        el.classList.add('edge-left');
      } else {
        const centerPos = (bk.whiteIndex + 1) * whiteKeyWidth;
        el.style.left = `${Math.round(centerPos - blackKeyWidth / 2)}px`;
      }

      // 검은건반에는 계이름 라벨을 일체 표시하지 않음 (순수 건반)
      blackLayer.appendChild(el);
      keyElements.set(bk.midi, el);
    });

    keysRow.appendChild(whiteLayer);
    keysRow.appendChild(blackLayer);
    wrapper.appendChild(keysRow);
    container.appendChild(wrapper);

    bindEvents(keysRow);
  }

  // ── 이벤트 바인딩 (멀티터치 + 마우스) ──────────────────────────
  function bindEvents(el) {
    // Touch Events
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        const target = getTargetKey(touch.clientX, touch.clientY);
        if (target) {
          const midi = parseInt(target.dataset.midi, 10);
          activeTouches.set(touch.identifier, midi);
          triggerKeyDown(midi);
        }
      }
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        const target = getTargetKey(touch.clientX, touch.clientY);
        const prevMidi = activeTouches.get(touch.identifier);
        if (target) {
          const newMidi = parseInt(target.dataset.midi, 10);
          if (prevMidi !== newMidi) {
            if (prevMidi) triggerKeyUp(prevMidi);
            activeTouches.set(touch.identifier, newMidi);
            triggerKeyDown(newMidi);
          }
        } else if (prevMidi) {
          triggerKeyUp(prevMidi);
          activeTouches.delete(touch.identifier);
        }
      }
    }, { passive: false });

    const handleTouchEnd = (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        const midi = activeTouches.get(touch.identifier);
        if (midi) {
          triggerKeyUp(midi);
          activeTouches.delete(touch.identifier);
        }
      }
    };

    el.addEventListener('touchend', handleTouchEnd, { passive: false });
    el.addEventListener('touchcancel', handleTouchEnd, { passive: false });

    // Mouse Events (PC 테스트 및 클릭 지원)
    let isMouseDown = false;
    let currentMouseMidi = null;

    el.addEventListener('mousedown', (e) => {
      isMouseDown = true;
      const target = e.target.closest('.kb-black-key') || e.target.closest('.kb-white-key') || getTargetKey(e.clientX, e.clientY);
      if (target) {
        currentMouseMidi = parseInt(target.dataset.midi, 10);
        triggerKeyDown(currentMouseMidi);
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!isMouseDown) return;
      const target = getTargetKey(e.clientX, e.clientY);
      if (target) {
        const newMidi = parseInt(target.dataset.midi, 10);
        if (currentMouseMidi !== newMidi) {
          if (currentMouseMidi) triggerKeyUp(currentMouseMidi);
          currentMouseMidi = newMidi;
          triggerKeyDown(newMidi);
        }
      } else if (currentMouseMidi) {
        triggerKeyUp(currentMouseMidi);
        currentMouseMidi = null;
      }
    });

    window.addEventListener('mouseup', () => {
      if (isMouseDown && currentMouseMidi) {
        triggerKeyUp(currentMouseMidi);
        currentMouseMidi = null;
      }
      isMouseDown = false;
    });
  }

  // 좌표에서 검은건반 우선 탐색 (검은건반이 위에 떠 있으므로)
  function getTargetKey(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    return el.closest('.kb-black-key') || el.closest('.kb-white-key') || null;
  }

  function triggerKeyDown(midi) {
    const el = keyElements.get(midi);
    if (el) el.classList.add('pressed');
    if (onKeyDown) onKeyDown(midi);
  }

  function triggerKeyUp(midi) {
    const el = keyElements.get(midi);
    if (el) el.classList.remove('pressed');
    if (onKeyUp) onKeyUp(midi);
  }

  // ── 정답/오답 건반 플래시 피드백 ──────────────────────────────
  function flashFeedback(midi, isCorrect) {
    const el = keyElements.get(midi);
    if (!el) return;

    el.classList.remove('key-feedback-correct', 'key-feedback-wrong');
    void el.offsetWidth; // DOM reflow 유도
    el.classList.add(isCorrect ? 'key-feedback-correct' : 'key-feedback-wrong');

    const handleAnimEnd = () => {
      el.classList.remove('key-feedback-correct', 'key-feedback-wrong');
      el.removeEventListener('animationend', handleAnimEnd);
    };
    el.addEventListener('animationend', handleAnimEnd);
  }

  // ── 조표/임시표 실수 건반 배지 큐 (♯, ♭, ♮) ────────────────────
  function flashAccidentalCue(targetMidi, symbol = '♭') {
    const el = keyElements.get(targetMidi);
    if (!el) return;

    clearAccidentalCue();

    const badge = document.createElement('span');
    badge.className = 'accidental-cue-badge';
    badge.textContent = symbol;
    el.appendChild(badge);

    accidentalCueTimer = setTimeout(() => {
      clearAccidentalCue();
    }, 2850);
  }

  function clearAccidentalCue() {
    clearTimeout(accidentalCueTimer);
    accidentalCueTimer = null;
    container?.querySelectorAll('.accidental-cue-badge').forEach(b => b.remove());
  }

  // ── 디딤돌 건반 일시 반짝임 (정답 건반은 절대 칠하지 않음) ───────────
  function highlightStepKey(midi, labelText, duration = 400) {
    const el = keyElements.get(midi);
    if (!el) return;
    el.classList.add('highlight-step');
    setTimeout(() => {
      el.classList.remove('highlight-step');
    }, duration);
  }

  function clearAllHighlights() {
    clearAccidentalCue();
    keyElements.forEach(el => el.classList.remove('highlight-step', 'highlight-target'));
  }

  function clearStepHints() {
    keyElements.forEach(el => el.classList.remove('highlight-step'));
  }

  return {
    init,
    render,
    flashFeedback,
    flashAccidentalCue,
    clearAccidentalCue,
    highlightStepKey,
    clearAllHighlights,
    clearStepHints,
    triggerKeyDown,
    triggerKeyUp
  };
})();

if (typeof window !== 'undefined') {
  window.Keyboard = Keyboard;
}
