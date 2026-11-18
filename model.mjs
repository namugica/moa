export const STATUS = { planning: '계획 중', traveling: '여행 중', finished: '여행 종료' };
export const uid = () => crypto.randomUUID();
export const dayCount = (start, end) => Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
export function validDates(start, end) {
  const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  return valid(start) && valid(end) && dayCount(start, end) >= 1;
}
export function amount(value) {
  const n = Number(value);
  if (String(value).trim() === '' || !Number.isSafeInteger(n) || n < 0 || n > 1_000_000_000) throw new Error('금액은 0원부터 10억 원까지 정수로 입력해 주세요.');
  return n;
}
export function splitExpense(value, participants) {
  if (!participants.length || new Set(participants).size !== participants.length) throw new Error('함께 쓴 멤버를 한 명 이상 선택해 주세요.');
  const total = amount(value);
  return participants.map((memberId, i) => ({ memberId, amount: Math.floor(total / participants.length) + (i < total % participants.length ? 1 : 0) }));
}
export const FUND_ID = '__fund__';
const priorPayments = trip => (trip.settlementRecords || []).filter(r => r.ledger === true && r.planKey !== trip.settlementPlanRevision);
export function fundBalance(trip) {
  return priorPayments(trip).reduce((sum, r) => sum + (r.to === FUND_ID ? r.amount : 0) - (r.from === FUND_ID ? r.amount : 0), 0)
    + (trip.fundEntries || []).reduce((sum, e) => sum + (e.kind === 'contribution' ? e.amount : -e.amount), 0)
    - trip.expenses.filter(e => e.payment === 'fund').reduce((sum, e) => sum + e.amount, 0);
}
export function balances(trip) {
  return trip.members.map(member => {
    const paid = trip.expenses.filter(e => e.payment !== 'fund' && e.payerId === member.id).reduce((s, e) => s + e.amount, 0);
    const share = trip.expenses.reduce((s, e) => s + (e.shares.find(p => p.memberId === member.id)?.amount || 0), 0);
    const contributed = (trip.fundEntries || []).filter(e => e.memberId === member.id && e.kind === 'contribution').reduce((s, e) => s + e.amount, 0);
    const refunded = (trip.fundEntries || []).filter(e => e.memberId === member.id && e.kind === 'refund').reduce((s, e) => s + e.amount, 0);
    const settled = priorPayments(trip).reduce((sum, r) => sum + (r.from === member.id ? r.amount : 0) - (r.to === member.id ? r.amount : 0), 0);
    return { ...member, paid, share, contributed, refunded, settled, balance: paid + contributed - refunded - share + settled };
  });
}
// Reject malformed ledger data on both client-independent server paths.
export function validateLedger(trip) {
  const members = new Set(trip.members.map(m => m.id));
  if (members.has(FUND_ID)) throw Error('사용할 수 없는 멤버 ID예요.');
  const entries = trip.fundEntries === undefined ? [] : trip.fundEntries;
  if (!Array.isArray(entries) || entries.length > 2000) throw Error('공동 자금 내역을 확인해 주세요.');
  const ids = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !/^[\w-]{1,80}$/.test(entry.id) || ids.has(entry.id) || !members.has(entry.memberId)
      || !['contribution', 'refund'].includes(entry.kind) || !Number.isSafeInteger(entry.amount) || entry.amount < 1 || entry.amount > 1e9
      || !validDates(entry.date, entry.date)) throw Error('공동 자금 내역을 확인해 주세요.');
    ids.add(entry.id);
  }
  for (const e of trip.expenses) {
    if (e.payment !== undefined && !['personal', 'fund'].includes(e.payment)) throw Error('결제 방식을 확인해 주세요.');
    if (e.spentOn !== undefined && !validDates(e.spentOn, e.spentOn)) throw Error('사용 날짜를 확인해 주세요.');
  }
}
export const totalCost = trip => trip.expenses.reduce((s, e) => s + e.amount, 0);
export const plannedCost = trip => trip.items.reduce((s, e) => s + e.estimate, 0);
export function newTrip({ title, destination, start, end, names = '', myName = '나' }) {
  if (!title.trim() || !destination.trim()) throw new Error('여행 이름과 여행지를 입력해 주세요.');
  if (!validDates(start, end)) throw new Error('종료일은 시작일과 같거나 이후여야 합니다.');
  if (!myName.trim() || myName.trim().length > 80) throw new Error('내 이름은 1~80자로 입력해 주세요.');
  const members = [...new Set([myName.trim(), ...names.split(',').map(n => n.trim()).filter(Boolean)])];
  if (members.some(name => name.length > 80)) throw new Error('멤버 이름은 80자 이내로 입력해 주세요.');
  if (members.length > 20) throw new Error('이번 프로토타입은 최대 20명까지 함께할 수 있어요.');
  return { id: uid(), title: title.trim(), destination: destination.trim(), start, end, status: 'planning', members: members.map(name => ({ id: uid(), name })), items: [], expenses: [] };
}
export function demoTrip() {
  const trip = newTrip({ title: '우리의 느긋한 제주', destination: '제주, 대한민국', start: '2026-11-06', end: '2026-11-08', names: '민지, 수현' });
  trip.demo = true;
  trip.items = [
    { id: uid(), date: trip.start, time: '10:00', place: '제주공항', category: '이동', estimate: 30000, note: '공항에서 만나 렌터카 픽업하기', order: 0 },
    { id: uid(), date: trip.start, time: '12:00', place: '애월 바다 앞 점심', category: '맛집', estimate: 60000, note: '바다 보면서 천천히 시작하는 여행', order: 1 },
    { id: uid(), date: trip.start, time: '14:00', place: '한담해안 산책로', category: '관광', estimate: 0, note: '에메랄드빛 바다 따라 걷기', order: 2 }
  ];
  return trip;
}

// A deterministic plan shared by everyone; the client filters it by its authenticated member ID.
export function settlementPlan(trip) {
  const rows = [...balances(trip), { id: FUND_ID, balance: -fundBalance(trip) }];
  const creditors = rows.filter(m => m.balance > 0).map(m => ({ id: m.id, left: m.balance }));
  const debtors = rows.filter(m => m.balance < 0).map(m => ({ id: m.id, left: -m.balance }));
  const transfers = [];
  let c = 0;
  for (const debtor of debtors) {
    while (debtor.left > 0 && c < creditors.length) {
      const creditor = creditors[c];
      const value = Math.min(debtor.left, creditor.left);
      transfers.push({ from: debtor.id, to: creditor.id, amount: value });
      debtor.left -= value; creditor.left -= value;
      if (!creditor.left) c++;
    }
  }
  return transfers;
}

// A payment mark belongs to one exact expense revision. Older imported trips
// have no revision token, so their expense content provides a stable fallback.
export function settlementPlanKey(trip) {
  if (typeof trip.settlementPlanRevision === 'string' && trip.settlementPlanRevision) return trip.settlementPlanRevision;
  return JSON.stringify({ expenses: trip.expenses, fundEntries: trip.fundEntries, plan: settlementPlan(trip) });
}

export function settlementProgress(trip) {
  const planKey = settlementPlanKey(trip);
  const records = Array.isArray(trip.settlementRecords) ? trip.settlementRecords : [];
  return settlementPlan(trip).map((transfer, index) => {
    const record = records.find(item => item.planKey === planKey && item.from === transfer.from && item.to === transfer.to && item.amount === transfer.amount);
    return { ...transfer, id: `${index}`, completed: Boolean(record), completedAt: record?.completedAt || null };
  });
}

