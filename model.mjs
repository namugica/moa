export const STATUS = { planning: '계획 중', traveling: '여행 중', finished: '여행 종료' };
export const uid = () => crypto.randomUUID();
export const dayCount = (start, end) => Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
export function validDates(start, end) {
  return /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && Number.isFinite(dayCount(start, end)) && dayCount(start, end) >= 1;
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
export function balances(trip) {
  return trip.members.map(member => {
    const paid = trip.expenses.filter(e => e.payerId === member.id).reduce((s, e) => s + e.amount, 0);
    const share = trip.expenses.reduce((s, e) => s + (e.shares.find(p => p.memberId === member.id)?.amount || 0), 0);
    return { ...member, paid, share, balance: paid - share };
  });
}
export const totalCost = trip => trip.expenses.reduce((s, e) => s + e.amount, 0);
export const plannedCost = trip => trip.items.reduce((s, e) => s + e.estimate, 0);
export function newTrip({ title, destination, start, end, names }) {
  if (!title.trim() || !destination.trim()) throw new Error('여행 이름과 여행지를 입력해 주세요.');
  if (!validDates(start, end)) throw new Error('종료일은 시작일과 같거나 이후여야 합니다.');
  const members = [...new Set(['나', ...names.split(',').map(n => n.trim()).filter(Boolean)])];
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
