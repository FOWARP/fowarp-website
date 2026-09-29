// 구글 서치콘솔 검색 실적 — 하루 요약과 /notify 통계 화면이 읽어간다.
//
// googleapis SDK 없이 서비스 계정 JWT 를 Node 내장 crypto 로 직접 서명한다.
// 이 저장소의 '의존성 0개' 원칙(package.json 없음) 때문이다. _push.js 와 같은 이유.
//
// 필요한 환경변수 (Vercel → Settings → Environment Variables):
//   GSC_SERVICE_ACCOUNT  구글 클라우드에서 받은 서비스 계정 키 JSON 전체
//   GSC_SITE_URL         (선택) 서치콘솔 속성 주소. 기본값 https://fowarp.com/
// 서비스 계정 이메일을 서치콘솔 → 설정 → 사용자 및 권한 에 추가해 둬야 읽을 수 있다.
//
// 설정이 없거나 실패하면 null 을 돌려주고 조용히 넘어간다(부가 기능).

const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const b64u = (b) => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

function account() {
  const raw = process.env.GSC_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    return sa.client_email && sa.private_key ? sa : null;
  } catch {
    return null;
  }
}

function configured() {
  return !!account();
}

/** 서비스 계정으로 1시간짜리 액세스 토큰을 받는다 */
async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const input = head + '.' + claim;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), sa.private_key);

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: input + '.' + b64u(sig),
    }),
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`token ${r.status} ${j.error || ''}`);
  return j.access_token;
}

/** 한국 날짜 YYYY-MM-DD. 서치콘솔은 속성 시간대가 아니라 태평양 시간 기준이지만 하루 차이는 무시한다. */
function dayKST(offsetDays) {
  return new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000)
    .toISOString().slice(0, 10);
}

/**
 * 최근 days 일간 구글 검색 실적.
 * 개인 사이트는 하루치가 너무 적어서 기본을 7일로 잡았다.
 * dataState 'all' 이라 확정 전(최근 1~2일) 데이터도 포함한다.
 * @returns {Promise<null | {days, clicks, impressions, position, queries: {q, clicks, impressions}[]}>}
 */
async function searchSummary({ days = 7, limit = 5 } = {}) {
  const sa = account();
  if (!sa) return null;
  try {
    const token = await accessToken(sa);
    const site = process.env.GSC_SITE_URL || 'https://fowarp.com/';
    const url = 'https://www.googleapis.com/webmasters/v3/sites/'
      + encodeURIComponent(site) + '/searchAnalytics/query';
    const base = { startDate: dayKST(-days), endDate: dayKST(0), dataState: 'all' };

    const q = (body) => fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, ...body }),
      signal: AbortSignal.timeout(5000),
    }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`query ${r.status} ${(j.error && j.error.message) || ''}`);
      return j.rows || [];
    });

    // 합계(차원 없음)와 검색어별 상위를 한 번에
    const [total, byQuery] = await Promise.all([
      q({}),
      q({ dimensions: ['query'], rowLimit: limit }),
    ]);
    const t = total[0] || {};
    return {
      days,
      clicks: t.clicks || 0,
      impressions: t.impressions || 0,
      position: t.position ? Math.round(t.position * 10) / 10 : null,
      queries: byQuery.map((r) => ({ q: r.keys[0], clicks: r.clicks, impressions: r.impressions })),
    };
  } catch (e) {
    console.error('[gsc]', e && e.message);
    return null;
  }
}

module.exports = { searchSummary, configured };
