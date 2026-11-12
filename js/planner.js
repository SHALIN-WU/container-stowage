import { buildLayout, expandPieces } from "./packer.js?v=2.1";
import { summarize } from "./parser.js?v=2.1";

/**
 * 櫃型規格集中在這裡，之後可依船公司資料改數字。
 * 一般櫃的內容積、載重、內徑維持原值。門高只供顯示，不參與能不能裝進。
 * 開頂只可超出櫃頂；平板可超出左右側與櫃頂。超出量超過下面的上限就不再試算。
 */
export const OOG_LIMITS = {
  otOverHeightCm: 200,
  frOverHeightCm: 200,
  frOverWidthPerSideCm: 150,
};

export const CONTAINERS = [
  {
    code: "20GP",
    name: "20呎櫃",
    kind: "general",
    cbm: 33.2,
    payloadKg: 28200,
    innerL: 589,
    innerW: 235,
    innerH: 239,
    doorW: 234,
    doorH: 228,
    overHeightCm: 0,
    overWidthCm: 0,
  },
  {
    code: "40GP",
    name: "40呎櫃",
    kind: "general",
    cbm: 67.7,
    payloadKg: 26700,
    innerL: 1203,
    innerW: 235,
    innerH: 239,
    doorW: 234,
    doorH: 228,
    overHeightCm: 0,
    overWidthCm: 0,
  },
  {
    code: "40HQ",
    name: "40呎高櫃",
    kind: "general",
    cbm: 76.3,
    payloadKg: 26500,
    innerL: 1203,
    innerW: 235,
    innerH: 269,
    doorW: 234,
    doorH: 258,
    overHeightCm: 0,
    overWidthCm: 0,
  },
  {
    code: "20OT",
    name: "20呎開頂櫃",
    kind: "ot",
    cbm: 32.5,
    payloadKg: 28180,
    innerL: 589,
    innerW: 235,
    innerH: 235,
    doorW: 234,
    doorH: 228,
    overHeightCm: OOG_LIMITS.otOverHeightCm,
    overWidthCm: 0,
  },
  {
    code: "40OT",
    name: "40呎開頂櫃",
    kind: "ot",
    cbm: 66.4,
    payloadKg: 26680,
    innerL: 1203,
    innerW: 235,
    innerH: 235,
    doorW: 234,
    doorH: 228,
    overHeightCm: OOG_LIMITS.otOverHeightCm,
    overWidthCm: 0,
  },
  {
    code: "20FR",
    name: "20呎平板櫃",
    kind: "fr",
    cbm: null,
    payloadKg: 31260,
    innerL: 594,
    innerW: 243,
    innerH: 223,
    doorW: null,
    doorH: null,
    overHeightCm: OOG_LIMITS.frOverHeightCm,
    overWidthCm: OOG_LIMITS.frOverWidthPerSideCm,
  },
  {
    code: "40FR",
    name: "40呎平板櫃",
    kind: "fr",
    cbm: null,
    payloadKg: 39300,
    innerL: 1206,
    innerW: 243,
    innerH: 196,
    doorW: null,
    doorH: null,
    overHeightCm: OOG_LIMITS.frOverHeightCm,
    overWidthCm: OOG_LIMITS.frOverWidthPerSideCm,
  },
];

const MAX_CONTAINERS = 12;
const FIT = 0.05;

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundKg(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatCm(value) {
  const rounded = Math.round((value + Number.EPSILON) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function planLabel(plan) {
  return plan.counts.map((part) => `${part.count} 個 ${part.name}（${part.code}）`).join(" ＋ ");
}

function generalContainers() {
  return CONTAINERS.filter((item) => item.kind === "general");
}

function enumerate(totalCbm, totalKg, floorCm2) {
  const found = [];
  const [a, b, c] = generalContainers();

  for (let n20 = 0; n20 <= MAX_CONTAINERS; n20 += 1) {
    for (let n40 = 0; n40 <= MAX_CONTAINERS; n40 += 1) {
      for (let nHq = 0; nHq <= MAX_CONTAINERS; nHq += 1) {
        const containerCount = n20 + n40 + nHq;
        if (containerCount === 0 || containerCount > MAX_CONTAINERS) continue;

        const capCbm = n20 * a.cbm + n40 * b.cbm + nHq * c.cbm;
        const capKg = n20 * a.payloadKg + n40 * b.payloadKg + nHq * c.payloadKg;
        const capFloor = n20 * a.innerL * a.innerW + n40 * b.innerL * b.innerW + nHq * c.innerL * c.innerW;
        if (capCbm + 1e-6 < totalCbm || capKg + 1e-6 < totalKg) continue;
        if (floorCm2 > 0 && capFloor + 1 < floorCm2) continue;

        const counts = [
          { ...a, count: n20 },
          { ...b, count: n40 },
          { ...c, count: nHq },
        ].filter((part) => part.count > 0);

        found.push({
          counts,
          containerCount,
          capCbm: round2(capCbm),
          capKg,
          capFloor,
          remainCbm: round2(capCbm - totalCbm),
          remainKg: roundKg(capKg - totalKg),
          signature: counts.map((part) => part.code).join("+"),
        });
      }
    }
  }

  found.sort((left, right) => {
    return (
      left.containerCount - right.containerCount ||
      left.remainCbm - right.remainCbm ||
      left.remainKg - right.remainKg ||
      left.signature.localeCompare(right.signature)
    );
  });

  return found;
}

function layoutHoldsAll(plan, rows, stackable) {
  if (!Array.isArray(rows) || rows.length === 0) return true;
  return buildLayout(plan, rows, { stackable }).unpacked.length === 0;
}

function pickGeneral(totalCbm, totalKg, floorCm2, rows, stackable) {
  const cbm = round2(Number(totalCbm) || 0);
  const kg = roundKg(Number(totalKg) || 0);
  const all = enumerate(cbm, kg, floorCm2);
  if (all.length === 0) return [];

  const picked = [];
  const usedSignatures = new Set();

  for (const plan of all) {
    if (usedSignatures.has(plan.signature)) continue;
    if (!layoutHoldsAll(plan, rows, stackable)) continue;
    usedSignatures.add(plan.signature);
    picked.push(plan);
    if (picked.length === 3) break;
  }

  if (picked.length < 3) {
    for (const plan of all) {
      const key = plan.counts.map((part) => `${part.code}:${part.count}`).join("|");
      if (picked.some((item) => item.counts.map((part) => `${part.code}:${part.count}`).join("|") === key)) {
        continue;
      }
      if (!layoutHoldsAll(plan, rows, stackable)) continue;
      picked.push(plan);
      if (picked.length === 3) break;
    }
  }

  return picked.map((plan, index) => ({
    ...plan,
    id: plan.counts.map((part) => `${part.code}x${part.count}`).join("+"),
    recommended: index === 0,
    volumeUse: plan.capCbm > 0 ? cbm / plan.capCbm : 0,
    weightUse: plan.capKg > 0 ? kg / plan.capKg : 0,
    floorUse: floorCm2 > 0 && plan.capFloor > 0 ? floorCm2 / plan.capFloor : null,
    remainFloorM2: floorCm2 > 0 ? round2((plan.capFloor - floorCm2) / 10000) : null,
  }));
}

function envelope() {
  const general = generalContainers();
  return {
    l: Math.max(...general.map((item) => item.innerL)),
    w: Math.max(...general.map((item) => item.innerW)),
    h: Math.max(...general.map((item) => item.innerH)),
  };
}

function orientationsOf(piece) {
  const triples = piece.tippable
    ? [
        [piece.l, piece.w, piece.h],
        [piece.w, piece.l, piece.h],
        [piece.l, piece.h, piece.w],
        [piece.h, piece.l, piece.w],
        [piece.w, piece.h, piece.l],
        [piece.h, piece.w, piece.l],
      ]
    : [
        [piece.l, piece.w, piece.h],
        [piece.w, piece.l, piece.h],
      ];
  const seen = new Set();
  const list = [];
  for (const [l, w, h] of triples) {
    const key = `${l}|${w}|${h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ l, w, h });
  }
  return list;
}

function fitsDims(orientation, container) {
  const maxW = container.innerW + (container.overWidthCm || 0) * 2;
  const maxH = container.innerH + (container.overHeightCm || 0);
  return orientation.l <= container.innerL + FIT && orientation.w <= maxW + FIT && orientation.h <= maxH + FIT;
}

function readyFor(options, containers, kg) {
  return options.filter((item) => containers.some((container) => fitsDims(item, container) && kg <= container.payloadKg + 0.01));
}

function classifyPiece(piece) {
  const box = envelope();
  const upright = orientationsOf({ ...piece, tippable: false });
  const turned = orientationsOf({ ...piece, tippable: true });
  const fitsGeneral = (options) => options.some((item) => item.l <= box.l + FIT && item.w <= box.w + FIT && item.h <= box.h + FIT);
  if (fitsGeneral(upright) || (piece.tippable && fitsGeneral(turned))) return { kind: "fit" };

  const ots = CONTAINERS.filter((item) => item.kind === "ot");
  const frs = CONTAINERS.filter((item) => item.kind === "fr");
  const uprightWorks = readyFor(upright, ots, piece.kg).length > 0 || readyFor(upright, frs, piece.kg).length > 0;
  const options = uprightWorks || !piece.tippable ? upright : turned;
  const otDims = options.filter((item) => item.w <= box.w + FIT && item.l <= box.l + FIT && ots.some((container) => fitsDims(item, container)));
  const otReady = otDims.filter((item) => ots.some((container) => fitsDims(item, container) && piece.kg <= container.payloadKg + 0.01));
  if (otReady.length > 0) {
    const best = otReady.reduce((left, right) => (left.h <= right.h ? left : right));
    return { kind: "ot", text: `超高 ${formatCm(Math.max(0, best.h - box.h))} cm` };
  }

  const frReady = readyFor(options, frs, piece.kg);
  if (frReady.length > 0) {
    const scored = frReady
      .map((item) => ({
        item,
        widthExcess: Math.max(0, item.w - box.w),
        heightExcess: Math.max(0, item.h - box.h),
      }))
      .sort((left, right) => left.widthExcess - right.widthExcess || left.heightExcess - right.heightExcess);
    const best = scored[0];
    const parts = [];
    if (best.widthExcess > FIT) parts.push(`超寬 ${formatCm(best.widthExcess)} cm`);
    if (best.heightExcess > FIT) parts.push(`超高 ${formatCm(best.heightExcess)} cm`);
    const text = parts.join("、") || "放不進一般櫃";
    return { kind: "fr", text: otDims.length > 0 ? `${text}，開頂載重不足` : text };
  }

  const longest = Math.max(piece.l, piece.w, piece.h);
  const maxLength = Math.max(...CONTAINERS.map((item) => item.innerL));
  if (longest > maxLength + FIT) return { kind: "impossible", text: "超長，開頂與平板的內長也放不下" };
  return { kind: "impossible", text: "超出開頂或平板的試算上限" };
}

function formatIdList(ids) {
  if (ids.length <= 4) return ids.join("、");
  return `${ids.slice(0, 3).join("、")} 等 ${ids.length}`;
}

function formatReasons(items) {
  const groups = new Map();
  for (const item of items) {
    const list = groups.get(item.text) || [];
    list.push(item.id);
    groups.set(item.text, list);
  }
  return [...groups].map(([text, ids]) => `第 ${formatIdList(ids)} 件${text}`);
}

function analyze(rows) {
  const { pieces } = expandPieces(rows);
  const kindByRow = new Map();
  const reasonItems = [];
  for (const piece of pieces) {
    const issue = classifyPiece(piece);
    if (!kindByRow.has(piece.rowIndex)) kindByRow.set(piece.rowIndex, issue.kind);
    if (issue.kind !== "fit") reasonItems.push({ id: piece.id, text: issue.text, kind: issue.kind });
  }
  const normal = [];
  const oog = [];
  rows.forEach((row, index) => {
    const kind = kindByRow.get(index);
    if (kind === "fit") normal.push(row);
    else if (kind === "ot" || kind === "fr") oog.push(row);
  });
  return {
    normal,
    oog,
    reasonItems,
    oogKind: reasonItems.some((item) => item.kind === "fr") ? "fr" : "ot",
  };
}

function enumerateTyped(rows, stackable, types) {
  const summary = summarize(rows);
  const cbm = round2(summary.cbm);
  const kg = roundKg(summary.kg);
  const floorCm2 = stackable ? 0 : Math.max(0, summary.floorCm2);
  const [a, b] = types;
  const found = [];

  for (let nA = 0; nA <= MAX_CONTAINERS; nA += 1) {
    for (let nB = 0; nB <= MAX_CONTAINERS; nB += 1) {
      const containerCount = nA + nB;
      if (containerCount === 0 || containerCount > MAX_CONTAINERS) continue;
      const capKg = nA * a.payloadKg + nB * b.payloadKg;
      if (capKg + 1e-6 < kg) continue;
      const capFloor = nA * a.innerL * a.innerW + nB * b.innerL * b.innerW;
      if (floorCm2 > 0 && capFloor + 1 < floorCm2) continue;
      const counts = [
        { ...a, count: nA },
        { ...b, count: nB },
      ].filter((part) => part.count > 0);
      const plan = {
        counts,
        containerCount,
        capCbm: round2(nA * (Number(a.cbm) || 0) + nB * (Number(b.cbm) || 0)),
        capKg,
        capFloor,
        remainCbm: round2(nA * (Number(a.cbm) || 0) + nB * (Number(b.cbm) || 0) - cbm),
        remainKg: roundKg(capKg - kg),
        signature: counts.map((part) => part.code).join("+"),
      };
      if (!layoutHoldsAll(plan, rows, stackable)) continue;
      found.push(plan);
    }
  }

  found.sort((left, right) => {
    const leftOver = left.remainCbm < -0.05 ? 1 : 0;
    const rightOver = right.remainCbm < -0.05 ? 1 : 0;
    return (
      left.containerCount - right.containerCount ||
      leftOver - rightOver ||
      left.remainCbm - right.remainCbm ||
      left.remainKg - right.remainKg ||
      left.signature.localeCompare(right.signature)
    );
  });
  return found;
}

function measureCounts(counts, rows, stackable) {
  const summary = summarize(rows);
  const cbm = round2(summary.cbm);
  const kg = roundKg(summary.kg);
  const floorCm2 = stackable ? 0 : Math.max(0, summary.floorCm2);
  const capCbm = counts.reduce((sum, part) => sum + part.count * (Number(part.cbm) || 0), 0);
  const capKg = counts.reduce((sum, part) => sum + part.count * part.payloadKg, 0);
  const capFloor = counts.reduce((sum, part) => sum + part.count * part.innerL * part.innerW, 0);
  return {
    counts,
    containerCount: counts.reduce((sum, part) => sum + part.count, 0),
    capCbm: round2(capCbm),
    capKg,
    capFloor,
    remainCbm: round2(capCbm - cbm),
    remainKg: roundKg(capKg - kg),
    signature: counts.map((part) => part.code).join("+"),
    cbm,
    kg,
    floorCm2,
  };
}

function present(counts, index, rows, stackable, reasonItems) {
  const plan = measureCounts(counts, rows, stackable);
  const shown = {
    ...plan,
    id: counts.map((part) => `${part.code}x${part.count}`).join("+"),
    recommended: index === 0,
    volumeUse: plan.capCbm > 0 ? plan.cbm / plan.capCbm : 0,
    weightUse: plan.capKg > 0 ? plan.kg / plan.capKg : 0,
    floorUse: plan.floorCm2 > 0 && plan.capFloor > 0 ? plan.floorCm2 / plan.capFloor : null,
    remainFloorM2: plan.floorCm2 > 0 ? round2((plan.capFloor - plan.floorCm2) / 10000) : null,
    reasons: formatReasons(reasonItems),
  };
  if (counts.some((part) => part.kind === "fr")) {
    shown.spaceByDiagram = true;
    shown.volumeUse = null;
  }
  return shown;
}

function withReasons(plans, reasonItems) {
  const reasons = formatReasons(reasonItems);
  return plans.map((plan, index) => ({ ...plan, recommended: index === 0, reasons }));
}

function suggestOutOfGauge(rows, stackable) {
  const { normal, oog, reasonItems, oogKind } = analyze(rows);
  if (reasonItems.length === 0) return [];
  if (oog.length === 0) {
    if (normal.length === 0) return [];
    const summary = summarize(normal);
    const floorCm2 = stackable ? 0 : summary.floorCm2;
    return withReasons(pickGeneral(summary.cbm, summary.kg, floorCm2, normal, stackable), reasonItems);
  }

  const summary = normal.length ? summarize(normal) : null;
  const generals = summary
    ? pickGeneral(summary.cbm, summary.kg, stackable ? 0 : summary.floorCm2, normal, stackable)
    : [];
  if (normal.length > 0 && generals.length === 0) return [];

  const types = CONTAINERS.filter((item) => item.kind === oogKind);
  const specials = enumerateTyped(oog, stackable, types);
  const packable = [...normal, ...oog];
  const anchor = generals[0] || null;
  const mixed = [];
  for (const special of specials) {
    const counts = [...(anchor ? anchor.counts : []), ...special.counts];
    const raw = measureCounts(counts, packable, stackable);
    if (!layoutHoldsAll(raw, packable, stackable)) continue;
    mixed.push(raw);
  }

  const pool = [];
  const seen = new Set();
  const addPlan = (plan) => {
    if (!plan || seen.has(plan.signature)) return;
    seen.add(plan.signature);
    pool.push(plan);
  };
  if (mixed.length > 0) {
    for (const plan of mixed) addPlan(plan);
    if (normal.length > 0) {
      for (const plan of enumerateTyped(packable, stackable, types)) addPlan(plan);
    }
  } else {
    for (const plan of enumerateTyped(packable, stackable, types)) addPlan(plan);
  }
  pool.sort(compareLoaded);

  return pool.slice(0, 3).map((plan, index) => present(plan.counts, index, packable, stackable, reasonItems));
}

function keepsGeneralCargo(plan) {
  return plan.counts.some((part) => part.kind === "general") ? 0 : 1;
}

function compareLoaded(left, right) {
  const leftOver = left.remainCbm < -0.05 ? 1 : 0;
  const rightOver = right.remainCbm < -0.05 ? 1 : 0;
  return (
    left.containerCount - right.containerCount ||
    keepsGeneralCargo(left) - keepsGeneralCargo(right) ||
    leftOver - rightOver ||
    left.remainCbm - right.remainCbm ||
    left.remainKg - right.remainKg ||
    left.signature.localeCompare(right.signature)
  );
}

export function suggestPlans(totalCbm, totalKg, options = {}) {
  const cbm = round2(Number(totalCbm) || 0);
  const kg = roundKg(Number(totalKg) || 0);
  const stackable = options.stackable !== false;
  const floorCm2 = stackable ? 0 : Math.max(0, Number(options.floorCm2) || 0);
  if (!(cbm > 0) && !(kg > 0)) return [];

  const rows = Array.isArray(options.rows) ? options.rows : null;
  if (rows && rows.length > 0 && analyze(rows).reasonItems.length > 0) {
    return suggestOutOfGauge(rows, stackable);
  }
  return pickGeneral(cbm, kg, floorCm2, rows, stackable);
}

export function unplannedNote(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const stackable = options.stackable !== false;
  const { normal, oog, reasonItems } = analyze(rows);
  if (reasonItems.length === 0) return "";
  const lines = [formatReasons(reasonItems).join("；")];
  if (normal.length > 0 && oog.length > 0) {
    const summary = summarize(normal);
    const plans = pickGeneral(summary.cbm, summary.kg, stackable ? 0 : summary.floorCm2, normal, stackable);
    if (plans.length === 0) lines.push("其餘一般貨超過 12 個櫃子的粗算範圍");
  }
  return `${lines.join("。")}。`;
}
