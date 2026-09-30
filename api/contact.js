// FOWARP 문의 폼 수신 → hi@fowarp.com 으로 메일 발송
// SMTP 발송 자체는 _mail.js 에 있다(알림 끊김 경보와 함께 쓴다).
//
// 필요한 환경변수 (Vercel → Settings → Environment Variables):
//   HIWORKS_EMAIL    예: hi@fowarp.com
//   HIWORKS_PASSWORD 하이웍스 메일 비밀번호
// 로컬 MCP(hiworks-mcp)가 쓰는 것과 동일한 계정·서버다.

const { sendMail } = require('./_mail.js');
const stat = require('./_stat.js');
const { referrerLabel, adLabel } = require('./_src.js');

/** 문의자가 어디서 왔는지 (js/track.js 가 기억해 둔 fw_src). 모르면 null. */
function sourceOf(src, ua) {
  if (!src || typeof src !== 'object') return null;
  const tag = adLabel(src.tag);
  const label = tag ? tag.label : (typeof src.ref === 'string' && src.ref ? referrerLabel(src.ref, ua) : null);
  if (!label) return null;
  const t = Number(src.t);
  const when = t ? new Date(t + 9 * 3600 * 1000).toISOString().slice(5, 10).split('-').map(Number).join('/') : null;
  return {
    paid: !!(tag && tag.paid),
    text: label
      + (tag && tag.kw ? ` · 키워드 "${tag.kw}"` : '')
      + (tag && tag.camp ? ` · 캠페인 "${tag.camp}"` : '')
      + (when ? ` (${when} 유입)` : ''),
  };
}

const MAX_LEN = 4000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST 만 허용됩니다.' });
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (_) { payload = null; }
  }
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: '요청 형식이 올바르지 않습니다.' });
  }

  const { brand, email, budget, message, _hp, src } = payload;

  // 봇이 함정 필드를 채웠으면 조용히 성공 처리 (봇에게 실패를 알려주지 않는다)
  if (_hp) return res.status(200).json({ ok: true });

  const vals = { brand, email, budget, message };
  for (const [k, v] of Object.entries(vals)) {
    if (typeof v !== 'string' || !v.trim()) {
      return res.status(400).json({ error: '필수 항목이 비어 있습니다.' });
    }
    if (v.length > MAX_LEN) {
      return res.status(400).json({ error: '입력이 너무 깁니다.' });
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: '이메일 형식을 확인해 주세요.' });
  }
  // 헤더 인젝션 방지 — Reply-To 에 들어가는 값에서 개행을 차단
  if (/[\r\n]/.test(email)) {
    return res.status(400).json({ error: '이메일 형식을 확인해 주세요.' });
  }

  const user = process.env.HIWORKS_EMAIL;
  const pass = process.env.HIWORKS_PASSWORD;
  if (!user || !pass) {
    console.error('HIWORKS_EMAIL / HIWORKS_PASSWORD 환경변수가 설정되지 않았습니다.');
    return res.status(500).json({ error: '서버 메일 설정이 없습니다.' });
  }

  const from = sourceOf(src, req.headers['user-agent']);

  const body = [
    'FOWARP 웹사이트 문의',
    '',
    `브랜드명 : ${brand.trim()}`,
    `이메일   : ${email.trim()}`,
    `예산     : ${budget.trim()}`,
    '',
    '문의 내용',
    '─────────────────────',
    message.trim(),
    '',
    '─────────────────────',
    `유입 경로 : ${from ? from.text : '모름 (직접 입력·북마크)'}`,
    `수신 경로 : ${req.headers['referer'] || 'fowarp.com/contact'}`,
  ].join('\n');

  try {
    await sendMail({
      user,
      pass,
      subject: `[문의${from && from.paid ? '·광고' : ''}] ${brand.trim()}`,
      body,
      replyTo: email.trim(),
    });
    // 하루 요약용 제출 카운트. 실패해도 메일은 이미 갔으니 응답에 영향 주지 않는다.
    try { await stat.recordSubmit({ ad: from && from.paid }); } catch {}
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('메일 발송 실패:', e && e.message);
    return res.status(502).json({ error: '메일 발송에 실패했습니다.' });
  }
};
