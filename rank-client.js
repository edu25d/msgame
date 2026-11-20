/**
 * battle-game/rank-client.js
 * Vercel KV (Upstash Redis) 백엔드 연동 클라이언트 (오프라인/오류 시 LocalStorage Fallback 지원)
 */

export const RankClient = (() => {
  const LOCAL_STORAGE_KEY = 'doremi_battle_rankings_local';

  // API 엔드포인트 URL 산출
  function getApiUrl() {
    // 1. window 전역 변수
    if (window.__API_URL) return window.__API_URL;
    if (window.__DOTHOME_API_URL) return window.__DOTHOME_API_URL;

    // 2. meta 태그
    const metaTag = document.querySelector('meta[name="api-url"]') || document.querySelector('meta[name="dothome-api-url"]');
    if (metaTag && metaTag.content && metaTag.content.trim()) {
      return metaTag.content.trim();
    }

    // 3. Vercel Serverless Function 엔드포인트 기본값
    return '/api/rank';
  }

  // ── 1. TOP 20 랭킹 목록 조회 ─────────────────────────────────────
  async function getRankings(limit = 20) {
    const apiUrl = getApiUrl();
    try {
      const res = await fetch(`${apiUrl}?action=list&limit=${limit}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        cache: 'no-store'
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.ok && Array.isArray(data.rankings)) {
        return { ok: true, rankings: data.rankings, source: 'server' };
      }
      throw new Error(data.message || '서버 응답 오류');
    } catch (err) {
      console.warn('[RankClient] 서버 연동 실패, LocalStorage로 대체:', err.message);
      return { ok: true, rankings: getLocalRankings(limit), source: 'local' };
    }
  }

  // ── 2. 점수 등록 ────────────────────────────────────────────────
  async function submitRanking(record) {
    const apiUrl = getApiUrl();
    const payload = {
      action: 'submit',
      nickname: record.nickname,
      song_id: record.song_id,
      song_title: record.song_title,
      difficulty: record.difficulty,
      difficulty_stars: record.difficulty_stars,
      score: record.score,
      elapsed_sec: record.elapsed_sec,
      accuracy: record.accuracy,
      max_combo: record.max_combo
    };

    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.ok) {
        return { ok: true, my_rank: data.my_rank, source: 'server' };
      }
      throw new Error(data.message || '등록 처리 오류');
    } catch (err) {
      console.warn('[RankClient] 점수 등록 실패, LocalStorage에 저장:', err.message);
      const myRank = saveLocalRanking(payload);
      return { ok: true, my_rank: myRank, source: 'local' };
    }
  }

  // ── 로컬 스토리지 Fallback 헬퍼 ──────────────────────────────────
  const DIFF_FALLBACK_MAP = {
    'scarecrow': { difficulty: '초급', stars: '★☆☆' },
    'friend': { difficulty: '중급', stars: '★★☆' },
    'town': { difficulty: '고급', stars: '★★★' },
    'forest-walk': { difficulty: '고급', stars: '★★★' }
  };

  function getLocalRankings(limit = 20) {
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      let list = stored ? JSON.parse(stored) : [];
      list.sort((a, b) => b.score - a.score || a.elapsed_sec - b.elapsed_sec);
      return list.slice(0, limit).map((item, idx) => {
        const fallback = DIFF_FALLBACK_MAP[item.song_id] || { difficulty: '초급', stars: '★☆☆' };
        return {
          ...item,
          rank: idx + 1,
          difficulty: item.difficulty || fallback.difficulty,
          difficulty_stars: item.difficulty_stars || fallback.stars
        };
      });
    } catch (e) {
      return [];
    }
  }

  function saveLocalRanking(record) {
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      let list = stored ? JSON.parse(stored) : [];
      const newEntry = {
        id: 'local_' + Date.now(),
        ...record,
        created_at: new Date().toISOString()
      };
      list.push(newEntry);
      list.sort((a, b) => b.score - a.score || a.elapsed_sec - b.elapsed_sec);
      list = list.slice(0, 50);
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(list));

      const rank = list.findIndex(item => item.id === newEntry.id) + 1;
      return rank > 0 ? rank : 1;
    } catch (e) {
      return 1;
    }
  }

  return {
    getRankings,
    submitRanking
  };
})();
