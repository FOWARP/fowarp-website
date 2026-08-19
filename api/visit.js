// 방문 알림 — 1차(접속 즉시) / 2차(이탈 시 요약)
//
// 방문자 상태(재방문·누적 방문수·쿨다운·본 페이지 순서)는 전부 브라우저
// localStorage 가 들고 클라이언트가 실어 보낸다. 서버에 DB 를 두지 않는
// 이유는 그게 더 정확하기도 해서다 — 방문자 단위 카운터라 IP 로 묶는 것보다
// 브라우저 단위가 실제 "같은 사람"에 가깝다.
//
// 서버가 하는 일은 세 가지뿐이다.
//   1) 봇 걸러내기
//   2) IP 로 지역 알아내기 + 데이터센터 IP 인지 판별 (클라이언트는 자기 IP 를 모른다)
//   3) 푸시 발송

const { send } = require('./_push.js');
const stat = require('./_stat.js');

const BOT_RE = /bot|crawl|spider|slurp|bing|yandex|baidu|duckduck|facebookexternal|embedly|preview|monitor|uptime|pingdom|lighthouse|headless|curl|wget|python-requests|axios|postman|vercel-screenshot|whatsapp|telegram|slackbot|discord|kakaotalk-scrap|daumoa/i;

// 각 페이지가 화면에 띄우는 실제 제목(.info-name)과 맞춘다.
// Returnity 는 두 페이지가 같은 이름이라 무엇에 관한 건지만 덧붙였다.
const PAGE_NAMES = {
  '/': '메인', '/index': '메인',
  '/contact': '컨택트',
  '/starbucks': 'Starbucks®', '/calmlab': 'Calmlab+', '/kohonjin': 'Kohonjin',
  '/unknot': 'Unknot', '/goventure': 'Goventure Forum', '/jjonjingeo': '쫀징어',
  '/gonyakjelly': '단백질 곤약젤리', '/gooumcookit': '구움쿠킷',
  '/hwanghugung': '황후궁 삼계탕', '/nosugaradded': 'No Sugar Added',
  '/returnity-skinhealer': 'Returnity 스킨힐러',
  '/returnity-scalp': 'Returnity 두피 스왑',
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
/**
 * 앱 안에서 링크를 열면(인스타·카톡 등) referrer 가 대부분 비어서 '직접 입력'
 * 으로 잡힌다. 인앱 브라우저는 User-Agent 에 자기 이름을 박아두므로 그걸로
 * 되살린다. 한국 유입은 카톡·인스타 공유가 큰 비중이라 이게 없으면 통계가
 * 통째로 왜곡된다.
 */
function inAppSource(ua) {
  if (!ua) return null;
  if (/Instagram/i.test(ua)) return '인스타그램 앱';
  if (/Threads|Barcelona/i.test(ua)) return '스레드 앱';
  if (/KAKAOTALK/i.test(ua)) return '카카오톡';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return '페이스북 앱';
  if (/NAVER\(inapp/i.test(ua)) return '네이버 앱';
  if (/DaumApps/i.test(ua)) return '다음 앱';
  if (/Line\//i.test(ua)) return '라인';
  if (/TwitterAndroid|Twitter for/i.test(ua)) return '트위터 앱';
  if (/everytimeApp/i.test(ua)) return '에브리타임';
  return null;
}

function referrerLabel(ref, ua) {
  if (!ref) return inAppSource(ua) || '직접 입력·북마크';
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

/**
 * 데이터센터(hosting) IP 인지 판별한다. 통신사·회사명은 알림에 더 이상 쓰지
 * 않지만(매번 같은 통신사가 찍혀 정보량이 없었다), 스캐너·프리뷰 봇을 걸러내는
 * hosting 플래그는 필요해서 조회 자체는 유지한다.
 * 실패해도 알림은 나가야 하므로 조용히 포기한다.
 */
async function lookupOrg(ip) {
  if (!ip) return null;
  try {
    // 이제 이 조회가 끝나야 응답이 나가므로 넉넉히 잡지 않는다.
    // 실패해도 지역 정보는 Vercel 헤더로 이미 있으니 알림 자체는 나간다.
    const ctl = AbortSignal.timeout(1500);
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

  // 발송을 모두 끝낸 뒤에 응답한다.
  // 응답을 먼저 주고 뒤에서 보내는 편이 방문자에겐 빠르지만, Vercel 함수는
  // Lambda 기반이라 응답이 끝나면 실행이 그 자리에서 얼어붙는다 — 뒤에 남은
  // await send() 가 통째로 죽어서 알림이 한 건도 안 나갔다.
  // 방문자 쪽은 sendBeacon / fetch(keepalive) 라 응답을 기다리지 않으므로
  // 여기서 몇 초 더 걸려도 체감 지연은 없다.
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

    if (b.phase === 'enter') {
      const visits = Number(b.visits) || 1;
      const returning = visits > 1;
      const last = b.lastVisit ? new Date(b.lastVisit) : null;
      const days = last ? Math.floor((Date.now() - last.getTime()) / 86400000) : null;

      const who = returning
        ? `재방문 ${visits}번째${days !== null ? ` (마지막 ${days === 0 ? '오늘' : days + '일 전'})` : ''}`
        : '첫 방문';

      const ref = referrerLabel(b.referrer, ua);
      // 메인으로 들어오는 게 기본값이라 매번 찍으면 노이즈다.
      // 프로젝트 상세로 바로 들어온 경우만 알린다(그때는 정보가 된다).
      const entry = pageName(b.path);
      const lines = [
        `${place} | ${device}`,
        entry === '메인' ? null : `${entry} 페이지로 진입`,
        ref ? `유입: ${ref}` : null,
        who,
      ].filter(Boolean);

      // 집계는 알림과 독립적으로 남긴다(하루 요약용)
      await stat.recordEnter({ sid: b.sid, page: b.path, ref, returning });

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

      // 집계는 짧은 방문도 포함해야 하루 통계가 맞다.
      // 알림만 30초 기준으로 거른다.
      await stat.recordLeave({ dwell, pages: b.pages, formAbandon: !!b.formAbandon });

      if (dwell < 30) return; // 스쳐 지나간 방문은 2차 알림을 보내지 않는다

      const seen = Array.isArray(b.pages) ? b.pages : [];
      const trail = seen.length
        ? seen.map(pageName).join(' → ')
        : pageName(b.path);

      await send({
        title: `📄 방문 종료 · ${human(dwell)} 체류`,
        body: [
          place,
          `본 페이지: ${trail}`,
          seen.length > 1 ? `${seen.length}개 페이지 열람` : null,
        ].filter(Boolean).join('\n'),
        tag: 'leave-' + (b.sid || Date.now()),
        url: seen[seen.length - 1] || b.path || '/',
      });
    }
  } catch {
    // 알림은 부가 기능이다. 어떤 이유로 실패하든 사이트에 영향을 주지 않는다.
  } finally {
    // 봇 차단·짧은 체류 등 중간 return 경로가 여러 개라 finally 로 모아 응답한다
    res.statusCode = 204;
    res.end();
  }
};
