// 하이웍스 SMTP 메일 발송 — contact.js(문의 폼)와 _push.js(알림 끊김 경보)가 함께 쓴다.
//
// 의존성 0개로 구현한 이유: 이 저장소는 순수 정적 사이트다.
// package.json 을 추가하면 Vercel 이 프로젝트를 프레임워크 프로젝트로 재인식해
// 현재 잘 돌고 있는 정적 서빙 설정(cleanUrls 등)이 바뀔 위험이 있다.
// 그래서 nodemailer 대신 Node 내장 tls 로 SMTP 대화를 직접 처리한다.
//
// 필요한 환경변수 (Vercel → Settings → Environment Variables):
//   HIWORKS_EMAIL    예: hi@fowarp.com
//   HIWORKS_PASSWORD 하이웍스 메일 비밀번호

const tls = require('tls');

const SMTP_HOST = 'smtps.hiworks.com';
const SMTP_PORT = 465; // implicit TLS
const MAIL_TO = 'hi@fowarp.com';
const TIMEOUT_MS = 15000;

/** SMTP 응답을 한 덩어리씩 읽어주는 헬퍼. 멀티라인 응답("250-...")도 처리한다. */
function makeClient(socket) {
  let buffer = '';
  let waiter = null;

  function flush() {
    if (!waiter) return;
    // 마지막 줄이 "NNN "(하이픈 아님) 형태면 응답이 끝난 것
    const lines = buffer.split('\r\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last || !/^\d{3} /.test(last)) return;
    const text = buffer;
    buffer = '';
    const w = waiter;
    waiter = null;
    w.resolve({ code: parseInt(last.slice(0, 3), 10), text });
  }

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => { buffer += chunk; flush(); });

  return {
    read() {
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        flush();
      });
    },
    write(line) { socket.write(line + '\r\n'); },
  };
}

async function expect(client, okCodes, label) {
  const r = await client.read();
  if (!okCodes.includes(r.code)) {
    throw new Error(`SMTP ${label} 실패 (${r.code})`);
  }
  return r;
}

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

/** 한글 제목은 그대로 못 넣으므로 RFC 2047 encoded-word 로 감싼다. */
function encodeHeader(s) { return `=?UTF-8?B?${b64(s)}?=`; }

/** 본문을 base64 로 보내면 줄 시작 점(.) 이스케이프 문제도 함께 사라진다. */
function b64Body(s) {
  return (b64(s).match(/.{1,76}/g) || []).join('\r\n');
}

function sendMail({ user, pass, subject, body, replyTo }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST },
      run
    );
    const fail = (e) => { try { socket.destroy(); } catch (_) {} reject(e); };
    socket.setTimeout(TIMEOUT_MS, () => fail(new Error('SMTP 응답 시간 초과')));
    socket.on('error', fail);

    async function run() {
      try {
        const c = makeClient(socket);
        await expect(c, [220], 'greeting');

        c.write('EHLO fowarp.com');
        await expect(c, [250], 'EHLO');

        c.write('AUTH LOGIN');
        await expect(c, [334], 'AUTH');
        c.write(b64(user));
        await expect(c, [334], 'AUTH user');
        c.write(b64(pass));
        await expect(c, [235], 'AUTH pass');

        c.write(`MAIL FROM:<${user}>`);
        await expect(c, [250], 'MAIL FROM');
        c.write(`RCPT TO:<${MAIL_TO}>`);
        await expect(c, [250, 251], 'RCPT TO');

        c.write('DATA');
        await expect(c, [354], 'DATA');

        const headers = [
          `From: FOWARP Website <${user}>`,
          `To: <${MAIL_TO}>`,
          replyTo ? `Reply-To: <${replyTo}>` : null,
          `Subject: ${encodeHeader(subject)}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
        ].filter(Boolean).join('\r\n');

        socket.write(headers + '\r\n\r\n' + b64Body(body) + '\r\n.\r\n');
        await expect(c, [250], 'body');

        c.write('QUIT');
        socket.end();
        resolve();
      } catch (e) {
        fail(e);
      }
    }
  });
}

module.exports = { sendMail, MAIL_TO };
