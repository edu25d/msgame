/**
 * playback-order.js
 * 음악 이론 기반의 연주 순서(도돌이표, 1·2번 볼타, D.C./Fine) 마디 전개 및 음표 시퀀스 생성 엔진
 */

import { getKeySignatureAlterMap, getSolfegeLabel, midiForPitch } from './music-theory.js';

/**
 * 정제된 1단 MusicXML에서 연주 순서대로 정렬된 마디 인덱스 배열 산출
 * @param {Element[]} measureElements 
 * @returns {number[]} 실제 연주할 마디 인덱스 순서 배열 (예: [0, 1, 2, 3, 4, 1, 2, 5, 6])
 */
export function unrollMeasureSequence(measureElements) {
  const count = measureElements.length;
  if (!count) return [];

  // 1. 각 마디의 구조적 기호 메타데이터 수집
  let activeEnding = null;
  const measureMeta = measureElements.map((m, index) => {
    const repeats = Array.from(m.querySelectorAll('barline > repeat'));
    const endings = Array.from(m.querySelectorAll('barline > ending'));
    const words = Array.from(m.querySelectorAll('direction > direction-type > words')).map(w => w.textContent?.trim().toUpperCase());

    const hasRepeatForward = repeats.some(r => r.getAttribute('direction') === 'forward');
    const hasRepeatBackward = repeats.some(r => r.getAttribute('direction') === 'backward');

    const endingStart = endings.find(e => e.getAttribute('type') === 'start');
    const endingStop = endings.find(e => ['stop', 'discontinue'].includes(e.getAttribute('type')));

    if (endingStart) {
      activeEnding = Number(endingStart.getAttribute('number')) || 1;
    }

    const currentEnding = activeEnding;

    if (endingStop) {
      activeEnding = null;
    }

    const hasDC = words.some(w => w?.includes('D.C.') || w?.includes('DA CAPO'));
    const hasFine = words.some(w => w === 'FINE' || w?.startsWith('FINE'));

    return {
      index,
      number: m.getAttribute('number'),
      hasRepeatForward,
      hasRepeatBackward,
      endingNum: currentEnding,
      isEnding1: currentEnding === 1,
      isEnding2: currentEnding === 2,
      hasEndingStart: !!endingStart,
      hasEndingStop: !!endingStop,
      hasDC,
      hasFine
    };
  });

  // 2. 마디 순서 전개 (Unrolling)
  const resultSequence = [];
  let currentIdx = 0;
  let repeatStartIdx = 0; // 시작 도돌이표 없을 시 맨 처음(0 또는 1)으로 복귀
  let isRepeatedPass = false; // 현재 도돌이표 구간 2회차 진행 여부
  let executedDC = false;
  let safetyLoopCounter = 0;
  const MAX_STEPS = count * 4;

  while (currentIdx < count && safetyLoopCounter < MAX_STEPS) {
    safetyLoopCounter++;
    const meta = measureMeta[currentIdx];

    // 시작 도돌이표를 만났을 때 (1회차일 때만 반복 시작점 저장)
    if (meta.hasRepeatForward && !isRepeatedPass) {
      repeatStartIdx = currentIdx;
    }

    // 2회차 반복 중에 1번 엔딩 구간(isEnding1)을 만난 경우 -> 1번 엔딩 건너뛰고 2번 엔딩 시작 마디로 점프!
    if (isRepeatedPass && meta.isEnding1) {
      const ending2Index = measureMeta.findIndex((m, i) => i > currentIdx && m.endingNum === 2);
      if (ending2Index !== -1) {
        currentIdx = ending2Index;
        // 2번 엔딩에 진입했으므로 반복 상태 해제
        isRepeatedPass = false;
        continue;
      }
    }

    // 현재 마디 연주 시퀀스에 추가
    resultSequence.push(currentIdx);

    // D.C. 상태에서 Fine을 만나면 악곡 종료
    if (executedDC && meta.hasFine) {
      break;
    }

    // 끝 도돌이표 처리
    if (meta.hasRepeatBackward) {
      if (!isRepeatedPass) {
        // 1회차 종료 -> 2회차 시작 플래그 세팅 후 반복 시작점으로 점프!
        isRepeatedPass = true;
        currentIdx = repeatStartIdx;
        continue;
      } else {
        // 2회차에서 끝 도돌이표를 만난 경우 (예: 2번 엔딩 내) 반복 종료
        isRepeatedPass = false;
      }
    }

    // D.C. (Da Capo) 처리: 곡의 맨 처음으로 점프
    if (meta.hasDC && !executedDC) {
      executedDC = true;
      currentIdx = 0;
      isRepeatedPass = false;
      continue;
    }

    currentIdx++;
  }

  return resultSequence.length ? resultSequence : measureElements.map((_, i) => i);
}

/**
 * 정제된 1단 XML 문서로부터 실제 연주할 음표 시퀀스를 추출
 * @param {string} cleanedXmlString 
 * @returns {{ playableNotes: any[], rawNoteCount: number, measureSequence: number[], cleanedDoc: Document }}
 */
export function extractPlayableSequence(cleanedXmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(cleanedXmlString, 'application/xml');
  const measures = Array.from(doc.querySelectorAll('score-partwise > part > measure'));

  if (!measures.length) {
    throw new Error('악보에서 마디 데이터를 찾지 못했습니다.');
  }

  // 1. 연주 마디 순서 전개
  const measureSequence = unrollMeasureSequence(measures);

  // 2. 조표 상태 추적 준비
  let currentFifths = 0;

  // 전체 악보 내 모든 유효 음표(노트헤드 매핑용 원본 인덱스 부여)
  let rawNoteCursor = 0;

  // 붙임줄(Tie) 및 동일음 슬러(Slur) 상태 추적 (마디 경계를 넘어 유지)
  let pendingTiePitchKey = null;
  let pendingSlurPitchKey = null;

  const measureNotesMap = measures.map((m, mIdx) => {
    // 마디 내 조표 확인
    const fifthsNode = m.querySelector(':scope > attributes > key > fifths');
    if (fifthsNode) {
      currentFifths = Number(fifthsNode.textContent) || 0;
    }

    // 마디별 임시표 상태 머신 (해당 마디 동안 유지)
    const measureAlterMap = { ...getKeySignatureAlterMap(currentFifths) };

    const notesInMeasure = [];
    const noteNodes = m.querySelectorAll(':scope > note');

    noteNodes.forEach(noteNode => {
      const isRest = !!noteNode.querySelector('rest');
      const pitchNode = noteNode.querySelector('pitch');
      const hasLyric = !!noteNode.querySelector('lyric');

      if (!isRest && pitchNode) {
        const step = pitchNode.querySelector('step')?.textContent?.trim().toUpperCase();
        const octave = Number(pitchNode.querySelector('octave')?.textContent) || 4;

        // XML 자체에 alter 또는 accidental이 명시되어 있는지 확인
        const explicitAlterNode = pitchNode.querySelector('alter');
        const accidentalNode = noteNode.querySelector('accidental');
        const accText = accidentalNode?.textContent?.trim().toLowerCase() || null;
        let alter = 0;

        if (explicitAlterNode) {
          alter = Number(explicitAlterNode.textContent) || 0;
          // 마디 내 임시표 상태 갱신
          if (step) measureAlterMap[step] = alter;
        } else if (accidentalNode) {
          // <alter> 없이 <accidental>만 명시된 경우 (예: MuseScore 제자리표 ♮ 등)
          if (accText === 'natural') alter = 0;
          else if (accText === 'sharp') alter = 1;
          else if (accText === 'flat') alter = -1;
          else if (accText === 'double-sharp') alter = 2;
          else if (accText === 'flat-flat') alter = -2;
          else alter = 0;
          if (step) measureAlterMap[step] = alter;
        } else {
          // 조표 또는 이전 임시표 계승
          alter = step && (step in measureAlterMap) ? measureAlterMap[step] : 0;
        }

        const pitch = { step, octave, alter };
        const midi = midiForPitch(pitch);
        const solfege = getSolfegeLabel(pitch);
        const pitchKey = `${step}_${octave}_${alter}`;

        // 붙임줄(Tie) 및 동일음 슬러(Slur) 판정
        const explicitTieStop = !!noteNode.querySelector('tie[type="stop"], tied[type="stop"]');
        const explicitTieStart = !!noteNode.querySelector('tie[type="start"], tied[type="start"]');
        const explicitSlurStop = !!noteNode.querySelector('slur[type="stop"]');
        const explicitSlurStart = !!noteNode.querySelector('slur[type="start"]');

        let isTieStop = false;

        // 1) 명시적 tie stop이 있는 경우
        if (explicitTieStop) {
          isTieStop = true;
        }
        // 2) 직전 음에서 시작된 tie가 동일 음높이로 이어진 경우
        else if (pendingTiePitchKey === pitchKey) {
          isTieStop = true;
        }
        // 3) 직전 음과 동일한 음높이이면서 slur로 연결된 경우 (보컬 악보의 사실상 붙임줄)
        else if (pendingSlurPitchKey === pitchKey && (explicitSlurStop || !explicitSlurStart)) {
          isTieStop = true;
        }

        // 다음 음을 위한 tie / slur 시작 상태 갱신
        if (explicitTieStart) {
          pendingTiePitchKey = pitchKey;
        } else if (isTieStop && !explicitTieStart) {
          pendingTiePitchKey = null;
        } else {
          pendingTiePitchKey = null;
        }

        if (explicitSlurStart) {
          pendingSlurPitchKey = pitchKey;
        } else if (explicitSlurStop || isTieStop) {
          pendingSlurPitchKey = null;
        } else if (pendingSlurPitchKey !== pitchKey) {
          pendingSlurPitchKey = null;
        }

        const keySignatureAlter = getKeySignatureAlterMap(currentFifths)[step] || 0;
        const hasNatural = accText === 'natural' || (explicitAlterNode && alter === 0 && keySignatureAlter !== 0);

        notesInMeasure.push({
          rawNoteIndex: rawNoteCursor,
          measureIndex: mIdx,
          step,
          octave,
          alter,
          midi,
          solfege,
          hasLyric,
          isTieStop,
          hasNatural,
          accidental: accText,
          fifths: currentFifths,
          keySignatureAlter
        });

        // 실제 렌더링되는 피치 음표(vf-notehead)와 1:1 동기화를 위해 유효 음표일 때만 증가
        rawNoteCursor++;
      }
    });

    return notesInMeasure;
  });

  // 3. 연주 순서(measureSequence)에 따라 음표들을 일렬로 결합
  const playableNotes = [];
  measureSequence.forEach((measureIdx, sequenceStep) => {
    const notesInThisMeasure = measureNotesMap[measureIdx] || [];
    notesInThisMeasure.forEach(note => {
      // 붙임줄로 연결된 뒤의 음(tieStop)은 타건 대상에서 제외 (음표 건너뛰기)
      if (note.isTieStop) {
        return;
      }
      playableNotes.push({
        ...note,
        playIndex: playableNotes.length,
        sequenceStep
      });
    });
  });

  if (!playableNotes.length) {
    throw new Error('연습할 음표를 찾지 못했습니다.');
  }

  return {
    playableNotes,
    rawNoteCount: rawNoteCursor,
    measureSequence,
    cleanedDoc: doc
  };
}
