/**
 * score-overlay.js
 * 악보 SVG 오버레이 제어 (포커스 타원, 고정도법 계이름 라벨, 계단 힌트 애니메이션, 오답 마커)
 */

import { STAFF_STEP } from '../core/constants.js';
import { diatonicIndex, pitchFromMidi, resolveWrongPitch, getSolfegeLabel } from '../core/music-theory.js';

export class ScoreOverlay {
  constructor(scoreViewer) {
    this.viewer = scoreViewer;
    this.svg = null;
    this.noteHeads = [];
    this.focusLayer = null;
    this.labelsLayer = null;
    this.hintsLayer = null;
    this.scoreLabels = [];
    this.confirmedLabels = {};
    this.wrongNoteMarker = null;
    this.wrongNoteShownAt = 0;
    this.wrongNoteClearTimer = null;
    this.currentFocusedRawIndex = null;
  }

  attach(svg, rawNoteCount) {
    if (!svg) return;

    const renderedHeads = this.viewer?.getPitchNoteheads
      ? this.viewer.getPitchNoteheads(svg)
      : Array.from(svg.querySelectorAll('.vf-notehead')).filter(h => {
          try { return h.getBBox().height <= 18; } catch (e) { return true; }
        });

    // 이미 현재 SVG에 모든 라벨과 헤드가 온전히 연결되어 있다면 레이어 재구축 없이 포커스만 보장
    if (
      this.svg === svg &&
      this.noteHeads.length === renderedHeads.length &&
      this.scoreLabels.length === renderedHeads.length &&
      this.scoreLabels.every((label, index) => label.isConnected && renderedHeads[index] === this.noteHeads[index]) &&
      this.hintsLayer?.isConnected &&
      this.labelsLayer?.isConnected &&
      this.focusLayer?.isConnected
    ) {
      if (this.currentFocusedRawIndex !== null) {
        this.drawFocusMarker(this.currentFocusedRawIndex);
      }
      return;
    }

    this.svg = svg;
    this.noteHeads = renderedHeads;

    // 기존 레이어 정리
    this.focusLayer?.remove();
    this.hintsLayer?.remove();
    this.labelsLayer?.remove();
    this.svg.querySelector('.score-focus-layer')?.remove();
    this.svg.querySelector('.score-hints-layer')?.remove();
    this.svg.querySelector('.score-labels-layer')?.remove();

    // 1. 포커스 배경 레이어 (음표 주위 스포트라이트)
    this.focusLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.focusLayer.setAttribute('class', 'score-focus-layer');
    this.svg.append(this.focusLayer);

    // 2. 힌트 레이어 (디딤돌, 화살표 등 전면 오버레이)
    this.hintsLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.hintsLayer.setAttribute('class', 'score-hints-layer');
    this.svg.append(this.hintsLayer);

    // 계이름 라벨 레이어 생성
    this.labelsLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.labelsLayer.setAttribute('class', 'score-labels-layer');
    this.svg.append(this.labelsLayer);

    // 라벨 텍스트 엘리먼트 초기화
    this.scoreLabels = this.noteHeads.map((head, index) => {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('class', 'score-syllable');
      this.labelsLayer.append(label);

      if (this.confirmedLabels[index]) {
        this.positionScoreLabel(index, label);
        label.textContent = this.confirmedLabels[index];
        label.classList.add('is-confirmed');
        label.style.opacity = '1';
      } else {
        label.style.opacity = '0';
      }

      return label;
    });

    // 현재 포커스 중이던 음표가 있다면 새 SVG에 즉시 복원
    if (this.currentFocusedRawIndex !== null) {
      this.drawFocusMarker(this.currentFocusedRawIndex);
    }
  }

  positionScoreLabel(index, targetLabel = null) {
    const head = this.noteHeads[index];
    const label = targetLabel || this.scoreLabels[index];
    if (!head || !label) return;

    try {
      const box = head.getBBox();
      const point = this.svgRootPoint(head, box.x + box.width / 2, box.y + box.height + 14);
      label.setAttribute('x', point.x);
      label.setAttribute('y', point.y);
    } catch {
      // getBBox 오류 시 무시
    }
  }

  svgRootPoint(element, x, y) {
    if (!this.svg) return { x, y };
    const point = this.svg.createSVGPoint();
    point.x = x;
    point.y = y;
    const elCTM = element?.getScreenCTM?.();
    const svgCTM = this.svg?.getScreenCTM?.();
    if (!elCTM || !svgCTM) {
      return { x, y };
    }
    try {
      return point.matrixTransform(elCTM).matrixTransform(svgCTM.inverse());
    } catch {
      return { x, y };
    }
  }

  hintLedger(pitch, x, y, className = 'score-hint-ledger') {
    if (pitch?.step !== 'C' || pitch?.octave !== 4) return null;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', className);
    line.setAttribute('x1', x - 9);
    line.setAttribute('x2', x + 9);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    return line;
  }

  getHeadCenter(rawNoteIndex) {
    const head = this.noteHeads[rawNoteIndex];
    if (!head) return null;
    try {
      const box = head.getBBox();
      if (!box || (box.width === 0 && box.height === 0 && box.x === 0 && box.y === 0)) {
        const r = head.getBoundingClientRect();
        const svgRect = this.svg?.getBoundingClientRect();
        if (svgRect && r.width > 0) {
          return {
            x: r.left - svgRect.left + r.width / 2,
            y: r.top - svgRect.top + r.height / 2
          };
        }
      }
      return this.svgRootPoint(head, box.x + box.width / 2, box.y + box.height / 2);
    } catch {
      try {
        const r = head.getBoundingClientRect();
        const svgRect = this.svg?.getBoundingClientRect();
        if (svgRect) {
          return {
            x: r.left - svgRect.left + r.width / 2,
            y: r.top - svgRect.top + r.height / 2
          };
        }
      } catch {}
      return null;
    }
  }

  /**
   * 실제 악보 음표 머리의 75% 크기(반지름 rx, ry) 산출
   * 가로 장축 : 세로 단축 = 1.45 : 1 비율을 수학적으로 강제하여 악보 음표와 일치
   * 좁은 구간(isTight=true)인 경우 65% 크기로 슬림화
   * @param {boolean} isTight 기준음과 목표음 간격이 좁은지 여부
   * @returns {{ rx: number, ry: number }}
   */
  getNoteHeadDimensions(isTight = false) {
    const scale = isTight ? 0.65 : 0.75;
    let baseWidth = 13.5;
    if (this.noteHeads && this.noteHeads.length > 0) {
      try {
        const box = this.noteHeads[0].getBBox();
        if (box.width > 0) {
          // 기둥(stem) 등으로 왜곡된 width를 11~15px 범위로 클램핑
          baseWidth = Math.max(11, Math.min(15, box.width));
        }
      } catch {
        // 무시
      }
    }
    const rx = Math.round((baseWidth / 2) * scale * 100) / 100;
    const ry = Math.round((rx / 1.45) * 100) / 100;
    return { rx, ry };
  }

  /**
   * 악보 음표 머리와 동일한 가로 타원 및 오른쪽 위 기울기(-20도) SVG 타원 요소 생성
   * @param {number} cx 중심 X좌표
   * @param {number} cy 중심 Y좌표
   * @param {number} rx X축 장축 반경 (가로)
   * @param {number} ry Y축 단축 반경 (세로)
   * @returns {SVGEllipseElement}
   */
  createHintNotehead(cx, cy, rx, ry) {
    const ellipse = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    ellipse.setAttribute('cx', cx);
    ellipse.setAttribute('cy', cy);
    ellipse.setAttribute('rx', rx);
    ellipse.setAttribute('ry', ry);
    ellipse.setAttribute('transform', `rotate(-20, ${cx}, ${cy})`);
    return ellipse;
  }

  clearFocusMarker() {
    this.focusLayer?.querySelector('.score-focus-marker')?.remove();
    this.hintsLayer?.querySelector('.score-focus-marker')?.remove();
    this.svg?.querySelectorAll('.vf-notehead.notehead-focused')?.forEach(el => {
      el.classList.remove('notehead-focused', 'is-wrong');
    });
    this.svg?.querySelectorAll('.vf-notehead.note-focused')?.forEach(el => {
      el.classList.remove('note-focused');
      el.style.removeProperty('fill');
      el.querySelectorAll('path, ellipse').forEach(p => {
        p.style.removeProperty('fill');
        p.style.removeProperty('stroke');
      });
    });
  }

  drawFocusMarker(rawNoteIndex) {
    this.currentFocusedRawIndex = rawNoteIndex;
    this.clearFocusMarker();
    const head = this.noteHeads[rawNoteIndex];
    if (!head || !this.svg) return;

    // 옵션 2-A: 기둥/꼬리와 분리하여 계이름을 결정하는 음표 머리(Head) 자체에 네온 골드 아우라 부여
    head.classList.add('notehead-focused');
  }

  triggerSuccessFeedback(rawNoteIndex = this.currentFocusedRawIndex) {
    const head = (rawNoteIndex !== null && rawNoteIndex !== undefined) ? this.noteHeads[rawNoteIndex] : null;
    if (head) {
      head.classList.remove('is-wrong');
      void head.getBoundingClientRect(); // reflow
      head.classList.add('is-success');
      setTimeout(() => head?.classList.remove('is-success'), 280);
    }
  }

  triggerWrongFeedback() {
    const head = (this.currentFocusedRawIndex !== null) ? this.noteHeads[this.currentFocusedRawIndex] : null;
    if (head) {
      head.classList.remove('is-wrong');
      void head.getBoundingClientRect();
      head.classList.add('is-wrong');
      setTimeout(() => head?.classList.remove('is-wrong'), 300);
    }
  }

  markConfirmed(rawNoteIndex, solfegeText) {
    this.confirmedLabels[rawNoteIndex] = solfegeText;
    const label = this.scoreLabels[rawNoteIndex];
    if (label) {
      this.positionScoreLabel(rawNoteIndex, label);
      label.textContent = solfegeText;
      label.classList.remove('is-fading');
      label.classList.add('is-confirmed');
      label.style.opacity = '1';
    }
  }

  showFadingHint(rawNoteIndex, solfegeText) {
    const label = this.scoreLabels[rawNoteIndex];
    if (label && !label.classList.contains('is-confirmed')) {
      this.positionScoreLabel(rawNoteIndex, label);
      label.textContent = solfegeText;
      label.style.removeProperty('opacity');
      label.classList.add('is-fading');
    }
  }

  clearFadingHint(rawNoteIndex) {
    const label = this.scoreLabels[rawNoteIndex];
    if (label && !label.classList.contains('is-confirmed')) {
      label.classList.remove('is-fading');
      label.textContent = '';
      label.style.opacity = '0';
    }
  }

  drawStepOrigin(context, currentRawIndex, lastRawIndex) {
    if (!this.hintsLayer) return;
    const fromHead = lastRawIndex !== null ? this.noteHeads[lastRawIndex] : null;
    const targetHead = this.noteHeads[currentRawIndex];
    if (!targetHead) return;

    const targetCenter = this.getHeadCenter(currentRawIndex);
    if (!targetCenter) return;

    const isNewLineOrAnchor = Boolean(context.isNewLine || !fromHead);
    const stepCount = context.stepCount || 1;
    let startPoint;

    if (isNewLineOrAnchor) {
      // 새 줄이거나 기준음 앵커 도약인 경우:
      let minAllowedX = 46; // 새 줄인 경우 음자리표/조표 최소 안전 마진

      // [1번 수정] 직전 연주 음(fromHead) 및 악보상 바로 앞 물리적 음표(immHead, 예: 붙임줄 음표) 침범 방지
      const immIndex = currentRawIndex > 0 ? currentRawIndex - 1 : null;
      const immHead = immIndex !== null ? this.noteHeads[immIndex] : null;

      [fromHead, immHead].forEach(headEl => {
        if (!headEl) return;
        try {
          const box = headEl.getBBox();
          const rightPt = this.svgRootPoint(headEl, box.x + box.width, box.y);
          const centerPt = this.svgRootPoint(headEl, box.x + box.width / 2, box.y);
          minAllowedX = Math.max(minAllowedX, rightPt.x + 28, centerPt.x + 36);
        } catch {}
      });

      // 앵커음부터 목표음까지 필요한 적정 간격 (과도하게 앞선 음을 침범하지 않음)
      const neededSpan = Math.max(34, 16 + stepCount * 18);
      let anchorX;

      if (targetCenter.x - neededSpan >= minAllowedX) {
        // 앞 음과 여백이 충분할 때: 앞 음에 들러붙지 않고 목표음 앞 적정 거리에 안착
        anchorX = targetCenter.x - neededSpan;
      } else {
        // 공간이 좁을 때: 최소 안전 여백(minAllowedX)을 지키되, 너무 목표음에 바짝 붙지 않도록 균형 조정
        anchorX = Math.min(minAllowedX, targetCenter.x - 24);
      }

      startPoint = {
        x: anchorX,
        y: targetCenter.y - (diatonicIndex(context.fromPitch) - diatonicIndex(context.targetPitch)) * STAFF_STEP
      };
    } else {
      // 직전 음 위에 겹쳐 표시할 때: 음표 머리 부분 중앙에 정확히 정렬
      startPoint = this.getHeadCenter(lastRawIndex);
    }

    if (!startPoint) return;
    context.startPoint = startPoint;

    const availableDx = Math.abs(targetCenter.x - startPoint.x);
    const isTight = availableDx < 45;
    const { rx, ry } = this.getNoteHeadDimensions(isTight);

    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'score-step-origin');

    // 악보상 음표 머리의 75%(좁은 구간 65%) 크기 및 기울어진 방향(-20도)을 일치시킨 기준음 타원
    const ellipse = this.createHintNotehead(startPoint.x, startPoint.y, rx, ry);

    const ledger = this.hintLedger(context.fromPitch, startPoint.x, startPoint.y);
    if (ledger) group.append(ledger);

    group.append(ellipse);

    // [중요 수정] 이전 음이 그대로 기준음이 된 경우에는 이미 직전 음에 계이름이 표시되어 있으므로
    // 추가로 계이름을 표시하지 않음 (글자 중복 및 겹침 방지).
    // 새 줄이거나 가상 앵커인 경우에만 음표 아래에 계이름 표시.
    if (isNewLineOrAnchor) {
      const name = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      name.setAttribute('class', 'score-step-origin-name');
      name.setAttribute('x', startPoint.x);
      name.setAttribute('y', startPoint.y + ry + 12);
      name.setAttribute('text-anchor', 'middle');
      name.textContent = getSolfegeLabel(context.fromPitch);
      group.append(name);
    }

    this.hintsLayer.append(group);

    // [3-C 줄-칸 가이드] 출발음과 목표음 사이의 줄/칸 인지 사다리 가이드 렌더링 (라벨링 제외)
    this.drawLineSpaceGuide(context, currentRawIndex);
  }

  /**
   * [3-C & 4번 수정] 출발음과 목표음 사이의 오선 줄(Line)과 칸(Space)을 시각적으로 인지시키는 스캐폴딩 가이드 (텍스트 라벨 없이 부드러운 밴드만 제공)
   */
  drawLineSpaceGuide(context, currentRawIndex) {
    this.hintsLayer?.querySelectorAll('.score-line-space-guide').forEach(g => g.remove());
    if (!this.hintsLayer || !context.startPoint || !context.fromPitch || !context.targetPitch) return;

    const targetCenter = this.getHeadCenter(currentRawIndex);
    if (!targetCenter) return;

    const fromIdx = diatonicIndex(context.fromPitch);
    const targetIdx = diatonicIndex(context.targetPitch);
    if (fromIdx === targetIdx) return;

    const minIdx = Math.min(fromIdx, targetIdx);
    const maxIdx = Math.max(fromIdx, targetIdx);

    const startX = Math.min(context.startPoint.x, targetCenter.x) - 10;
    const endX = Math.max(context.startPoint.x, targetCenter.x) + 10;
    const width = Math.max(20, endX - startX);

    const guideGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    guideGroup.setAttribute('class', 'score-line-space-guide');

    for (let idx = minIdx; idx <= maxIdx; idx++) {
      const y = targetCenter.y - (idx - targetIdx) * STAFF_STEP;
      const isLine = (idx % 2 === 0);

      if (isLine) {
        // 오선 줄(Line): 얇은 점선 라인
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('class', 'guide-line');
        line.setAttribute('x1', startX);
        line.setAttribute('x2', endX);
        line.setAttribute('y1', y);
        line.setAttribute('y2', y);
        guideGroup.append(line);
      } else {
        // 오선 칸(Space): 부드러운 반투명 소프트 밴드
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('class', 'guide-space');
        rect.setAttribute('x', startX);
        rect.setAttribute('y', y - STAFF_STEP / 2);
        rect.setAttribute('width', width);
        rect.setAttribute('height', STAFF_STEP);
        rect.setAttribute('rx', 2);
        guideGroup.append(rect);
      }
    }

    // 디딤돌 음표 뒤에 깔리도록 hintsLayer의 최하단에 삽입
    this.hintsLayer.prepend(guideGroup);
  }

  drawStepHint(pitch, index, total, context, currentRawIndex) {
    if (!this.hintsLayer) return;
    const targetCenter = this.getHeadCenter(currentRawIndex);
    if (!targetCenter || !context.startPoint) return;

    const start = context.startPoint;
    const availableDx = Math.abs(targetCenter.x - start.x);
    const stepDx = availableDx / (total + 1);
    const isTight = stepDx < 22 || availableDx < 55;
    const { rx, ry } = this.getNoteHeadDimensions(isTight);

    // [순수 균등 분할] 목표음 앞의 인위적 최소 여백을 완전 제거하고,
    // 출발음부터 목표음까지 전체 구간을 완전히 동일한 보폭으로 균등 분배
    const progress = (index + 1) / (total + 1);
    const x = start.x + (targetCenter.x - start.x) * progress;
    const y = start.y + (targetCenter.y - start.y) * progress;

    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'score-step-hint');

    // 악보 음표 머리의 75%(좁은 구간 65%) 크기 및 -20도 회전 경과음 디딤돌 타원
    const ellipse = this.createHintNotehead(x, y, rx, ry);

    const ledger = this.hintLedger(pitch, x, y);
    if (ledger) group.append(ledger);

    // [3번 수정] 인위적인 staggerOffset 제거: 음표 머리의 실제 Y 좌표에 연동하여 자연스러운 경사 유지
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('class', 'score-step-hint-name');
    text.setAttribute('x', x);
    text.setAttribute('y', y + ry + 12);
    text.setAttribute('text-anchor', 'middle');
    text.textContent = getSolfegeLabel(pitch);

    group.append(ellipse, text);
    this.hintsLayer.append(group);
  }

  drawIntervalArrow(currentRawIndex, lastRawIndex, context) {
    this.hintsLayer?.querySelectorAll('.score-interval-arrow').forEach(a => a.remove());
    const end = this.getHeadCenter(currentRawIndex);
    if (!end || !this.hintsLayer) return;

    // 직전에 물리적 음표(예: 붙임줄로 이어진 음표)가 있다면 그 물리적 음표에서 화살표 출발
    let originIndex = lastRawIndex;
    if (currentRawIndex > 0 && lastRawIndex !== null && currentRawIndex - 1 > lastRawIndex) {
      originIndex = currentRawIndex - 1;
    }

    const start = (context?.isNewLine || lastRawIndex === null)
      ? context?.startPoint
      : (this.getHeadCenter(originIndex) || context?.startPoint);
    if (!start) return;

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < 8) return;

    const ux = dx / length;
    const uy = dy / length;

    // [2번 수정] 목표음 머리(반경 ~6.8px)와 겹치지 않도록 끝점 마진 7.0px 적용
    const targetMargin = 7.0;
    const x2 = end.x - ux * targetMargin;
    const y2 = end.y - uy * targetMargin;

    // 좁은 간격 감지: 화살표 머리를 날렵하고 세련되게 조절 (중간 크기 3.5px)
    const isTight = length < 55;
    const headSize = isTight ? 3.5 : Math.min(5.2, Math.max(3.8, length * 0.11));
    const side = headSize * 0.5; // 날렵한 화살촉 가로 비율

    const x1 = start.x + ux * 6;
    const y1 = start.y + uy * 6;

    const baseX = x2 - ux * headSize;
    const baseY = y2 - uy * headSize;
    const px = -uy * side;
    const py = ux * side;

    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'score-interval-arrow');

    const shaftLength = Math.hypot(baseX - x1, baseY - y1);
    const shaft = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shaft.setAttribute('class', 'arrow-shaft');
    shaft.setAttribute('d', `M${x1} ${y1}L${baseX} ${baseY}`);
    shaft.style.setProperty('--shaft-len', `${shaftLength.toFixed(1)}px`);
    shaft.style.strokeDasharray = `${shaftLength.toFixed(1)}`;
    shaft.style.strokeDashoffset = `${shaftLength.toFixed(1)}`;

    const headPoly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    headPoly.setAttribute('class', 'arrow-head');
    headPoly.setAttribute('points', `${x2},${y2} ${baseX + px},${baseY + py} ${baseX - px},${baseY - py}`);

    group.append(shaft, headPoly);
    this.hintsLayer.append(group);
  }

  showWrongNote(rawNoteIndex, wrongMidi, expectedPitch) {
    clearTimeout(this.wrongNoteClearTimer);
    this.wrongNoteClearTimer = null;
    this.wrongNoteMarker?.remove();
    this.wrongNoteMarker = null;
    const head = this.noteHeads[rawNoteIndex];
    if (!head || !this.hintsLayer) return;

    const center = this.getHeadCenter(rawNoteIndex);
    if (!center) return;

    const { rx, ry } = this.getNoteHeadDimensions(false);
    // [맥락 기반 오답 피치] 단순 MIDI 숫자가 아닌 학생이 본 목표음 위치와 조표/임시표 문맥을 반영하여 오답 표기
    const wrongPitch = resolveWrongPitch(wrongMidi, expectedPitch);
    const diff = diatonicIndex(wrongPitch) - diatonicIndex(expectedPitch);
    const y = center.y - diff * STAFF_STEP;

    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'score-wrong-note');

    // [5번 수정] 오답 힌트 시에도 정답음과 오답음 사이 줄-칸 가이드(부드러운 반투명 밴드) 제공
    const expIdx = diatonicIndex(expectedPitch);
    const wrgIdx = diatonicIndex(wrongPitch);
    if (expIdx !== wrgIdx) {
      const minIdx = Math.min(expIdx, wrgIdx);
      const maxIdx = Math.max(expIdx, wrgIdx);
      const guideX = center.x - 14;
      const guideW = rx * 2 + 36;

      const wrongGuide = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      wrongGuide.setAttribute('class', 'score-wrong-line-space-guide');

      for (let idx = minIdx; idx <= maxIdx; idx++) {
        const stepY = center.y - (idx - expIdx) * STAFF_STEP;
        const isLine = (idx % 2 === 0);

        if (isLine) {
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('class', 'guide-line wrong-guide-line');
          line.setAttribute('x1', guideX);
          line.setAttribute('x2', guideX + guideW);
          line.setAttribute('y1', stepY);
          line.setAttribute('y2', stepY);
          wrongGuide.append(line);
        } else {
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('class', 'guide-space wrong-guide-space');
          rect.setAttribute('x', guideX);
          rect.setAttribute('y', stepY - STAFF_STEP / 2);
          rect.setAttribute('width', guideW);
          rect.setAttribute('height', STAFF_STEP);
          rect.setAttribute('rx', 2);
          wrongGuide.append(rect);
        }
      }
      group.append(wrongGuide);
    }

    // 악보 음표 머리의 75% 크기 및 -20도 회전 오답 음표 타원
    const ellipse = this.createHintNotehead(center.x, y, rx, ry);

    const ledger = this.hintLedger(wrongPitch, center.x, y, 'score-wrong-ledger');
    if (ledger) group.append(ledger);

    // 오답 힌트의 계이름 표시는 음표 우측에 배치 (클래스 부여로 OSMD 17px 강제 오버라이드 방지 및 12px 통일)
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('class', 'score-wrong-note-name');
    text.setAttribute('x', center.x + rx + 4);
    text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'start');
    text.textContent = getSolfegeLabel(wrongPitch);

    group.append(ellipse, text);
    this.hintsLayer.append(group);
    this.wrongNoteMarker = group;
    this.wrongNoteShownAt = Date.now();
  }

  /**
   * [옵션 C] 조표 또는 임시표 미적용 오답 시 악보 상의 해당 조표/임시표 기호를 코랄색으로 3회 점멸
   * @param {Object} currentNote 
   */
  blinkAccidentalOrKeySignature(currentNote) {
    if (!this.svg || !currentNote) return;
    const head = this.noteHeads[currentNote.rawNoteIndex];
    if (!head) return;

    let targetElement = null;

    // 1. 해당 음표 바로 앞의 임시표(제자리표 ♮, ♯, ♭) 물리적 SVG Path 탐색 (클래스명 유무와 무관)
    try {
      const container = head.closest('.vf-stavenote') || head.closest('.vf-measure') || head.parentElement;
      if (container) {
        const headBox = head.getBBox();
        const headLeftPt = this.svgRootPoint(head, headBox.x, headBox.y + headBox.height / 2);

        // 컨테이너 내의 음표 머리/기둥을 제외한 모든 패스 중 음표 머리 바로 앞(35px 이내)의 글리프 탐색
        const paths = Array.from(container.querySelectorAll('path:not(.vf-notehead):not(.vf-stem)'));
        for (const p of paths) {
          try {
            const pBox = p.getBBox();
            const pRightPt = this.svgRootPoint(p, pBox.x + pBox.width, pBox.y + pBox.height / 2);
            // 음표 머리 좌측 바로 앞 (우측 끝이 음표 머리 왼쪽 기준 -4px ~ +32px 이내) & 수직 오차 22px 이내
            const dx = headLeftPt.x - pRightPt.x;
            const dy = Math.abs(headLeftPt.y - pRightPt.y);
            if (dx >= -4 && dx <= 32 && dy < 22 && pBox.width < 25 && pBox.height < 45) {
              targetElement = p;
              break;
            }
          } catch {}
        }
      }
    } catch {}

    // 2. 음표에 임시표가 없을 때만 해당 줄(System)의 조표(Key Signature) 탐색
    if (!targetElement) {
      try {
        const headRect = head.getBoundingClientRect();
        const allMeasures = Array.from(this.svg.querySelectorAll('.vf-measure'));
        // 같은 줄(System)에 속하는 마디들 필터링 (수직 위치 차이 60px 이내)
        const sameSystemMeasures = allMeasures.filter(m => {
          const r = m.getBoundingClientRect();
          return Math.abs(r.top - headRect.top) < 60;
        });

        const firstMeasure = sameSystemMeasures[0] || allMeasures[0];
        if (firstMeasure) {
          targetElement = firstMeasure.querySelector('.vf-keysignature');
          if (!targetElement) {
            // .vf-keysignature 클래스가 없는 경우 음자리표와 첫 음표 사이의 패스 탐색
            const clef = firstMeasure.querySelector('.vf-clef');
            const paths = Array.from(firstMeasure.querySelectorAll('path:not(.vf-notehead):not(.vf-stem)'));
            if (clef && paths.length > 0) {
              const clefBox = clef.getBBox();
              const candidate = paths.find(p => {
                const b = p.getBBox();
                return b.x > clefBox.x + clefBox.width && b.x < clefBox.x + clefBox.width + 70 && b.width < 25 && b.height < 45;
              });
              if (candidate) targetElement = candidate;
            }
          }
        }
      } catch {}
    }

    // 3. 찾은 기호에 코랄 점멸 클래스 부여
    if (targetElement) {
      targetElement.classList.remove('keysig-accidental-blink');
      void targetElement.getBoundingClientRect(); // reflow
      targetElement.classList.add('keysig-accidental-blink');
      setTimeout(() => {
        targetElement.classList.remove('keysig-accidental-blink');
      }, 1400);
    }
  }

  clearWrongNote(force = false) {
    if (!force && this.wrongNoteMarker && this.wrongNoteShownAt) {
      const elapsed = Date.now() - this.wrongNoteShownAt;
      const remaining = 850 - elapsed;
      if (remaining > 0 && !this.wrongNoteClearTimer) {
        this.wrongNoteClearTimer = setTimeout(() => {
          this.wrongNoteClearTimer = null;
          this.wrongNoteMarker?.remove();
          this.wrongNoteMarker = null;
          this.wrongNoteShownAt = 0;
        }, remaining);
        return;
      }
    }
    clearTimeout(this.wrongNoteClearTimer);
    this.wrongNoteClearTimer = null;
    this.wrongNoteMarker?.remove();
    this.wrongNoteMarker = null;
    this.wrongNoteShownAt = 0;
  }

  clearTransientHints() {
    this.hintsLayer?.querySelectorAll('.score-step-hint, .score-step-origin, .score-interval-arrow, .score-line-space-guide').forEach(h => h.remove());
  }

  reset() {
    this.clearFocusMarker();
    this.svg?.querySelectorAll('.vf-notehead.is-success')?.forEach(el => el.classList.remove('is-success'));
    this.clearWrongNote(true);
    this.clearTransientHints();
    this.svg?.querySelectorAll('.keysig-accidental-blink').forEach(el => el.classList.remove('keysig-accidental-blink'));
    this.currentFocusedRawIndex = null;
    this.confirmedLabels = {};
    this.scoreLabels.forEach(label => {
      label.textContent = '';
      label.classList.remove('is-confirmed', 'is-fading');
      label.style.opacity = '0';
    });
    this.svg?.querySelectorAll('.score-syllable')?.forEach(el => {
      el.textContent = '';
      el.classList.remove('is-confirmed', 'is-fading');
      el.style.opacity = '0';
    });
    this.hintsLayer?.replaceChildren();
    this.focusLayer?.replaceChildren();
  }
}
