// 통계 조회 — /notify 앱의 상세 화면이 읽어간다.
//
// 알림 본문은 두 줄로 줄이고, 자세한 내용은 여기서 받아 앱에서 본다.
// 담기는 값은 숫자와 페이지 경로뿐이라 개인을 식별할 수 있는 정보는 없다.
//
// STATS_KEY 를 설정하면 그 키를 가진 요청만 받는다. 설정하지 않으면 열어 둔다
// (민감 정보는 아니지만 굳이 공개할 이유도 없다).

const { readDay, todayKST, configured } = require('./_stat.js');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  const key = process.env.STATS_KEY;
  if (key) {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('k') !== key) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
  }

  if (!configured()) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ error: 'no-store' }));
  }

  try {
    // 오늘부터 7일치
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = todayKST(-i);
      const r = await readDay(d);
      days.push({ date: d, ...(r || { count: {}, uniques: 0, pages: {}, refs: {}, contactFrom: {} }) });
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ days }));
  } catch (e) {
    res.statusCode = 200;
    res.end(JSON.stringify({ error: e && e.message }));
  }
};
