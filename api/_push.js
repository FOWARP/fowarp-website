// Web Push 발송 — 의존성 0개 구현
//
// contact.js 가 nodemailer 없이 SMTP 를 직접 말하는 것과 같은 이유다.
// 이 저장소에 package.json 을 만들면 Vercel 이 정적 프로젝트가 아니라
// 프레임워크 프로젝트로 재인식해 cleanUrls 등 현재 서빙 설정이 흔들린다.
// 그래서 web-push 라이브러리 대신 Node 내장 crypto 로 규격을 직접 구현한다.
//
//   RFC 8291  Message Encryption for Web Push (aes128gcm)
//   RFC 8292  VAPID (Voluntary Application Server Identification)
//
// 필요한 환경변수 (Vercel → Settings → Environment Variables):
//   VAPID_PUBLIC_KEY    base64url, 브라우저 구독 시에도 같은 값을 쓴다
//   VAPID_PRIVATE_KEY   base64url (JWK 의 d 값)
//   PUSH_SUBSCRIPTION   구독 JSON 문자열 (/notify 에서 등록 후 한 번 붙여넣기)

const crypto = require('crypto');
const { sendMail } = require('./_mail.js');
const stat = require('./_stat.js');

const VAPID_SUBJECT = 'mailto:hi@fowarp.com';

const b64u = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const unb64u = (s) =>
  Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** HKDF-SHA256. Web Push 는 출력이 항상 32바이트 이하라 블록 한 번이면 끝난다. */
function hkdf(salt, ikm, info, len) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const out = crypto.createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest();
  return out.subarray(0, len);
}

/** VAPID Authorization 헤더. 푸시 서비스에 "이 발신자가 맞다"를 증명한다. */
function vapidHeader(endpoint) {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const raw = unb64u(pub); // 0x04 || X(32) || Y(32)

  const key = crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: priv,
      x: b64u(raw.subarray(1, 33)),
      y: b64u(raw.subarray(33, 65)),
    },
    format: 'jwk',
  });

  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID_SUBJECT,
  }));
  const input = head + '.' + body;

  // JWS 는 DER 이 아니라 R||S 고정폭 서명을 쓴다
  const sig = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(sig)}, k=${pub}`;
}

/** 본문을 구독자 공개키로 암호화한다(aes128gcm). 푸시 서비스는 내용을 못 본다. */
function encrypt(payload, p256dhB64, authB64) {
  const uaPublic = unb64u(p256dhB64);   // 구독자 공개키 65바이트
  const authSecret = unb64u(authB64);   // 구독자 인증 시크릿 16바이트

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const prk = hkdf(
    authSecret,
    shared,
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]),
    32
  );

  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12);

  // 0x02 는 "패딩 없음, 마지막 레코드" 구분자
  const plain = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([0x02])]);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);

  // 헤더: salt(16) || recordSize(4) || keyIdLen(1) || keyId
  const header = Buffer.concat([
    salt,
    Buffer.from([0x00, 0x00, 0x10, 0x00]), // 4096
    Buffer.from([asPublic.length]),
    asPublic,
  ]);
  return Buffer.concat([header, body]);
}

/**
 * 알림 하나를 보낸다.
 * @param {object} data  서비스워커가 받을 페이로드 (title/body/tag 등)
 * @param {number} ttl   푸시 서비스가 폰 꺼져 있을 때 붙들고 있을 초
 */
async function send(data, ttl = 3600) {
  const out = await deliver(data, ttl);
  // 429(잠깐 너무 많이 보냄)만 빼고, 알림이 폰에 못 가는 상태면 메일로 알린다.
  // 2026-08-31 에 구독이 만료됐는데 한 달 동안 아무도 몰랐던 일이 있었다.
  if (out.skipped || (out.status >= 400 && out.status !== 429)) await alertBroken(out);
  return out;
}

async function deliver(data, ttl) {
  const rawSub = process.env.PUSH_SUBSCRIPTION;
  if (!rawSub || !process.env.VAPID_PRIVATE_KEY) return { skipped: 'not-configured' };

  let sub;
  try {
    sub = JSON.parse(rawSub);
  } catch {
    return { skipped: 'bad-subscription-json' };
  }
  if (!sub.endpoint || !sub.keys) return { skipped: 'bad-subscription' };

  const body = encrypt(JSON.stringify(data), sub.keys.p256dh, sub.keys.auth);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      // normal 로 두면 APNs 가 배터리를 아끼려고 알림을 모아뒀다가 폰이
      // 깨어날 때 몰아서 준다 — 실제로 수십 초씩 늦었다. 방문 알림은
      // 즉시성이 핵심이라 high 로 올려 바로 깨우게 한다.
      Urgency: 'high',
    },
    body,
  });

  // 404/410 은 구독 만료 — 폰에서 /notify 로 다시 등록해야 한다.
  // 끝자리(ep)는 /notify 가 폰의 현재 구독과 같은지 대조하는 데 쓴다.
  const out = {
    status: res.status,
    expired: res.status === 404 || res.status === 410,
    ep: sub.endpoint.slice(-12),
  };
  if (!res.ok) out.reason = (await res.text().catch(() => '')).slice(0, 200);
  return out;
}

/** 알림이 끊겼다고 하이웍스 메일로 알린다. 하루 한 번만. 실패해도 조용히 넘어간다. */
async function alertBroken(out) {
  try {
    const user = process.env.HIWORKS_EMAIL;
    const pass = process.env.HIWORKS_PASSWORD;
    if (!user || !pass) return;
    if (!(await stat.once('alert:push-broken', 86400))) return;

    const why = out.skipped
      ? `서버 설정 문제 (${out.skipped})`
      : out.expired
        ? `폰의 알림 구독이 만료됨 (${out.status})`
        : `푸시 서비스가 거절함 (${out.status}) ${out.reason || ''}`;

    await sendMail({
      user,
      pass,
      subject: '[FOWARP] 방문 알림이 끊겼다',
      body: [
        '방문 알림이 폰으로 가지 않고 있다.',
        '',
        `원인: ${why}`,
        '',
        '고치는 법',
        '1. 폰에서 FOWARP 알림 앱을 열고 "테스트 알림 보내기"를 누른다',
        '2. 화면에 뜨는 "이 폰의 구독 값 복사" 버튼으로 값을 복사한다',
        '3. Vercel → fowarp-website → Settings → Environment Variables 에서',
        '   PUSH_SUBSCRIPTION 값을 바꾸고 Redeploy 한다 (또는 Claude 에게 맡긴다)',
        '',
        '이 메일은 하루에 한 번만 온다.',
      ].join('\n'),
    });
  } catch (e) {
    console.error('[push] 끊김 메일 실패:', e && e.message);
  }
}

module.exports = { send, b64u, unb64u };
