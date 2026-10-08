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
const { referrerLabel, adLabel } = require('./_src.js');

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
  '/antursolais': 'An Túr Solais',
  '/returnity-promo': 'Returnity 시즈널 프로모션',
};

const pageName = (p) => PAGE_NAMES[(p || '').replace(/\/$/, '') || '/'] || p || '?';

/** "3분 12초" 같은 사람이 읽는 형태로 */
function human(sec) {
  if (sec < 60) return `${sec}초`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}분 ${s}초` : `${m}분`;
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
    // 아이폰 'iCloud 비공개 릴레이'는 클라우드플레어·아카마이·Fastly 서버 IP 로
    // 나간다. 2026-10-08 확인: 한국 릴레이 대역 509개 중 89개가 hosting 으로
    // 판정돼 실제 방문자가 알림·통계에서 통째로 빠졌다. 이 셋은 사람으로 본다.
    const relay = /cloudflare|akamai|fastly/i.test(j.isp || '');
    if (j.hosting && !relay) return { org: j.isp || j.org, hosting: true };

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
  // 알림이 안 올 때 어디서 끊겼는지 Vercel 로그에서 바로 보이도록
  // 요청마다 결과를 한 줄 남긴다(IP 는 남기지 않는다).
  // 테스트 버튼(/notify)에는 같은 결과를 응답으로 돌려준다.
  let b = {};
  let out = { outcome: 'none' };
  try {
    b = await readBody(req);
    const ua = req.headers['user-agent'] || '';
    if (BOT_RE.test(ua) || !ua) { out = { outcome: 'bot' }; return; }

    const h = req.headers;
    const ip = (h['x-forwarded-for'] || '').split(',')[0].trim();
    const city = h['x-vercel-ip-city'] ? decodeURIComponent(h['x-vercel-ip-city']) : null;
    const country = h['x-vercel-ip-country'] || null;
    const place = [city, country].filter(Boolean).join(', ') || '위치 미상';

    const org = await lookupOrg(ip);
    // 데이터센터 IP 는 사람이 아니라 스캐너·프리뷰 봇일 가능성이 높다
    if (org && org.hosting) { out = { outcome: 'hosting-ip', org: org.org }; return; }

    const device = b.mobile ? '모바일' : 'PC';

    if (b.phase === 'enter') {
      const visits = Number(b.visits) || 1;
      const returning = visits > 1;
      const last = b.lastVisit ? new Date(b.lastVisit) : null;
      const days = last ? Math.floor((Date.now() - last.getTime()) / 86400000) : null;

      const who = returning
        ? `재방문 ${visits}번째${days !== null ? ` (마지막 ${days === 0 ? '오늘' : days + '일 전'})` : ''}`
        : '첫 방문';

      // 광고·꼬리표 링크로 왔으면 그게 referrer 보다 정확하다
      const tag = adLabel(b.tag);
      const ref = tag ? tag.label : referrerLabel(b.referrer, ua);
      // 메인으로 들어오는 게 기본값이라 매번 찍으면 노이즈다.
      // 프로젝트 상세로 바로 들어온 경우만 알린다(그때는 정보가 된다).
      const entry = pageName(b.path);
      const lines = [
        `${place} | ${device}`,
        entry === '메인' ? null : `${entry} 페이지로 진입`,
        ref ? `유입: ${ref}` + (tag && tag.kw ? ` · "${tag.kw}"` : '') : null,
        who,
      ].filter(Boolean);

      // 집계는 알림과 독립적으로 남긴다(하루 요약용).
      // /notify 테스트 버튼은 실제 방문이 아니라 통계에서 뺀다.
      if (!b.test) await stat.recordEnter({ sid: b.sid, vid: b.vid, page: b.path, ref, returning, ad: tag && tag.paid, kw: tag && tag.paid ? tag.kw : null });

      out = await send({
        title: tag && tag.paid
          ? (returning ? '📣 광고로 재방문자 접속' : '📣 광고로 새 방문자 접속')
          : (returning ? '🔁 재방문자 접속' : '👤 새 방문자 접속'),
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
      await stat.recordLeave({ sid: b.sid, dwell, pages: b.pages, formAbandon: !!b.formAbandon, ad: !!b.ad });

      // 탭이 가려졌을 뿐인 중간 저장(final:false)은 통계만 갱신하고 알리지 않는다.
      // 폰에서 카톡 잠깐 보고 돌아오는 것까지 '방문 종료'로 알리던 문제.
      if (b.final === false) { out = { outcome: 'checkpoint', dwell }; return; }

      if (dwell < 30) { out = { outcome: 'short-stay', dwell }; return; } // 스쳐 지나간 방문은 2차 알림을 보내지 않는다

      const seen = Array.isArray(b.pages) ? b.pages : [];
      const trail = seen.length
        ? seen.map(pageName).join(' → ')
        : pageName(b.path);

      out = await send({
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
  } catch (e) {
    // 알림은 부가 기능이다. 어떤 이유로 실패하든 사이트에 영향을 주지 않는다.
    out = { outcome: 'error', message: e && e.message };
  } finally {
    const line = JSON.stringify({ phase: b.phase || null, test: !!b.test, ...out });
    if (out.status && out.status >= 300 || out.skipped || out.outcome === 'error') console.error('[visit]', line);
    else console.log('[visit]', line);

    // 봇 차단·짧은 체류 등 중간 return 경로가 여러 개라 finally 로 모아 응답한다
    if (b.test) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(line);
    }
    res.statusCode = 204;
    res.end();
  }
};
