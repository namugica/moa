// Approved costs and cash movements are distinct: reimbursement is not another cost.
export function financeTotals(entries, cash, memberId) {
  const approved = entries.filter(e => e.status === 'approved');
  const personal = approved.filter(e => e.payment === 'personal');
  const paid = cash.filter(c => c.kind === 'reimbursement').reduce((s,c) => s+c.amount,0);
  const mine = personal.filter(e => e.member_id === memberId);
  const myPaid = cash.filter(c => c.kind === 'reimbursement' && mine.some(e => e.id === c.entry_id)).reduce((s,c) => s+c.amount,0);
  return {
    cost: approved.reduce((s,e) => s+e.amount,0),
    balance: cash.reduce((s,c) => s+(c.kind === 'income' ? c.amount : -c.amount),0) - approved.filter(e=>e.payment==='fund').reduce((s,e)=>s+e.amount,0),
    pending: personal.reduce((s,e)=>s+e.amount,0)-paid,
    myPending: mine.reduce((s,e)=>s+e.amount,0)-myPaid,
    review: entries.filter(e=>e.status==='submitted').length
  };
}
