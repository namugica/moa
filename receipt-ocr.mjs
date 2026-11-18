let workerPromise;
let progressCallback = () => {};

async function worker() {
  if (!workerPromise) {
    workerPromise = import('https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.esm.min.js')
      .then(({ createWorker }) => createWorker('kor+eng', 1, {
        logger: message => {
          if (message.status === 'recognizing text' && Number.isFinite(message.progress)) progressCallback(message.progress);
        }
      }))
      .catch(error => {
        workerPromise = undefined;
        throw error;
      });
  }
  return workerPromise;
}

function parseDate(text) {
  const korean = text.match(/(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?/);
  const numeric = text.match(/(20\d{2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/);
  const match = korean || numeric;
  if (!match) return '';
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseAmount(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const totalLabels = /(합\s*계|총\s*액|결제\s*금액|받을\s*금액|승인\s*금액|청구\s*금액|결제\s*합계)/;
  const ignoredLabels = /(공급가|부가세|세액|할인|잔액|포인트|사업자|전화|카드번호)/;
  const candidates = [];
  for (const [index, line] of lines.entries()) {
    const numbers = [...line.matchAll(/(?:₩|￦)?\s*(\d[\d,]{2,})\s*원?/g)]
      .map(match => Number(match[1].replaceAll(',', '')))
      .filter(value => value > 0 && value <= 1_000_000_000);
    const priority = totalLabels.test(line) && !ignoredLabels.test(line) ? 3 : 0;
    if (!numbers.length) {
      if (priority && lines[index + 1]) {
        const next = [...lines[index + 1].matchAll(/(\d[\d,]{2,})\s*원?/g)]
          .map(match => Number(match[1].replaceAll(',', '')))
          .filter(value => value > 0 && value <= 1_000_000_000);
        next.forEach(value => candidates.push({ value, priority: 2, index: index + 1 }));
      }
      continue;
    }
    numbers.forEach(value => candidates.push({ value, priority, index }));
  }
  if (!candidates.length) return '';
  candidates.sort((a, b) => b.priority - a.priority || b.index - a.index);
  return candidates[0].value;
}

function parseTitle(text) {
  const ignored = /(영수증|사업자|등록번호|대표자|전화|주소|카드|승인|결제|합계|공급가|부가세|현금|거래일|주문번호|포스|pos)/i;
  return text.split(/\r?\n/).map(line => line.trim().replace(/\s{2,}/g, ' '))
    .find(line => line.length >= 2 && line.length <= 40 && !ignored.test(line) && !/^[\d\s.,:/-]+$/.test(line)) || '';
}

export function parseReceiptText(text) {
  return { title: parseTitle(text), amount: parseAmount(text), spent_on: parseDate(text) };
}

export async function recognizeReceipt(file, onProgress = () => {}) {
  progressCallback = onProgress;
  try {
    const ocr = await worker();
    const result = await ocr.recognize(file);
    return { ...parseReceiptText(result.data.text), text: result.data.text };
  } finally {
    progressCallback = () => {};
  }
}
