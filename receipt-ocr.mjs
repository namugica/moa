let workerPromise;
const progressListeners = new Set();

function notify(progress, stage) {
  for (const listener of progressListeners) {
    try { listener(progress, stage); } catch {}
  }
}

export function receiptOCRStageName(stage) {
  return ({
    'loading tesseract core': '인식 엔진 준비 중',
    'initializing tesseract': '인식 엔진 시작 중',
    'loading language traineddata': '한국어 인식 모델 준비 중',
    'initializing api': '인식 준비 중',
    'recognizing text': '영수증 글자 읽는 중',
    'photo-preprocess': '사진 선명도 보정 중',
    'retry-original': '원본 사진을 한 번 더 확인 중'
  })[stage] || '영수증 인식 준비 중';
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = import('https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js')
      .then(async module => {
        const createWorker = module.createWorker || module.default?.createWorker || module.default;
        if (typeof createWorker !== 'function') throw new Error('Tesseract worker is unavailable');
        const instance = await createWorker('kor+eng', 1, {
          logger: message => notify(Number.isFinite(message.progress) ? message.progress : null, message.status)
        });
        await instance.setParameters({
          tessedit_pageseg_mode: '6',
          preserve_interword_spaces: '1'
        });
        return instance;
      })
      .catch(error => {
        workerPromise = undefined;
        throw error;
      });
  }
  return workerPromise;
}

export function prepareReceiptOCR(onProgress = () => {}) {
  if (onProgress) progressListeners.add(onProgress);
  return getWorker().finally(() => progressListeners.delete(onProgress));
}

function parseDate(text) {
  const korean = text.match(/(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?/);
  const numeric = text.match(/(20\d{2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/);
  const match = korean || numeric;
  if (!match) return '';
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return '';
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function parseAmount(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const totalLabels = /(합\s*계|총\s*액|결제\s*금액|받을\s*금액|승인\s*금액|청구\s*금액|결제\s*합계|payment\s*total|total\s*amount|grand\s*total|amount\s*due|^total\b)/i;
  const ignoredLabels = /(공급가|부가세|세액|할인|잔액|포인트|사업자|전화|카드번호|승인번호|거래번호|주문번호|receipt\s*(?:no|number)|card\s*(?:no|number)|phone)/i;
  const candidates = [];
  for (const [index, line] of lines.entries()) {
    if (!totalLabels.test(line) && (ignoredLabels.test(line) || /(?:20\d{2})\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2}/.test(line))) continue;
    const numbers = [...line.matchAll(/(?:₩|￦|KRW)?\s*(\d[\d,]{2,})\s*원?/gi)]
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
  if (!candidates.length) return { amount: '', amountConfidence: 'low' };
  candidates.sort((a, b) => b.priority - a.priority || b.index - a.index);
  const best = candidates[0];
  return { amount: best.value, amountConfidence: best.priority >= 2 ? 'high' : 'low' };
}

function parseTitle(text) {
  const ignored = /(영수증|사업자|등록번호|대표자|전화|주소|카드|승인|결제|합계|공급가|부가세|현금|거래일|주문번호|포스|pos|total|subtotal|payment|receipt)/i;
  return text.split(/\r?\n/).map(line => line.trim().replace(/\s{2,}/g, ' '))
    .find(line => line.length >= 2 && line.length <= 40 && !ignored.test(line) && !/^[\d\s.,:/-]+$/.test(line)) || '';
}

export function parseReceiptText(text) {
  return { title: parseTitle(text), ...parseAmount(text), spent_on: parseDate(text) };
}

function parseOCRResult(data) {
  return { ...parseReceiptText(data.text || ''), confidence: Number(data.confidence) || 0, text: data.text || '' };
}

function resultScore(result) {
  return (result.amount ? 100 : 0)
    + (result.amountConfidence === 'high' ? 40 : 0)
    + (result.spent_on ? 10 : 0)
    + (result.title ? 5 : 0)
    + Math.min(100, result.confidence) * 0.1;
}

function mergeCandidates(first, second) {
  const best = resultScore(first) >= resultScore(second) ? first : second;
  const other = best === first ? second : first;
  return {
    ...best,
    title: best.title || other.title,
    spent_on: best.spent_on || other.spent_on
  };
}

function nextFrame() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function findReceiptCrop(source, sourceWidth, sourceHeight) {
  const previewScale = Math.min(1, 720 / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * previewScale));
  const height = Math.max(1, Math.round(sourceHeight * previewScale));
  const preview = makeCanvas(width, height);
  const context = preview.getContext('2d', { willReadFrequently: true });
  if (!context) return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  context.drawImage(source, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const rows = new Uint16Array(height);
  const columns = new Uint16Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const red = pixels[offset], green = pixels[offset + 1], blue = pixels[offset + 2];
      const luma = 0.299 * red + 0.587 * green + 0.114 * blue;
      if (luma > 145 && Math.max(red, green, blue) - Math.min(red, green, blue) < 65) {
        rows[y]++;
        columns[x]++;
      }
    }
  }
  const rowMinimum = Math.max(10, width * 0.08);
  const columnMinimum = Math.max(8, height * 0.05);
  let top = 0, bottom = height - 1, left = 0, right = width - 1;
  while (top < bottom && rows[top] < rowMinimum) top++;
  while (bottom > top && rows[bottom] < rowMinimum) bottom--;
  while (left < right && columns[left] < columnMinimum) left++;
  while (right > left && columns[right] < columnMinimum) right--;
  const scaleX = sourceWidth / width, scaleY = sourceHeight / height;
  let x = left * scaleX, y = top * scaleY;
  let cropWidth = (right - left + 1) * scaleX, cropHeight = (bottom - top + 1) * scaleY;
  const padX = cropWidth * 0.03, padY = cropHeight * 0.025;
  x = Math.max(0, x - padX);
  y = Math.max(0, y - padY);
  cropWidth = Math.min(sourceWidth - x, cropWidth + padX * 2);
  cropHeight = Math.min(sourceHeight - y, cropHeight + padY * 2);
  const coverage = (cropWidth * cropHeight) / (sourceWidth * sourceHeight);
  if (coverage < 0.18 || coverage > 0.94 || cropWidth < sourceWidth * 0.16 || cropHeight < sourceHeight * 0.16) {
    return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  }
  return { x, y, width: cropWidth, height: cropHeight };
}

async function preprocessReceiptImage(file, onProgress = () => {}) {
  let bitmap, objectUrl;
  try {
    if (typeof createImageBitmap === 'function') {
      try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch { bitmap = await createImageBitmap(file); }
    } else {
      objectUrl = URL.createObjectURL(file);
      bitmap = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Could not read receipt image'));
        image.src = objectUrl;
      });
    }
    const sourceWidth = bitmap.width || bitmap.naturalWidth;
    const sourceHeight = bitmap.height || bitmap.naturalHeight;
    if (!sourceWidth || !sourceHeight) throw new Error('Receipt image has no dimensions');
    const crop = findReceiptCrop(bitmap, sourceWidth, sourceHeight);
    const scale = Math.min(1.25, 2800 / Math.max(crop.width, crop.height));
    const width = Math.max(1, Math.round(crop.width * scale));
    const height = Math.max(1, Math.round(crop.height * scale));
    const canvas = makeCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas is unavailable');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);

    const image = context.getImageData(0, 0, width, height);
    const tileSize = 64;
    const columns = Math.max(2, Math.ceil(width / tileSize));
    const rows = Math.max(2, Math.ceil(height / tileSize));
    const small = makeCanvas(columns, rows);
    const smallContext = small.getContext('2d', { willReadFrequently: true });
    if (!smallContext) throw new Error('Canvas is unavailable');
    smallContext.imageSmoothingEnabled = true;
    smallContext.imageSmoothingQuality = 'high';
    smallContext.drawImage(canvas, 0, 0, columns, rows);
    const sample = smallContext.getImageData(0, 0, columns, rows).data;
    const background = new Uint8Array(columns * rows);
    for (let i = 0; i < background.length; i++) {
      const offset = i * 4;
      background[i] = Math.round(sample[offset] * 0.299 + sample[offset + 1] * 0.587 + sample[offset + 2] * 0.114);
    }
    const x0 = new Uint8Array(width), x1 = new Uint8Array(width), xf = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const gridX = (x / Math.max(1, width - 1)) * (columns - 1);
      x0[x] = Math.floor(gridX);
      x1[x] = Math.min(columns - 1, x0[x] + 1);
      xf[x] = gridX - x0[x];
    }
    const data = image.data;
    for (let y = 0; y < height; y++) {
      const gridY = (y / Math.max(1, height - 1)) * (rows - 1);
      const y0 = Math.floor(gridY), y1 = Math.min(rows - 1, y0 + 1), yf = gridY - y0;
      const topOffset = y0 * columns, bottomOffset = y1 * columns;
      for (let x = 0; x < width; x++) {
        const topBackground = background[topOffset + x0[x]] * (1 - xf[x]) + background[topOffset + x1[x]] * xf[x];
        const bottomBackground = background[bottomOffset + x0[x]] * (1 - xf[x]) + background[bottomOffset + x1[x]] * xf[x];
        const localBackground = topBackground * (1 - yf) + bottomBackground * yf;
        const offset = (y * width + x) * 4;
        const gray = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
        const normalized = Math.max(0, Math.min(255, 255 - Math.max(0, localBackground - gray) * 2.25));
        data[offset] = data[offset + 1] = data[offset + 2] = normalized;
      }
      if (y && y % 64 === 0) {
        notify(y / height, 'photo-preprocess');
        await nextFrame();
      }
    }
    context.putImageData(image, 0, 0);
    notify(1, 'photo-preprocess');
    return canvas;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

let recognitionQueue = Promise.resolve();

export function recognizeReceipt(file, onProgress = () => {}) {
  const job = recognitionQueue.then(async () => {
    if (onProgress) progressListeners.add(onProgress);
    try {
      const ocr = await getWorker();
      notify(0, 'photo-preprocess');
      let image = file;
      try { image = await preprocessReceiptImage(file, onProgress); }
      catch { image = file; }
      const first = parseOCRResult((await ocr.recognize(image)).data);
      const shouldRetry = !first.amount || first.confidence < 32 || (first.amountConfidence === 'low' && first.confidence < 55);
      if (!shouldRetry || image === file) return first;
      notify(0, 'retry-original');
      const second = parseOCRResult((await ocr.recognize(file)).data);
      return mergeCandidates(first, second);
    } finally {
      if (onProgress) progressListeners.delete(onProgress);
    }
  });
  recognitionQueue = job.catch(() => {});
  return job;
}
