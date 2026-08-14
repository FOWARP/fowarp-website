// 푸시 설정 점검용. 키 값 자체는 절대 응답에 담지 않는다(존재 여부와 길이만).
// 원인 파악이 끝나면 지운다.

module.exports = async (req, res) => {
  const has = (k) => !!process.env[k];
  const len = (k) => (process.env[k] || '').length;

  let subInfo = null;
  try {
    const s = JSON.parse(process.env.PUSH_SUBSCRIPTION || '{}');
    subInfo = {
      host: s.endpoint ? new URL(s.endpoint).host : null,
      hasP256dh: !!(s.keys && s.keys.p256dh),
      hasAuth: !!(s.keys && s.keys.auth),
    };
  } catch (e) {
    subInfo = { parseError: e.message };
  }

  let result = null, error = null;
  try {
    const { send } = require('./_push.js');
    result = await send({
      title: 'FOWARP 점검',
      body: '이 알림이 보이면 발송 경로는 정상이다.',
      tag: 'debug',
      url: '/',
    });
  } catch (e) {
    error = { message: e.message, at: (e.stack || '').split('\n')[1] };
  }

  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({
    env: {
      VAPID_PUBLIC_KEY: has('VAPID_PUBLIC_KEY') ? `있음(${len('VAPID_PUBLIC_KEY')}자)` : '없음',
      VAPID_PRIVATE_KEY: has('VAPID_PRIVATE_KEY') ? `있음(${len('VAPID_PRIVATE_KEY')}자)` : '없음',
      PUSH_SUBSCRIPTION: has('PUSH_SUBSCRIPTION') ? `있음(${len('PUSH_SUBSCRIPTION')}자)` : '없음',
    },
    subscription: subInfo,
    sendResult: result,
    error,
  }, null, 2));
};
