/**
 * score-cleaner.js
 * 피아노 2단 악보(양손)나 복합 악보를 초등학생용 오른손 단선율 1단 악보로 자동 정제하고,
 * 위/아래 줄 간격을 최적화(충분한 여백 확보)하는 DOM 변환 모듈
 */

import { getKeySignatureAlterMap, midiForPitch } from './music-theory.js';

// 실제 악보 표시 영역(170px) 및 외곽 여백(50px) 환경에서 위/아래 줄 잔상이 비치지 않도록 보장하는 표준 줄 간격(tenths)
export const TARGET_SYSTEM_DISTANCE_TENTHS = 380;

/**
 * 입력 악보의 줄 간격(System Distance)을 분석하여 충분한 줄 사이 여백(380 tenths)을 확보하도록 강제 보정
 * @param {XMLDocument} doc 
 * @param {number} targetDistance 
 */
export function adjustScoreSystemSpacing(doc, targetDistance = TARGET_SYSTEM_DISTANCE_TENTHS) {
  // 1. defaults 내 전역 system-layout 보정
  let defaults = doc.querySelector('score-partwise > defaults');
  if (!defaults) {
    const root = doc.querySelector('score-partwise');
    if (root) {
      defaults = doc.createElement('defaults');
      root.insertBefore(defaults, root.firstChild);
    }
  }

  if (defaults) {
    let defSystemLayout = defaults.querySelector('system-layout');
    if (!defSystemLayout) {
      defSystemLayout = doc.createElement('system-layout');
      defaults.appendChild(defSystemLayout);
    }
    let defSysDist = defSystemLayout.querySelector('system-distance');
    if (!defSysDist) {
      defSysDist = doc.createElement('system-distance');
      defSystemLayout.appendChild(defSysDist);
    }
    const currentDefDist = parseFloat(defSysDist.textContent) || 0;
    if (currentDefDist < targetDistance) {
      defSysDist.textContent = String(targetDistance);
    }
  }

  // 2. 각 마디 내 print 및 system-layout 순회 보정
  const printNodes = doc.querySelectorAll('measure > print');
  printNodes.forEach((printNode, idx) => {
    let systemLayout = printNode.querySelector('system-layout');
    const isNewSystem = printNode.getAttribute('new-system') === 'yes' || idx > 0;

    if (isNewSystem) {
      if (!systemLayout) {
        systemLayout = doc.createElement('system-layout');
        printNode.appendChild(systemLayout);
      }
      let sysDist = systemLayout.querySelector('system-distance');
      if (!sysDist) {
        sysDist = doc.createElement('system-distance');
        systemLayout.appendChild(sysDist);
      }
      const currentDist = parseFloat(sysDist.textContent) || 0;
      if (currentDist < targetDistance) {
        sysDist.textContent = String(targetDistance);
      }
    }
  });
}

/**
 * 악보 내의 슬러(<slur>) 중 동일한 음높이(step, octave, alter)를 연결하는 슬러를
 * 표준 붙임줄(<tie> 및 <notations><tied>)로 변환하여 OSMD가 가사 충돌 없이 견고하게 붙임줄을 렌더링하도록 보정
 * @param {XMLDocument} doc 
 */
export function convertSamePitchSlursToTies(doc) {
  const measures = Array.from(doc.querySelectorAll('score-partwise > part > measure'));
  if (!measures.length) return;

  let currentFifths = 0;
  const activeSlurs = new Map(); // slur number -> { noteNode, pitchKey }

  measures.forEach(measure => {
    const fifthsNode = measure.querySelector(':scope > attributes > key > fifths');
    if (fifthsNode) {
      currentFifths = Number(fifthsNode.textContent) || 0;
    }
    const measureAlterMap = { ...getKeySignatureAlterMap(currentFifths) };

    const notes = Array.from(measure.querySelectorAll(':scope > note'));
    notes.forEach(noteNode => {
      const isRest = !!noteNode.querySelector('rest');
      const pitchNode = noteNode.querySelector('pitch');
      if (isRest || !pitchNode) return;

      const step = pitchNode.querySelector('step')?.textContent?.trim().toUpperCase();
      const octave = Number(pitchNode.querySelector('octave')?.textContent) || 4;

      const explicitAlterNode = pitchNode.querySelector('alter');
      const accidentalNode = noteNode.querySelector('accidental');
      let alter = 0;

      if (explicitAlterNode) {
        alter = Number(explicitAlterNode.textContent) || 0;
        if (step) measureAlterMap[step] = alter;
      } else if (accidentalNode) {
        const accText = accidentalNode.textContent?.trim().toLowerCase();
        if (accText === 'natural') alter = 0;
        else if (accText === 'sharp') alter = 1;
        else if (accText === 'flat') alter = -1;
        else if (accText === 'double-sharp') alter = 2;
        else if (accText === 'flat-flat') alter = -2;
        if (step) measureAlterMap[step] = alter;
      } else {
        alter = step && (step in measureAlterMap) ? measureAlterMap[step] : 0;
      }

      const pitchKey = `${step}_${octave}_${alter}`;

      // slur 확인
      const slurs = Array.from(noteNode.querySelectorAll('notations > slur'));
      slurs.forEach(slur => {
        const type = slur.getAttribute('type');
        const number = slur.getAttribute('number') || '1';

        if (type === 'start') {
          activeSlurs.set(number, { noteNode, pitchKey });
        } else if (type === 'stop') {
          const startInfo = activeSlurs.get(number);
          if (startInfo) {
            activeSlurs.delete(number);
            // 동일 음높이인 경우 붙임줄(Tie)로 자동 변환!
            if (startInfo.pitchKey === pitchKey) {
              const startNote = startInfo.noteNode;

              // 1. startNote에 tie start 추가
              if (!startNote.querySelector('tie[type="start"]')) {
                const tie = doc.createElement('tie');
                tie.setAttribute('type', 'start');
                startNote.appendChild(tie);
              }
              let startNotations = startNote.querySelector('notations');
              if (!startNotations) {
                startNotations = doc.createElement('notations');
                startNote.appendChild(startNotations);
              }
              if (!startNotations.querySelector('tied[type="start"]')) {
                const tied = doc.createElement('tied');
                tied.setAttribute('type', 'start');
                startNotations.appendChild(tied);
              }

              // 2. stopNote(현재 음표)에 tie stop 추가
              if (!noteNode.querySelector('tie[type="stop"]')) {
                const tie = doc.createElement('tie');
                tie.setAttribute('type', 'stop');
                noteNode.appendChild(tie);
              }
              let stopNotations = noteNode.querySelector('notations');
              if (!stopNotations) {
                stopNotations = doc.createElement('notations');
                noteNode.appendChild(stopNotations);
              }
              if (!stopNotations.querySelector('tied[type="stop"]')) {
                const tied = doc.createElement('tied');
                tied.setAttribute('type', 'stop');
                stopNotations.appendChild(tied);
              }

              // 3. 기존 slur 태그 제거 (가사 충돌 회피 알고리즘 방지)
              slur.remove();
              startNotations.querySelector(`slur[type="start"][number="${number}"], slur[type="start"]`)?.remove();
            }
          }
        }
      });
    });
  });
}

/**
 * 2단 보표 및 복합 악보를 오른손 1단 단선율 MusicXML로 정제
 * @param {string} xmlString 
 * @returns {{ cleanedXml: string, title: string, hasRemovedStaff2: boolean }}
 */
export function cleanScoreToSingleStaff(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');

  if (doc.querySelector('parsererror')) {
    throw new Error('악보 파일을 읽을 수 없습니다. 올바른 MusicXML 파일인지 확인해 주세요.');
  }

  // 곡 제목 추출
  let title = doc.querySelector('work > work-title')?.textContent?.trim()
    || doc.querySelector('movement-title')?.textContent?.trim()
    || doc.querySelector('credit-words[font-size="22"], credit-words[font-size="20"]')?.textContent?.trim()
    || '악보 연습';

  const parts = doc.querySelectorAll('score-partwise > part');
  if (!parts.length) {
    throw new Error('악보에서 파트 데이터를 찾지 못했습니다.');
  }

  // 가사(<lyric>) 태그 일괄 제거 (배틀 게임에서는 가사 표시 불필요 및 오선 하단 40px 여백 확보)
  doc.querySelectorAll('lyric').forEach(node => node.remove());

  // 기본적으로 첫 번째 멜로디 파트를 주 타깃으로 처리
  const mainPart = parts[0];
  let hasRemovedStaff2 = false;

  const measures = mainPart.querySelectorAll(':scope > measure');

  measures.forEach(measure => {
    // 1. attributes 내 staves 2 및 staff 2 관련 설정 정제
    const attributesList = measure.querySelectorAll(':scope > attributes');
    attributesList.forEach(attrs => {
      const stavesNode = attrs.querySelector('staves');
      if (stavesNode && Number(stavesNode.textContent) > 1) {
        hasRemovedStaff2 = true;
        stavesNode.remove(); // 1단 보표 표준으로 변경
      }

      // 2번 보표 음자리표(<clef number="2">) 제거
      attrs.querySelectorAll('clef[number="2"]').forEach(node => node.remove());

      // 2번 보표 레이아웃(<staff-details number="2">) 제거
      attrs.querySelectorAll('staff-details[number="2"]').forEach(node => node.remove());
    });

    // 2. 마디 내 자식 노드 순회하며 staff 2 음표 및 관련 backup 제거
    const children = Array.from(measure.children);
    let pendingBackup = null;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const tagName = child.localName;

      if (tagName === 'backup') {
        pendingBackup = child;
        continue;
      }

      if (tagName === 'note') {
        const staff = child.querySelector('staff')?.textContent?.trim();
        if (staff === '2') {
          hasRemovedStaff2 = true;
          // staff 2 음표 제거
          child.remove();
          // 만약 이 음표로 가기 위한 직전 backup이 있었다면 함께 제거
          if (pendingBackup && pendingBackup.isConnected) {
            pendingBackup.remove();
            pendingBackup = null;
          }
          continue;
        } else {
          // staff 1 음표는 보표 태그를 1단 표준으로 정리
          const staffNode = child.querySelector('staff');
          if (staffNode) {
            staffNode.remove(); // 단일 보표에서는 staff 태그 불필요
          }
        }
      }

      // staff 1 관련 노드가 나왔다면 pendingBackup 유지할 필요 없음
      if (tagName !== 'backup') {
        pendingBackup = null;
      }
    }

    // 3. 화음(<chord/>) 정리: 초등학생 멜로디 연습을 위해 최상단 음 1개만 유지
    const remainingNotes = Array.from(measure.querySelectorAll(':scope > note'));
    const chordGroups = [];
    let currentGroup = [];

    for (const note of remainingNotes) {
      if (note.querySelector('chord')) {
        currentGroup.push(note);
      } else {
        if (currentGroup.length > 1) {
          chordGroups.push(currentGroup);
        }
        currentGroup = [note];
      }
    }
    if (currentGroup.length > 1) {
      chordGroups.push(currentGroup);
    }

    chordGroups.forEach(group => {
      // 각 음표의 MIDI 음높이 계산 후 가장 높은 음 1개 선정
      let highestNote = group[0];
      let highestMidi = -1;

      group.forEach(noteNode => {
        const pitchNode = noteNode.querySelector('pitch');
        if (pitchNode) {
          const step = pitchNode.querySelector('step')?.textContent?.trim().toUpperCase();
          const octave = Number(pitchNode.querySelector('octave')?.textContent) || 4;
          const alter = Number(pitchNode.querySelector('alter')?.textContent) || 0;
          const midi = midiForPitch({ step, octave, alter });
          if (midi > highestMidi) {
            highestMidi = midi;
            highestNote = noteNode;
          }
        }
      });

      // 가장 높은 음표를 제외하고 나머지 부화음 음표 제거
      group.forEach(noteNode => {
        if (noteNode !== highestNote) {
          noteNode.remove();
        } else {
          // 최상단 음표의 chord 태그 제거 (주 멜로디 단음화)
          noteNode.querySelector('chord')?.remove();
        }
      });
    });
  });

  // 4. 요구사항: 실제 악보 표시 영역에 위/아래 줄이 침범하지 않도록 충분한 줄 사이 여백(380 tenths) 확보
  adjustScoreSystemSpacing(doc, TARGET_SYSTEM_DISTANCE_TENTHS);

  // 5. 동일 음높이를 잇는 슬러(<slur>)를 표준 붙임줄(<tie>, <tied>)로 자동 변환하여 시각적 곡선 렌더링 및 타건 제외 보장
  convertSamePitchSlursToTies(doc);

  const serializer = new XMLSerializer();
  const cleanedXml = serializer.serializeToString(doc);

  return {
    cleanedXml,
    title,
    hasRemovedStaff2
  };
}
