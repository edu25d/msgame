/**
 * score-viewer.js
 * OpenSheetMusicDisplay(OSMD) 악보 렌더링 및 포커스 마커 기준 무결점 스냅 스크롤 제어 모듈
 */

// 악보 창(203px) 내에서 오선 중앙선(3번째 선)이 위치할 이상적 목표 높이 비율
// 실측 기준: 203px 악보 창 기준 정확히 76px 지점 (기존 83px에서 7px 상향 조정, 76 / 203 ≈ 0.374384)
export const STAFF_TARGET_RATIO = 76 / 203;

export class ScoreViewer {
  constructor(containerElement, scrollElement) {
    this.container = containerElement;
    this.scrollEl = scrollElement;
    this.osmd = null;
    this.svg = null;
    this.currentSystemIndex = null;
    this.systemStaffCenters = [];
    this.systemScrollTops = [];
    this.noteToSystemIndex = [];

    // 브라우저 창 크기 변경 시 동적 여백 및 오선 높이 자동 재조율
    window.addEventListener('resize', () => {
      if (this.svg && this.systemStaffCenters.length > 0) {
        this.setupSystemPositions();
      }
    });
  }

  /**
   * MusicXML의 가사 폰트 크기·색상을 앱 자체 기준값으로 강제 (입력 XML 설정에 의존하지 않음)
   * DOM 파싱 없이 문자열 치환으로 처리하여 SVG 구조 변형을 방지한다.
   * @param {string} xml 원본 MusicXML 문자열
   * @param {number} size 강제할 가사 폰트 크기 (pt)
   * @param {string} color 가사 색상 (#RRGGBB)
   * @returns {string} 수정된 MusicXML 문자열
   */
  forceLyricStyle(xml, size, color) {
    let result = xml;
    // 1. <lyric-font> font-size 교체 또는 추가
    if (result.includes('<lyric-font')) {
      result = result.replace(
        /(<lyric-font\b[^>]*?)font-size="[^"]*"/,
        `$1font-size="${size}"`
      );
    } else if (result.includes('</defaults>')) {
      result = result.replace(
        '</defaults>',
        `<lyric-font font-size="${size}"/>\n    </defaults>`
      );
    }
    // 2. 각 <lyric> 요소에 color 속성 강제 (<lyric-font>, <lyric-language> 등은 제외)
    if (color) {
      result = result.replace(/(<lyric\s)color="[^"]*"\s*/g, '$1');
      result = result.replace(/<lyric\s/g, `<lyric color="${color}" `);
    }
    return result;
  }

  /**
   * 음표/쉼표의 박자 지속시간에 따른 시각적 간격 가중치 산출 (표준 악보 조판학 Gould 비율 기반)
   * 2분음표 뒤의 간격 > 4분음표 뒤의 간격 > 8분음표 뒤의 간격 확보
   * @param {Element} noteEl MusicXML <note> 요소
   * @param {number} divisions 마디의 박자 divisions 값
   * @returns {number} 시각적 간격 가중치
   */
  getNoteVisualWeight(noteEl, divisions = 1) {
    const typeEl = noteEl.querySelector('type');
    const hasDot = Boolean(noteEl.querySelector('dot'));
    let type = typeEl?.textContent?.trim();

    if (!type) {
      const durEl = noteEl.querySelector('duration');
      const dur = durEl ? parseFloat(durEl.textContent) : divisions;
      const quarters = dur / (divisions || 1);
      if (quarters >= 3.5) type = 'whole';
      else if (quarters >= 1.75) type = 'half';
      else if (quarters >= 0.85) type = 'quarter';
      else if (quarters >= 0.4) type = 'eighth';
      else type = '16th';
    }

    let weight = 1.0;
    switch (type) {
      case '16th':
      case '32nd':
      case '64th':
        weight = 0.75;
        break;
      case 'eighth':
        weight = 1.0;
        break;
      case 'quarter':
        weight = 1.6;
        break;
      case 'half':
        weight = 2.5;
        break;
      case 'three-quarters':
        weight = 2.1;
        break;
      case 'whole':
        weight = 3.6;
        break;
      case 'breve':
        weight = 4.2;
        break;
      default:
        weight = 1.3;
        break;
    }

    if (hasDot) {
      weight *= 1.25;
    }

    return weight;
  }

  calculateSpacingSettings(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const measures = Array.from(doc.querySelectorAll('part > measure'));
    const totalMeasures = measures.length;

    // 못갖춘마디(0번 마디) 확인
    const firstMeasure = measures[0];
    const isPickup = firstMeasure?.getAttribute('implicit') === 'yes' || firstMeasure?.getAttribute('number') === '0';

    // 원본 악보에 명시적인 줄바꿈(new-system="yes" 또는 new-page="yes")이 있는지 확인
    const hasExplicitSystems = measures.some((m, idx) => {
      if (idx === 0) return false;
      const print = m.querySelector('print');
      return print?.getAttribute('new-system') === 'yes' || print?.getAttribute('new-page') === 'yes';
    });

    // [중요 수정] MuseScore 등에서 내보낸 고정 width 속성 제거
    // 고정 width가 남아있으면 OSMD가 가중치 기반으로 마디 폭을 자연스럽게 확장하지 못함
    measures.forEach(m => {
      m.removeAttribute('width');
    });

    // 현재 렌더링 영역의 가로폭 감지 (1.3배 줌 상태에 맞춰 유효 가로폭 산출)
    const zoom = 1.3;
    const rawWidth = this.container?.clientWidth || this.scrollEl?.clientWidth || window.innerWidth || 1200;
    const availableWidth = rawWidth / zoom;

    // 모바일/좁은 화면(화면 폭 860px 미만 또는 줌 유효폭 700px 미만)에서는 3마디/줄 적용
    const isNarrowScreen = rawWidth < 860 || availableWidth < 700;
    const baseMeasuresPerLine = isNarrowScreen ? 3 : 4;

    // 마디들을 줄(System) 단위로 그룹화
    const systems = [];
    let currentSystem = [];

    if (hasExplicitSystems) {
      measures.forEach((m, idx) => {
        const print = m.querySelector('print');
        const isNewSystem = idx > 0 && (print?.getAttribute('new-system') === 'yes' || print?.getAttribute('new-page') === 'yes');
        if (isNewSystem && currentSystem.length > 0) {
          systems.push(currentSystem);
          currentSystem = [];
        }
        currentSystem.push(m);
      });
      if (currentSystem.length > 0) {
        systems.push(currentSystem);
      }
    } else {
      measures.forEach((m, idx) => {
        const limit = (systems.length === 0 && isPickup) ? (baseMeasuresPerLine + 1) : baseMeasuresPerLine;
        if (currentSystem.length >= limit) {
          systems.push(currentSystem);
          currentSystem = [];
        }
        currentSystem.push(m);
      });
      if (currentSystem.length > 0) {
        systems.push(currentSystem);
      }
    }

    // 각 마디별 음가 가중치 및 음표 개수 분석
    let currentDivisions = 1;
    const measureStats = measures.map((m, mIdx) => {
      const divEl = m.querySelector('attributes > divisions');
      if (divEl) {
        const parsed = parseFloat(divEl.textContent);
        if (parsed > 0) currentDivisions = parsed;
      }

      const notes = Array.from(m.querySelectorAll('note'));
      const visibleNotes = notes.filter(n => {
        if (n.getAttribute('print-object') === 'no') return false;
        if (n.querySelector('chord')) return false; // 화음은 가로 공간 공유
        return true;
      });

      const noteCount = visibleNotes.length;
      let totalWeight = 0;
      let hasLongNote = false;

      visibleNotes.forEach(n => {
        const w = this.getNoteVisualWeight(n, currentDivisions);
        totalWeight += w;
        if (w >= 2.5) hasLongNote = true; // 2분음표 이상 포함 여부
      });

      // 빈 마디(온쉼표 등)인 경우 기본 4박 가중치 부여
      if (noteCount === 0 || totalWeight === 0) {
        totalWeight = 3.6;
      }

      return {
        measureEl: m,
        measureIndex: mIdx,
        noteCount: Math.max(1, noteCount),
        totalWeight,
        hasLongNote
      };
    });

    // 시스템(줄) 단위로 각 마디의 osmdWidthFactor 강력 배정
    // VexFlow의 기본 최소 너비는 음표 개수(noteCount)에 정비례하므로,
    // 2분음표/온음표처럼 음표 개수가 적은 마디가 쪼그라들지 않고
    // 음가 가중치(totalWeight)에 맞춰 마디 폭이 넓게 유지되도록 보정 계수 산출
    systems.forEach(sysMeasures => {
      const sysStats = sysMeasures.map(m => measureStats.find(s => s.measureEl === m)).filter(Boolean);
      if (sysStats.length === 0) return;

      const avgWeight = sysStats.reduce((acc, s) => acc + s.totalWeight, 0) / sysStats.length;
      const avgCount = sysStats.reduce((acc, s) => acc + s.noteCount, 0) / sysStats.length;
      const baseDensity = avgWeight / (avgCount || 1);

      sysStats.forEach(s => {
        const measureDensity = s.totalWeight / s.noteCount;
        let factor = measureDensity / (baseDensity || 1);

        // 2분음표 등 긴 음이 포함되었을 때 쪼그라들지 않도록 적절히 보정 (과도한 팽창 2.15 -> 1.35로 정상화)
        if (s.hasLongNote && s.noteCount <= 3) {
          factor = Math.max(factor, 1.35);
        }

        const clampedFactor = Math.round(Math.max(0.85, Math.min(1.48, factor)) * 100) / 100;
        s.measureEl.setAttribute('osmdWidthFactor', clampedFactor.toString());
      });

      // 한 줄(4마디) 내의 Factor 총합이 과도해져 4번째 마디가 다음 줄로 밀려나지 않도록 안전 정규화
      const sumFactor = sysStats.reduce((sum, s) => {
        return sum + parseFloat(s.measureEl.getAttribute('osmdWidthFactor') || '1.0');
      }, 0);
      const maxAllowedSum = sysStats.length * 1.15; // 4마디 기준 최대 4.60
      if (sumFactor > maxAllowedSum) {
        const scaleDown = maxAllowedSum / sumFactor;
        sysStats.forEach(s => {
          const cur = parseFloat(s.measureEl.getAttribute('osmdWidthFactor') || '1.0');
          const normalized = Math.round(cur * scaleDown * 100) / 100;
          s.measureEl.setAttribute('osmdWidthFactor', normalized.toString());
        });
      }
    });

    // 각 줄의 최대 가중치 밀도(시각적 가중치 합산) 계산
    let maxWeightedDensityInSystem = 0;
    systems.forEach(sysMeasures => {
      const sysStats = sysMeasures.map(m => measureStats.find(s => s.measureEl === m)).filter(Boolean);
      const sysWeightSum = sysStats.reduce((acc, s) => acc + s.totalWeight, 0);
      maxWeightedDensityInSystem = Math.max(maxWeightedDensityInSystem, sysWeightSum);
    });

    // 1단계: 음가 가중치 밀도 기반 기본 간격 계산 (1.3배 확대에 맞춘 최적 비례)
    let voiceSpacing = 1.05;
    if (maxWeightedDensityInSystem > 20) {
      voiceSpacing = Math.max(0.72, 1.05 - (maxWeightedDensityInSystem - 20) * 0.02);
    }

    // 2단계: 화면 축소 시 반응형 조절 및 최소 가독성 임계치 보장
    const MIN_READABLE_SPACING = 0.68;
    if (availableWidth < 1050 && availableWidth > 0) {
      const widthRatio = Math.max(0.72, availableWidth / 1050);
      voiceSpacing = Math.max(MIN_READABLE_SPACING, voiceSpacing * widthRatio);
    }

    const serializer = new XMLSerializer();
    const modifiedXml = serializer.serializeToString(doc);

    return {
      modifiedXml,
      measureStats,
      layout: {
        hasExplicitSystems,
        maxMeasuresPerLine: isPickup ? (baseMeasuresPerLine + 1) : baseMeasuresPerLine,
        stretchLastSystem: totalMeasures % baseMeasuresPerLine === 0,
        voiceSpacing: Math.round(voiceSpacing * 100) / 100
      }
    };
  }

  async render(xml) {
    if (!window.opensheetmusicdisplay) {
      throw new Error('OSMD 악보 렌더링 라이브러리를 불러오지 못했습니다. 네트워크 연결을 확인해 주세요.');
    }

    this.container.classList.remove('score-placeholder');
    this.container.innerHTML = '';
    this.currentSystemIndex = null;
    if (this.scrollEl) this.scrollEl.scrollTop = 0;

    const { modifiedXml, measureStats, layout } = this.calculateSpacingSettings(xml);

    this.osmd = new window.opensheetmusicdisplay.OpenSheetMusicDisplay(this.container, {
      autoResize: true,
      drawTitle: false,
      drawComposer: false,
      drawPartNames: false,
      backend: 'svg',
      followCursor: false,
      pageFormat: 'Endless',
      stretchLastSystemLine: layout.stretchLastSystem
    });

    // 악보 및 오선지 전체 요소 1.3배 벡터 확대
    this.osmd.Zoom = 1.3;

    const rules = this.osmd.rules;
    rules.PageTopMargin = 0;
    rules.PageBottomMargin = 0;
    rules.PageLeftMargin = 4;
    rules.PageRightMargin = 4;

    rules.MinimumDistanceBetweenSystems = 20.0;
    rules.MinSkyBottomDistBetweenSystems = 15.0;
    rules.StaffDistance = 120;
    rules.BetweenStaffDistance = 100;

    rules.RenderLyrics = true;
    rules.LyricsYOffsetToStaffHeight = 2;
    rules.RenderMeasureNumbers = false;
    rules.VoiceSpacingMultiplierVexflow = layout.voiceSpacing;

    // [중요 수정] SoftmaxFactorVexFlow를 15 -> 2.5로 대폭 완화
    // VexFlow가 긴 음표(2분음표 등)의 지속 시간에 비례하여 뒤쪽 시각적 간격을 충분히 넓히도록 보장
    rules.SoftmaxFactorVexFlow = 2.5;

    // 원본 악보에 명시적 줄바꿈(new-system="yes")이 있으면 OSMD의 강제 고정 마디 분할을 끄고(0)
    // 원본 악보의 줄 구분을 우선 따름. 단, 화면이 지나치게 좁으면 가독성 유지를 위해 OSMD가 자동 줄바꿈.
    rules.RenderXMeasuresPerLineAkaSystem = layout.hasExplicitSystems ? 0 : layout.maxMeasuresPerLine;
    rules.NewSystemAtXMLNewSystemAttribute = true;
    rules.NewPageAtXMLNewPageAttribute = true;

    // 가사 폰트 크기 기본 8pt -> 12pt (+4 확대) 및 음가 가중치 적용 XML 로드
    await this.osmd.load(this.forceLyricStyle(modifiedXml, 12, '#7D7D7D'));

    // OSMD Sheet SourceMeasures 객체 모델에도 WidthFactor 확실히 동기화
    if (this.osmd.Sheet?.SourceMeasures && Array.isArray(measureStats)) {
      measureStats.forEach(stat => {
        const sm = this.osmd.Sheet.SourceMeasures[stat.measureIndex];
        if (sm) {
          const factorStr = stat.measureEl.getAttribute('osmdWidthFactor');
          if (factorStr) {
            sm.WidthFactor = parseFloat(factorStr);
          }
        }
      });
    }

    await this.osmd.render();

    this.svg = this.container.querySelector('svg');

    // 뷰포트 창에 맞춰 첫 줄과 마지막 줄의 오선 중심(83px)을 수학적으로 일치시키는 상하 여백 및 스크롤 테이블 구성
    this.setupSystemPositions();

    return this.svg;
  }

  refreshSystems() {
    this.currentSystemIndex = null;
    this.setupSystemPositions();
  }

  /**
   * 렌더링된 SVG로부터 모든 오선 줄(System)의 중심 높이를 측정하여
   * - 스크롤 최상단(0)에서 첫 줄 오선이 정확히 83px(전체 높이 203px의 40.8%)에 오도록 paddingTop 설정
   * - 스크롤 최하단(max)에서 마지막 줄 오선이 정확히 83px에 멈추도록 paddingBottom 설정
   * - 각 줄(System k)별 고정 목표 scrollTop 테이블 구축
   * - 각 음표와 줄 번호 간 1:1 사전 매핑
   */
  setupSystemPositions() {
    const liveSvg = this.container?.querySelector('svg');
    if (!liveSvg || !this.scrollEl) return;
    this.svg = liveSvg;

    // 0. 초기화: 이전 패딩 및 마진 리셋
    this.container.classList.remove('score-placeholder');
    this.container.style.paddingTop = '0px';
    this.container.style.paddingBottom = '0px';
    liveSvg.style.marginTop = '0px';

    const svgRect = liveSvg.getBoundingClientRect();

    // 1. SVG 내의 모든 수평선 <path> 요소 추출 (길이 > 25px, y1 == y2)
    const paths = Array.from(liveSvg.querySelectorAll('path'));
    const hLines = [];
    paths.forEach(p => {
      const d = p.getAttribute('d') || '';
      const m = d.match(/^M\s*([\d.-]+)\s+([\d.-]+)\s*L\s*([\d.-]+)\s+([\d.-]+)$/);
      if (m) {
        const x1 = parseFloat(m[1]);
        const y1 = parseFloat(m[2]);
        const x2 = parseFloat(m[3]);
        const y2 = parseFloat(m[4]);
        if (Math.abs(y1 - y2) < 0.1 && Math.abs(x2 - x1) > 25) {
          hLines.push(Math.round(y1 * 10) / 10);
        }
      }
    });

    if (hLines.length === 0) return;

    // 2. Y좌표 정렬 및 1.5px 이내 미세 오차 병합 (동일 선 클러스터링)
    hLines.sort((a, b) => a - b);
    const uniqueY = [];
    for (let i = 0; i < hLines.length; i++) {
      if (uniqueY.length === 0) {
        uniqueY.push(hLines[i]);
      } else {
        const last = uniqueY[uniqueY.length - 1];
        if (Math.abs(hLines[i] - last) > 1.5) {
          uniqueY.push(hLines[i]);
        }
      }
    }

    // 3. [핵심 개선] 볼타 괄호 등 노이즈를 완벽 배제하고, '순수 5선(Staff)'만을 엄격히 검출
    // 오선은 반드시 등간격(간격 6.5px ~ 18px, 간격 간 오차 <= 2px)의 연속 5개 선으로 구성됨
    const staves = [];
    let idx = 0;
    while (idx <= uniqueY.length - 5) {
      const window = uniqueY.slice(idx, idx + 5);
      const g1 = window[1] - window[0];
      const g2 = window[2] - window[1];
      const g3 = window[3] - window[2];
      const g4 = window[4] - window[3];
      const avgGap = (g1 + g2 + g3 + g4) / 4;
      const maxDiff = Math.max(
        Math.abs(g1 - avgGap),
        Math.abs(g2 - avgGap),
        Math.abs(g3 - avgGap),
        Math.abs(g4 - avgGap)
      );

      if (avgGap >= 6.5 && avgGap <= 18.0 && maxDiff <= 2.0) {
        // window[2]가 오선의 정확한 중앙선(3번째 선)
        staves.push({
          topLine: window[0],
          centerLine: window[2],
          bottomLine: window[4],
          lines: window
        });
        idx += 5; // 오선 5선 확정 후 다음 줄로 점프
      } else {
        idx += 1; // 단독선(볼타선, 단일 덧줄 등)은 노이즈로 배제하고 다음 선 탐색
      }
    }

    // 예외 방어: 만약 엄격 검출에서 오선이 검출되지 않는 비정상 SVG인 경우의 폴백
    if (staves.length === 0) {
      const clusters = [];
      let cur = [];
      for (let i = 0; i < uniqueY.length; i++) {
        if (cur.length === 0 || uniqueY[i] - cur[cur.length - 1] < 20) {
          cur.push(uniqueY[i]);
        } else {
          if (cur.length >= 4) clusters.push(cur);
          cur = [uniqueY[i]];
        }
      }
      if (cur.length >= 4) clusters.push(cur);

      this.systemStaffCenters = clusters.map(c => (c[0] + c[c.length - 1]) / 2);
    } else {
      // 순수 5선의 가운데 3번째 선 좌표 등록
      this.systemStaffCenters = staves.map(s => s.centerLine);
    }

    if (this.systemStaffCenters.length === 0) return;

    const numSystems = this.systemStaffCenters.length;
    const y0 = this.systemStaffCenters[0];
    const yLast = this.systemStaffCenters[numSystems - 1];

    // 4. 뷰포트 창 높이 및 목표 오선 중심 높이 정의
    // 실측치: 203px 악보 창에서 사용자가 지정한 중앙 3번째 선 높이 (약 92px, 45.3%)
    const H_win = this.scrollEl.clientHeight || 203;
    const Y_target = Math.round(H_win * STAFF_TARGET_RATIO);

    // 5. 상단 여백 설정: scrollTop = 0 일 때 첫 줄(Line 1) 오선 3번째 선이 정확히 Y_target에 멈추도록 설정
    const topDiff = Y_target - y0;
    if (topDiff >= 0) {
      this.container.style.paddingTop = `${Math.round(topDiff)}px`;
      liveSvg.style.marginTop = '0px';
    } else {
      this.container.style.paddingTop = '0px';
      liveSvg.style.marginTop = `${Math.round(topDiff)}px`;
    }

    // 6. [핵심 개선] 하단 여백 설정: 스크롤 최하단(max)에서 마지막 줄 오선 3번째 선이 첫 줄과 완전히 동일하게 Y_target에 정렬
    // maxScrollTop = scrollHeight - H_win == yLast - y0
    // => 목표 scrollHeight = (yLast - y0) + H_win
    if (numSystems <= 1) {
      this.container.style.paddingBottom = '0px';
    } else {
      const targetScrollHeight = Math.round((yLast - y0) + H_win);
      const currentScrollHeight = this.scrollEl.scrollHeight;
      const neededBottomPadding = Math.max(0, targetScrollHeight - currentScrollHeight);
      this.container.style.paddingBottom = `${Math.round(neededBottomPadding)}px`;
    }

    // 7. 각 줄(System k)별 결정론적 고정 scrollTop 테이블 구축
    this.systemScrollTops = this.systemStaffCenters.map(yk => Math.max(0, Math.round(yk - y0)));

    // 8. 각 음표(notehead)를 해당하는 줄(System index)에 1:1 사전 매핑 (쉼표는 배제)
    let mappedSystems = [];
    if (this.osmd?.graphic?.measureList && this.osmd?.graphic?.MusicPages?.[0]?.MusicSystems) {
      const musicSystems = this.osmd.graphic.MusicPages[0].MusicSystems;
      this.osmd.graphic.measureList.forEach(col => {
        col.forEach(m => {
          const sysIdx = m.parentMusicSystem ? musicSystems.indexOf(m.parentMusicSystem) : 0;
          m.staffEntries?.forEach(se => {
            se.graphicalVoiceEntries?.forEach(gve => {
              gve.notes?.forEach(n => {
                if (!n.sourceNote?.isRest?.()) {
                  mappedSystems.push(Math.max(0, sysIdx));
                }
              });
            });
          });
        });
      });
    }

    if (mappedSystems.length > 0) {
      this.noteToSystemIndex = mappedSystems;
    } else {
      const freshSvgRect = liveSvg.getBoundingClientRect();
      const noteheads = this.getPitchNoteheads(liveSvg);
      this.noteToSystemIndex = noteheads.map(head => {
        const hRect = head.getBoundingClientRect();
        const headCenterYInSvg = (hRect.top - freshSvgRect.top) + hRect.height / 2;

        let closestIdx = 0;
        let minDiff = Infinity;
        this.systemStaffCenters.forEach((sysY, sIdx) => {
          const diff = Math.abs(headCenterYInSvg - sysY);
          if (diff < minDiff) {
            minDiff = diff;
            closestIdx = sIdx;
          }
        });
        return closestIdx;
      });
    }

    // 9. 초기 렌더링 시 첫 줄(Line 0) 위치로 즉시 스냅 (scrollTop = 0)
    this.currentSystemIndex = 0;
    this.scrollEl.scrollTop = 0;
  }

  /**
   * 실제 피치(소리) 음표 머리(Notehead) 요소들만 1:1로 수집 (쉼표 글리프 완벽 배제)
   * @param {SVGElement} [svg]
   * @returns {Element[]}
   */
  getPitchNoteheads(svg = this.svg) {
    if (!svg) return [];

    // 1. OSMD graphic 객체가 있으면 GraphicalNotes를 통해 실제 피치 음표만 1:1 역추적
    if (this.osmd?.graphic?.measureList) {
      const pitchHeads = [];
      this.osmd.graphic.measureList.forEach(col => {
        col.forEach(m => {
          m.staffEntries.forEach(se => {
            se.graphicalVoiceEntries.forEach(gve => {
              gve.notes.forEach(n => {
                if (!n.sourceNote.isRest()) {
                  const vfNote = Array.isArray(n.vfnote) ? n.vfnote[0] : n.vfnote;
                  if (vfNote?.attrs?.id) {
                    const snId = 'vf-' + vfNote.attrs.id;
                    const snEl = svg.getElementById ? svg.getElementById(snId) : svg.querySelector('#' + snId);
                    const head = snEl ? snEl.querySelector('.vf-notehead') : null;
                    if (head) pitchHeads.push(head);
                  }
                }
              });
            });
          });
        });
      });
      if (pitchHeads.length > 0) {
        return pitchHeads;
      }
    }

    // 2. Fallback: graphic 순회가 불가능할 때 VexFlow 쉼표 글리프(세로 높이 18px 초과) 배제
    const allHeads = Array.from(svg.querySelectorAll('.vf-notehead'));
    return allHeads.filter(head => {
      try {
        const b = head.getBBox();
        if (b.height > 18) return false;
      } catch (e) {}
      return true;
    });
  }

    /**
   * 해당 음표가 속한 줄(System)의 오선지를 사용자 지정 이상적 높이(83px)에 정밀 스냅 정렬
   * - 같은 줄을 연주하는 동안에는 스크롤 고정 (화면 출렁임 0%)
   * - 줄바꿈 시에만 해당 줄의 고정 scrollTop으로 부드럽게 이동
   * - 사용자가 수동으로 스크롤하여 탐색하다가 새 음표를 연주하면 해당 줄로 자동 재정렬
   * @param {number} rawNoteIndex 음표 인덱스
   * @param {boolean} forceScroll 강제 정렬 여부
   */
  centerStaffOfNote(rawNoteIndex, forceScroll = false) {
    if (!this.scrollEl || !this.systemScrollTops || this.systemScrollTops.length === 0) return;

    const systemIndex = (this.noteToSystemIndex && this.noteToSystemIndex[rawNoteIndex] !== undefined)
      ? this.noteToSystemIndex[rawNoteIndex]
      : 0;

    // 1번째 줄(System 0) 연주 중에는 어떠한 미세 리플로우나 터치 변위가 있어도 scrollTop 0 고정 보장
    if (systemIndex === 0) {
      this.currentSystemIndex = 0;
      if (forceScroll || this.scrollEl.scrollTop !== 0) {
        this.scrollEl.scrollTop = 0;
      }
      return;
    }

    const targetScrollTop = this.systemScrollTops[systemIndex] ?? 0;
    const isManuallyDisplaced = Math.abs(this.scrollEl.scrollTop - targetScrollTop) > 25;

    // 같은 줄을 연주 중이고 강제 정렬이 아니며 수동 이탈도 없으면 스크롤 유지
    if (!forceScroll && systemIndex === this.currentSystemIndex && !isManuallyDisplaced) {
      return;
    }

    this.currentSystemIndex = systemIndex;

    if (forceScroll) {
      this.scrollEl.scrollTop = targetScrollTop;
    } else {
      this.scrollEl.scrollTo({
        top: targetScrollTop,
        behavior: 'smooth'
      });
    }
  }

  /**
   * 주어진 음표 요소(DOM element)가 속한 오선 줄(System) 인덱스 반환
   * @param {Element} element 
   * @returns {number}
   */
  getSystemIndexForElement(element) {
    if (!element || !this.svg || !this.noteToSystemIndex) return 0;
    const noteheads = this.getPitchNoteheads(this.svg);
    const targetIndex = noteheads.indexOf(element);
    if (targetIndex === -1) return 0;
    return this.noteToSystemIndex[targetIndex] ?? 0;
  }

  /**
   * 레거시 및 외부 참조용 헬퍼: 주어진 요소의 현재 스크린 Y 중심 좌표 반환
   */
  getStaffCenterYForElement(liveSvg, targetEl) {
    if (!liveSvg || !targetEl) return null;
    const targetRect = targetEl.getBoundingClientRect();
    const targetCenterY = targetRect.top + targetRect.height / 2;
    if (!this.systemStaffCenters || this.systemStaffCenters.length === 0) return targetCenterY;

    const svgRect = liveSvg.getBoundingClientRect();
    const targetYInSvg = targetCenterY - svgRect.top;

    let closestStaffY = this.systemStaffCenters[0];
    let minD = Infinity;
    this.systemStaffCenters.forEach(sysY => {
      const d = Math.abs(sysY - targetYInSvg);
      if (d < minD) {
        minD = d;
        closestStaffY = sysY;
      }
    });
    return svgRect.top + closestStaffY;
  }

  /** 하위 호환용 래퍼 */
  centerFocusMarker() {}
}
