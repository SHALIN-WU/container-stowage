export const OCR_NOTICE = "OCR 辨識，請核對";
export const FIRST_OCR_LOAD = "首次載入辨識模組，約需數十秒";
export const OCR_WORKING = "正在辨識圖片，請稍候…";
export const LOW_CONFIDENCE = 70;

const ACCEPT_LIST = "PDF、JPG、PNG、Word（.docx）、Excel（.xlsx、.xls、.csv）";

let workerPromise = null;

export function fileBadge(filename) {
  const ext = String(filename || "").split(".").pop().toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "jpg";
  if (ext === "png") return "png";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "word";
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return "excel";
  return "";
}

export function classifyUpload(filename) {
  const name = String(filename || "");
  const ext = ((name.match(/\.([^.]+)$/) || [])[1] || "").toLowerCase();
  if (ext === "pdf") return { kind: "pdf" };
  if (ext === "doc") {
    return { kind: "doc", error: `${name} 是舊版 Word，讀不了。請用 Word 另存為 .docx 再上傳。` };
  }
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return { kind: "excel" };
  if (ext === "docx") return { kind: "word" };
  if (ext === "jpg" || ext === "jpeg" || ext === "png") return { kind: "image" };
  return { kind: "unsupported", error: `不支援 ${name}。請改傳 ${ACCEPT_LIST}。` };
}

export function cellsToItems(rows, yBase = 10000) {
  const items = [];
  rows.forEach((row, rowIndex) => {
    const cells = Array.isArray(row) ? row : [];
    cells.forEach((value, columnIndex) => {
      const str = value == null ? "" : String(value).replace(/\s+/g, " ").trim();
      if (!str) return;
      items.push({
        str,
        x: 40 + columnIndex * 90,
        y: yBase - rowIndex * 24,
        w: str.length * 6,
      });
    });
  });
  return items;
}

function asBytes(buffer) {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

export function excelToItems(buffer) {
  const xlsx = globalThis.XLSX;
  if (!xlsx) throw new Error("Excel 讀取元件沒有載入。");
  const workbook = xlsx.read(asBytes(buffer), { type: "array", cellDates: false });
  const items = [];
  workbook.SheetNames.forEach((sheetName, sheetIndex) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
    items.push(...cellsToItems(rows, 10000 + sheetIndex * 100000));
  });
  return items;
}

function blockNodes(node, visit) {
  if (!node || node.nodeType !== 1) return;
  if (node.tagName === "TABLE") {
    visit(node);
    return;
  }
  const children = [...node.children];
  if (children.some((child) => child.tagName === "TABLE" || child.querySelector?.("table"))) {
    children.forEach((child) => blockNodes(child, visit));
    return;
  }
  visit(node);
}

export async function wordToItems(buffer) {
  const mammoth = globalThis.mammoth;
  if (!mammoth) throw new Error("Word 讀取元件沒有載入。");
  const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
  const doc = new DOMParser().parseFromString(result.value || "", "text/html");
  const items = [];
  let y = 200000;
  blockNodes(doc.body, (node) => {
    if (node.tagName === "TABLE") {
      const rows = [...node.rows].map((tr) => [...tr.cells].map((cell) => cell.textContent.replace(/\s+/g, " ").trim()));
      items.push(...cellsToItems(rows, y));
      y -= Math.max(rows.length, 1) * 24 + 80;
      return;
    }
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (!text) return;
    items.push({ str: text, x: 40, y, w: text.length * 6 });
    y -= 24;
  });
  return items;
}

export function readJpegOrientation(buffer) {
  const bytes = asBytes(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return 1;
  let offset = 2;
  while (offset + 4 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const size = view.getUint16(offset + 2);
    if (size < 2 || offset + 2 + size > view.byteLength) break;
    if (marker === 0xe1) {
      const orientation = orientationInExif(view, offset + 4, offset + 2 + size);
      if (orientation) return orientation;
    }
    offset += 2 + size;
  }
  return 1;
}

function orientationInExif(view, start, end) {
  if (start + 8 > end) return 0;
  if (view.getUint32(start) !== 0x45786966 || view.getUint16(start + 4) !== 0) return 0;
  const tiff = start + 6;
  if (tiff + 8 > end) return 0;
  const order = view.getUint16(tiff);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return 0;
  const read16 = (pos) => view.getUint16(pos, little);
  const read32 = (pos) => view.getUint32(pos, little);
  if (read16(tiff + 2) !== 42) return 0;
  const ifd = tiff + read32(tiff + 4);
  if (ifd + 2 > end) return 0;
  const count = read16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) break;
    if (read16(entry) !== 0x0112) continue;
    const value = read16(entry + 8);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 0;
}

let exifHandledByBrowser = null;

function insertJpegOrientation(bytes, orientation) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = new Uint8Array(source.length + 36);
  out.set(source.subarray(0, 2), 0);
  const exif = new DataView(out.buffer, 2, 36);
  exif.setUint16(0, 0xffe1);
  exif.setUint16(2, 34);
  exif.setUint32(4, 0x45786966);
  exif.setUint16(8, 0);
  exif.setUint16(10, 0x4949);
  exif.setUint16(12, 42, true);
  exif.setUint32(14, 8, true);
  exif.setUint16(18, 1, true);
  exif.setUint16(20, 0x0112, true);
  exif.setUint16(22, 3, true);
  exif.setUint32(24, 1, true);
  exif.setUint16(28, orientation, true);
  out.set(source.subarray(2), 38);
  return out;
}

async function browserAppliesExif() {
  if (exifHandledByBrowser != null) return exifHandledByBrowser;
  const probe = document.createElement("canvas");
  probe.width = 8;
  probe.height = 4;
  const blob = await new Promise((resolve) => probe.toBlob(resolve, "image/jpeg", 0.8));
  const turned = insertJpegOrientation(new Uint8Array(await blob.arrayBuffer()), 6);
  const bitmap = await createImageBitmap(new Blob([turned], { type: "image/jpeg" }), { imageOrientation: "none" }).catch(() =>
    createImageBitmap(new Blob([turned], { type: "image/jpeg" }))
  );
  exifHandledByBrowser = bitmap.width === 4 && bitmap.height === 8;
  if (bitmap.close) bitmap.close();
  return exifHandledByBrowser;
}

function drawOriented(bitmap, orientation) {
  const swap = orientation >= 5 && orientation <= 8;
  const canvas = document.createElement("canvas");
  canvas.width = swap ? bitmap.height : bitmap.width;
  canvas.height = swap ? bitmap.width : bitmap.height;
  const ctx = canvas.getContext("2d");
  if (orientation === 2) ctx.transform(-1, 0, 0, 1, bitmap.width, 0);
  else if (orientation === 3) ctx.transform(-1, 0, 0, -1, bitmap.width, bitmap.height);
  else if (orientation === 4) ctx.transform(1, 0, 0, -1, 0, bitmap.height);
  else if (orientation === 5) ctx.transform(0, 1, 1, 0, 0, 0);
  else if (orientation === 6) ctx.transform(0, 1, -1, 0, bitmap.height, 0);
  else if (orientation === 7) ctx.transform(0, -1, -1, 0, bitmap.height, bitmap.width);
  else if (orientation === 8) ctx.transform(0, -1, 1, 0, 0, bitmap.width);
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

export async function uprightImage(blob) {
  const buffer = await blob.arrayBuffer();
  const orientation = readJpegOrientation(buffer);
  const source = new Blob([buffer], { type: blob.type || "image/jpeg" });
  let bitmap;
  try {
    bitmap = await createImageBitmap(source, { imageOrientation: "none" });
  } catch (error) {
    bitmap = await createImageBitmap(source);
  }
  const canvas = document.createElement("canvas");
  if (orientation === 1 || (await browserAppliesExif())) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
  } else {
    const turned = drawOriented(bitmap, orientation);
    if (bitmap.close) bitmap.close();
    return turned;
  }
  if (bitmap.close) bitmap.close();
  return canvas;
}

const OCR_PSM = "6";

function capEdge(canvas, maxEdge) {
  const edge = Math.max(canvas.width, canvas.height);
  if (edge <= maxEdge) return canvas;
  const ratio = maxEdge / edge;
  const scaled = document.createElement("canvas");
  scaled.width = Math.max(1, Math.round(canvas.width * ratio));
  scaled.height = Math.max(1, Math.round(canvas.height * ratio));
  const ctx = scaled.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
  return scaled;
}

function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (const value of gray) hist[value] += 1;
  const total = gray.length;
  let sum = 0;
  for (let tone = 0; tone < 256; tone += 1) sum += tone * hist[tone];
  let sumBack = 0;
  let weightBack = 0;
  let best = -1;
  let threshold = 128;
  for (let tone = 0; tone < 256; tone += 1) {
    weightBack += hist[tone];
    if (!weightBack) continue;
    const weightFore = total - weightBack;
    if (!weightFore) break;
    sumBack += tone * hist[tone];
    const meanBack = sumBack / weightBack;
    const meanFore = (sum - sumBack) / weightFore;
    const between = weightBack * weightFore * (meanBack - meanFore) ** 2;
    if (between > best) {
      best = between;
      threshold = tone;
    }
  }
  return threshold;
}

function isTintedPaper(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let tinted = 0;
  let samples = 0;
  for (let index = 0; index < data.length; index += 64) {
    samples += 1;
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    if (red > 170 && green > 90 && green < 230 && blue < 90 && red > blue + 80) tinted += 1;
  }
  return samples > 0 && tinted / samples > 0.12;
}

function prepareTintedCanvas(canvas) {
  const scale = 3;
  const enlarged = document.createElement("canvas");
  enlarged.width = Math.max(1, canvas.width * scale);
  enlarged.height = Math.max(1, canvas.height * scale);
  const draw = enlarged.getContext("2d", { willReadFrequently: true });
  draw.imageSmoothingEnabled = false;
  draw.drawImage(canvas, 0, 0, enlarged.width, enlarged.height);
  const fitted = capEdge(enlarged, 5000);
  const ctx = fitted.getContext("2d", { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, fitted.width, fitted.height);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const gray = (0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]) | 0;
    data[index] = gray;
    data[index + 1] = gray;
    data[index + 2] = gray;
  }
  ctx.putImageData(image, 0, 0);
  return { canvas: fitted, scale: fitted.width / canvas.width };
}

function prepareOcrCanvas(canvas) {
  const enlarged = document.createElement("canvas");
  enlarged.width = Math.max(1, canvas.width * 2);
  enlarged.height = Math.max(1, canvas.height * 2);
  const draw = enlarged.getContext("2d", { willReadFrequently: true });
  draw.imageSmoothingEnabled = true;
  draw.drawImage(canvas, 0, 0, enlarged.width, enlarged.height);
  const fitted = capEdge(enlarged, 4000);
  const ctx = fitted.getContext("2d", { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, fitted.width, fitted.height);
  const data = image.data;
  const gray = new Uint8Array(data.length / 4);
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    gray[pixel] = (0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]) | 0;
  }
  const threshold = otsuThreshold(gray);
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    const value = gray[pixel] < threshold ? 0 : 255;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }
  ctx.putImageData(image, 0, 0);
  return fitted;
}

function vendorUrl(relative) {
  return new URL(relative, document.baseURI).href;
}

async function getOcrWorker(onStatus) {
  const tesseract = globalThis.Tesseract;
  if (!tesseract) throw new Error("圖片辨識元件沒有載入。");
  if (!workerPromise) {
    if (onStatus) onStatus(FIRST_OCR_LOAD);
    const pending = tesseract
      .createWorker("chi_tra+chi_sim+eng", 1, {
        workerPath: vendorUrl("js/vendor/tesseract/worker.min.js"),
        corePath: vendorUrl("js/vendor/tesseract/tesseract-core-simd-lstm.wasm.js"),
        langPath: vendorUrl("js/vendor/tesseract/lang"),
        workerBlobURL: false,
        gzip: true,
      })
      .then(async (worker) => {
        await worker.setParameters({ tessedit_pageseg_mode: OCR_PSM });
        return worker;
      })
      .catch((error) => {
        workerPromise = null;
        throw error;
      });
    workerPromise = pending;
  }
  return workerPromise;
}

function clusterWords(words) {
  const heights = words.map((word) => word.height).filter((height) => height > 0).sort((left, right) => left - right);
  const typical = heights[Math.floor(heights.length / 2)] || 20;
  const limit = Math.max(12, typical * 0.65);
  const sorted = [...words].sort((left, right) => left.mid - right.mid);
  const lines = [];
  for (const word of sorted) {
    const line = lines.find((candidate) => Math.abs(candidate.mid - word.mid) <= limit);
    if (!line) {
      lines.push({ mid: word.mid, height: word.height, words: [word] });
      continue;
    }
    line.words.push(word);
    const count = line.words.length;
    line.mid = (line.mid * (count - 1) + word.mid) / count;
    line.height = Math.max(line.height, word.height);
  }
  return lines;
}

function isDimSeparator(text) {
  return /^[xX×*＊°"·•]$/.test(String(text).trim());
}

function digitsOf(value) {
  return String(value).replace(/\D/g, "");
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

async function readNumberCrop(worker, source, crop) {
  const zoom = 8;
  const sx = Math.max(0, Math.floor(crop.x));
  const sy = Math.max(0, Math.floor(crop.y));
  const ex = Math.min(source.width, Math.ceil(crop.x + crop.w));
  const ey = Math.min(source.height, Math.ceil(crop.y + crop.h));
  if (ex - sx < 4 || ey - sy < 4) return "";
  const tile = document.createElement("canvas");
  tile.width = (ex - sx) * zoom;
  tile.height = (ey - sy) * zoom;
  const ctx = tile.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, sx, sy, ex - sx, ey - sy, 0, 0, tile.width, tile.height);
  const result = await worker.recognize(tile);
  return String(result.data.text || "").replace(/\s+/g, "").trim();
}

async function refineDecimals(worker, words, source, scale) {
  const targets = words.filter((word) => /^\d{2,}$/.test(word.text));
  if (!targets.length) return;
  await worker.setParameters({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: "0123456789." });
  try {
    for (const word of targets) {
      const box = {
        x: word.x / scale,
        y: word.y0 / scale,
        w: word.width / scale,
        h: Math.max(1, (word.y1 - word.y0) / scale),
      };
      const crops = [
        { x: box.x - 2, y: box.y + 4, w: box.w + 6, h: Math.max(16, box.h * 0.56) },
        { x: box.x, y: box.y + 2, w: box.w + 8, h: Math.max(18, box.h * 0.62) },
        { x: box.x - 8, y: box.y - 4, w: box.w + 16, h: box.h + 8 },
      ];
      for (const crop of crops) {
        const text = await readNumberCrop(worker, source, crop);
        if (text.includes(".") && digitsOf(text) === digitsOf(word.text)) {
          word.text = text;
          break;
        }
      }
    }
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: OCR_PSM, tessedit_char_whitelist: "" });
  }
}

function isNoiseToken(text) {
  return /^[|~ˍ﹍_\[\]\-–—.=·•ˉ¯\s]+$/.test(String(text).trim());
}

function dedupeWords(words) {
  const kept = [];
  for (const word of words) {
    const text = String(word.text).trim();
    const duplicate = kept.some(
      (other) => String(other.text).trim() === text && Math.abs(other.x - word.x) < 12 && Math.abs(other.mid - word.mid) < 12
    );
    if (!duplicate) kept.push(word);
  }
  return kept;
}

function spreadLines(words) {
  const measToken = /\d+(?:\.\d+)?[xX×*＊°"·•]\d+(?:\.\d+)?[xX×*＊°"·•]\d+(?:\.\d+)?/;
  const numeric = /^\d+(?:\.\d+)?$/;
  const found = [];
  for (const line of clusterWords(words)) {
    const ordered = [...line.words].sort((left, right) => left.x - right.x);
    const meas = ordered.find((word) => measToken.test(String(word.text).replace(/\s/g, "")));
    if (!meas) continue;
    const numbers = ordered.filter((word) => word.x > meas.x + meas.width * 0.4 && numeric.test(String(word.text).trim()));
    found.push({ meas, numbers, mid: line.mid });
  }
  return found;
}

function injectSpreadHeader(words) {
  const tokens = words.map((word) => String(word.text).trim().toLowerCase());
  const hasQty = tokens.some((token) => /^(quantity|qty|數量)$/.test(token));
  const hasWeight = tokens.some((token) => /^(weight|total weight|毛重|重量)(?:\s*\(t\))?$/.test(token));
  if (hasQty && hasWeight) return;
  const samples = spreadLines(words).filter((line) => line.numbers.length >= 3);
  if (samples.length < 2) return;
  const dataTop = Math.min(...samples.map((sample) => sample.mid));
  for (let index = words.length - 1; index >= 0; index -= 1) {
    if (words[index].mid < dataTop - 36) words.splice(index, 1);
  }
  const mid = dataTop - 140;
  const columns = [
    ["Dimensions (LxWxH)", median(samples.map((sample) => sample.meas.x))],
    ["Quantity", median(samples.map((sample) => sample.numbers[0].x))],
    ["Weight (t)", median(samples.map((sample) => sample.numbers[1].x))],
    ["Total Weight (t)", median(samples.map((sample) => sample.numbers[2].x))],
  ];
  for (const [text, x] of columns) {
    words.push({ text, x, width: Math.min(text.length * 10, 150), mid, height: 22, y0: mid - 11, y1: mid + 11, confidence: 90 });
  }
}

async function fillMissingQuantities(worker, words, source, scale) {
  const lines = spreadLines(words);
  const complete = lines.filter((line) => line.numbers.length >= 3);
  const gaps = lines.filter((line) => line.numbers.length < 3);
  if (complete.length < 2 || !gaps.length) return;
  const qtyX = median(complete.map((line) => line.numbers[0].x));
  await worker.setParameters({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: "0123456789" });
  try {
    for (const gap of gaps) {
      if (gap.numbers.some((word) => Math.abs(word.x - qtyX) < 90)) continue;
      const box = {
        y: gap.meas.y0 / scale,
        h: Math.max(1, (gap.meas.y1 - gap.meas.y0) / scale),
      };
      const crops = [
        { x: qtyX / scale - 18, y: box.y + 4, w: 46, h: Math.max(16, box.h * 0.56) },
        { x: qtyX / scale - 24, y: box.y + 2, w: 60, h: Math.max(18, box.h * 0.62) },
      ];
      for (const crop of crops) {
        const digits = (await readNumberCrop(worker, source, crop)).replace(/\D/g, "");
        if (!/^([1-9]\d{0,2})$/.test(digits)) continue;
        words.push({
          text: digits,
          x: qtyX,
          width: 24,
          y0: gap.meas.y0,
          y1: gap.meas.y1,
          mid: (gap.meas.y0 + gap.meas.y1) / 2,
          height: Math.max(8, gap.meas.y1 - gap.meas.y0),
          confidence: 70,
        });
        break;
      }
    }
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: OCR_PSM, tessedit_char_whitelist: "" });
  }
}

function joinDimensionTokens(words) {
  const ordered = [...words].sort((left, right) => left.x - right.x);
  const merged = [];
  for (const word of ordered) {
    const last = merged[merged.length - 1];
    const gap = last ? word.x - (last.x + last.width) : Infinity;
    const close = last && gap < Math.max(28, (last.height || 12) * 1.6);
    const lastText = last ? String(last.text).trim() : "";
    const wordText = String(word.text).trim();
    const glue =
      close &&
      ((/\d$/.test(lastText) && isDimSeparator(wordText)) ||
        (isDimSeparator(lastText.slice(-1)) && /^\d/.test(wordText)));
    if (glue) {
      last.text = `${lastText}${wordText}`;
      last.width = word.x + word.width - last.x;
      if (Number.isFinite(word.confidence)) {
        last.confidence = Number.isFinite(last.confidence) ? Math.min(last.confidence, word.confidence) : word.confidence;
      }
      continue;
    }
    merged.push({ ...word });
  }
  return merged;
}

export async function imageToItems(blob, onStatus, psm = OCR_PSM) {
  const upright = await uprightImage(blob);
  const tinted = isTintedPaper(upright);
  const prepared = tinted ? prepareTintedCanvas(upright) : { canvas: prepareOcrCanvas(upright), scale: 2 };
  const canvas = prepared.canvas;
  const worker = await getOcrWorker(onStatus);
  if (onStatus) onStatus(OCR_WORKING);
  await worker.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: "" });
  const result = await worker.recognize(canvas);
  const rawWords = result.data.words && result.data.words.length ? result.data.words : result.data.symbols || [];
  const words = [];
  for (const word of rawWords) {
    const text = String(word.text || "").replace(/\s+/g, " ").trim();
    if (!text || !word.bbox) continue;
    const height = Math.max(8, word.bbox.y1 - word.bbox.y0);
    words.push({
      text,
      x: word.bbox.x0,
      width: Math.max(1, word.bbox.x1 - word.bbox.x0),
      y0: word.bbox.y0,
      y1: word.bbox.y1,
      mid: (word.bbox.y0 + word.bbox.y1) / 2,
      height,
      confidence: Number(word.confidence),
    });
  }
  if (tinted && String(psm) === OCR_PSM) {
    await refineDecimals(worker, words, upright, prepared.scale);
    const cleaned = dedupeWords(words.filter((word) => !isNoiseToken(word.text)));
    words.length = 0;
    words.push(...cleaned);
    injectSpreadHeader(words);
    await fillMissingQuantities(worker, words, upright, prepared.scale);
  }
  const items = [];
  for (const line of clusterWords(words)) {
    const y = canvas.height - line.mid;
    for (const word of joinDimensionTokens(line.words)) {
      const item = { str: word.text, x: word.x, y, w: word.width };
      if (Number.isFinite(word.confidence)) item.confidence = word.confidence;
      items.push(item);
    }
  }
  return items;
}

export async function convertToItems(file, onStatus) {
  const classified = classifyUpload(file.name);
  if (classified.kind === "excel") return { source: "excel", items: excelToItems(await file.arrayBuffer()) };
  if (classified.kind === "word") return { source: "word", items: await wordToItems(await file.arrayBuffer()) };
  if (classified.kind === "image") return { source: "image", items: await imageToItems(file, onStatus) };
  throw new Error(classified.error || `不支援 ${file.name}。請改傳 ${ACCEPT_LIST}。`);
}
