/**
 * battle-game/battle.js
 * 도레미 스피드런 챌린지 코어 게임 루프 & UI 컨트롤러 (v1.2)
 */

import { SONGS } from './songs.js';
import { RankClient } from './rank-client.js';
import { Synth } from './audio/synth.js';
import { Keyboard } from './keyboard/keyboard.js';
import { ScoreViewer } from './score/score-viewer.js';
import { ScoreOverlay } from './score/score-overlay.js';
import { HintController } from './core/hint-controller.js';
import { cleanScoreToSingleStaff } from './core/score-cleaner.js';
import { extractPlayableSequence } from './core/playback-order.js';
import { resolveWrongPitch } from './core/music-theory.js';

(() => {
  // ── DOM 요소 ──────────────────────────────────────────────────
  const lobbyView = document.getElementById('lobby-view');
  const gameView = document.getElementById('game-view');
  const resultModal = document.getElementById('result-modal');

  const songCardsContainer = document.getElementById('song-cards-container');
  const rankingTableBody = document.getElementById('ranking-table-body');
  const btnRefreshRank = document.getElementById('btn-refresh-rank');

  const hudSongTitle = document.getElementById('hud-song-title');
  const hudDiffPill = document.getElementById('hud-diff-pill');
  const hudCombo = document.getElementById('hud-combo');
  const hudTimer = document.getElementById('hud-timer');
  const hudBtnExit = document.getElementById('hud-btn-exit');

  const scoreOsmdContainer = document.getElementById('score-osmd-container');
  const scoreScrollWrapper = document.getElementById('score-scroll-wrapper');
  const keyboardContainer = document.getElementById('keyboard-container');

  const countdownOverlay = document.getElementById('countdown-overlay');
  const countdownNumber = document.getElementById('countdown-number');

  const resTime = document.getElementById('res-time');
  const resAccuracy = document.getElementById('res-accuracy');
  const resCombo = document.getElementById('res-combo');
  const resScore = document.getElementById('res-score');
  const nicknameInput = document.getElementById('nickname-input');
  const btnSubmitRank = document.getElementById('btn-submit-rank');
  const rankSubmitStatus = document.getElementById('rank-submit-status');
  const btnRetry = document.getElementById('btn-retry');
  const btnBackLobby = document.getElementById('btn-back-lobby');

  // ── 상태 변수 ──────────────────────────────────────────────────
  let scoreViewer = null;
  let scoreOverlay = null;
  let hintController = null;
  let scoreObserver = null;
  let currentParsed = null;

  let currentSong = null;
  let playableNotes = [];
  let currentIndex = 0;
  let lastCorrectNote = null;
  let isPlaying = false;

  let startTime = 0;
  let elapsedSec = 0;
  let elapsedTimerId = null;

  let combo = 0;
  let maxCombo = 0;
  let comboBonus = 0;
  let wrongCount = 0;
  let lastFinalStats = null;

  // ── 초기화 ────────────────────────────────────────────────────
  function init() {
    renderSongCards();
    loadRankings();

    // 키보드 초기화 (검은 건반 라벨 없이 11건반 렌더링)
    Keyboard.init({
      container: keyboardContainer,
      onKeyDown: handleKeyInput
    });

    // 악보 뷰어 & 오버레이 초기화
    scoreViewer = new ScoreViewer(scoreOsmdContainer, scoreScrollWrapper);
    scoreOverlay = new ScoreOverlay(scoreViewer);

    // 힌트 컨트롤러 초기화 (기존 도레미 읽기 연습장 방식 100% 이식)
    hintController = new HintController(scoreOverlay, Keyboard);

    // 이벤트 리스너 연결
    btnRefreshRank.addEventListener('click', loadRankings);
    hudBtnExit.addEventListener('click', exitToLobby);

    btnSubmitRank.addEventListener('click', submitRanking);
    btnRetry.addEventListener('click', retrySong);
    btnBackLobby.addEventListener('click', exitToLobby);

    nicknameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitRanking();
    });
  }

  // ── 1. 로비 곡 카드 렌더링 ────────────────────────────────────
  function renderSongCards() {
    songCardsContainer.innerHTML = '';

    SONGS.forEach(song => {
      const card = document.createElement('div');
      card.className = 'song-card';

      let badgeClass = 'badge-easy';
      if (song.difficulty === '중급') badgeClass = 'badge-mid';
      else if (song.difficulty === '고급') badgeClass = 'badge-hard';

      card.innerHTML = `
        <div class="song-info">
          <span class="song-badge ${badgeClass}">${song.difficulty} ${song.stars}</span>
          <span class="song-name">${song.title}</span>
        </div>
        <button class="btn-play-song" data-id="${song.id}">시작</button>
      `;

      card.querySelector('.btn-play-song').addEventListener('click', () => {
        startSong(song);
      });

      songCardsContainer.appendChild(card);
    });
  }

  // ── 2. TOP 20 랭킹 전광판 갱신 ────────────────────────────────
  async function loadRankings() {
    rankingTableBody.innerHTML = '<tr><td colspan="5" class="empty-ranking">랭킹 불러오는 중...</td></tr>';
    try {
      const res = await RankClient.getRankings(20);
      if (!res.ok || !res.rankings || res.rankings.length === 0) {
        rankingTableBody.innerHTML = '<tr><td colspan="5" class="empty-ranking">아직 등록된 기록이 없습니다. 첫 번째 1위에 도전해보세요!</td></tr>';
        return;
      }

      rankingTableBody.innerHTML = '';
      res.rankings.forEach(item => {
        const tr = document.createElement('tr');

        let rankBadge = item.rank;
        let rankClass = '';
        if (item.rank === 1) { rankBadge = '🥇'; rankClass = 'top-1'; }
        else if (item.rank === 2) { rankBadge = '🥈'; rankClass = 'top-2'; }
        else if (item.rank === 3) { rankBadge = '🥉'; rankClass = 'top-3'; }

        tr.innerHTML = `
          <td class="rank-num ${rankClass}">${rankBadge}</td>
          <td class="rank-nick" title="${item.nickname}">${escapeHtml(item.nickname)}</td>
          <td class="rank-song" title="${item.song_title}">${escapeHtml(item.song_title)}</td>
          <td class="rank-time">${item.elapsed_sec ? item.elapsed_sec.toFixed(1) + 's' : '-'}</td>
          <td class="rank-score">${item.score.toLocaleString()}</td>
        `;
        rankingTableBody.appendChild(tr);
      });
    } catch (err) {
      rankingTableBody.innerHTML = '<tr><td colspan="5" class="empty-ranking">랭킹을 불러올 수 없습니다.</td></tr>';
    }
  }

  // ── 3. 곡 플레이 시작 ──────────────────────────────────────────
  async function startSong(song) {
    currentSong = song;

    // 사운드 컨텍스트 언락
    try {
      await Synth.getContext();
    } catch (e) {}

    // 화면 전환
    lobbyView.classList.remove('active');
    resultModal.classList.remove('active');
    gameView.classList.add('active');

    // 화면 크기 계산 후 건반 렌더링
    requestAnimationFrame(() => {
      Keyboard.render();
    });

    // HUD 갱신 (경계선 없는 인라인 오버레이)
    hudSongTitle.textContent = song.title;
    hudDiffPill.textContent = `${song.difficulty} ${song.stars}`;
    hudCombo.classList.remove('visible');
    hudTimer.textContent = '⏱ 00:00.0';

    // 악보 정제 및 로드
    try {
      const { cleanedXml } = cleanScoreToSingleStaff(song.xml);
      currentParsed = extractPlayableSequence(cleanedXml);
      playableNotes = currentParsed.playableNotes || [];

      const svg = await scoreViewer.render(cleanedXml);
      scoreOverlay.attach(svg, currentParsed.rawNoteCount);

      // OSMD autoResize 및 재렌더링 시 Live SVG 실시간 재부착 감시
      scoreObserver?.disconnect();
      let reattachTimer = null;
      scoreObserver = new MutationObserver(() => {
        clearTimeout(reattachTimer);
        reattachTimer = setTimeout(() => {
          const liveSvg = scoreOsmdContainer?.querySelector('svg');
          if (liveSvg && currentParsed) {
            scoreOverlay.attach(liveSvg, currentParsed.rawNoteCount);
            if (isPlaying && playableNotes[currentIndex]) {
              scoreOverlay.drawFocusMarker(playableNotes[currentIndex].rawNoteIndex);
            }
          }
        }, 80);
      });
      scoreObserver.observe(scoreOsmdContainer, { childList: true, subtree: true });
    } catch (e) {
      console.error('악보 로드 실패:', e);
      alert('악보 로드 중 오류가 발생했습니다.');
      exitToLobby();
      return;
    }

    // 3·2·1 카운트다운 시작
    runCountdown();
  }

  function runCountdown() {
    isPlaying = false;
    hintController.stop();

    countdownOverlay.classList.add('active');
    countdownNumber.textContent = '3';
    Synth.playKeyTap(60);

    setTimeout(() => {
      countdownNumber.textContent = '2';
      Synth.playKeyTap(64);
    }, 700);

    setTimeout(() => {
      countdownNumber.textContent = '1';
      Synth.playKeyTap(67);
    }, 1400);

    setTimeout(() => {
      countdownNumber.textContent = 'START!';
      Synth.playKeyTap(72);
    }, 2100);

    setTimeout(() => {
      countdownOverlay.classList.remove('active');
      startPlaying();
    }, 2700);
  }

  function startPlaying() {
    isPlaying = true;
    currentIndex = 0;
    lastCorrectNote = null;
    combo = 0;
    maxCombo = 0;
    comboBonus = 0;
    wrongCount = 0;
    elapsedSec = 0;

    Keyboard.clearAllHighlights();
    Keyboard.clearAccidentalCue();

    startTime = performance.now();
    clearInterval(elapsedTimerId);
    elapsedTimerId = setInterval(tickTimer, 40);

    // 최신 Live SVG 확인 및 연결 보장
    const liveSvg = scoreOsmdContainer?.querySelector('svg');
    if (liveSvg && currentParsed && liveSvg !== scoreOverlay.svg) {
      scoreOverlay.attach(liveSvg, currentParsed.rawNoteCount);
    }

    if (playableNotes.length > 0) {
      const first = playableNotes[0];
      // rawNoteIndex로 정확한 포커싱 및 스냅 스크롤 적용!
      scoreOverlay.drawFocusMarker(first.rawNoteIndex);
      scoreViewer.centerStaffOfNote(first.rawNoteIndex, true);

      // 첫 음 힌트 스케줄러 시작 (지체 시 은은한 페이드 계이름)
      hintController.start(first, null, true, 1800);
    }
  }

  function tickTimer() {
    if (!isPlaying) return;
    elapsedSec = (performance.now() - startTime) / 1000;
    hudTimer.textContent = `⏱ ${formatTime(elapsedSec)}`;
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`;
  }

  // ── 4. 건반 터치 입력 처리 ─────────────────────────────────────
  function handleKeyInput(midi) {
    // 피아노 타건 사운드 즉각 재생
    Synth.playNote(midi, 0.5, { velocity: 0.8 });

    if (!isPlaying || currentIndex >= playableNotes.length) return;

    const target = playableNotes[currentIndex];

    if (midi === target.midi) {
      // ── 정답! ─────────────────────────────────────────────
      hintController.stop(); // 힌트 즉시 소거
      scoreOverlay.triggerSuccessFeedback(); // 150ms 에메랄드 블룸
      scoreOverlay.clearWrongNote(true);
      Keyboard.flashFeedback(midi, true);
      Keyboard.clearAccidentalCue();

      combo++;
      if (combo > maxCombo) maxCombo = combo;
      comboBonus += combo * 10;

      if (combo >= 2) {
        hudCombo.textContent = `🔥 ${combo} COMBO`;
        hudCombo.classList.add('visible');
      }

      lastCorrectNote = target;
      currentIndex++;

      if (currentIndex < playableNotes.length) {
        const next = playableNotes[currentIndex];

        // rawNoteIndex 기반 포커싱 및 줄바꿈 스냅 스크롤!
        scoreOverlay.drawFocusMarker(next.rawNoteIndex);
        scoreViewer.centerStaffOfNote(next.rawNoteIndex, false);

        // 줄바꿈 여부 확인
        const isNewLine = Boolean(
          scoreViewer.noteToSystemIndex &&
          scoreViewer.noteToSystemIndex[next.rawNoteIndex] !== scoreViewer.noteToSystemIndex[target.rawNoteIndex]
        );

        // 다음 음 힌트 스케줄러 가동 (디딤돌 힌트)
        hintController.start(next, lastCorrectNote, isNewLine, 1800);
      } else {
        // 모든 음표 완주!
        finishGame();
      }
    } else {
      // ── 오답! ─────────────────────────────────────────────
      combo = 0;
      wrongCount++;
      hudCombo.classList.remove('visible');

      Keyboard.flashFeedback(midi, false);
      Synth.playWrong();
      scoreOverlay.triggerWrongFeedback();

      const pitch = { step: target.step, octave: target.octave, alter: target.alter };
      scoreOverlay.showWrongNote(target.rawNoteIndex, midi, pitch);

      // [맥락 기반 오답 피치 판별] 조표/임시표 실수 감지
      const wrongPitch = resolveWrongPitch(midi, pitch);
      const isMissingAccidental = Boolean(
        target.alter !== 0 &&
        wrongPitch.step === target.step &&
        wrongPitch.octave === target.octave &&
        wrongPitch.alter === 0
      );
      const isMissingNatural = Boolean(
        target.alter === 0 &&
        (target.hasNatural || target.keySignatureAlter !== 0) &&
        wrongPitch.step === target.step &&
        wrongPitch.octave === target.octave &&
        wrongPitch.alter !== 0
      );

      if (isMissingNatural) {
        scoreOverlay.blinkAccidentalOrKeySignature(target);
        Keyboard.flashAccidentalCue(target.midi, '♮');
      } else if (isMissingAccidental) {
        const symbol = target.alter > 0 ? '♯' : '♭';
        scoreOverlay.blinkAccidentalOrKeySignature(target);
        Keyboard.flashAccidentalCue(target.midi, symbol);
      }

      // 오답 후 1.5초 지체 시 힌트 재가동
      hintController.stop();
      hintController.start(target, lastCorrectNote, false, 1500);
    }
  }

  // ── 5. 완주 처리 & 결과 모달 ───────────────────────────────────
  function finishGame() {
    isPlaying = false;
    clearInterval(elapsedTimerId);
    hintController.stop();

    const endTime = performance.now();
    elapsedSec = (endTime - startTime) / 1000;

    Keyboard.clearAllHighlights();
    Keyboard.clearStepHints();
    Synth.playLevelUp();

    // 점수 계산 (v1.2 공식)
    const totalNotes = playableNotes.length;
    const baseScore = totalNotes * 100;
    const speedBonus = Math.max(0, Math.round((currentSong.targetSeconds - elapsedSec) * 50));
    const wrongPenalty = wrongCount * 50;
    const perfectBonus = (wrongCount === 0) ? 1000 : 0;
    const rawScore = Math.max(100, baseScore + comboBonus + speedBonus - wrongPenalty + perfectBonus);
    const finalScore = Math.round(rawScore * currentSong.multiplier);
    const accuracy = Math.max(0, Math.round(((totalNotes - wrongCount) / totalNotes) * 100));

    lastFinalStats = {
      song_id: currentSong.id,
      song_title: currentSong.title,
      score: finalScore,
      elapsed_sec: parseFloat(elapsedSec.toFixed(2)),
      accuracy,
      max_combo: maxCombo
    };

    // 결과 모달 데이터 바인딩
    resTime.textContent = `${elapsedSec.toFixed(1)}초`;
    resAccuracy.textContent = `${accuracy}%`;
    resCombo.textContent = `${maxCombo}연타`;
    resScore.textContent = `${finalScore.toLocaleString()}점`;

    nicknameInput.value = '';
    btnSubmitRank.disabled = false;
    rankSubmitStatus.textContent = '';

    // 축하 폭죽 (Confetti)
    if (window.confetti) {
      window.confetti({
        particleCount: 80,
        spread: 70,
        origin: { y: 0.6 }
      });
    }

    resultModal.classList.add('active');
  }

  // ── 6. 랭킹 등록 ──────────────────────────────────────────────
  async function submitRanking() {
    if (!lastFinalStats) return;

    const nickname = nicknameInput.value.trim();
    if (!nickname) {
      rankSubmitStatus.textContent = '닉네임을 1자 이상 입력해 주세요.';
      rankSubmitStatus.style.color = '#fb7185';
      return;
    }

    btnSubmitRank.disabled = true;
    rankSubmitStatus.textContent = '기록 등록 중...';
    rankSubmitStatus.style.color = '#38bdf8';

    try {
      const res = await RankClient.submitRanking({
        nickname,
        ...lastFinalStats
      });

      if (res.ok) {
        rankSubmitStatus.textContent = `🏆 축하합니다! 실시간 TOP 20위(현재 ${res.my_rank}위)에 등록되었습니다!`;
        rankSubmitStatus.style.color = '#34d399';
        loadRankings(); // 로비 랭킹 갱신
      } else {
        rankSubmitStatus.textContent = '등록 실패: 다시 시도해 주세요.';
        rankSubmitStatus.style.color = '#fb7185';
        btnSubmitRank.disabled = false;
      }
    } catch (e) {
      rankSubmitStatus.textContent = '등록 중 오류가 발생했습니다.';
      rankSubmitStatus.style.color = '#fb7185';
      btnSubmitRank.disabled = false;
    }
  }

  function retrySong() {
    resultModal.classList.remove('active');
    hintController.stop();
    if (currentSong) {
      startSong(currentSong);
    } else {
      exitToLobby();
    }
  }

  function exitToLobby() {
    isPlaying = false;
    clearInterval(elapsedTimerId);
    hintController.stop();
    scoreObserver?.disconnect();
    Keyboard.clearAllHighlights();
    Keyboard.clearAccidentalCue();

    resultModal.classList.remove('active');
    gameView.classList.remove('active');
    lobbyView.classList.add('active');

    loadRankings();
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // DOM 로드 완료 시 초기화
  window.addEventListener('DOMContentLoaded', init);
})();
