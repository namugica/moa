import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPABASE_URL } from './config.mjs';
import { STATUS, validDates, splitExpense } from './model.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const token = () => randomBytes(32).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const id = value => typeof value === 'string' && /^[\w-]{1,80}$/.test(value);
const unique = list => list.every(x => x && typeof x === 'object') && new Set(list.map(x => x.id)).size === list.length;

export function validateTrip(t) {
  if (!t || !id(t.id) || !text(t.title, 80) || !text(t.destination, 80) || !validDates(t.start, t.end) || (typeof t.status !== 'string' || !Object.hasOwn(STATUS, t.status))) fail(400, '여행 정보가 올바르지 않아요.');
  if (!Array.isArray(t.members) || !t.members.length || t.members.length > 20 || !unique(t.members) || t.members.some(m => !id(m.id) || !text(m.name, 80))) fail(400, '멤버 정보를 확인해 주세요. (최대 20명)');
  if (!Array.isArray(t.items) || !Array.isArray(t.expenses) || t.items.length > 2000 || t.expenses.length > 2000 || !unique(t.items) || !unique(t.expenses)) fail(400, '일정 또는 지출 목록이 올바르지 않아요.');
  const members = new Set(t.members.map(m => m.id));
  const items = new Set(t.items.map(i => i.id));
  for (const i of t.items) {
    if (!id(i.id) || !text(i.place, 100) || !validDates(i.date, i.date) || i.date < t.start || i.date > t.end || !Number.isSafeInteger(i.estimate) || i.estimate < 0 || i.estimate > 1e9 || !Number.isSafeInteger(i.order) || i.order < 0 || typeof i.note !== 'string' || i.note.length > 1000 || typeof i.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/.test(i.time) || !['관광','맛집','카페','이동','숙소','기타'].includes(i.category)) fail(400, '일정 내용을 확인해 주세요.');
  }
  for (const e of t.expenses) {
    if (!id(e.id) || !text(e.title, 100) || !members.has(e.payerId) || (e.itemId !== null && !items.has(e.itemId)) || !Number.isSafeInteger(e.amount) || !Array.isArray(e.shares) || e.shares.some(s => !s || !members.has(s.memberId))) fail(400, '지출 내용을 확인해 주세요.');
    let shares;
    try { shares = splitExpense(e.amount, e.shares.map(s => s.memberId)); } catch { fail(400, '분할 금액 또는 참여자가 올바르지 않아요.'); }
    if (shares.some((s, i) => s.amount !== e.shares[i].amount)) fail(400, '분할 금액이 일치하지 않아요.');
  }
  return t;
}

export function createMoaServer({ dataDir = process.env.MOA_DATA_DIR || join(root, '.moa-data'), allowedOrigins = process.env.MOA_ALLOWED_ORIGINS || '' } = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbFile = join(dataDir, 'trips.json');
  let db = { rooms: {} };
  try { db = JSON.parse(readFileSync(dbFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!db.rooms || typeof db.rooms !== 'object') throw new Error('Invalid MOA data file');
  const streams = new Set();
  const commit = fn => {
    const next = structuredClone(db);
    const result = fn(next);
    writeFileSync(dbFile + '.tmp', JSON.stringify(next), { mode: 0o600 });
    renameSync(dbFile + '.tmp', dbFile);
    db = next;
    return result;
  };
  const snapshot = (room, memberId) => ({ trip: room.trip, version: room.version, memberId, ownerId: room.ownerId, claimedIds: [...new Set(Object.values(room.sessions))] });
  const publish = roomId => {
    for (const stream of streams) if (stream.roomId === roomId) stream.res.write(`data: ${JSON.stringify(snapshot(db.rooms[roomId], stream.memberId))}\n\n`);
  };
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const body = async req => {
    if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'JSON 형식으로 요청해 주세요.');
    let size = 0, chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 1_000_000) fail(413, '여행 데이터가 너무 커요.'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, '요청을 읽을 수 없어요.'); }
  };
  const auth = (req, roomId) => {
    const room = db.rooms[roomId];
    const bearer = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const memberId = room && bearer && room.sessions[hash(bearer)];
    if (!memberId) fail(401, '이 여행에 참여할 권한이 없어요. 원래 참여한 브라우저 또는 새 초대 링크를 이용해 주세요.');
    return { room, memberId };
  };
  const invitation = value => {
    if (!/^[a-f0-9]{64}$/.test(value)) fail(404, '유효하지 않은 초대 링크예요.');
    const digest = hash(value);
    for (const [roomId, room] of Object.entries(db.rooms)) {
      const invite = room.invites[digest];
      if (invite) {
        if (invite.used || invite.expiresAt < Date.now()) fail(410, '이미 사용했거나 만료된 초대 링크예요. 여행을 만든 친구에게 새 링크를 요청해 주세요.');
        return { roomId, room, invite, digest };
      }
    }
    fail(404, '초대 링크를 찾을 수 없어요.');
  };
  const origins = new Set(allowedOrigins.split(',').map(s => s.trim()).filter(Boolean));
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(origin && origins.has(origin) ? 204 : 403); res.end(); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self' ${SUPABASE_URL ? new URL(SUPABASE_URL).origin : ''}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
      if (path === '/api/trips' && req.method === 'POST') {
        const { trip } = await body(req);
        validateTrip(trip);
        const session = token();
        const roomId = randomUUID();
        const room = { trip: { ...trip, id: roomId }, version: 1, ownerId: trip.members[0].id, sessions: { [hash(session)]: trip.members[0].id }, invites: {} };
        commit(next => { next.rooms[roomId] = room; });
        return json(res, 201, { ...snapshot(room, room.ownerId), token: session });
      }
      const inviteRoute = path.match(/^\/api\/invites\/([^/]+)(\/join)?$/);
      if (inviteRoute) {
        if (!['GET', 'POST'].includes(req.method) || (req.method === 'POST') !== Boolean(inviteRoute[2])) fail(405, '지원하지 않는 요청이에요.');
        const { roomId, room, invite, digest } = invitation(inviteRoute[1]);
        if (req.method === 'GET') return json(res, 200, { title: room.trip.title, memberName: room.trip.members.find(m => m.id === invite.memberId).name });
        // No await between checking the single-use invitation and committing its claim.
        const session = token();
        const updated = commit(next => {
          const r = next.rooms[roomId];
          r.invites[digest].used = true;
          r.sessions[hash(session)] = invite.memberId;
          return r;
        });
        publish(roomId);
        return json(res, 200, { ...snapshot(updated, invite.memberId), token: session });
      }
      const tripRoute = path.match(/^\/api\/trips\/([\w-]+)(?:\/(events|invites))?$/);
      if (tripRoute) {
        const [, roomId, action] = tripRoute;
        let { room, memberId } = auth(req, roomId);
        if (!action && req.method === 'GET') return json(res, 200, snapshot(room, memberId));
        if (action === 'events' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(`data: ${JSON.stringify(snapshot(room, memberId))}\n\n`);
          const stream = { roomId, memberId, res };
          streams.add(stream);
          const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
          res.on('close', () => { streams.delete(stream); clearInterval(heartbeat); });
          return;
        }
        if (!action && req.method === 'PATCH') {
          const { trip, version } = await body(req);
          ({ room, memberId } = auth(req, roomId));
          if (version !== room.version) return json(res, 409, { error: '친구가 먼저 변경했어요. 최신 내용을 확인하고 다시 저장해 주세요.', ...snapshot(room, memberId) });
          validateTrip(trip);
          if (trip.id !== roomId || JSON.stringify(trip.members) !== JSON.stringify(room.trip.members)) fail(400, '멤버 변경은 초대 기능을 이용해 주세요.');
          const updated = commit(next => { next.rooms[roomId].trip = trip; next.rooms[roomId].version++; return next.rooms[roomId]; });
          publish(roomId);
          return json(res, 200, snapshot(updated, memberId));
        }
        if (action === 'invites' && req.method === 'POST') {
          const input = await body(req);
          ({ room, memberId } = auth(req, roomId));
          if (memberId !== room.ownerId) fail(403, '초대 링크는 여행을 만든 사람만 만들 수 있어요.');
          const value = token();
          const expiresAt = Date.now() + 7 * 86400000;
          const updated = commit(next => {
            const r = next.rooms[roomId];
            let target = input.memberId;
            if (!target) {
              if (!text(input.name, 80)) fail(400, '초대할 친구 이름을 입력해 주세요.');
              if (r.trip.members.length >= 20) fail(400, '여행은 최대 20명까지 함께할 수 있어요.');
              if (r.trip.members.some(m => m.name === input.name.trim())) fail(400, '이미 있는 이름이에요. 목록에서 선택해 주세요.');
              target = randomUUID();
              r.trip.members.push({ id: target, name: input.name.trim() });
            }
            if (!r.trip.members.some(m => m.id === target) || Object.values(r.sessions).includes(target)) fail(409, '이미 참여했거나 없는 멤버예요.');
            for (const pending of Object.values(r.invites)) if (pending.memberId === target) pending.used = true;
            r.invites[hash(value)] = { memberId: target, expiresAt, used: false };
            r.version++;
            return r;
          });
          publish(roomId);
          return json(res, 201, { ...snapshot(updated, memberId), inviteToken: value, expiresAt });
        }
        fail(405, '지원하지 않는 요청이에요.');
      }
      if (path.startsWith('/api/')) fail(404, '요청한 기능을 찾을 수 없어요.');
      const files = { '/': ['index.html','text/html'], '/index.html': ['index.html','text/html'], '/app.mjs': ['app.mjs','text/javascript'], '/auth.mjs': ['auth.mjs','text/javascript'], '/account.mjs': ['account.mjs','text/javascript'], '/shared.mjs': ['shared.mjs','text/javascript'], '/config.mjs': ['config.mjs','text/javascript'], '/supabase-client.mjs': ['supabase-client.mjs','text/javascript'], '/model.mjs': ['model.mjs','text/javascript'], '/styles.css': ['styles.css','text/css'], '/assets/travel.svg': ['assets/travel.svg','image/svg+xml'] };
      if (!files[path] || !['GET','HEAD'].includes(req.method)) fail(404, '페이지를 찾을 수 없어요.');
      const [file, type] = files[path];
      const content = readFileSync(join(root, file));
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (e) {
      if (res.headersSent) return res.end();
      json(res, e.status || 500, { error: e.status ? e.message : '서버에 저장하지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }
  });
  server.closeSharedStreams = () => { for (const s of streams) s.res.end(); };
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createMoaServer();
  const port = Number(process.env.PORT || 8000), host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`MOA server listening on ${host}:${port}`));
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => { server.closeSharedStreams(); server.close(() => process.exit(0)); });
}
