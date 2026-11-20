/**
 * music-theory.js
 * 초등학생용 고정도법 계이름 매핑, 조표/임시표 계산, MIDI 변환 및 음정(Diatonic Step) 유틸리티
 */

import { NOTE_NAMES, NATURAL_SEMITONES } from './constants.js';

const SHARPS_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B']; // 파-도-솔-레-라-미-시
const FLATS_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];  // 시-미-라-레-솔-도-파
const STEP_LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/**
 * 조표(fifths: -7 ~ +7)에 따른 기본 alter 맵 반환
 * @param {number} fifths 
 * @returns {Record<string, number>}
 */
export function getKeySignatureAlterMap(fifths = 0) {
  const map = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  if (fifths > 0) {
    for (let i = 0; i < Math.min(fifths, SHARPS_ORDER.length); i++) {
      map[SHARPS_ORDER[i]] = 1;
    }
  } else if (fifths < 0) {
    const count = Math.min(Math.abs(fifths), FLATS_ORDER.length);
    for (let i = 0; i < count; i++) {
      map[FLATS_ORDER[i]] = -1;
    }
  }
  return map;
}

/**
 * 고정도법 계이름 텍스트 생성 (예: 도, 레, 파♯, 시♭)
 * @param {{ step: string, alter?: number }} pitch 
 * @returns {string}
 */
export function getSolfegeLabel(pitch) {
  if (!pitch || !pitch.step) return '';
  const stepIndex = STEP_LETTERS.indexOf(pitch.step.toUpperCase());
  if (stepIndex === -1) return '';
  const baseName = NOTE_NAMES[stepIndex];
  const alter = pitch.alter || 0;
  let accidental = '';
  if (alter === 1) accidental = '♯';
  else if (alter === -1) accidental = '♭';
  else if (alter === 2) accidental = '𝄪';
  else if (alter === -2) accidental = '𝄫';
  return baseName + accidental;
}

/**
 * MIDI 번호 계산 (C4 = 60, A4 = 69)
 * @param {{ step: string, octave: number, alter?: number }} pitch 
 * @returns {number}
 */
export function midiForPitch(pitch) {
  const step = pitch.step?.toUpperCase();
  const natural = NATURAL_SEMITONES[step] ?? 0;
  const alter = pitch.alter || 0;
  const octave = Number(pitch.octave) || 4;
  return 12 * (octave + 1) + natural + alter;
}

/**
 * MIDI 번호로부터 피치 객체 복원 (플랫 문맥 지원)
 * @param {number} midi 
 * @param {boolean} [preferFlats=false] 플랫(♭) 표기 우선 여부
 * @returns {{ step: string, octave: number, alter: number }}
 */
export function pitchFromMidi(midi, preferFlats = false) {
  const sharpMap = [
    { step: 'C', alter: 0 },
    { step: 'C', alter: 1 },
    { step: 'D', alter: 0 },
    { step: 'D', alter: 1 },
    { step: 'E', alter: 0 },
    { step: 'F', alter: 0 },
    { step: 'F', alter: 1 },
    { step: 'G', alter: 0 },
    { step: 'G', alter: 1 },
    { step: 'A', alter: 0 },
    { step: 'A', alter: 1 },
    { step: 'B', alter: 0 }
  ];

  const flatMap = [
    { step: 'C', alter: 0 },
    { step: 'D', alter: -1 },
    { step: 'D', alter: 0 },
    { step: 'E', alter: -1 },
    { step: 'E', alter: 0 },
    { step: 'F', alter: 0 },
    { step: 'G', alter: -1 },
    { step: 'G', alter: 0 },
    { step: 'A', alter: -1 },
    { step: 'A', alter: 0 },
    { step: 'B', alter: -1 },
    { step: 'B', alter: 0 }
  ];

  const map = preferFlats ? flatMap : sharpMap;
  const pitch = map[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return { step: pitch.step, alter: pitch.alter, octave };
}

const BLACK_KEY_SEMITONES = new Set([1, 3, 6, 8, 10]);

/**
 * MIDI 번호가 검은 건반인지 판별
 * @param {number} midi 
 * @returns {boolean}
 */
export function isBlackKeyMidi(midi) {
  return BLACK_KEY_SEMITONES.has(((midi % 12) + 12) % 12);
}

/**
 * 학생의 인지 맥락(목표음 위치, 조표, 임시표/제자리표)을 고려한 오답 피치 복원
 * - 흰 건반은 예외 없이 7개 온음계 제자리음(도, 레, 미, 파, 솔, 라, 시)으로 해석 (도와 시, 미와 파 사이의 도b, 파b 오류 방지)
 * - 검은 건반을 눌렀을 때만 목표음 자리의 샵(파#)/플랫(시b) 또는 조표 맥락에 따른 이명동음으로 해석
 * @param {number} wrongMidi 학생이 실제로 누른 MIDI 번호
 * @param {{ step: string, octave: number, alter: number, fifths?: number, keySignatureAlter?: number }} expectedPitch 목표음 정보
 * @returns {{ step: string, octave: number, alter: number }} 맥락에 맞는 피치 객체
 */
export function resolveWrongPitch(wrongMidi, expectedPitch) {
  if (!expectedPitch) {
    return pitchFromMidi(wrongMidi);
  }

  const expStep = expectedPitch.step?.toUpperCase();
  const expOctave = Number(expectedPitch.octave) || 4;
  const expNaturalMidi = 12 * (expOctave + 1) + (NATURAL_SEMITONES[expStep] ?? 0);
  const isBlack = isBlackKeyMidi(wrongMidi);

  // 1. 학생이 흰 건반을 누른 경우:
  // 피아노의 흰 건반은 언제나 7개 온음계 제자리음(도, 레, 미, 파, 솔, 라, 시)입니다.
  // 도(C)-시(B)와 파(F)-미(E) 사이는 반음 차이지만 검은 건반이 없으므로,
  // '시'를 눌렀을 때 '도♭', '미'를 눌렀을 때 '파♭'으로 왜곡하지 않고 본래의 흰 건반 제자리음으로 해석합니다.
  if (!isBlack) {
    return pitchFromMidi(wrongMidi, false);
  }

  // 2. 학생이 검은 건반을 누른 경우:
  // 목표음 자리(expStep)에서 반음 위/아래의 흑건을 눌렀다면, 해당 자리의 샵(♯) 또는 플랫(♭)으로 해석
  if (wrongMidi === expNaturalMidi - 1) {
    // 예: B자리에서 검은 건반 B♭ 누름 (시♭)
    return { step: expStep, octave: expOctave, alter: -1 };
  }
  if (wrongMidi === expNaturalMidi + 1) {
    // 예: F자리에서 검은 건반 F# 누름 (파♯)
    return { step: expStep, octave: expOctave, alter: 1 };
  }

  // 3. 목표음 자리와 무관한 다른 검은 건반을 누른 경우:
  // 조표(fifths < 0)이거나 목표음이 플랫 계열이면 플랫(♭) 우선, 아니면 샵(♯) 우선 표기
  const isFlatContext = Boolean(
    (expectedPitch.fifths !== undefined && expectedPitch.fifths < 0) ||
    expectedPitch.alter < 0 ||
    (expectedPitch.keySignatureAlter !== undefined && expectedPitch.keySignatureAlter < 0)
  );

  return pitchFromMidi(wrongMidi, isFlatContext);
}

/**
 * 7음계 온음계 인덱스 (Diatonic Index) 계산 (C4=28, D4=29 ...)
 * @param {{ step: string, octave: number }} pitch 
 * @returns {number}
 */
export function diatonicIndex(pitch) {
  const idx = STEP_LETTERS.indexOf(pitch.step.toUpperCase());
  return (pitch.octave ?? 4) * 7 + (idx !== -1 ? idx : 0);
}

/**
 * 온음계 인덱스로부터 피치 반환
 * @param {number} index 
 * @returns {{ step: string, octave: number, alter: number }}
 */
export function pitchFromDiatonicIndex(index) {
  const step = STEP_LETTERS[(index % 7 + 7) % 7];
  const octave = Math.floor(index / 7);
  return { step, octave, alter: 0 };
}

/**
 * 초등학생용 오선보 기준음 후보군 (도, 미, 솔, 시, 높은도)
 * - 도(C4): 아래 첫째 줄 (Diatonic Index: 28)
 * - 미(E4): 첫째 줄 (Diatonic Index: 30)
 * - 솔(G4): 둘째 줄 (Diatonic Index: 32)
 * - 시(B4): 셋째 줄 (Diatonic Index: 34)
 * - 높은도(C5): 셋째 칸 (Diatonic Index: 35)
 */
export const ANCHOR_REFERENCE_PITCHES = [
  { step: 'C', octave: 4, alter: 0 },
  { step: 'E', octave: 4, alter: 0 },
  { step: 'G', octave: 4, alter: 0 },
  { step: 'B', octave: 4, alter: 0 },
  { step: 'C', octave: 5, alter: 0 }
];

/**
 * 도돌이표/점프/6도 이상 도약 시 이전 음과의 연결 방향 및 2음 이상 거리 조건을 반영한 기준음(도, 미, 솔, 시, 높은도) 앵커 선택
 * - 이전 음과의 연결성: 멜로디의 상향/하향 진행에 맞추어 계단식 힌트가 자연스럽게 이어지도록 방향 결정
 * - 학습할 음에서 2음 이상 떨어진 기준음 선택: 최소 1개의 중간 디딤돌 음을 두어 계단식 읽기의 장점 극대화
 * @param {{ step: string, octave: number }} target 
 * @param {{ step: string, octave: number } | null} last 
 * @returns {{ step: string, octave: number, alter: number }}
 */
export function getAnchorReferencePitch(target, last = null) {
  const targetIdx = diatonicIndex(target);
  let desiredDir = 0; // +1: 상향 진행(target > last) -> 앵커는 target 아래 (anchorIdx < targetIdx)
                      // -1: 하향 진행(target < last) -> 앵커는 target 위 (anchorIdx > targetIdx)

  if (last) {
    const lastIdx = diatonicIndex(last);
    desiredDir = Math.sign(targetIdx - lastIdx);
  }

  // 이전 음과 목표 음이 동일하거나(반복 점프) 이전 음이 없는 경우:
  // 오선보 중앙 기준(G4 = 32): G4 이상이면 아래에서 상향 접근, G4 미만이면 위에서 하향 접근
  if (desiredDir === 0) {
    desiredDir = targetIdx >= 32 ? 1 : -1;
  }

  // 1차 후보군: 원하는 진행 방향이면서 목표 음에서 2음 이상 떨어진(|targetIdx - candIdx| >= 2) 기준음
  const primaryCandidates = ANCHOR_REFERENCE_PITCHES.filter(cand => {
    const candIdx = diatonicIndex(cand);
    const dist = Math.abs(targetIdx - candIdx);
    if (dist < 2) return false;
    return desiredDir > 0 ? (candIdx < targetIdx) : (candIdx > targetIdx);
  });

  if (primaryCandidates.length > 0) {
    // 조건 만족 후보 중 목표 음과 가장 알맞은(거리 최소) 기준음 선택
    return primaryCandidates.reduce((best, cand) => {
      const bestDist = Math.abs(targetIdx - diatonicIndex(best));
      const candDist = Math.abs(targetIdx - diatonicIndex(cand));
      return candDist < bestDist ? cand : best;
    });
  }

  // 2차 대체 후보군(Fallback): 해당 방향에 기준음이 없는 경우(경계음 등), 반대 방향에서 2음 이상 떨어진 기준음 중 최단 거리 선택
  const fallbackCandidates = ANCHOR_REFERENCE_PITCHES.filter(cand => {
    const dist = Math.abs(targetIdx - diatonicIndex(cand));
    return dist >= 2;
  });

  if (fallbackCandidates.length > 0) {
    return fallbackCandidates.reduce((best, cand) => {
      const bestDist = Math.abs(targetIdx - diatonicIndex(best));
      const candDist = Math.abs(targetIdx - diatonicIndex(cand));
      return candDist < bestDist ? cand : best;
    });
  }

  // 방어 코드: 가장 거리가 먼 기준음 반환
  return ANCHOR_REFERENCE_PITCHES.reduce((best, cand) => {
    const bestDist = Math.abs(targetIdx - diatonicIndex(best));
    const candDist = Math.abs(targetIdx - diatonicIndex(cand));
    return candDist > bestDist ? cand : best;
  });
}

/**
 * 하위 호환성을 위한 래퍼 함수
 */
export function nearestReferencePitch(target, last = null) {
  return getAnchorReferencePitch(target, last);
}
