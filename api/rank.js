/**
 * api/rank.js — Vercel Serverless Function
 * Vercel KV (Upstash Redis) 기반 실시간 TOP 20 리더보드 API
 *
 * 환경 변수 (Vercel Storage KV 연동 시 자동 생성):
 * - KV_REST_API_URL 또는 UPSTASH_REDIS_REST_URL
 * - KV_REST_API_TOKEN 또는 UPSTASH_REDIS_REST_TOKEN
 */

export default async function handler(req, res) {
  // CORS 헤더 설정
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  // Vercel KV가 아직 연결되지 않은 경우 Graceful 안내
  if (!redisUrl || !redisToken) {
    if (req.method === 'GET') {
      return res.status(200).json({
        ok: true,
        rankings: [],
        source: 'unconfigured_kv',
        message: 'Vercel KV가 아직 연결되지 않았습니다. Vercel Storage에서 KV를 생성해 주세요.'
      });
    }
    if (req.method === 'POST') {
      return res.status(200).json({
        ok: true,
        my_rank: 1,
        source: 'unconfigured_kv',
        message: 'Vercel KV 미설정 상태: 로컬 랭킹으로 저장됩니다.'
      });
    }
  }

  const LEADERBOARD_KEY = 'doremi_battle_leaderboard';
  const DIFF_FALLBACK_MAP = {
    'scarecrow': { difficulty: '초급', stars: '★☆☆' },
    'friend': { difficulty: '중급', stars: '★★☆' },
    'forest-walk': { difficulty: '중급', stars: '★★☆' },
    'town': { difficulty: '고급', stars: '★★★' },
    'radetzky': { difficulty: '고급', stars: '★★★' }
  };

  try {
    // ── 1. GET: TOP 20 랭킹 목록 조회 ──────────────────────────
    if (req.method === 'GET') {
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));

      // Upstash REST API: ZREVRANGE (점수 높은 순으로 상위 N개 조회)
      const response = await fetch(`${redisUrl}/zrevrange/${LEADERBOARD_KEY}/0/${limit - 1}`, {
        headers: { Authorization: `Bearer ${redisToken}` }
      });
      const data = await response.json();

      const rawMembers = data.result || [];
      const rankings = rawMembers.map((str, idx) => {
        try {
          const parsed = typeof str === 'string' ? JSON.parse(str) : str;
          const fallback = DIFF_FALLBACK_MAP[parsed.song_id] || { difficulty: '초급', stars: '★☆☆' };
          return {
            rank: idx + 1,
            difficulty: parsed.difficulty || fallback.difficulty,
            difficulty_stars: parsed.difficulty_stars || fallback.stars,
            ...parsed
          };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);

      return res.status(200).json({
        ok: true,
        rankings,
        source: 'redis'
      });
    }

    // ── 2. POST: 점수 등록 ──────────────────────────────────────
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { nickname, song_id, song_title, difficulty, difficulty_stars, score, elapsed_sec, accuracy, max_combo } = body;

      if (!nickname || typeof nickname !== 'string' || !nickname.trim()) {
        return res.status(400).json({ ok: false, message: '닉네임을 입력해 주세요.' });
      }

      const cleanScore = Math.max(0, parseInt(score, 10) || 0);
      const cleanNick = nickname.trim().slice(0, 20);
      const entryId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const fallback = DIFF_FALLBACK_MAP[song_id] || { difficulty: '초급', stars: '★☆☆' };

      const entry = {
        id: entryId,
        nickname: cleanNick,
        song_id: song_id || 'unknown',
        song_title: song_title || '연습곡',
        difficulty: difficulty || fallback.difficulty,
        difficulty_stars: difficulty_stars || fallback.stars,
        score: cleanScore,
        elapsed_sec: parseFloat(elapsed_sec) || 0,
        accuracy: parseInt(accuracy, 10) || 100,
        max_combo: parseInt(max_combo, 10) || 0,
        created_at: new Date().toISOString()
      };

      const memberStr = JSON.stringify(entry);

      // Upstash Pipeline:
      // 1) ZADD: 점수 기준 정렬 세트에 추가
      // 2) ZREVRANK: 내림차순 기준 플레이어 순위 계산
      // 3) ZREMRANGEBYRANK: 상위 200위 초과 시 최하위 정리
      const pipelineCommands = [
        ["ZADD", LEADERBOARD_KEY, cleanScore.toString(), memberStr],
        ["ZREVRANK", LEADERBOARD_KEY, memberStr],
        ["ZREMRANGEBYRANK", LEADERBOARD_KEY, "0", "-201"]
      ];

      const pipeRes = await fetch(`${redisUrl}/pipeline`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${redisToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(pipelineCommands)
      });

      const pipeData = await pipeRes.json();
      const rankIdx = pipeData[1]?.result;
      const myRank = typeof rankIdx === 'number' ? rankIdx + 1 : 1;

      return res.status(200).json({
        ok: true,
        my_rank: myRank,
        entry,
        source: 'redis'
      });
    }

    return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  } catch (err) {
    console.error('Leaderboard API error:', err);
    return res.status(500).json({ ok: false, message: '서버 에러가 발생했습니다.', error: err.message });
  }
}
