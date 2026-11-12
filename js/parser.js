const Y_TOLERANCE = 3.5;
const LB_TO_KG = 0.45359237;

function normalizeText(value) {
  return String(value).normalize("NFKC").replace(/\u2ED1/g, "長");
}

function compact(value) {
  return String(value).replace(/\s+/g, "").toLowerCase();
}

function isLxwxhLabel(value) {
  return /(?:長|l)(?:cm|mm)?[x×*＊](?:寬|w)(?:cm|mm)?[x×*＊](?:高|h)/.test(compact(value));
}

function weightRole(text) {
  if (/totalweight|總毛重|總重/.test(text)) return "total";
  if (/grossweight|g\.?w|毛重|gross/.test(text)) return "gross";
  if (/^(?:kgs?|公斤|lbs?|磅|weight|重量)(?:\((?:t|mt|kg|kgs|lb|lbs)\)|ton(?:ne)?s?|tons?)?$/.test(text)) return "plain";
  return null;
}

function isTonneText(value) {
  const text = compact(value);
  if (!text) return false;
  if (/\(t\)|\(mt\)|公噸/.test(text)) return true;
  if (/tonnes?|tons?/.test(text)) return true;
  if (/(^|[^a-z])mt($|[^a-z])/.test(text)) return true;
  return /^\d+(?:\.\d+)?t$/.test(text);
}

function classifyHeader(raw) {
  const text = compact(raw);
  if (!text) return null;
  if (/淨重|netweight|n\.?w/.test(text) && !/毛|gross/.test(text)) return "nw";
  if (/(單件|unit|每箱|每件|per|\/ctn|\/pc|piece)/.test(text) && /(重|weight|g\.?w|kgs?|lbs?|公斤|磅)/.test(text)) return "unitKg";
  if (weightRole(text)) return "lineKg";
  if (/項次|^item$|^itemno\.?$|^no\.?$|^#$|^序號$|^sno\.?$/.test(text)) return "index";
  if (/品名|description|commodity|貨物名稱|desc|貨物|productname|^product$/.test(text)) return "name";
  if (isLxwxhLabel(text)) return "meas";
  if (/尺寸|measurement|meas|dimension|dims?|size|外箱尺寸|箱規|體積|volume|cbm|m3|m³/.test(text)) return "meas";
  if (/^長|^l$|^l\.?$|^l\(|^lcm|^length/.test(text)) return "l";
  if (/^寬|^w$|^w\.?$|^w\(|^wcm|^width/.test(text)) return "w";
  if (/^高|^h$|^h\.?$|^h\(|^hcm|^height/.test(text)) return "h";
  if (/數量|qty|quantity|q'?ty|件數|箱數|cartons?|packages?|ctns?|pkgs?|pcs?/.test(text)) return "qty";
  return null;
}

function statedLengthFactor(headerText) {
  const text = compact(headerText);
  if (/mm|公厘|毫米/.test(text)) return 0.1;
  if (/cm|公分/.test(text)) return 1;
  if (/公尺|米/.test(text)) return 100;
  if (/(^|[^a-z])m($|[^a-z])/.test(text)) return 100;
  return null;
}

function loneUnit(value) {
  const text = compact(value);
  if (/^(mm|公厘|毫米)$/.test(text)) return { kind: "length", factor: 0.1 };
  if (/^(cm|公分)$/.test(text)) return { kind: "length", factor: 1 };
  if (/^(m|米|公尺)$/.test(text)) return { kind: "length", factor: 100 };
  if (/^(t|ton|tons|tonne|tonnes|mt|公噸|\(t\)|\(mt\))$/.test(text)) return { kind: "weight", tonnes: true };
  if (/^(lb|lbs|磅)$/.test(text)) return { kind: "weight", pounds: true };
  if (/^(kg|kgs|公斤)$/.test(text)) return { kind: "weight", pounds: false };
  return null;
}

function textWidth(cell) {
  if (cell.w > 0) return cell.w;
  let width = 0;
  for (const char of cell.str) width += char.codePointAt(0) > 255 ? 11 : 6.2;
  return width;
}

function keepConfidence(token, confidence) {
  if (!Number.isFinite(confidence)) return;
  token.confidence = Number.isFinite(token.confidence) ? Math.min(token.confidence, confidence) : confidence;
}

function mergeTokens(cells) {
  const sorted = [...cells].sort((left, right) => left.x - right.x);
  const tokens = [];
  for (const cell of sorted) {
    const width = textWidth(cell);
    const last = tokens[tokens.length - 1];
    if (last && cell.x <= last.x + last.w + 8) {
      const gap = cell.x - (last.x + last.w);
      const needsSpace =
        gap > 0.4 &&
        ((/[A-Za-z0-9]$/.test(last.str) && /^[^\u0000-\u007f]/.test(cell.str)) ||
          (/[^\u0000-\u007f]$/.test(last.str) && /^[A-Za-z0-9]/.test(cell.str)));
      last.str += `${needsSpace ? " " : ""}${cell.str}`;
      last.w = Math.max(last.w, cell.x + width - last.x);
      keepConfidence(last, cell.confidence);
      continue;
    }
    const token = { str: cell.str, x: cell.x, w: width };
    if (Number.isFinite(cell.confidence)) token.confidence = cell.confidence;
    tokens.push(token);
  }
  return tokens;
}

function groupLines(items) {
  const lines = [];
  const sorted = [...items].sort((left, right) => right.y - left.y || left.x - right.x);

  for (const item of sorted) {
    const text = normalizeText(item.str || "").trim();
    if (!text) continue;
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= Y_TOLERANCE);
    if (!line) {
      line = { y: item.y, cells: [] };
      lines.push(line);
    }
    const cell = {
      str: text,
      x: item.x,
      w: item.w || 0,
    };
    if (Number.isFinite(item.confidence)) cell.confidence = item.confidence;
    line.cells.push(cell);
  }

  for (const line of lines) {
    line.cells = mergeTokens(line.cells);
  }
  return lines;
}

function isHeader(line) {
  const keys = line.cells.map((cell) => classifyHeader(cell.str));
  const hasSize =
    (keys.includes("l") && keys.includes("w") && keys.includes("h")) || keys.includes("meas");
  const hasAmount = keys.includes("qty") || keys.includes("unitKg") || keys.includes("lineKg");
  return hasSize && hasAmount;
}

function makeColumn(cell, key) {
  const text = compact(cell.str);
  return {
    key,
    x: cell.x,
    center: cell.x + textWidth(cell) / 2,
    text: cell.str,
    factor: statedLengthFactor(cell.str),
    pounds: /lbs?|磅/.test(text),
    tonnes: isTonneText(cell.str),
    weightRole: key === "lineKg" ? weightRole(text) : null,
  };
}

function promotePlainWeight(columns) {
  if (!columns.some((column) => column.weightRole === "total")) return;
  for (const column of columns) {
    if (column.key === "lineKg" && column.weightRole === "plain") {
      column.key = "unitKg";
      column.weightRole = "unit";
    }
  }
}

function mapColumns(line) {
  const columns = [];
  for (const cell of line.cells) {
    const key = classifyHeader(cell.str);
    if (!key) continue;
    const role = key === "lineKg" ? weightRole(compact(cell.str)) : null;
    if (columns.some((column) => column.key === key && (key !== "lineKg" || column.weightRole === role))) continue;
    columns.push(makeColumn(cell, key));
  }
  columns.sort((left, right) => left.x - right.x);
  promotePlainWeight(columns);
  return columns;
}

function nearestColumn(center, columns) {
  let best = null;
  let bestDistance = Infinity;
  for (const column of columns) {
    const distance = Math.abs(center - column.center);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = column;
    }
  }
  return best;
}

function isSubHeader(line) {
  const labels = line.cells.map((cell) => compact(cell.str));
  const useful = labels.filter((text) => classifyHeader(text) || loneUnit(text));
  const numbers = labels.filter((text) => /\d/.test(text));
  return useful.length >= 2 && numbers.length === 0;
}

function absorbSubHeader(lines, headerIndex) {
  const columns = mapColumns(lines[headerIndex]);
  const next = lines[headerIndex + 1];
  if (!next || !isSubHeader(next)) return { columns, dataStart: headerIndex + 1 };
  for (const cell of next.cells) {
    const key = classifyHeader(cell.str);
    const unit = loneUnit(cell.str);
    const center = cell.x + textWidth(cell) / 2;
    const role = key === "lineKg" ? weightRole(compact(cell.str)) : null;
    if (key && !columns.some((column) => column.key === key && (key !== "lineKg" || column.weightRole === role))) {
      columns.push(makeColumn(cell, key));
      continue;
    }
    const column = nearestColumn(center, columns);
    if (!column) continue;
    if (isLxwxhLabel(cell.str) && ["l", "w", "h", "meas"].includes(column.key)) {
      column.text = `${column.text} ${cell.str}`;
    }
    if (!unit) continue;
    if (unit.kind === "length" && column.factor == null && ["l", "w", "h", "meas"].includes(column.key)) {
      column.factor = unit.factor;
    }
    if (unit.kind === "weight" && unit.pounds) column.pounds = true;
    if (unit.kind === "weight" && unit.tonnes && ["unitKg", "lineKg", "nw"].includes(column.key)) column.tonnes = true;
  }
  columns.sort((left, right) => left.x - right.x);
  promotePlainWeight(columns);
  const hasSides = ["l", "w", "h"].every((key) => columns.some((column) => column.key === key));
  if (hasSides) {
    const measIndex = columns.findIndex((column) => column.key === "meas");
    if (measIndex >= 0) columns.splice(measIndex, 1);
  }
  return { columns, dataStart: headerIndex + 2 };
}

function columnIndex(cell, columns) {
  const width = textWidth(cell);
  const anchor = width > 36 ? cell.x : cell.x + width / 2;
  let best = 0;
  let bestDistance = Infinity;
  columns.forEach((column, index) => {
    const distance = Math.abs(anchor - column.center);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

function parseNumber(value) {
  if (value == null) return null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function joinItems(items) {
  const ordered = [...items].sort((left, right) => left.x - right.x);
  let text = "";
  let lastRight = null;
  for (const item of ordered) {
    if (lastRight != null && item.x > lastRight + 1.5) text += " ";
    text += item.str;
    lastRight = item.x + (item.w || 0);
  }
  return text.replace(/\s+/g, " ").trim();
}

function factorFromUnit(unit) {
  if (!unit) return null;
  const text = compact(unit);
  if (text === "mm" || text === "公厘" || text === "毫米") return 0.1;
  if (text === "cm" || text === "公分") return 1;
  if (text === "m" || text === "米" || text === "公尺") return 100;
  return null;
}

function scaledTriple(n1, u1, n2, u2, n3, u3) {
  const factors = [factorFromUnit(u1), factorFromUnit(u2), factorFromUnit(u3)];
  const known = factors.filter((factor) => factor != null);
  if (known.length === 0) {
    return { l: n1, w: n2, h: n3, hasUnit: false, raw: "" };
  }
  const fill = known[known.length - 1];
  return {
    l: n1 * (factors[0] ?? fill),
    w: n2 * (factors[1] ?? fill),
    h: n3 * (factors[2] ?? fill),
    hasUnit: true,
    raw: "",
  };
}

function measExpression() {
  const unit = "mm|cm|公分|公厘|毫米|公尺|米|m";
  return `(\\d+(?:\\.\\d+)?)\\s*(${unit})?\\s*[xX×*＊°"·•]\\s*(\\d+(?:\\.\\d+)?)\\s*(${unit})?\\s*[xX×*＊°"·•]\\s*(\\d+(?:\\.\\d+)?)\\s*(${unit})?`;
}

function findSingleMeas(value) {
  const found = [...String(value).matchAll(new RegExp(measExpression(), "gi"))];
  if (found.length !== 1) return null;
  return parseMeas(found[0][0]);
}

function parseMeas(value) {
  const source = String(value);
  const unit = "mm|cm|公分|公厘|毫米|公尺|米|m";
  const match = source.match(new RegExp(measExpression(), "i"));
  if (match) {
    const triple = scaledTriple(Number(match[1]), match[2], Number(match[3]), match[4], Number(match[5]), match[6]);
    triple.raw = match[0];
    return triple;
  }
  const spaced = source.trim().match(
    new RegExp(`^(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)\\s*(${unit})?$`, "i")
  );
  if (!spaced) return null;
  const triple = scaledTriple(Number(spaced[1]), null, Number(spaced[2]), null, Number(spaced[3]), spaced[4]);
  triple.raw = spaced[0];
  return triple;
}

function isTotalName(name) {
  return /合計|小計|總計|\btotal\b/i.test(name);
}

function restoreNameSpaces(value) {
  const unit = /^(?:mm|cm|kg|lbs|lb|m|g|t)(?![A-Za-z])/i;
  const text = String(value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2");
  return text
    .replace(/(\d)([A-Za-z])/g, (full, digits, letter, index, source) => {
      const rest = source.slice(index + digits.length);
      if (unit.test(rest)) return full;
      return `${digits} ${letter}`;
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function columnOf(columns, key) {
  return columns.find((column) => column.key === key) || null;
}

function readLength(text, headerFactor) {
  const source = String(text || "");
  const number = parseNumber(source);
  if (!(number > 0)) return null;
  const cellFactor = statedLengthFactor(source);
  return number * (cellFactor ?? headerFactor ?? 1);
}

function ambiguousMmHeader(headerText) {
  if (!headerText || statedLengthFactor(headerText) != null) return false;
  return isLxwxhLabel(headerText);
}

function scaleMeasured(meas, headerText) {
  if (meas.hasUnit) {
    return {
      l: meas.l,
      w: meas.w,
      h: meas.h,
      fromMm: /mm|公厘|毫米/i.test(meas.raw || ""),
    };
  }
  const factor = headerText ? statedLengthFactor(headerText) : null;
  if (factor != null) {
    return { l: meas.l * factor, w: meas.w * factor, h: meas.h * factor, fromMm: factor === 0.1 };
  }
  if (ambiguousMmHeader(headerText) && Math.max(meas.l, meas.w, meas.h) > 500) {
    return { l: meas.l / 10, w: meas.w / 10, h: meas.h / 10, fromMm: true };
  }
  return { l: meas.l, w: meas.w, h: meas.h, fromMm: false };
}

function showNumber(value) {
  if (!Number.isFinite(value)) return String(value ?? "");
  return String(Math.round(value * 10000) / 10000);
}

function formatSourceWeight(weight) {
  const unit = weight.fromTonne ? "t" : weight.fromLb ? "lb" : "kg";
  return `${showNumber(weight.raw)} ${unit}`;
}

function readWeight(text, column) {
  const number = parseNumber(text);
  if (number == null || number < 0) return null;
  const cell = compact(text);
  const cellLb = /lbs?|磅/.test(cell);
  const cellKg = /kgs?|公斤/.test(cell);
  const fromLb = cellLb || (Boolean(column?.pounds) && !cellKg);
  const fromTonne = !fromLb && !cellKg && (Boolean(column?.tonnes) || isTonneText(text));
  let kg = number;
  if (fromLb) kg = number * LB_TO_KG;
  else if (fromTonne) kg = number * 1000;
  return { kg, fromLb, fromTonne, raw: number };
}

function readRow(line, columns) {
  const buckets = new Map();
  for (const column of columns) {
    if (!buckets.has(column.key)) buckets.set(column.key, []);
  }
  const leading = [];
  const firstX = columns.length ? Math.min(...columns.map((column) => column.x)) : 0;
  for (const cell of line.cells) {
    if (columns.length && cell.x + 8 < firstX && /[A-Za-z\u4e00-\u9fff]/.test(cell.str)) {
      leading.push(cell);
      continue;
    }
    const index = columnIndex(cell, columns);
    const key = columns[index].key;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(cell);
  }

  const lineText = joinItems(line.cells);
  let name = joinItems(buckets.get("name") || []);
  if (!name) name = joinItems(leading);
  if (!name) name = joinItems(buckets.get("index") || []);
  if (isTotalName(name) || isTotalName(lineText)) return null;
  name = restoreNameSpaces(name);

  const columnText = (key) => joinItems(buckets.get(key) || []);
  const factorOf = (key) => columnOf(columns, key)?.factor ?? 1;
  let length = readLength(columnText("l"), factorOf("l"));
  let width = readLength(columnText("w"), factorOf("w"));
  let height = readLength(columnText("h"), factorOf("h"));
  let lengthFromMm = false;
  if (length > 0 && width > 0 && height > 0) {
    lengthFromMm = ["l", "w", "h"].some((key) => {
      const header = columnOf(columns, key);
      return statedLengthFactor(columnText(key)) === 0.1 || header?.factor === 0.1;
    });
  } else {
    const fromColumn = ["meas", "l", "w", "h"]
      .map((key) => {
        const meas = parseMeas(columnText(key));
        if (!meas) return null;
        return { scaled: scaleMeasured(meas, columnOf(columns, key)?.text || "") };
      })
      .find(Boolean);
    const fromLine =
      !fromColumn && length == null && width == null && height == null ? findSingleMeas(lineText) : null;
    const chosen = fromColumn || (fromLine ? { scaled: scaleMeasured(fromLine, columnOf(columns, "meas")?.text || "") } : null);
    if (chosen) {
      length = chosen.scaled.l;
      width = chosen.scaled.w;
      height = chosen.scaled.h;
      lengthFromMm = chosen.scaled.fromMm;
    }
  }

  const qty = parseNumber(columnText("qty"));
  const unit = readWeight(columnText("unitKg"), columnOf(columns, "unitKg"));
  const lineKg = readWeight(columnText("lineKg"), columnOf(columns, "lineKg"));
  const net = readWeight(columnText("nw"), columnOf(columns, "nw"));
  const hasDim = length > 0 && width > 0 && height > 0;
  const hasQty = qty > 0;
  if (!hasDim && !hasQty) return null;

  const scoreOf = (key) => minConfidence(buckets.get(key) || []);
  const nameSource = (buckets.get("name") || []).length
    ? buckets.get("name")
    : leading.length
      ? leading
      : buckets.get("index") || [];
  const confidence = {};
  const assignScore = (key, score) => {
    if (Number.isFinite(score)) confidence[key] = score;
  };
  assignScore("name", minConfidence(nameSource));
  assignScore("l", scoreOf("l") ?? (length > 0 ? scoreOf("meas") : null));
  assignScore("w", scoreOf("w") ?? (width > 0 ? scoreOf("meas") : null));
  assignScore("h", scoreOf("h") ?? (height > 0 ? scoreOf("meas") : null));
  assignScore("qty", scoreOf("qty"));
  assignScore("unitKg", unit != null ? (scoreOf("unitKg") ?? scoreOf("lineKg")) : scoreOf("lineKg"));

  let unitKg = unit;
  let weightWasLineTotal = false;
  let weightFromPounds = Boolean(unit?.fromLb);
  let weightFromTonne = Boolean(unit?.fromTonne);
  if (unitKg == null && lineKg != null && hasQty) {
    unitKg = { kg: lineKg.kg / qty, fromLb: lineKg.fromLb, fromTonne: lineKg.fromTonne };
    weightWasLineTotal = true;
    weightFromPounds = weightFromPounds || Boolean(lineKg.fromLb);
    weightFromTonne = Boolean(lineKg.fromTonne);
  }
  let alert = "";
  if (unit && lineKg && hasQty) {
    const expected = unit.kg * qty;
    const scale = Math.max(Math.abs(expected), Math.abs(lineKg.kg), 1);
    if (Math.abs(expected - lineKg.kg) / scale > 0.01) {
      alert = `單重 ${formatSourceWeight(unit)} × 數量 ${showNumber(qty)} 與總重 ${formatSourceWeight(lineKg)} 不符，請人工決定`;
    }
  }

  return {
    name: name || "未命名貨物",
    l: hasDim ? roundDim(length) : "",
    w: hasDim ? roundDim(width) : "",
    h: hasDim ? roundDim(height) : "",
    qty: hasQty ? roundDim(qty) : "",
    unitKg: unitKg == null ? "" : roundDim(unitKg.kg),
    weightWasLineTotal,
    weightFromPounds,
    weightFromTonne,
    lengthFromMm,
    alert,
    netOnly: unitKg == null && net != null,
    netKg: net == null ? null : roundDim(net.kg),
    grossWithoutQty: unitKg == null && lineKg != null && !hasQty,
    grossKg: lineKg == null ? null : roundDim(lineKg.kg),
    missingDim: !hasDim,
    ...(Object.keys(confidence).length ? { confidence } : {}),
  };
}

function minConfidence(cells) {
  let score = null;
  for (const cell of cells) {
    if (!Number.isFinite(cell.confidence)) continue;
    score = score == null ? cell.confidence : Math.min(score, cell.confidence);
  }
  return score;
}

function stampLineConfidence(row, line) {
  if (!row) return row;
  const score = minConfidence(line.cells);
  if (score == null) return row;
  row.confidence = { name: score, l: score, w: score, h: score, qty: score, unitKg: score };
  return row;
}

function publicRow(row) {
  const published = {
    name: row.name,
    l: row.l,
    w: row.w,
    h: row.h,
    qty: row.qty,
    unitKg: row.unitKg,
  };
  if (row.confidence) published.confidence = row.confidence;
  if (row.alert) published.alert = row.alert;
  return published;
}

function roundDim(value) {
  return Math.round(value * 10000) / 10000;
}

function blankFlags(row) {
  return {
    ...row,
    weightWasLineTotal: false,
    weightFromPounds: false,
    weightFromTonne: false,
    lengthFromMm: false,
    alert: "",
    netOnly: false,
    missingDim: false,
    grossWithoutQty: false,
  };
}

function sheetNoise(text) {
  const source = text.replace(/\s+/g, " ").trim();
  if (!source || !/[A-Za-z\u4e00-\u9fff]/.test(source)) return true;
  if (isTotalName(source)) return true;
  if (/pallet\s*#\s*\d+/i.test(source)) return true;
  if (/ctns?\s*x/i.test(source)) return true;
  return /packing data|shipper|exporter|consignee|notify|port of|carriage|airway|invoice|abn\b|e-?mail|tel\s*:|fax\s*:|address\s*:|receiver|company\s*:|description of commodity|non hazardous|kilogram|\buom\b|declare that|signature|director|controlled copy|export packing|container|tare\s*\(|nett\s*\(|gross\s*\(|^cd\b/i.test(
    source
  );
}

function parsePalletCargo(lines) {
  const ordered = [...lines].sort((left, right) => {
    const leftPage = Math.floor(left.y / 10000);
    const rightPage = Math.floor(right.y / 10000);
    if (leftPage !== rightPage) return leftPage - rightPage;
    return right.y - left.y;
  });
  const rows = [];
  const products = [];
  let inTable = false;
  const palletPattern =
    /pallet\s*#\s*(\d+)\s*L\s*(\d+(?:\.\d+)?)\s*cm\s*[x×*＊]\s*W\s*(\d+(?:\.\d+)?)\s*cm\s*[x×*＊]\s*H\s*(\d+(?:\.\d+)?)\s*cm\s*gross\s*(\d+(?:\.\d+)?)\s*kgs?(?:\s+(\d+(?:\.\d+)?))?/i;

  for (const line of ordered) {
    const text = joinItems(line.cells);
    if (/packing data sheet|shipper\s*\/\s*exporter/i.test(text)) {
      inTable = false;
      continue;
    }
    if (/description of commodity/i.test(text) && /gross/i.test(text)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    const match = text.match(palletPattern);
    if (!match) {
      if (!sheetNoise(text)) products.push(restoreNameSpaces(text.replace(/\s+/g, " ").trim()));
      continue;
    }
    const qty = Number(match[6] || 1);
    const gross = Number(match[5]);
    const distinct = [];
    for (const product of products) {
      if (!distinct.includes(product)) distinct.push(product);
    }
    products.length = 0;
    rows.push(
      stampLineConfidence(
        blankFlags({
          name: distinct.length ? `Pallet #${match[1]} ${distinct.join(" / ")}` : `Pallet #${match[1]}`,
          l: roundDim(Number(match[2])),
          w: roundDim(Number(match[3])),
          h: roundDim(Number(match[4])),
          qty: qty > 0 ? roundDim(qty) : 1,
          unitKg: roundDim(qty > 0 ? gross / qty : gross),
          weightWasLineTotal: qty > 1,
        }),
        line
      )
    );
  }
  return rows;
}

function parseLabeledLine(text) {
  const source = text.replace(/\s+/g, " ").trim();
  if (isTotalName(source)) return null;
  const meas = parseMeas(source);
  if (!meas?.raw) return null;
  const rest = source.replace(meas.raw, " ").replace(/\s+/g, " ").trim();
  const name = restoreNameSpaces(
    rest.replace(/\d+(?:\.\d+)?\s*(?:kgs?|lbs?|公斤|磅|ctns?|cartons?|pcs?|pkgs?)?/gi, " ").replace(/\s+/g, " ").trim()
  );
  const qtyMatch = rest.match(/(\d+(?:\.\d+)?)\s*(?:ctns?|cartons?|pkgs?|packages?|pcs?|qty|件|箱)/i);
  const qty = qtyMatch ? Number(qtyMatch[1]) : null;
  const explicitGross = rest.match(/(?:總?毛重|gross\s*weight|g\.?\s*w\.?)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(kgs?|lbs?|公斤|磅)?/i);
  const unitHint = /單件|每箱|每件|per|unit|\/ctn/i.test(rest);
  const kgMatch = rest.match(/(\d+(?:\.\d+)?)\s*(kgs?|公斤)/i);
  const lbMatch = rest.match(/(\d+(?:\.\d+)?)\s*(lbs?|磅)/i);
  const picked = explicitGross || lbMatch || kgMatch;
  let unitKg = "";
  let weightWasLineTotal = false;
  let weightFromPounds = false;
  if (picked && qty > 0) {
    const number = Number(picked[1]);
    const unitName = picked[2] || "";
    const fromLb = /lbs?|磅/i.test(unitName);
    const kg = fromLb ? number * LB_TO_KG : number;
    weightFromPounds = fromLb;
    if (unitHint && !explicitGross) unitKg = roundDim(kg);
    else {
      unitKg = roundDim(kg / qty);
      weightWasLineTotal = true;
    }
  }
  if (!(meas.l > 0) || !(meas.w > 0) || !(meas.h > 0)) return null;
  return blankFlags({
    name: name || "未命名貨物",
    l: roundDim(meas.l),
    w: roundDim(meas.w),
    h: roundDim(meas.h),
    qty: qty > 0 ? roundDim(qty) : "",
    unitKg,
    weightWasLineTotal,
    weightFromPounds,
    missingDim: false,
  });
}

function parseLooseLine(text) {
  const labeled = parseLabeledLine(text);
  if (labeled) return labeled;
  const source = text.replace(/\s+/g, " ").trim();
  if (isTotalName(source)) return null;
  const match = source.match(
    /^(.*?)(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s*(?:kg|kgs|公斤))?\s*$/i
  );
  if (!match) return null;
  const name = restoreNameSpaces(match[1].replace(/^\d+\s*/, "").trim());
  const length = Number(match[2]);
  const width = Number(match[3]);
  const height = Number(match[4]);
  const qty = Number(match[5]);
  const unitKg = Number(match[6]);
  if (!(length > 0) || !(width > 0) || !(height > 0) || !(qty > 0)) return null;
  return blankFlags({
    name: name || "未命名貨物",
    l: length,
    w: width,
    h: height,
    qty,
    unitKg,
  });
}

function previewList(rows, textOf) {
  const preview = rows.slice(0, 8).map(textOf).join("、");
  const more = rows.length > 8 ? `，其餘 ${rows.length - 8} 列請看明細` : "";
  return `${preview}${more}`;
}

export function parseTextItems(items) {
  const lines = groupLines(items);
  const palletRows = parsePalletCargo(lines);
  if (palletRows.length > 0) {
    const warnings = ["這份裝箱單把尺寸和毛重寫在棧板上，已依每個棧板的長、寬、高與毛重讀取。紙箱明細沒有尺寸，沒有另列。"];
    if (palletRows.some((row) => row.weightWasLineTotal)) {
      warnings.push("毛重欄看起來是整列總重，已除以數量換成單件毛重，請核對。");
    }
    return {
      rows: palletRows.map(publicRow),
      warnings,
    };
  }

  const headerIndex = lines.findIndex(isHeader);
  const warnings = [];
  let rows = [];
  let usedLooseOrder = false;

  if (headerIndex >= 0) {
    const { columns, dataStart } = absorbSubHeader(lines, headerIndex);
    rows = lines
      .slice(dataStart)
      .filter((line) => !isHeader(line) && !isSubHeader(line))
      .map((line) => readRow(line, columns))
      .filter(Boolean);
  }

  if (rows.length === 0 && headerIndex < 0) {
    rows = lines
      .filter((line) => !isHeader(line) && !isSubHeader(line))
      .map((line) => stampLineConfidence(parseLooseLine(joinItems(line.cells)), line))
      .filter(Boolean);
    usedLooseOrder = rows.length > 0;
  }

  if (usedLooseOrder) warnings.push("找不到完整表頭，已依每列的數字順序讀取，請核對。");
  if (rows.some((row) => row.weightWasLineTotal)) {
    warnings.push("毛重欄看起來是整列總重，已除以數量換成單件毛重，請核對。");
  }
  if (rows.some((row) => row.weightFromPounds)) {
    warnings.push("重量單位是磅，已換算成公斤，請核對。");
  }
  if (rows.some((row) => row.lengthFromMm)) warnings.push("已由 mm 換算");
  if (rows.some((row) => row.weightFromTonne)) warnings.push("已由 t 換算");
  const netOnly = rows.filter((row) => row.netOnly);
  if (netOnly.length > 0) {
    warnings.push(`毛重未在文件中找到，淨重沒有拿來計算：${previewList(netOnly, (row) => `${row.name} ${row.netKg} kg`)}。`);
  }
  const missingGrossQty = rows.filter((row) => row.grossWithoutQty);
  if (missingGrossQty.length > 0) {
    warnings.push(`數量未在文件中找到，總毛重無法換成單件毛重：${previewList(missingGrossQty, (row) => `${row.name} ${row.grossKg} kg`)}。`);
  }
  if (rows.some((row) => row.missingDim)) {
    warnings.push("有列的尺寸未在文件中找到，長、寬、高留空，請補上。");
  }
  if (rows.length === 0) {
    warnings.push("沒有讀到尺寸、數量。若這是掃描檔，請在下一頁自己補上明細。");
  }

  return {
    rows: rows.map(publicRow),
    warnings,
  };
}

export function lineMetrics(row) {
  const length = Number(row.l);
  const width = Number(row.w);
  const height = Number(row.h);
  const qty = Number(row.qty);
  const unitKg = Number(row.unitKg);
  const hasSize = length > 0 && width > 0 && height > 0 && qty > 0;
  const hasWeight = row.unitKg !== "" && row.unitKg != null && Number.isFinite(unitKg) && unitKg >= 0;
  return {
    complete: hasSize && hasWeight,
    cbm: hasSize ? (length * width * height * qty) / 1_000_000 : 0,
    kg: hasSize && hasWeight ? unitKg * qty : 0,
  };
}

export function summarize(rows) {
  return rows.reduce(
    (total, row) => {
      const metrics = lineMetrics(row);
      if (!metrics.complete) {
        total.incomplete += 1;
        return total;
      }
      total.cbm += metrics.cbm;
      total.kg += metrics.kg;
      total.qty += Number(row.qty);
      total.floorCm2 += Number(row.l) * Number(row.w) * Number(row.qty);
      total.lines += 1;
      return total;
    },
    { cbm: 0, kg: 0, qty: 0, floorCm2: 0, lines: 0, incomplete: 0 }
  );
}
