// 하루 요약 — 매일 밤 11시(KST) Vercel Cron 이 호출한다.
//
// 개별 방문 알림이 그날의 조각이라면 이건 전체 그림이다.
// 컨택트 지표(문의 페이지 방문 / 폼 쓰다 이탈 / 실제 제출)를 함께 실어
// "오늘 얼마나 문의에 가까워졌는가"를 한 눈에 본다.

const { send } = require('./_push.js');
const { readDay, todayKST, configured } = require('./_stat.js');

const PAGE_NAMES = {
  '/': '메인', '/index': '메인', '/contact': '컨택트',
  '/starbucks': 'Starbucks®', '/calmlab': 'Calmlab+', '/kohonjin': 'Kohonjin',
  '/unknot': 'Unknot', '/goventure': 'Goventure Forum', '/jjonjingeo': '쫀징어',
  '/gonyakjelly': '단백질 곤약젤리', '/gooumcookit': '구움쿠킷',
  '/hwanghugung': '황후궁 삼계탕', '/nosugaradded': 'No Sugar Added',
  '/returnity-skinhealer': 'Returnity 스킨힐러',
  '/returnity-scalp': 'Returnity 두피 스왑',
  '/returnity-promo': 'Returnity 시즈널 프로모션',
};
const pageName = (p) => PAGE_NAMES[(p || '').replace(/\/$/, '') || '/'] || p || '?';

/** 값이 큰 순으로 상위 n개를 "이름 3" 형태로 */
function top(obj, n, label) {
  return Object.entries(obj || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${label ? label(k) : k} ${v}`)
    .join(' · ');
}

function human(sec) {
  if (!sec) return '0초';
  if (sec < 60) return `${sec}초`;
  const m = Math.floor(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분 ${sec % 60}초`;
}

module.exports = async (req, res) => {
  // Vercel Cron 은 Authorization: Bearer $CRON_SECRET 을 붙여 호출한다.
  // 값을 설정해 두면 외부에서 이 주소를 때려도 무시된다.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    res.statusCode = 401;
    return res.end('Unauthorized');
  }

  try {
    if (!configured()) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ skipped: 'no-store' }));
    }

    const day = todayKST();
    const d = await readDay(day);
    const c = (d && d.count) || {};

    const visits = Number(c.visits) || 0;
    const first = Number(c.first) || 0;
    const returning = Number(c.returning) || 0;
    const sessions = Number(c.sessions) || 0;
    const dwellSum = Number(c.dwellSum) || 0;
    const avg = sessions ? Math.round(dwellSum / sessions) : 0;

    const contactViews = Number(c.contactViews) || 0;
    const formAbandon = Number(c.formAbandon) || 0;
    const submits = Number(c.submits) || 0;

    // 방문이 하나도 없는 날은 굳이 알리지 않는다
    if (!visits && !submits) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ skipped: 'no-visits', day }));
    }

    // 알림은 두 줄만. iOS 잠금화면에서 잘리지 않는 분량이고,
    // 나머지는 탭해서 /notify 앱의 상세 화면에서 본다.
    const body = [
      `방문 ${visits} · 방문자 ${d.uniques || 0}명` + (avg ? ` · 평균 ${human(avg)}` : ''),
      `📮 컨택트 ${contactViews} · 이탈 ${formAbandon} · 제출 ${submits}`,
    ].join('\n');

    await send({
      title: submits ? `🎉 오늘 문의 ${submits}건 · 하루 요약` : '📊 하루 요약',
      body,
      tag: 'summary-' + day,
      url: '/notify',   // 탭하면 상세 화면으로
    }, 86400);

    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, day, visits, submits }));
  } catch (e) {
    res.statusCode = 200; // cron 재시도를 유발하지 않는다
    res.end(JSON.stringify({ error: e && e.message }));
  }
};
