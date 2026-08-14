// 방문 알림 — 1차(접속 즉시) / 2차(이탈 시 요약)
//
// 방문자 상태(재방문·누적 방문수·쿨다운·본 페이지 순서)는 전부 브라우저
// localStorage 가 들고 클라이언트가 실어 보낸다. 서버에 DB 를 두지 않는
// 이유는 그게 더 정확하기도 해서다 — 방문자 단위 카운터라 IP 로 묶는 것보다
// 브라우저 단위가 실제 "같은 사람"에 가깝다.
//
// 서버가 하는 일은 세 가지뿐이다.
//   1) 봇 걸러내기
//   2) IP 로 지역·회사(ISP) 알아내기 (클라이언트는 자기 IP 를 모른다)
//   3) 푸시 발송

const { send } = require('./_push.js');

const BOT_RE = /bot|crawl|spider|slurp|bing|yandex|baidu|duckduck|facebookexternal|embedly|preview|monitor|uptime|pingdom|lighthouse|headless|curl|wget|python-requests|axios|postman|vercel-screenshot|whatsapp|telegram|slackbot|discord/i;

const PAGE_NAMES = {
  '/': '메인', '/index': '메인', '/about': 'About', '/project': '프로젝트 목록',
  '/project2': '프로젝트 목록', '/contact': '컨택트', '/contact-light': '컨택트',
  '/starbucks': '스타벅스', '/calmlab': '캄랩', '/kohonjin': '고혼진',
  '/unknot': '언노트', '/goventure': '고벤처', '/jjonjingeo': '쫀진거',
  '/gonyakjelly': '곤약젤리', '/gooumcookit': '고움쿡잇', '/hwanghugung': '황후궁',
  '/nosugaradded': '노슈가', '/returnity-skinhealer': '리터니티 스킨힐러',
  '/returnity-scalp': '리터니티 스캘프',
};

const pageName = (p) => PAGE_NAMES[(p || '').replace(/\/$/, '') || '/'] || p || '?';

/** "3분 12초" 같은 사람이 읽는 형태로 */
function human(sec) {
  if (sec < 60) return `${sec}초`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}분 ${s}초` : `${m}분`;
}

/** 유입 경로를 사람 말로. 검색어가 붙어 오면 그것까지. */
function referrerLabel(ref) {
  if (!ref) return '직접 입력·북마크';
  let host;
  try { host = new URL(ref).hostname.replace(/^www\./, ''); } catch { return '알 수 없음'; }
  if (/fowarp/.test(host)) return null; // 사이트 내부 이동
  const known = {
    'google.com': '구글 검색', 'google.co.kr': '구글 검색',
    'search.naver.com': '네이버 검색', 'naver.com': '네이버',
    'daum.net': '다음', 'search.daum.net': '다음 검색',
    'bing.com': '빙 검색', 'instagram.com': '인스타그램',
    'l.instagram.com': '인스타그램', 'behance.net': 'Behance',
    'linkedin.com': '링크드인', 'facebook.com': '페이스북',
    't.co': '트위터', 'youtube.com': '유튜브',
  };
  return known[host] || host;
}

/** ISP·회사명. 실패해도 알림 자체는 나가야 하므로 조용히 포기한다. */
async function lookupOrg(ip) {
  if (!ip) return null;
  try {
    const ctl = AbortSignal.timeout(2500);
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=status,isp,org,mobile,hosting`, { signal: ctl });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.status !== 'success') return null;
    if (j.hosting) return { org: j.isp || j.org, hosting: true };

    // org 는 회사망이면 회사명("Samsung Electronics")이 잡혀 쓸모가 크지만,
    // 일반 가정회선이면 통신사 지사명을 로마자로 붙여 쓴 한 덩어리
    // ("Sudogwongangnambonbujang")가 온다. 후자만 걸러내고 isp 로 대체한다.
    // 판별 기준은 '띄어쓰기 없는 긴 한 단어' — 실제 회사명은 거의 다 띄어쓴다.
    const isp = j.isp || '';
    const org = j.org || '';
    const junk = !org
      || org.toLowerCase() === isp.toLowerCase()
      || (!/\s/.test(org) && /^[a-z]{12,}$/i.test(org));
    return { org: junk ? isp : org, mobile: j.mobile };
  } catch {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body) return resolve(typeof req.body === 'string' ? safeJson(req.body) : req.body);
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 8000) req.destroy(); });
    req.on('end', () => resolve(safeJson(raw)));
    req.on('error', () => resolve({}));
  });
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }

  // 응답은 즉시 준다 — 방문자 브라우저를 푸시 발송 때문에 붙들 이유가 없다
  res.statusCode = 204;
  res.end();

  try {
    const b = await readBody(req);
    const ua = req.headers['user-agent'] || '';
    if (BOT_RE.test(ua) || !ua) return;

    const h = req.headers;
    const ip = (h['x-forwarded-for'] || '').split(',')[0].trim();
    const city = h['x-vercel-ip-city'] ? decodeURIComponent(h['x-vercel-ip-city']) : null;
    const country = h['x-vercel-ip-country'] || null;
    const place = [city, country].filter(Boolean).join(', ') || '위치 미상';

    const org = await lookupOrg(ip);
    // 데이터센터 IP 는 사람이 아니라 스캐너·프리뷰 봇일 가능성이 높다
    if (org && org.hosting) return;

    const device = b.mobile ? '모바일' : 'PC';
    const orgText = org && org.org ? ` · ${org.org}` : '';

    if (b.phase === 'enter') {
      const visits = Number(b.visits) || 1;
      const returning = visits > 1;
      const last = b.lastVisit ? new Date(b.lastVisit) : null;
      const days = last ? Math.floor((Date.now() - last.getTime()) / 86400000) : null;

      const who = returning
        ? `재방문 ${visits}번째${days !== null ? ` (마지막 ${days === 0 ? '오늘' : days + '일 전'})` : ''}`
        : '첫 방문';

      const ref = referrerLabel(b.referrer);
      const lines = [
        `${place}${orgText} · ${device}`,
        `${pageName(b.path)} 페이지로 진입`,
        ref ? `유입: ${ref}` : null,
        who,
      ].filter(Boolean);

      await send({
        title: returning ? '🔁 재방문자 접속' : '👤 새 방문자 접속',
        body: lines.join('\n'),
        tag: 'visit-' + (b.sid || Date.now()),
        url: b.path || '/',
      });
      return;
    }

    if (b.phase === 'leave') {
      const dwell = Math.round(Number(b.dwell) || 0);
      if (dwell < 30) return; // 스쳐 지나간 방문은 2차 알림을 보내지 않는다

      const seen = Array.isArray(b.pages) ? b.pages : [];
      const trail = seen.length
        ? seen.map(pageName).join(' → ')
        : pageName(b.path);

      await send({
        title: `📄 방문 종료 · ${human(dwell)} 체류`,
        body: [
          `${place}${orgText}`,
          `본 페이지: ${trail}`,
          seen.length > 1 ? `${seen.length}개 페이지 열람` : null,
        ].filter(Boolean).join('\n'),
        tag: 'leave-' + (b.sid || Date.now()),
        url: seen[seen.length - 1] || b.path || '/',
      });
    }
  } catch {
    // 알림은 부가 기능이다. 어떤 이유로 실패하든 사이트에 영향을 주지 않는다.
  }
};
