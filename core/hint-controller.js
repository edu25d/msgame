/**
 * battle-game/core/hint-controller.js
 * 도레미 읽기 연습장 3단계 계단 읽기 힌트 엔진
 *
 * 1단계: 첫 음 페이드 계이름 힌트 (showFadingHint)
 * 2단계: 기준음 앵커 + 디딤돌 사운드 및 오선보 디딤돌 타원 (drawStepOrigin, drawStepHint)
 *        *목표음 자체는 정답 노출 방지를 위해 디딤돌/건반 하이라이트에서 완전 제외*
 * 3단계: 악보 방향 화살표 (drawIntervalArrow)
 */

import {
  diatonicIndex,
  pitchFromDiatonicIndex,
  getAnchorReferencePitch,
  midiForPitch,
  getSolfegeLabel
} from './music-theory.js';
import { Synth } from '../audio/synth.js';

export class HintController {
  constructor(overlay, keyboard, onStatusMessage, onHintTriggered) {
    this.overlay = overlay;
    this.keyboard = keyboard;
    this.onStatusMessage = onStatusMessage || (() => {});
    this.onHintTriggered = onHintTriggered || (() => {});

    this.timerId = null;
    this.subTimers = [];
    this.active = false;
  }

  schedule(callback, delayMs) {
    const id = setTimeout(() => {
      this.subTimers = this.subTimers.filter(t => t !== id);
      callback();
    }, delayMs);
    this.subTimers.push(id);
    return id;
  }

  stop() {
    clearTimeout(this.timerId);
    this.timerId = null;
    this.subTimers.forEach(clearTimeout);
    this.subTimers = [];

    this.keyboard?.clearAllHighlights?.();
    this.keyboard?.clearStepHints?.();
    this.overlay?.clearTransientHints?.();
    this.active = false;
  }

  start(currentPlayableNote, lastPlayableNote, isNewLine, delayMs = 1800) {
    this.stop();
    if (!currentPlayableNote) return;

    this.active = true;

    // 맨 첫 음인 경우: 악보 아래에 첫 음 계이름을 은은하게 페이드 인으로 표시
    if (!lastPlayableNote) {
      this.timerId = this.schedule(() => {
        if (!this.active) return;
        this.stage1FadeLabel(currentPlayableNote);
      }, delayMs);
      return;
    }

    // 2번째 음부터는 delayMs 대기 후 1회차 계단식 힌트 시작
    this.timerId = this.schedule(() => {
      if (!this.active) return;
      this.runStepHintCycle(1, currentPlayableNote, lastPlayableNote, isNewLine);
    }, delayMs);
  }

  stage1FadeLabel(targetNote) {
    this.overlay.showFadingHint(targetNote.rawNoteIndex, targetNote.solfege);
    this.onHintTriggered('fade');
  }

  runStepHintCycle(cycle, targetNote, lastNote, isNewLine) {
    if (!this.active) return;

    const targetPitch = { step: targetNote.step, octave: targetNote.octave, alter: targetNote.alter };
    const lastPitch = lastNote ? { step: lastNote.step, octave: lastNote.octave, alter: lastNote.alter } : null;

    // 도돌이표/점프/줄바꿈 또는 6음 이상 도약 시 기준음(도, 미, 솔, 시, 높은도) 앵커 전환
    let useAnchor = isNewLine || !lastPitch;
    let fromPitch = useAnchor
      ? getAnchorReferencePitch(targetPitch, lastPitch)
      : lastPitch;

    if (!useAnchor && lastPitch) {
      const fromIdx = diatonicIndex(fromPitch);
      const targetIdx = diatonicIndex(targetPitch);
      if (Math.abs(targetIdx - fromIdx) >= 5) {
        useAnchor = true;
        fromPitch = getAnchorReferencePitch(targetPitch, lastPitch);
      }
    }

    const fromIdx = diatonicIndex(fromPitch);
    const targetIdx = diatonicIndex(targetPitch);
    const direction = Math.sign(targetIdx - fromIdx);

    // 시작음(기준음)부터 목표 음 직전까지 순차적으로 생성 (목표 음 자체는 정답 노출 방지를 위해 제외!)
    const steps = [fromPitch];
    for (let idx = fromIdx + direction; direction && idx !== targetIdx; idx += direction) {
      steps.push(pitchFromDiatonicIndex(idx));
    }

    const context = {
      fromPitch,
      targetPitch,
      isNewLine: useAnchor,
      stepCount: steps.length
    };

    // 음정 차이가 1단계 이하(동일음 또는 바로 옆음)인 경우 곧바로 화살표 힌트로 진행
    if (Math.abs(targetIdx - fromIdx) <= 1 && !useAnchor) {
      this.stage3DirectionArrow(targetNote, lastNote, context);
      return;
    }

    this.onHintTriggered('step');

    // 악보상 출발음 동그라미 링 표시
    this.overlay.drawStepOrigin(context, targetNote.rawNoteIndex, (!useAnchor && lastNote) ? lastNote.rawNoteIndex : null);

    // 시작음부터 순차적으로 사운드와 건반/악보 표시
    steps.forEach((stepPitch, index) => {
      this.schedule(() => {
        if (!this.active) return;
        if (index > 0) {
          this.overlay.drawStepHint(stepPitch, index - 1, steps.length - 1, context, targetNote.rawNoteIndex);
        }

        const midi = midiForPitch(stepPitch);
        this.keyboard.highlightStepKey(midi, getSolfegeLabel(stepPitch), 400);
        Synth.playNote(midi, 0.40, { velocity: 0.65 });
      }, (index + 1) * 450);
    });

    const sequenceEnd = steps.length ? steps.length * 450 + 450 : 450;

    // 계단음 재생 완료 후 화살표 힌트로 전환
    this.schedule(() => {
      if (!this.active) return;
      this.stage3DirectionArrow(targetNote, lastNote, context);

      // 1회차 완료 후 2.5초 동안 미입력 시 2회차 반복 실행
      if (cycle === 1) {
        this.schedule(() => {
          if (!this.active) return;
          this.overlay.clearTransientHints();
          this.runStepHintCycle(2, targetNote, lastNote, isNewLine);
        }, 2500);
      }
    }, sequenceEnd);
  }

  stage3DirectionArrow(targetNote, lastNote, context) {
    this.onHintTriggered('arrow');
    const fromRawIndex = context?.isNewLine ? null : (lastNote ? lastNote.rawNoteIndex : null);
    this.overlay.drawIntervalArrow(targetNote.rawNoteIndex, fromRawIndex, context);
  }
}
