import { lineMetrics } from "./parser.js?v=2.1";

const EPS = 0.05;

/** 縱向、橫向是佔櫃長、櫃寬的比例。綁紮間距與輕貨上疊只用在開頂與平板。 */
export const LOAD_RULES = {
  cgLongLimit: 0.05,
  cgLatLimit: 0.02,
  lashingGapCm: 10,
  topStackKg: 200,
  topStackHeightCm: 30,
  topStackSupport: 0.6,
  topStackBandCm: 2,
  topStackEndCm: 50,
};

/** 名稱含 Pallet 或棧板時預設不可放倒。列上的 tippable 為 true 或 false 時以該列為準。 */
export function canTip(row) {
  if (!row) return true;
  if (row.tippable === true) return true;
  if (row.tippable === false) return false;
  return !/pallet|棧板/i.test(String(row.name || ""));
}

function mayTip(item, allowTip) {
  return Boolean(allowTip) && item.tippable !== false;
}

function overLimit(bin) {
  return {
    h: bin.h + (bin.maxOverH || 0),
    z: bin.w + (bin.maxOverW || 0),
    minZ: -(bin.maxOverW || 0),
    w: bin.w + (bin.maxOverW || 0) * 2,
  };
}

function round1(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function same(left, right) {
  return Math.abs(left - right) <= 0.011;
}

function less(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index] - 1e-9) return true;
    if (left[index] > right[index] + 1e-9) return false;
  }
  return false;
}

function overlaps(left, right) {
  return (
    left.x + EPS < right.x + right.dl &&
    left.x + left.dl > right.x + EPS &&
    left.y + EPS < right.y + right.dh &&
    left.y + left.dh > right.y + EPS &&
    left.z + EPS < right.z + right.dw &&
    left.z + left.dw > right.z + EPS
  );
}

function containsPoint(box, point) {
  return (
    point.x > box.x + EPS &&
    point.x < box.x + box.dl - EPS &&
    point.y > box.y + EPS &&
    point.y < box.y + box.dh - EPS &&
    point.z > box.z + EPS &&
    point.z < box.z + box.dw - EPS
  );
}

function unionArea(rects) {
  if (rects.length === 0) return 0;
  const xs = [...new Set(rects.flatMap((rect) => [rect.x1, rect.x2]))].sort((left, right) => left - right);
  let area = 0;
  for (let index = 0; index < xs.length - 1; index += 1) {
    const x1 = xs[index];
    const x2 = xs[index + 1];
    const width = x2 - x1;
    if (width <= EPS) continue;
    const intervals = [];
    for (const rect of rects) {
      if (rect.x1 <= x1 + 1e-6 && rect.x2 >= x2 - 1e-6) intervals.push([rect.z1, rect.z2]);
    }
    intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    let start = -Infinity;
    let end = -Infinity;
    for (const [from, to] of intervals) {
      if (from > end) {
        if (end > start) area += width * (end - start);
        start = from;
        end = to;
      } else if (to > end) {
        end = to;
      }
    }
    if (end > start) area += width * (end - start);
  }
  return area;
}

function onSurface(other, box) {
  return other !== box && Math.abs(other.y + other.dh - box.y) <= 0.2;
}

function supportedStrict(placed, box) {
  if (box.y <= EPS) return true;
  return placed.some((other) => {
    if (!onSurface(other, box)) return false;
    return (
      other.x <= box.x + EPS &&
      other.z <= box.z + EPS &&
      other.x + other.dl + EPS >= box.x + box.dl &&
      other.z + other.dw + EPS >= box.z + box.dw
    );
  });
}

function supportRects(placed, box) {
  const rects = [];
  for (const other of placed) {
    if (!onSurface(other, box)) continue;
    const x1 = Math.max(box.x, other.x);
    const x2 = Math.min(box.x + box.dl, other.x + other.dl);
    const z1 = Math.max(box.z, other.z);
    const z2 = Math.min(box.z + box.dw, other.z + other.dw);
    if (x2 - x1 > EPS && z2 - z1 > EPS) rects.push({ x1, x2, z1, z2 });
  }
  return rects;
}

function endsCovered(rects, origin, size, startOf, endOf) {
  const cap = Math.max(8, Math.min(size * 0.2, 50));
  const nearStart = rects.some((rect) => endOf(rect) > origin + EPS && startOf(rect) < origin + cap);
  const nearEnd = rects.some((rect) => startOf(rect) < origin + size - EPS && endOf(rect) > origin + size - cap);
  return nearStart && nearEnd;
}

/** 單件 100 kg 以下可跨在兩件以上頂面。兩端都要承到，承托面積至少是底面的 60%。 */
function bridgeSupport(placed, box) {
  if (!(box.item && Number(box.item.kg) <= 100) || box.y <= EPS) return false;
  const rects = supportRects(placed, box);
  if (rects.length < 2) return false;
  const area = unionArea(rects);
  if (area + 1e-6 < box.dl * box.dw * 0.6) return false;
  const alongLength = box.dl >= box.dw;
  return alongLength
    ? endsCovered(rects, box.x, box.dl, (rect) => rect.x1, (rect) => rect.x2)
    : endsCovered(rects, box.z, box.dw, (rect) => rect.z1, (rect) => rect.z2);
}

function overHeightBases(placed, bin) {
  return placed.filter((box) => box.y <= EPS && box.y + box.dh > bin.h + EPS);
}

/** 輕貨疊在超高件頂面。高差 2 cm 以內的頂面一起算，承托面積至少是底面的 60%。 */
function measureTopStack(bases, box) {
  const rects = [];
  for (const other of bases) {
    if (other === box) continue;
    const top = other.y + other.dh;
    if (top > box.y + EPS || box.y - top > LOAD_RULES.topStackBandCm + EPS) continue;
    const x1 = Math.max(box.x, other.x);
    const x2 = Math.min(box.x + box.dl, other.x + other.dl);
    const z1 = Math.max(box.z, other.z);
    const z2 = Math.min(box.z + box.dw, other.z + other.dw);
    if (x2 - x1 > EPS && z2 - z1 > EPS) rects.push({ x1, x2, z1, z2 });
  }
  if (!rects.length) return null;
  const area = unionArea(rects);
  const footprint = box.dl * box.dw;
  if (!(footprint > 0) || area + 1e-6 < footprint * LOAD_RULES.topStackSupport) return null;
  const alongLength = box.dl >= box.dw;
  const origin = alongLength ? box.x : box.z;
  const size = alongLength ? box.dl : box.dw;
  const coveredStart = Math.min(...rects.map((rect) => (alongLength ? rect.x1 : rect.z1)));
  const coveredEnd = Math.max(...rects.map((rect) => (alongLength ? rect.x2 : rect.z2)));
  return {
    ratio: area / footprint,
    endA: Math.max(0, coveredStart - origin),
    endB: Math.max(0, origin + size - coveredEnd),
  };
}

function placementHold(placed, box) {
  if (box.topStacked) {
    return measureTopStack(placed, box) ? { ok: true, spanned: false } : { ok: false, spanned: false };
  }
  if (box.y <= EPS || supportedStrict(placed, box)) return { ok: true, spanned: false };
  if (bridgeSupport(placed, box)) return { ok: true, spanned: true };
  if (supported(placed, box)) return { ok: true, spanned: false };
  return { ok: false, spanned: false };
}

function supported(placed, box) {
  if (supportedStrict(placed, box)) return true;
  if (box.y <= EPS) return true;
  const rects = [];
  for (const other of placed) {
    if (!onSurface(other, box)) continue;
    const x1 = Math.max(box.x, other.x);
    const x2 = Math.min(box.x + box.dl, other.x + other.dl);
    const z1 = Math.max(box.z, other.z);
    const z2 = Math.min(box.z + box.dw, other.z + other.dw);
    if (x2 - x1 > EPS && z2 - z1 > EPS) rects.push({ x1, x2, z1, z2 });
  }
  return unionArea(rects) >= box.dl * box.dw - 0.5;
}

function orientations(item, bin, allowTip) {
  const options = [];
  const seen = new Set();
  const push = (dl, dw, dh) => {
    const limit = overLimit(bin);
    if (dl > bin.l + EPS || dw > limit.w + EPS || dh > limit.h + EPS) return;
    const key = `${dl}|${dw}|${dh}`;
    if (seen.has(key)) return;
    seen.add(key);
    options.push({
      dl,
      dw,
      dh,
      turned: !(same(dl, item.l) && same(dw, item.w) && same(dh, item.h)),
    });
  };

  push(item.l, item.w, item.h);
  push(item.w, item.l, item.h);
  if (!allowTip) return options;

  const sides = [item.l, item.w, item.h];
  const orders = [
    [0, 1, 2],
    [1, 0, 2],
    [0, 2, 1],
    [2, 0, 1],
    [1, 2, 0],
    [2, 1, 0],
  ];
  for (const [lengthIndex, widthIndex, heightIndex] of orders) {
    push(sides[lengthIndex], sides[widthIndex], sides[heightIndex]);
  }
  return options;
}

function addPoint(bin, point) {
  const x = round1(point.x);
  const y = round1(point.y);
  const z = round1(point.z);
  const limit = overLimit(bin);
  if (x < -EPS || y < -EPS || z < limit.minZ - EPS) return;
  if (x > bin.l + EPS || y > limit.h + EPS || z > limit.z + EPS) return;
  const key = `${x}|${y}|${z}`;
  if (bin.pointKeys.has(key)) return;
  const candidate = { x, y, z };
  if (bin.placed.some((box) => containsPoint(box, candidate))) return;
  bin.pointKeys.add(key);
  bin.points.push(candidate);
}

function overWide(bin, dw) {
  return dw > bin.w + EPS && (bin.maxOverW || 0) > 0;
}

function widthFits(bin, z, dw) {
  const extra = bin.maxOverW || 0;
  if (overWide(bin, dw)) {
    return Math.abs(z - (bin.w - dw) / 2) <= 0.2 && z >= -extra - EPS && z + dw <= bin.w + extra + EPS;
  }
  return z >= -EPS && z + dw <= bin.w + EPS;
}

function widthStarts(pointZ, dw, bin) {
  const raw = overWide(bin, dw) ? [(bin.w - dw) / 2] : bin.maxOverW > 0 ? [pointZ, 0, bin.w - dw] : [pointZ];
  const seen = new Set();
  const starts = [];
  for (const value of raw) {
    const z = round1(value);
    if (seen.has(z)) continue;
    seen.add(z);
    if (!widthFits(bin, z, dw)) continue;
    starts.push(z);
  }
  return starts;
}

function placementKey(bin, box, option) {
  const bridged = supportedStrict(bin.placed, box) ? 0 : 1;
  const turned = option.turned ? 1 : 0;
  if (!(bin.maxOverH > 0) && !(bin.maxOverW > 0)) {
    return [box.y, box.x, box.z, bridged, turned];
  }
  const overW = Math.max(0, -box.z) + Math.max(0, box.z + box.dw - bin.w);
  const overH = Math.max(0, box.y + box.dh - bin.h);
  const balance = Math.abs(Math.max(0, -box.z) - Math.max(0, box.z + box.dw - bin.w));
  return [box.y, box.x, overW, overH, balance, box.z, bridged, turned];
}

/** 允許超高只給「本身高度超過內高、而且貼在櫃底」的單件。輕貨上疊另計。 */
function allowsOwnOverHeight(bin, item, y, dh) {
  return y <= EPS && item.h > bin.h + EPS && same(dh, item.h) && (bin.maxOverH || 0) > 0;
}

function heightFits(bin, item, y, dh) {
  const top = y + dh;
  if (allowsOwnOverHeight(bin, item, y, dh)) return top <= bin.h + bin.maxOverH + EPS;
  return top <= bin.h + EPS;
}

function heightOutside(bin, box) {
  const top = box.y + box.dh;
  const cap = bin.h + (bin.maxOverH || 0) + EPS;
  if (box.topStacked) return top > cap;
  if (allowsOwnOverHeight(bin, box.item, box.y, box.dh)) return top > cap;
  return top > bin.h + EPS;
}

function uniqueSorted(values) {
  const seen = new Set();
  const list = [];
  for (const value of values) {
    const rounded = round1(value);
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    list.push(rounded);
  }
  list.sort((left, right) => left - right);
  return list;
}

function floorPoints(bin) {
  const xs = uniqueSorted([0, ...bin.placed.flatMap((box) => [box.x, box.x + box.dl])]);
  const zs = uniqueSorted([
    0,
    bin.w,
    ...bin.placed.flatMap((box) => [Math.max(0, box.z), Math.min(bin.w, box.z + box.dw)]),
  ]);
  const points = [];
  for (const x of xs) {
    if (x < -EPS || x > bin.l + EPS) continue;
    for (const z of zs) {
      if (z < -EPS || z > bin.w + EPS) continue;
      const blocked = bin.placed.some(
        (box) =>
          box.y <= EPS &&
          x > box.x + EPS &&
          x < box.x + box.dl - EPS &&
          z > box.z + EPS &&
          z < box.z + box.dw - EPS
      );
      if (blocked) continue;
      points.push({ x, y: 0, z });
    }
  }
  return points;
}

function searchPoints(bin, item, points, options, supportMode, seed) {
  let best = null;
  let bestKey = null;
  for (const point of points) {
    if (bin.placed.some((box) => containsPoint(box, point))) continue;
    for (const option of options) {
      if (point.x + option.dl > bin.l + EPS) continue;
      if (!heightFits(bin, item, point.y, option.dh)) continue;
      const zValues = widthStarts(point.z, option.dw, bin);
      for (const z of zValues) {
        const box = {
          x: point.x,
          y: point.y,
          z,
          dl: option.dl,
          dw: option.dw,
          dh: option.dh,
        };
        if (bin.placed.some((other) => overlaps(box, other))) continue;
        const hold = supportMode === "strict"
          ? { ok: supportedStrict(bin.placed, box), spanned: false }
          : placementHold(bin.placed, { ...box, item });
        if (!hold.ok) continue;
        const placed = {
          ...box,
          turned: option.turned,
          spanned: hold.spanned,
          bridged: supportedStrict(bin.placed, box) ? 0 : 1,
        };
        if (seed) return placed;
        const key = placementKey(bin, box, option);
        if (!best || less(key, bestKey)) {
          best = placed;
          bestKey = key;
        }
      }
    }
  }
  return best;
}

function preferredOrientations(bin, item, options) {
  const usable = options.filter((option) => heightFits(bin, item, 0, option.dh));
  const pool = usable.length > 0 ? usable : options;
  if (!(bin.maxOverW > 0) || pool.length < 2) return pool;
  const minOver = Math.min(...pool.map((option) => Math.max(0, option.dw - bin.w)));
  return pool.filter((option) => Math.max(0, option.dw - bin.w) <= minOver + 0.05);
}

function topStackStarts(limit, size, anchors) {
  const values = [];
  for (const anchor of anchors) {
    if (anchor >= -EPS && anchor + size <= limit + EPS) values.push(anchor);
  }
  return uniqueSorted(values);
}

function findTopStack(bin, item, allowTip) {
  if (!(bin.maxOverH > 0) || !(Number(item.kg) <= LOAD_RULES.topStackKg)) return null;
  const bases = overHeightBases(bin.placed, bin);
  if (!bases.length) return null;
  const options = orientations(item, bin, allowTip).filter((option) => option.dh <= LOAD_RULES.topStackHeightCm + EPS);
  let best = null;
  let bestKey = null;
  for (const seat of uniqueSorted(bases.map((box) => box.y + box.dh))) {
    const supporters = bases.filter((box) => {
      const top = box.y + box.dh;
      return top <= seat + EPS && seat - top <= LOAD_RULES.topStackBandCm + EPS;
    });
    if (!supporters.length) continue;
    const supportX0 = Math.min(...supporters.map((box) => box.x));
    const supportX1 = Math.max(...supporters.map((box) => box.x + box.dl));
    const supportZ0 = Math.min(...supporters.map((box) => box.z));
    const supportZ1 = Math.max(...supporters.map((box) => box.z + box.dw));
    for (const option of options) {
      if (seat + option.dh > bin.h + bin.maxOverH + EPS || option.dl > bin.l + EPS) continue;
      const span = supportX1 - supportX0;
      const xs = topStackStarts(bin.l, option.dl, [
        supportX0 - (option.dl - span) / 2,
        supportX0,
        supportX1 - option.dl,
        0,
        bin.l - option.dl,
        ...supporters.flatMap((box) => [box.x, box.x + box.dl - option.dl, box.x + box.dl / 2 - option.dl / 2]),
      ]);
      const zs = topStackStarts(bin.w + (bin.maxOverW || 0), option.dw, [
        (bin.w - option.dw) / 2,
        (supportZ0 + supportZ1 - option.dw) / 2,
        0,
        bin.w - option.dw,
        ...supporters.flatMap((box) => [box.z, box.z + box.dw - option.dw, box.z + (box.dw - option.dw) / 2]),
      ]).filter((z) => widthFits(bin, z, option.dw));
      for (const x of xs) {
        for (const z of zs) {
          const box = {
            x,
            y: seat,
            z,
            dl: option.dl,
            dw: option.dw,
            dh: option.dh,
            item,
          };
          if (bin.placed.some((other) => overlaps(box, other))) continue;
          const hold = measureTopStack(supporters, box);
          if (!hold) continue;
          const hung = hold.endA > LOAD_RULES.topStackEndCm && hold.endB > LOAD_RULES.topStackEndCm;
          const placed = {
            x,
            y: seat,
            z,
            dl: option.dl,
            dw: option.dw,
            dh: option.dh,
            turned: option.turned,
            spanned: false,
            topStacked: true,
            endHangA: hung ? hold.endA : null,
            endHangB: hung ? hold.endB : null,
            bridged: 1,
          };
          const key = [
            option.turned ? 1 : 0,
            Math.abs(x + option.dl / 2 - (supportX0 + supportX1) / 2),
            -hold.ratio,
            Math.abs(z + option.dw / 2 - bin.w / 2),
            x,
            z,
          ];
          if (!best || less(key, bestKey)) {
            best = placed;
            bestKey = key;
          }
        }
      }
    }
  }
  return best;
}

function placeTopStacks(bins, items, allowTip) {
  const left = [];
  for (const item of items) {
    if (!(Number(item.kg) <= LOAD_RULES.topStackKg)) {
      left.push(item);
      continue;
    }
    let best = null;
    let bestKey = null;
    for (let index = 0; index < bins.length; index += 1) {
      const bin = bins[index];
      if (bin.kg + item.kg > bin.payloadKg + 0.01) continue;
      const spot = findTopStack(bin, item, mayTip(item, allowTip));
      if (!spot) continue;
      const key = [index, spot.turned ? 1 : 0, spot.y, spot.x, spot.z];
      if (!best || less(key, bestKey)) {
        best = { bin, spot };
        bestKey = key;
      }
    }
    if (!best) left.push(item);
    else commit(best.bin, item, best.spot);
  }
  return left;
}

function findSpot(bin, item, allowTip, supportMode, stackable, seed) {
  let options = preferredOrientations(bin, item, orientations(item, bin, allowTip));
  if (options.length === 0) return null;
  if (seed) options = shuffleBySeed(options, mixSeed(seed * 1009 + item.id * 131));
  const floor = searchPoints(bin, item, floorPoints(bin), options, supportMode, seed);
  if (floor) return floor;
  if (!stackable) return null;
  const raised = [...bin.points]
    .filter((point) => point.y > EPS && point.y < bin.h - EPS)
    .sort((left, right) => left.y - right.y || left.x - right.x || left.z - right.z);
  return searchPoints(bin, item, raised, options, supportMode, seed);
}

function commit(bin, item, spot) {
  const box = { item, ...spot };
  bin.placed.push(box);
  bin.kg += item.kg;
  const seeds = [
    { x: box.x + box.dl, y: box.y, z: box.z },
    { x: box.x, y: box.y + box.dh, z: box.z },
    { x: box.x, y: box.y, z: box.z + box.dw },
  ];
  for (const other of bin.placed) {
    seeds.push(
      { x: box.x + box.dl, y: box.y, z: other.z + other.dw },
      { x: box.x + box.dl, y: other.y + other.dh, z: box.z },
      { x: other.x + other.dl, y: box.y, z: box.z + box.dw },
      { x: other.x + other.dl, y: box.y + box.dh, z: box.z },
      { x: box.x, y: box.y + box.dh, z: other.z + other.dw },
      { x: box.x, y: other.y + other.dh, z: box.z + box.dw }
    );
  }
  for (const seed of seeds) addPoint(bin, seed);
}

function placeAll(bins, items, allowTip, supportMode, stackable, seed) {
  const unpacked = [];
  for (const item of items) {
    let best = null;
    let bestKey = null;
    for (let index = 0; index < bins.length; index += 1) {
      const bin = bins[index];
      if (bin.kg + item.kg > bin.payloadKg + 0.01) continue;
      const spot = findSpot(bin, item, mayTip(item, allowTip), supportMode, stackable, seed);
      if (!spot) continue;
      const key = [index, spot.y, spot.x, spot.z, spot.bridged ? 1 : 0, spot.turned ? 1 : 0];
      if (!best || less(key, bestKey)) {
        best = { bin, spot };
        bestKey = key;
      }
    }
    if (!best) unpacked.push(item);
    else commit(best.bin, item, best.spot);
  }
  return unpacked;
}

function footprintsOverlap(left, right) {
  return (
    left.x + EPS < right.x + right.dl &&
    left.x + left.dl > right.x + EPS &&
    left.z + EPS < right.z + right.dw &&
    left.z + left.dw > right.z + EPS
  );
}

function drawingLayers(placed) {
  const layers = [];
  const ordered = [...placed].sort((left, right) => left.y - right.y || left.x - right.x || left.z - right.z);
  for (const box of ordered) {
    let layer = layers.find((group) => group.every((other) => !footprintsOverlap(other, box)));
    if (!layer) {
      layer = [];
      layers.push(layer);
    }
    layer.push(box);
  }
  return layers;
}

function mixSeed(seed) {
  let value = seed + 0x6d2b79f5;
  value = Math.imul(value ^ (value >>> 15), 1 | value);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return (value ^ (value >>> 14)) >>> 0;
}

function shuffleBySeed(items, seed) {
  const copy = [...items];
  let state = seed;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = mixSeed(state);
    const swap = state % (index + 1);
    const item = copy[index];
    copy[index] = copy[swap];
    copy[swap] = item;
  }
  return copy;
}

function resetBins(bins) {
  for (const bin of bins) {
    bin.placed = [];
    bin.points = [{ x: 0, y: 0, z: 0 }];
    bin.pointKeys = new Set(["0|0|0"]);
    bin.kg = 0;
  }
}

function takeSnapshot(bins) {
  return bins.map((bin) => ({
    placed: bin.placed.map((box) => ({ ...box })),
    points: bin.points.map((point) => ({ ...point })),
    pointKeys: new Set(bin.pointKeys),
    kg: bin.kg,
  }));
}

function restoreSnapshot(bins, snapshot) {
  bins.forEach((bin, index) => {
    bin.placed = snapshot[index].placed;
    bin.points = snapshot[index].points;
    bin.pointKeys = snapshot[index].pointKeys;
    bin.kg = snapshot[index].kg;
  });
}

function expandBins(plan) {
  const bins = [];
  for (const part of plan.counts) {
    for (let count = 0; count < part.count; count += 1) {
      bins.push({
        index: bins.length + 1,
        code: part.code,
        name: part.name,
        l: part.innerL,
        w: part.innerW,
        h: part.innerH,
        payloadKg: part.payloadKg,
        kind: part.kind || "general",
        maxOverH: part.overHeightCm || 0,
        maxOverW: part.overWidthCm || 0,
        placed: [],
        points: [{ x: 0, y: 0, z: 0 }],
        pointKeys: new Set(["0|0|0"]),
        kg: 0,
      });
    }
  }
  return bins;
}

const PIECE_LIMIT = 500;

export function expandPieces(rows) {
  const pieces = [];
  const notes = [];
  let limited = false;
  rows.forEach((row, rowIndex) => {
    if (limited) return;
    const metrics = lineMetrics(row);
    if (!metrics.complete) return;
    const qty = Number(row.qty);
    const count = Math.round(qty);
    const name = String(row.name || "").trim() || "未命名貨物";
    if (Math.abs(count - qty) > 0.001) {
      notes.push(`「${name}」的數量不是整數，配載圖按 ${count} 件排列。`);
    }
    const tippable = canTip(row);
    for (let index = 0; index < count; index += 1) {
      if (pieces.length >= PIECE_LIMIT) {
        notes.push(`件數太多，配載圖只排前 ${PIECE_LIMIT} 件。`);
        limited = true;
        break;
      }
      pieces.push({
        id: pieces.length + 1,
        rowIndex,
        name,
        l: Number(row.l),
        w: Number(row.w),
        h: Number(row.h),
        kg: Number(row.unitKg),
        tippable,
      });
    }
  });
  return { pieces, notes };
}

function formatDim(value) {
  const rounded = round1(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatPctNumber(ratio) {
  const rounded = Math.round((Math.abs(ratio) + Number.EPSILON) * 1000) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function centerOfGravity(bin) {
  const placed = (bin && bin.placed) || [];
  const kg = placed.reduce((sum, box) => sum + Number(box.item && box.item.kg), 0);
  if (!placed.length || !(kg > 0) || !(bin.l > 0) || !(bin.w > 0)) return null;
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (const box of placed) {
    const weight = Number(box.item.kg);
    mx += weight * (box.x + box.dl / 2);
    my += weight * (box.y + box.dh / 2);
    mz += weight * (box.z + box.dw / 2);
  }
  const x = mx / kg;
  const y = my / kg;
  const z = mz / kg;
  const longOffset = x - bin.l / 2;
  const latOffset = z - bin.w / 2;
  const longRatio = longOffset / bin.l;
  const latRatio = latOffset / bin.w;
  return {
    x,
    y,
    z,
    kg,
    longOffset,
    latOffset,
    longRatio,
    latRatio,
    longLimit: LOAD_RULES.cgLongLimit,
    latLimit: LOAD_RULES.cgLatLimit,
    longWarn: Math.abs(longRatio) > LOAD_RULES.cgLongLimit + 1e-9,
    latWarn: Math.abs(latRatio) > LOAD_RULES.cgLatLimit + 1e-9,
  };
}

export function cogText(cog) {
  if (!cog) return "";
  const longDir = cog.longOffset < -0.5 ? "偏封閉端" : cog.longOffset > 0.5 ? "偏櫃門" : "置中";
  const latDir = cog.latOffset < -0.5 ? "偏上緣" : cog.latOffset > 0.5 ? "偏下緣" : "置中";
  const longLimit = `容許 ±${formatPctNumber(cog.longLimit)}%`;
  const latLimit = `容許 ±${formatPctNumber(cog.latLimit)}%`;
  const longNote = cog.longWarn ? `${longLimit}，超出` : longLimit;
  const latNote = cog.latWarn ? `${latLimit}，超出` : latLimit;
  return `縱向${longDir} ${formatPctNumber(cog.longRatio)}%（${longNote}） · 橫向${latDir} ${formatPctNumber(cog.latRatio)}%（${latNote}）`;
}

export function cogMark(cog) {
  if (!cog) return "";
  const sign = cog.longRatio > 0.0005 ? "+" : cog.longRatio < -0.0005 ? "−" : "";
  return `重心 ${sign}${formatPctNumber(cog.longRatio)}%`;
}

export function endHangText(box) {
  const left = box && box.endHangA;
  const right = box && box.endHangB;
  if (!(left > LOAD_RULES.topStackEndCm) || !(right > LOAD_RULES.topStackEndCm)) return "";
  if (Math.abs(left - right) <= 1) return `兩端懸空約 ${formatDim((left + right) / 2)} cm，需綁紮固定`;
  const low = Math.min(left, right);
  const high = Math.max(left, right);
  return `兩端懸空約 ${formatDim(low)} cm 與 ${formatDim(high)} cm，需綁紮固定`;
}

export function stackedHeightText(bin) {
  const placed = (bin && bin.placed) || [];
  if (!placed.some((box) => box.topStacked)) return "";
  const total = Math.max(...placed.map((box) => box.y + box.dh));
  return `含上疊總高 ${formatDim(total)} cm`;
}

/** 俯視圖上緣（z 較小）為左側，下緣為右側。左右超出相同時合成一句。 */
export function sideOverhangText(box, bin) {
  const parts = [];
  const top = box.y + box.dh - bin.h;
  const left = Math.max(0, -box.z);
  const right = Math.max(0, box.z + box.dw - bin.w);
  if (!box.topStacked && top > 0.05) parts.push(`頂部超出 ${formatDim(top)} cm`);
  if (left > 0.05 || right > 0.05) {
    if (Math.abs(left - right) <= 0.5) parts.push(`左右各超出 ${formatDim((left + right) / 2)} cm`);
    else {
      if (left > 0.05) parts.push(`左側超出 ${formatDim(left)} cm`);
      if (right > 0.05) parts.push(`右側超出 ${formatDim(right)} cm`);
    }
  }
  return parts;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function snapshotPlaced(bin) {
  return {
    placed: bin.placed.map((box) => ({ ...box })),
    kg: bin.kg,
  };
}

function restorePlaced(bin, snap) {
  bin.placed = snap.placed.map((box) => ({ ...box }));
  bin.kg = snap.kg;
}

function placementIssues(bin, stackable) {
  return auditLayout({
    stackable,
    pieces: bin.placed.map((box) => box.item),
    unpacked: [],
    containers: [bin],
  });
}

function xGroups(placed) {
  const boxes = [...placed].sort((left, right) => left.x - right.x || left.z - right.z || left.y - right.y);
  const groups = [];
  for (const box of boxes) {
    const last = groups[groups.length - 1];
    if (!last || box.x >= last.x1 - EPS) {
      groups.push({ boxes: [box], x0: box.x, x1: box.x + box.dl });
    } else {
      last.boxes.push(box);
      last.x0 = Math.min(last.x0, box.x);
      last.x1 = Math.max(last.x1, box.x + box.dl);
    }
  }
  return groups;
}

function centerOut(boxes) {
  const sorted = [...boxes].sort(
    (left, right) => right.item.kg - left.item.kg || right.dl * right.dw * right.dh - left.dl * left.dw * left.dh || left.item.id - right.item.id
  );
  const mid = (sorted.length - 1) / 2;
  const indexes = [...sorted.keys()].sort((left, right) => Math.abs(left - mid) - Math.abs(right - mid) || left - right);
  const slots = new Array(sorted.length);
  sorted.forEach((box, index) => {
    slots[indexes[index]] = box;
  });
  return slots;
}

function layoutSingleRow(bin, gap) {
  if (!bin.placed.length || bin.placed.some((box) => box.y > EPS)) return null;
  const ordered = centerOut(bin.placed);
  const content = ordered.reduce((sum, box) => sum + box.dl, 0);
  const slack = bin.l - content;
  if (slack < -0.5) return null;
  const count = ordered.length;
  const full = gap * (count + 1);
  if (gap > 0 && slack + 0.05 < full) return { retry: true };
  let between = 0;
  let side = slack / 2;
  if (gap > 0) {
    between = gap;
    side = (slack - between * (count - 1)) / 2;
  }
  const next = [];
  let cursor = side;
  for (const box of ordered) {
    const z = (bin.w - box.dw) / 2;
    if (!widthFits(bin, z, box.dw)) return null;
    if (cursor < -EPS || cursor + box.dl > bin.l + EPS) return null;
    next.push({ box, x: round1(cursor), z: round1(z) });
    cursor += box.dl + between;
  }
  for (const item of next) {
    item.box.x = item.x;
    item.box.z = item.z;
  }
  return false;
}

function spreadGroups(bin, gap) {
  const groups = xGroups(bin.placed);
  if (!groups.length) return false;
  const content = groups.reduce((sum, group) => sum + (group.x1 - group.x0), 0);
  const slack = bin.l - content;
  if (slack < -0.5) return null;
  const slots = groups.length + 1;
  if (gap > 0 && slack + 0.05 < gap * slots) return { retry: true };
  const use = gap > 0 ? gap : 0;
  const between = groups.length > 1 ? use : 0;
  const side = (slack - between * Math.max(0, groups.length - 1)) / 2;
  const moves = [];
  let cursor = side;
  for (const group of groups) {
    const dx = cursor - group.x0;
    for (const box of group.boxes) {
      const x = box.x + dx;
      if (x < -EPS || x + box.dl > bin.l + EPS) return false;
      moves.push({ box, x });
    }
    cursor += group.x1 - group.x0 + between;
  }
  for (const move of moves) move.box.x = round1(move.x);
  return false;
}

function centerOverwide(bin) {
  const extra = bin.maxOverW || 0;
  for (const box of bin.placed) {
    if (box.dw <= bin.w + EPS) continue;
    const z = round1((bin.w - box.dw) / 2);
    if (z < -extra - EPS || z + box.dw > bin.w + extra + EPS) continue;
    const moved = { ...box, z };
    if (bin.placed.some((other) => other !== box && overlaps(moved, other))) continue;
    box.z = z;
  }
}

function shiftBalance(bin) {
  const cog = centerOfGravity(bin);
  if (!cog || (!cog.longWarn && !cog.latWarn)) return;
  let loX = -1e9;
  let hiX = 1e9;
  let loZ = -1e9;
  let hiZ = 1e9;
  for (const box of bin.placed) {
    loX = Math.max(loX, -box.x);
    hiX = Math.min(hiX, bin.l - (box.x + box.dl));
    if (overWide(bin, box.dw)) {
      const exact = (bin.w - box.dw) / 2 - box.z;
      loZ = Math.max(loZ, exact);
      hiZ = Math.min(hiZ, exact);
    } else {
      loZ = Math.max(loZ, -box.z);
      hiZ = Math.min(hiZ, bin.w - (box.z + box.dw));
    }
  }
  const dx = hiX < loX - EPS ? 0 : clamp(bin.l / 2 - cog.x, loX, hiX);
  const dz = hiZ < loZ - EPS ? 0 : clamp(bin.w / 2 - cog.z, loZ, hiZ);
  if (Math.abs(dx) < 0.05 && Math.abs(dz) < 0.05) return;
  for (const box of bin.placed) {
    box.x = round1(box.x + dx);
    box.z = round1(box.z + dz);
  }
}

function balanceOrientations(bin, box) {
  const item = box.item;
  const sides = [item.l, item.w, item.h];
  const orders = item.tippable === false ? [[0, 1, 2], [1, 0, 2]] : [[0, 1, 2], [1, 0, 2], [0, 2, 1], [2, 0, 1], [1, 2, 0], [2, 1, 0]];
  const seen = new Set();
  const list = [];
  for (const [lengthIndex, widthIndex, heightIndex] of orders) {
    const dl = sides[lengthIndex];
    const dw = sides[widthIndex];
    const dh = sides[heightIndex];
    const key = `${dl}|${dw}|${dh}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (dl > bin.l + EPS || dw > bin.w + EPS) continue;
    if (!heightFits(bin, item, 0, dh)) continue;
    list.push({
      dl,
      dw,
      dh,
      turned: !(same(dl, item.l) && same(dw, item.w) && same(dh, item.h)),
    });
  }
  return list;
}

function addSlotValue(values, value, limit, size) {
  const next = round1(clamp(value, 0, limit - size));
  if (next < -EPS || next + size > limit + EPS) return;
  values.add(next);
}

/** 整組平移被長件頂住時，改把底層並排，讓重貨的中心靠櫃長中央。 */
function centerHeavy(bin, stackable) {
  if (bin.kind === "fr" || bin.kind === "ot") return;
  if (!bin.placed.length || bin.placed.some((box) => box.y > EPS) || bin.placed.length > 4) return;
  const before = centerOfGravity(bin);
  if (!before || (!before.longWarn && !before.latWarn)) return;
  const snap = snapshotPlaced(bin);
  const boxes = [...bin.placed].sort(
    (left, right) => right.item.kg - left.item.kg || right.dl * right.dw * right.dh - left.dl * left.dw * left.dh || left.item.id - right.item.id
  );
  let visits = 0;

  const slotsFor = (box, parked) => {
    const slots = [];
    for (const option of balanceOrientations(bin, box)) {
      const xs = new Set();
      const zs = new Set();
      addSlotValue(xs, (bin.l - option.dl) / 2, bin.l, option.dl);
      addSlotValue(xs, 0, bin.l, option.dl);
      addSlotValue(xs, bin.l - option.dl, bin.l, option.dl);
      addSlotValue(zs, (bin.w - option.dw) / 2, bin.w, option.dw);
      addSlotValue(zs, 0, bin.w, option.dw);
      addSlotValue(zs, bin.w - option.dw, bin.w, option.dw);
      for (const lane of [15, 30, 40, 60]) {
        addSlotValue(zs, lane, bin.w, option.dw);
        addSlotValue(zs, bin.w - option.dw - lane, bin.w, option.dw);
      }
      for (const other of parked) {
        addSlotValue(xs, other.x, bin.l, option.dl);
        addSlotValue(xs, other.x + other.dl, bin.l, option.dl);
        addSlotValue(xs, other.x - option.dl, bin.l, option.dl);
        addSlotValue(xs, other.x + other.dl / 2 - option.dl / 2, bin.l, option.dl);
        addSlotValue(zs, other.z + other.dw, bin.w, option.dw);
        addSlotValue(zs, other.z - option.dw, bin.w, option.dw);
        addSlotValue(zs, other.z, bin.w, option.dw);
      }
      for (const x of xs) {
        for (const z of zs) {
          if (!widthFits(bin, z, option.dw)) continue;
          const trial = { x, y: 0, z, dl: option.dl, dw: option.dw, dh: option.dh, turned: option.turned };
          if (parked.some((other) => overlaps(trial, other))) continue;
          const kg = parked.reduce((sum, item) => sum + item.item.kg, 0) + box.item.kg;
          const mx = parked.reduce((sum, item) => sum + item.item.kg * (item.x + item.dl / 2), 0) + box.item.kg * (x + option.dl / 2);
          const mz = parked.reduce((sum, item) => sum + item.item.kg * (item.z + item.dw / 2), 0) + box.item.kg * (z + option.dw / 2);
          const longRatio = Math.abs(mx / kg - bin.l / 2) / bin.l;
          const latRatio = Math.abs(mz / kg - bin.w / 2) / bin.w;
          trial.key = [
            longRatio > LOAD_RULES.cgLongLimit ? 1 : 0,
            latRatio > LOAD_RULES.cgLatLimit ? 1 : 0,
            option.turned ? 1 : 0,
            longRatio,
            latRatio,
          ];
          slots.push(trial);
        }
      }
    }
    slots.sort((left, right) => (less(left.key, right.key) ? -1 : less(right.key, left.key) ? 1 : 0));
    return slots.slice(0, 16);
  };

  const search = (index, parked) => {
    if (visits > 4000) return null;
    visits += 1;
    if (index === boxes.length) {
      const cog = centerOfGravity({ l: bin.l, w: bin.w, placed: parked });
      return cog && !cog.longWarn && !cog.latWarn ? parked : null;
    }
    for (const slot of slotsFor(boxes[index], parked)) {
      const found = search(index + 1, parked.concat({ ...boxes[index], ...slot }));
      if (found) return found;
    }
    return null;
  };

  const found = search(0, []);
  if (!found) return;
  found.forEach((slot, index) => {
    const box = boxes[index];
    box.x = slot.x;
    box.y = 0;
    box.z = slot.z;
    box.dl = slot.dl;
    box.dw = slot.dw;
    box.dh = slot.dh;
    box.turned = slot.turned;
  });
  if (placementIssues(bin, stackable).length) restorePlaced(bin, snap);
}

function gapShort(bin, gap) {
  if (!(gap > 0) || !bin.placed.length) return false;
  const minX = Math.min(...bin.placed.map((box) => box.x));
  const maxX = Math.max(...bin.placed.map((box) => box.x + box.dl));
  if (minX + 0.6 < gap || bin.l - maxX + 0.6 < gap) return true;
  const groups = xGroups(bin.placed);
  for (let index = 1; index < groups.length; index += 1) {
    if (groups[index].x0 - groups[index - 1].x1 + 0.6 < gap) return true;
  }
  return false;
}

function applyBalance(bin, stackable) {
  if (!bin.placed.length) {
    bin.cog = null;
    bin.lashingShort = false;
    return;
  }
  const snap = snapshotPlaced(bin);
  const open = bin.kind === "fr" || bin.kind === "ot";
  const gap = open ? LOAD_RULES.lashingGapCm : 0;
  let short = false;
  const floorLength = bin.placed.reduce((sum, box) => sum + box.dl, 0);
  const flatRow = bin.placed.every((box) => box.y <= EPS) && floorLength <= bin.l + 0.5;
  if (open && (flatRow || gap > 0)) {
    const applyGap = (nextGap) => (flatRow ? layoutSingleRow(bin, nextGap) : spreadGroups(bin, nextGap));
    const result = applyGap(gap);
    if (result && result.retry) {
      restorePlaced(bin, snap);
      const second = applyGap(0);
      if (second == null || second.retry) restorePlaced(bin, snap);
      else short = true;
    } else if (result == null) {
      restorePlaced(bin, snap);
    }
  }
  centerOverwide(bin);
  shiftBalance(bin);
  centerHeavy(bin, stackable);
  if (open && gapShort(bin, gap)) short = true;
  if (placementIssues(bin, stackable).length) {
    restorePlaced(bin, snap);
    centerOverwide(bin);
    shiftBalance(bin);
    if (placementIssues(bin, stackable).length) restorePlaced(bin, snap);
    short = false;
  }
  bin.lashingShort = Boolean(open && short);
  bin.cog = centerOfGravity(bin);
}

export function buildLayout(plan, rows, options = {}) {
  const stackable = options.stackable !== false;
  const { pieces, notes } = expandPieces(rows);
  const bins = expandBins(plan);
  const ordered = [...pieces].sort(
    (left, right) => right.kg - left.kg || right.l * right.w * right.h - left.l * left.w * left.h || left.id - right.id
  );
  let unpacked = placeAll(bins, ordered, false, "bridge", stackable, false);
  if (unpacked.length > 0) unpacked = placeAll(bins, unpacked, true, "bridge", stackable, false);
  if (unpacked.length > 0 && stackable) {
    let bestLeft = unpacked;
    let bestSnap = takeSnapshot(bins);
    const tries = pieces.length > 40 ? 8 : 48;
    for (let seed = 1; seed <= tries; seed += 1) {
      resetBins(bins);
      const left = placeAll(bins, shuffleBySeed(ordered, seed), true, "bridge", true, seed);
      if (left.length < bestLeft.length) {
        bestLeft = left;
        bestSnap = takeSnapshot(bins);
        if (left.length === 0) break;
      }
    }
    restoreSnapshot(bins, bestSnap);
    unpacked = bestLeft;
  }

  for (const bin of bins) applyBalance(bin, stackable);
  if (stackable && unpacked.length > 0) {
    unpacked = placeTopStacks(bins, unpacked, true);
    for (const bin of bins) {
      if (!bin.placed.some((box) => box.topStacked)) continue;
      if ((bin.kind === "fr" || bin.kind === "ot") && gapShort(bin, LOAD_RULES.lashingGapCm)) bin.lashingShort = true;
      bin.cog = centerOfGravity(bin);
    }
  }
  if (bins.some((bin) => bin.lashingShort)) {
    notes.push(`間距不足。開頂或平板留不下 ${LOAD_RULES.lashingGapCm} cm 綁紮間距，這櫃已把間距降到 0。`);
  }
  if (bins.some((bin) => bin.placed.some((box) => box.topStacked))) {
    notes.push("含上疊總高需確認拖車與路線限高。");
  }

  return {
    stackable,
    notes,
    pieces,
    unpacked,
    containers: bins.map((bin) => ({
      index: bin.index,
      code: bin.code,
      name: bin.name,
      l: bin.l,
      w: bin.w,
      h: bin.h,
      kind: bin.kind,
      maxOverH: bin.maxOverH,
      maxOverW: bin.maxOverW,
      payloadKg: bin.payloadKg,
      kg: round1(bin.kg),
      placed: bin.placed,
      layers: drawingLayers(bin.placed),
      cog: bin.cog || null,
      lashingShort: Boolean(bin.lashingShort),
    })),
  };
}

export function auditLayout(layout) {
  const issues = [];
  const seen = new Set();
  for (const bin of layout.containers) {
    for (const box of bin.placed) {
      if (seen.has(box.item.id)) issues.push(`duplicate ${box.item.id}`);
      seen.add(box.item.id);
      const limit = overLimit(bin);
      if (
        box.x < -EPS ||
        box.y < -EPS ||
        box.z < limit.minZ - EPS ||
        box.x + box.dl > bin.l + EPS ||
        heightOutside(bin, box) ||
        box.z + box.dw > limit.z + EPS
      ) {
        issues.push(`outside ${box.item.id}`);
      }
      if (!placementHold(bin.placed, box).ok) issues.push(`float ${box.item.id}`);
      if (!overWide(bin, box.dw) && (box.z < -EPS || box.z + box.dw > bin.w + EPS)) issues.push(`side ${box.item.id}`);
    }
    for (let left = 0; left < bin.placed.length; left += 1) {
      for (let right = left + 1; right < bin.placed.length; right += 1) {
        if (overlaps(bin.placed[left], bin.placed[right])) {
          issues.push(`overlap ${bin.placed[left].item.id} ${bin.placed[right].item.id}`);
        }
      }
    }
    if (bin.kg > bin.payloadKg + 0.05) issues.push(`overweight ${bin.index}`);
  }
  for (const piece of layout.unpacked) {
    if (seen.has(piece.id)) issues.push(`unpacked also placed ${piece.id}`);
    seen.add(piece.id);
  }
  if (seen.size !== layout.pieces.length) issues.push(`count ${seen.size}/${layout.pieces.length}`);
  if (layout.stackable === false) {
    for (const bin of layout.containers) {
      for (const box of bin.placed) {
        if (box.y > 0.05) issues.push(`stacked ${box.item.id}`);
      }
    }
  }
  return issues;
}
