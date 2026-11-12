import * as THREE from "three";
import { OrbitControls } from "./vendor/three/OrbitControls.js";
import { centerOfGravity, cogMark, cogText, endHangText, sideOverhangText, stackedHeightText } from "./packer.js?v=2.1";
import { CONTAINERS } from "./planner.js?v=2.1";

const EPS = 0.05;
const SEAM = 0.2;
const BASE_PLAY_MS = 700;

/** 1× 約 0.7 秒一件。5×、20× 依此縮短。 */
export const PLAY_SPEEDS = [1, 5, 20];

export function playIntervalMs(speed) {
  const factor = PLAY_SPEEDS.includes(speed) ? speed : 1;
  return BASE_PLAY_MS / factor;
}

export function shellFaces(kind) {
  if (kind === "fr") return ["floor", "end-closed", "end-door"];
  if (kind === "ot") return ["floor", "side-high", "side-low", "end-closed", "end-door"];
  return ["floor", "roof", "side-high", "side-low", "end-closed", "end-door"];
}

export function cargoMarks(box) {
  const marks = [];
  if (box.turned) marks.push("轉");
  if (box.topStacked) marks.push("上");
  else if (box.spanned) marks.push("跨");
  else if (box.y > 0.05) marks.push("疊");
  return marks;
}

/** 裝櫃順序就是 placed 的順序。count 是目前已放進畫面的件數。 */
export function visibleBoxes(bin, count) {
  const shown = Math.max(0, Math.min(bin.placed.length, Number(count) || 0));
  return bin.placed.slice(0, shown);
}

function formatDim(value) {
  return Number(value || 0).toLocaleString("zh-Hant", { maximumFractionDigits: 2 });
}

function formatKg(value) {
  return Number(value || 0).toLocaleString("zh-Hant", { maximumFractionDigits: 2 });
}

export function formatRate(ratio) {
  return `${(Number(ratio) * 100).toLocaleString("zh-Hant", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

export function volumeRate(bin, boxes) {
  const used = boxes.reduce((sum, box) => sum + (box.dl * box.dw * box.dh) / 1_000_000, 0);
  const spec = CONTAINERS.find((item) => item.code === bin.code);
  const cap = spec && spec.cbm ? spec.cbm : (bin.l * bin.w * bin.h) / 1_000_000;
  return cap > 0 ? used / cap : 0;
}

export function sceneCaption(bin, boxes) {
  const kg = boxes.reduce((sum, box) => sum + Number(box.item.kg || 0), 0);
  const cog = bin.cog || centerOfGravity(bin);
  const stacked = stackedHeightText({ placed: boxes });
  return {
    title: `第 ${bin.index} 櫃 · ${bin.name}（${bin.code}）`,
    detail: `${boxes.length} 件 · 總重 ${formatKg(kg)} kg · 體積使用率 ${formatRate(volumeRate(bin, boxes))}`,
    balance: cogText(cog),
    stacked,
    warn: Boolean(cog && (cog.longWarn || cog.latWarn)),
  };
}

function overhangParts(box, bin) {
  return sideOverhangText(box, bin);
}

export function cargoInfo(box, bin) {
  const flags = [];
  if (box.turned) flags.push("已轉向");
  if (box.topStacked) flags.push("上疊，需綁紮");
  else if (box.spanned) flags.push("跨放，需綁紮");
  else if (box.y > 0.05) flags.push("堆疊");
  const hang = endHangText(box);
  if (hang) flags.push(hang);
  const over = overhangParts(box, bin);
  if (over.length) flags.push(over.join("、"));
  return {
    title: `編號 ${box.item.id}　${box.item.name}`,
    size: `${formatDim(box.dl)}×${formatDim(box.dw)}×${formatDim(box.dh)} cm`,
    weight: `${formatKg(box.item.kg)} kg`,
    place: `第 ${bin.index} 櫃 · 距封閉端 ${formatDim(box.x)} cm · 距上緣 ${formatDim(box.z)} cm · 離地 ${formatDim(box.y)} cm`,
    flags: flags.join(" · "),
  };
}

export function cargoInfoLines(box, bin) {
  const info = cargoInfo(box, bin);
  return [info.title, info.size, info.weight, info.place, info.flags].filter(Boolean);
}

function pushPart(parts, role, x0, x1, y0, y1, z0, z1, cut) {
  const dl = x1 - x0;
  const dh = y1 - y0;
  const dw = z1 - z0;
  if (dl <= EPS || dh <= EPS || dw <= EPS) return;
  parts.push({ role, x: x0, y: y0, z: z0, dl, dh, dw, cut: cut || "" });
}

/** 內徑裡的部分用原色，超出的部分另成一塊，方便標成紅色。上疊件整件保留貨物本色。 */
export function cargoParts(box, bin) {
  const parts = [];
  const x0 = box.x;
  const x1 = box.x + box.dl;
  const y0 = box.y;
  const y1 = box.y + box.dh;
  const z0 = box.z;
  const z1 = box.z + box.dw;
  if (box.topStacked) {
    pushPart(parts, "body", x0, x1, y0, y1, Math.max(z0, 0), Math.min(z1, bin.w));
    if (z0 < -EPS) pushPart(parts, "overhang", x0, x1, y0, y1, z0, Math.min(z1, SEAM), "maxZ");
    if (z1 > bin.w + EPS) pushPart(parts, "overhang", x0, x1, y0, y1, Math.max(z0, bin.w - SEAM), z1, "minZ");
    return parts;
  }
  pushPart(parts, "body", Math.max(x0, 0), Math.min(x1, bin.l), Math.max(y0, 0), Math.min(y1, bin.h), Math.max(z0, 0), Math.min(z1, bin.w));
  if (x0 < -EPS) pushPart(parts, "overhang", x0, Math.min(x1, SEAM), y0, y1, z0, z1, "maxX");
  if (x1 > bin.l + EPS) pushPart(parts, "overhang", Math.max(x0, bin.l - SEAM), x1, y0, y1, z0, z1, "minX");
  if (y0 < -EPS) pushPart(parts, "overhang", x0, x1, y0, Math.min(y1, SEAM), z0, z1, "maxY");
  if (y1 > bin.h + EPS) pushPart(parts, "overhang", x0, x1, Math.max(y0, bin.h - SEAM), y1, z0, z1, "minY");
  if (z0 < -EPS) pushPart(parts, "overhang", x0, x1, y0, y1, z0, Math.min(z1, SEAM), "maxZ");
  if (z1 > bin.w + EPS) pushPart(parts, "overhang", x0, x1, y0, y1, Math.max(z0, bin.w - SEAM), z1, "minZ");
  return parts;
}

export function meshAabb(mesh) {
  const geometry = mesh.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  return {
    x: mesh.position.x + box.min.x,
    y: mesh.position.y + box.min.y,
    z: mesh.position.z + box.min.z,
    dl: box.max.x - box.min.x,
    dh: box.max.y - box.min.y,
    dw: box.max.z - box.min.z,
  };
}

export function unionAabb(meshes) {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (const mesh of meshes) {
    if (!mesh.isMesh) continue;
    const part = meshAabb(mesh);
    x0 = Math.min(x0, part.x);
    y0 = Math.min(y0, part.y);
    z0 = Math.min(z0, part.z);
    x1 = Math.max(x1, part.x + part.dl);
    y1 = Math.max(y1, part.y + part.dh);
    z1 = Math.max(z1, part.z + part.dw);
  }
  return { x: x0, y: y0, z: z0, dl: x1 - x0, dh: y1 - y0, dw: z1 - z0 };
}

function boxMaterial(color, role) {
  const material = new THREE.MeshLambertMaterial({
    color,
    polygonOffset: role === "body",
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  return material;
}

const HATCH_STEP = 48;

let hatchLineMaterial = null;

function sharedHatchLines() {
  if (!hatchLineMaterial) {
    hatchLineMaterial = new THREE.LineBasicMaterial({ color: 0xc4382b });
    hatchLineMaterial.userData.shared = true;
  }
  return hatchLineMaterial;
}

function hatchLineSegments(dl, dh, dw, cut) {
  if (Math.min(dl, dh, dw) < 3) return null;
  const positions = [];
  const hx = dl / 2;
  const hy = dh / 2;
  const hz = dw / 2;
  const faces = [
    { name: "maxX", origin: [hx, -hy, -hz], u: [0, 1, 0], v: [0, 0, 1], nu: dh, nv: dw, n: [1, 0, 0] },
    { name: "minX", origin: [-hx, -hy, -hz], u: [0, 1, 0], v: [0, 0, 1], nu: dh, nv: dw, n: [-1, 0, 0] },
    { name: "maxY", origin: [-hx, hy, -hz], u: [1, 0, 0], v: [0, 0, 1], nu: dl, nv: dw, n: [0, 1, 0] },
    { name: "minY", origin: [-hx, -hy, -hz], u: [1, 0, 0], v: [0, 0, 1], nu: dl, nv: dw, n: [0, -1, 0] },
    { name: "maxZ", origin: [-hx, -hy, hz], u: [1, 0, 0], v: [0, 1, 0], nu: dl, nv: dh, n: [0, 0, 1] },
    { name: "minZ", origin: [-hx, -hy, -hz], u: [1, 0, 0], v: [0, 1, 0], nu: dl, nv: dh, n: [0, 0, -1] },
  ];
  for (const face of faces) {
    if (face.name === cut || face.nu < 4 || face.nv < 4) continue;
    const span = face.nu + face.nv;
    for (let offset = HATCH_STEP * 0.5; offset < span; offset += HATCH_STEP) {
      const u0 = Math.max(0, offset - face.nv);
      const v0 = offset - u0;
      const u1 = Math.min(face.nu, offset);
      const v1 = offset - u1;
      if (u1 - u0 < 4) continue;
      const point = (u, v) => [
        face.origin[0] + face.u[0] * u + face.v[0] * v + face.n[0] * 0.4,
        face.origin[1] + face.u[1] * u + face.v[1] * v + face.n[1] * 0.4,
        face.origin[2] + face.u[2] * u + face.v[2] * v + face.n[2] * 0.4,
      ];
      positions.push(...point(u0, v0), ...point(u1, v1));
    }
  }
  if (!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(geometry, sharedHatchLines());
  lines.userData.role = "hatch";
  return lines;
}

export function buildCargoMeshes(box, bin, color) {
  const meshes = [];
  for (const part of cargoParts(box, bin)) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(part.dl, part.dh, part.dw), boxMaterial(color, part.role));
    mesh.position.set(part.x + part.dl / 2, part.y + part.dh / 2, part.z + part.dw / 2);
    mesh.userData.pieceId = box.item.id;
    mesh.userData.role = part.role;
    meshes.push(mesh);
    if (part.role !== "overhang") continue;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color: 0xc4382b })
    );
    mesh.add(edges);
    const lines = hatchLineSegments(part.dl, part.dh, part.dw, part.cut);
    if (lines) mesh.add(lines);
  }
  return meshes;
}

function wallMaterial(color, opacity) {
  return new THREE.MeshLambertMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: opacity >= 0.5,
  });
}

function addShell(list, face, size, center, color, opacity) {
  const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
  const mesh = new THREE.Mesh(geometry, wallMaterial(color, opacity));
  mesh.position.set(center.x, center.y, center.z);
  mesh.userData.face = face;
  mesh.renderOrder = face === "floor" ? 1 : 4;
  list.push(mesh);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0x143e39 })
  );
  edges.position.copy(mesh.position);
  edges.userData.role = "edge";
  edges.renderOrder = 5;
  list.push(edges);
}

export function buildShellMeshes(bin) {
  const list = [];
  const faces = new Set(shellFaces(bin.kind));
  const thickness = 2.6;
  const l = bin.l;
  const w = bin.w;
  const h = bin.h;
  const floorColor = 0xc8b496;
  const wallColor = bin.kind === "ot" ? 0x8a5a2b : 0x1d4e89;
  const doorColor = 0xd0893a;
  if (faces.has("floor")) {
    addShell(list, "floor", { x: l, y: thickness, z: w }, { x: l / 2, y: -thickness / 2, z: w / 2 }, floorColor, 0.78);
  }
  if (faces.has("roof")) {
    addShell(list, "roof", { x: l, y: thickness, z: w }, { x: l / 2, y: h + thickness / 2, z: w / 2 }, 0x143e39, 0.12);
  }
  if (faces.has("side-high")) {
    addShell(list, "side-high", { x: l, y: h, z: thickness }, { x: l / 2, y: h / 2, z: -thickness / 2 }, wallColor, 0.16);
  }
  if (faces.has("side-low")) {
    addShell(list, "side-low", { x: l, y: h, z: thickness }, { x: l / 2, y: h / 2, z: w + thickness / 2 }, wallColor, 0.16);
  }
  if (faces.has("end-closed")) {
    const opacity = bin.kind === "fr" ? 0.78 : 0.22;
    addShell(list, "end-closed", { x: thickness, y: h, z: w }, { x: -thickness / 2, y: h / 2, z: w / 2 }, wallColor, opacity);
  }
  if (faces.has("end-door")) {
    const opacity = bin.kind === "fr" ? 0.88 : 0.28;
    addShell(list, "end-door", { x: thickness, y: h, z: w }, { x: l + thickness / 2, y: h / 2, z: w / 2 }, doorColor, opacity);
  }
  return list;
}

export function disposeMeshes(meshes) {
  for (const mesh of meshes) {
    const objects = [];
    if (mesh.traverse) mesh.traverse((obj) => objects.push(obj));
    else objects.push(mesh);
    for (const obj of objects) {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material && !obj.material.userData.shared) {
        if (obj.material.map) obj.material.map.dispose();
        obj.material.dispose();
      }
    }
  }
}

function near(left, right) {
  return Math.abs(left - right) <= 0.02;
}

function fullyInside(box, bin) {
  return (
    box.x >= -EPS &&
    box.y >= -EPS &&
    box.z >= -EPS &&
    box.x + box.dl <= bin.l + EPS &&
    box.y + box.dh <= bin.h + EPS &&
    box.z + box.dw <= bin.w + EPS
  );
}

function contained(part, bin) {
  return (
    part.x >= -0.02 &&
    part.y >= -0.02 &&
    part.z >= -0.02 &&
    part.x + part.dl <= bin.l + 0.02 &&
    part.y + part.dh <= bin.h + 0.02 &&
    part.z + part.dw <= bin.w + 0.02
  );
}

function allowsOwnOverHeight(bin, item, y, dh) {
  return y <= EPS && item && item.h > bin.h + EPS && Math.abs(dh - item.h) <= 0.011 && (bin.maxOverH || 0) > 0;
}

function outsideLimits(bin, box) {
  const maxW = bin.maxOverW || 0;
  const maxH = bin.maxOverH || 0;
  const top = box.y + box.dh;
  const heightOutside = box.topStacked || allowsOwnOverHeight(bin, box.item, box.y, box.dh)
    ? top > bin.h + maxH + EPS
    : top > bin.h + EPS;
  return (
    box.x < -EPS ||
    box.y < -EPS ||
    box.z < -maxW - EPS ||
    box.x + box.dl > bin.l + EPS ||
    heightOutside ||
    box.z + box.dw > bin.w + maxW + EPS
  );
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

function auditBin(bin) {
  const issues = [];
  const shell = buildShellMeshes(bin);
  const faces = shell.filter((mesh) => mesh.userData.face).map((mesh) => mesh.userData.face).sort();
  const expected = shellFaces(bin.kind).slice().sort();
  if (faces.join("|") !== expected.join("|")) issues.push(`shell ${bin.code || bin.kind} ${faces.join("+")}`);
  const floor = shell.find((mesh) => mesh.userData.face === "floor");
  if (!floor || Math.abs(floor.geometry.parameters.width - bin.l) > 0.01 || Math.abs(floor.geometry.parameters.depth - bin.w) > 0.01) {
    issues.push(`floor ${bin.code || bin.kind}`);
  }
  const door = shell.find((mesh) => mesh.userData.face === "end-door");
  const closed = shell.find((mesh) => mesh.userData.face === "end-closed");
  if (!door || !closed || !(door.position.x > closed.position.x)) issues.push(`door ${bin.code || bin.kind}`);
  disposeMeshes(shell);

  const boxes = [];
  for (const box of bin.placed || []) {
    const meshes = buildCargoMeshes(box, bin, "#888888");
    if (!meshes.length) {
      issues.push(`empty ${box.item.id}`);
      continue;
    }
    const aabb = unionAabb(meshes);
    if (!near(aabb.x, box.x) || !near(aabb.y, box.y) || !near(aabb.z, box.z) || !near(aabb.dl, box.dl) || !near(aabb.dh, box.dh) || !near(aabb.dw, box.dw)) {
      issues.push(`mismatch ${box.item.id} ${aabb.dl}×${aabb.dw}×${aabb.dh} @ ${aabb.x},${aabb.y},${aabb.z}`);
    }
    if (!box.topStacked && fullyInside(box, bin) && (meshes.length !== 1 || meshes[0].userData.role !== "body")) issues.push(`split ${box.item.id}`);
    if (!box.topStacked && !fullyInside(box, bin) && !meshes.some((mesh) => mesh.userData.role === "overhang")) issues.push(`no-overhang ${box.item.id}`);
    for (const mesh of meshes) {
      const part = meshAabb(mesh);
      if (box.topStacked && mesh.userData.role === "body") {
        const cap = bin.h + (bin.maxOverH || 0);
        const insidePlan = part.x >= -0.02 && part.z >= -0.02 && part.x + part.dl <= bin.l + 0.02 && part.z + part.dw <= bin.w + 0.02 && part.y >= -0.02 && part.y + part.dh <= cap + 0.02;
        if (!insidePlan) issues.push(`body-outside ${box.item.id}`);
      } else if (mesh.userData.role === "body" && !contained(part, bin)) issues.push(`body-outside ${box.item.id}`);
      if (mesh.userData.role === "overhang" && contained(part, bin)) issues.push(`overhang-inside ${box.item.id}`);
    }
    const reconstructed = { ...aabb, item: box.item, topStacked: box.topStacked };
    if (outsideLimits(bin, reconstructed)) issues.push(`outside ${box.item.id}`);
    disposeMeshes(meshes);
    boxes.push({ id: box.item.id, ...aabb });
  }
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      if (overlaps(boxes[left], boxes[right])) issues.push(`overlap ${boxes[left].id} ${boxes[right].id}`);
    }
  }
  return issues;
}

export function auditScene(layout) {
  const issues = [];
  for (const bin of layout.containers || []) issues.push(...auditBin(bin));
  return issues;
}

export function titleBandHeight(width) {
  const scale = Math.max(1, width / 1100);
  return Math.round(132 * scale);
}

export function composePngCanvas(source, caption) {
  const band = titleBandHeight(source.width);
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height + band;
  const ctx = canvas.getContext("2d");
  const scale = Math.max(1, source.width / 1100);
  ctx.fillStyle = "#f6f1e8";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "top";
  ctx.fillStyle = "#143e39";
  ctx.font = `700 ${Math.round(32 * scale)}px "Segoe UI", "Microsoft JhengHei", sans-serif`;
  ctx.fillText(caption.title, Math.round(28 * scale), Math.round(16 * scale));
  ctx.fillStyle = "#1c2430";
  ctx.font = `600 ${Math.round(22 * scale)}px "Segoe UI", "Microsoft JhengHei", sans-serif`;
  ctx.fillText(caption.detail, Math.round(28 * scale), Math.round(56 * scale));
  if (caption.balance) {
    ctx.fillStyle = caption.warn ? "#9a3412" : "#143e39";
    ctx.fillText(caption.balance, Math.round(28 * scale), Math.round(92 * scale));
  }
  ctx.drawImage(source, 0, band);
  return canvas;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function button(className, text, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = text;
  node.addEventListener("click", onClick);
  return node;
}

function group(label) {
  const wrap = document.createElement("div");
  wrap.className = "scene3d-group";
  if (label) {
    const name = document.createElement("span");
    name.className = "scene3d-label";
    name.textContent = label;
    wrap.append(name);
  }
  return wrap;
}

export function createSceneView(host, options) {
  const layout = options.layout;
  const containers = layout.containers || [];
  if (!containers.length) {
    host.textContent = "這組方案沒有櫃子。";
    return { dispose() {}, setActive() {}, setHighlight() {} };
  }

  let bin = containers[0];
  let shown = 0;
  let speed = 1;
  let playing = false;
  let timer = 0;
  let highlightId = options.highlightId ? String(options.highlightId) : "";
  let enabled = true;
  let active = true;
  let scheduled = false;
  let raf = 0;
  let currentView = "reset";
  let press = null;
  const spriteMaterials = new Map();

  const initial = containers.find((item) => item.placed.some((box) => String(box.item.id) === highlightId));
  if (initial) bin = initial;

  host.replaceChildren();
  const root = document.createElement("div");
  root.className = "scene3d";
  const toolbar = document.createElement("div");
  toolbar.className = "scene3d-toolbar";
  const stageEl = document.createElement("div");
  stageEl.className = "scene3d-stage";
  const tip = document.createElement("div");
  tip.className = "scene3d-tip";
  tip.hidden = true;
  const captionTitle = document.createElement("span");
  const captionDetail = document.createElement("span");
  const captionBalance = document.createElement("span");
  const captionStacked = document.createElement("span");
  captionStacked.className = "is-stack";
  const caption = document.createElement("p");
  caption.className = "scene3d-caption";
  caption.append(captionTitle, captionDetail, captionBalance, captionStacked);
  const detail = document.createElement("p");
  detail.className = "scene3d-detail";
  const help = document.createElement("p");
  help.className = "scene3d-help";
  help.textContent = "左鍵拖曳旋轉，滾輪縮放，右鍵平移。逐件播放依裝櫃順序放入，可改速度，或直接跳到全部顯示。";
  stageEl.append(tip);
  root.append(toolbar, stageEl, caption, detail, help);
  host.append(root);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    if (!renderer.getContext()) throw new Error("no webgl");
  } catch (error) {
    host.replaceChildren();
    const note = document.createElement("p");
    note.className = "banner";
    note.textContent = "這個瀏覽器無法顯示 3D，請改用 2D 配載圖。";
    host.append(note);
    return { dispose() { host.replaceChildren(); }, setActive() {}, setHighlight() {} };
  }

  renderer.setClearColor(0xf6f1e8, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stageEl.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1.6, 0.5, 100000);
  camera.up.set(0, 1, 0);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  controls.minDistance = 40;
  controls.maxDistance = 20000;
  controls.maxPolarAngle = Math.PI * 0.96;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.addEventListener("start", () => {
    currentView = "";
    markViews();
  });

  scene.add(new THREE.AmbientLight(0xffffff, 0.84));
  const key = new THREE.DirectionalLight(0xffffff, 1.08);
  key.position.set(900, 1600, 1100);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.38);
  fill.position.set(-700, 600, -500);
  scene.add(fill);

  const shellGroup = new THREE.Group();
  const cargoGroup = new THREE.Group();
  const cogGroup = new THREE.Group();
  scene.add(shellGroup, cargoGroup, cogGroup);

  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();

  const binGroup = group("櫃子");
  const binButtons = [];
  if (containers.length > 1) {
    for (const item of containers) {
      const node = button("secondary", `第 ${item.index} 櫃`, () => {
        if (item === bin) return;
        bin = item;
        rebuild();
      });
      node.dataset.bin = String(item.index);
      binButtons.push(node);
      binGroup.append(node);
    }
  }
  const viewGroup = group("視角");
  const viewButtons = {
    front: button("secondary", "正面", () => setView("front")),
    side: button("secondary", "側面", () => setView("side")),
    top: button("secondary", "俯視", () => setView("top")),
    reset: button("secondary", "重設視角", () => setView("reset")),
  };
  viewButtons.front.title = "從櫃門這端看";
  viewButtons.side.title = "從側面看，封閉端在左";
  viewButtons.top.title = "從上方看，封閉端在左、上緣在上";
  viewButtons.reset.title = "回到斜向視角";
  viewGroup.append(viewButtons.front, viewButtons.side, viewButtons.top, viewButtons.reset);

  const playGroup = group("播放");
  const playButton = button("", "逐件播放", togglePlay);
  const speedButtons = PLAY_SPEEDS.map((value) => {
    const node = button("secondary", `${value}×`, () => setSpeed(value));
    node.dataset.speed = String(value);
    node.title = value === 1 ? "正常速度" : `${value} 倍速度`;
    return node;
  });
  const jumpButton = button("secondary", "跳到全部顯示", showAll);
  const countLabel = document.createElement("span");
  countLabel.className = "scene3d-count";
  playGroup.append(playButton, ...speedButtons, jumpButton, countLabel);

  const exportButton = button("secondary", "匯出 PNG", exportPng);
  exportButton.title = "下載目前這個櫃子的 3D 畫面";
  if (containers.length > 1) toolbar.append(binGroup);
  toolbar.append(viewGroup, playGroup, exportButton);

  function textSprite(text, tone = null) {
    const key = tone ? `${tone.fill}|${tone.ink}|${text}` : text;
    let material = spriteMaterials.get(key);
    if (!material) {
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 128;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = tone ? tone.fill : "rgba(255, 248, 234, 0.94)";
      roundRect(ctx, 8, 16, 496, 96, 32);
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.strokeStyle = tone ? tone.ink : "#9a5416";
      ctx.stroke();
      ctx.fillStyle = tone ? tone.ink : "#9a5416";
      ctx.font = "700 64px 'Microsoft JhengHei', 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 256, 66);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
      material.userData.shared = true;
      spriteMaterials.set(key, material);
    }
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 8;
    return sprite;
  }

  function clearGroup(groupNode) {
    for (const child of [...groupNode.children]) {
      groupNode.remove(child);
      if (child.traverse) {
        child.traverse((obj) => {
          if (obj === child) return;
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material && !obj.material.userData.shared) obj.material.dispose();
        });
      }
      if (child.geometry) child.geometry.dispose();
      if (child.material && !child.material.userData.shared) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    }
  }

  function colorEntry(box) {
    return (options.colors && options.colors.get(box.item.name)) || { fill: "#1d4e89", ink: "#f4f8fc" };
  }

  function colorFor(box) {
    return colorEntry(box).fill;
  }

  function contentBounds() {
    let minX = 0;
    let minY = 0;
    let minZ = 0;
    let maxX = bin.l;
    let maxY = bin.h;
    let maxZ = bin.w;
    for (const box of bin.placed) {
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      minZ = Math.min(minZ, box.z);
      maxX = Math.max(maxX, box.x + box.dl);
      maxY = Math.max(maxY, box.y + box.dh);
      maxZ = Math.max(maxZ, box.z + box.dw);
    }
    if (bin.placed.some((box) => box.topStacked)) maxY += 150;
    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  function markViews() {
    for (const [name, node] of Object.entries(viewButtons)) {
      const on = name === currentView;
      node.classList.toggle("is-on", on);
      node.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function setView(name) {
    currentView = name === "front" || name === "side" || name === "top" ? name : "reset";
    const bounds = contentBounds();
    const center = new THREE.Vector3(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      (bounds.minZ + bounds.maxZ) / 2
    );
    const sizeX = Math.max(1, bounds.maxX - bounds.minX);
    const sizeY = Math.max(1, bounds.maxY - bounds.minY);
    const sizeZ = Math.max(1, bounds.maxZ - bounds.minZ);
    const aspectRatio = camera.aspect > 0.05 ? camera.aspect : 1.6;
    const fit = (widthSpan, heightSpan) => {
      const vFov = THREE.MathUtils.degToRad(camera.fov);
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspectRatio);
      const distH = (heightSpan / 2) / Math.tan(vFov / 2);
      const distW = (widthSpan / 2) / Math.tan(hFov / 2);
      return Math.max(distH, distW) * 1.38;
    };
    const outside = 48;
    controls.target.copy(center);
    camera.up.set(0, 1, 0);
    if (currentView === "front") {
      camera.position.set(bounds.maxX + fit(sizeZ, sizeY) + outside, center.y + sizeY * 0.04, center.z);
    } else if (currentView === "side") {
      camera.position.set(center.x, center.y + sizeY * 0.04, bounds.maxZ + fit(sizeX, sizeY) + outside);
    } else if (currentView === "top") {
      const distance = fit(sizeX, sizeZ);
      camera.position.set(center.x, bounds.maxY + distance + outside, center.z + distance * 0.015);
    } else {
      const distance = fit(Math.max(sizeX, sizeZ), Math.max(sizeY, sizeZ * 0.85));
      const offset = new THREE.Vector3(0.78, 0.5, 0.9).normalize().multiplyScalar(distance);
      camera.position.copy(center).add(offset);
    }
    camera.near = 0.5;
    camera.far = 100000;
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    controls.update();
    markViews();
    renderer.render(scene, camera);
  }

  function fillShell() {
    clearGroup(shellGroup);
    for (const mesh of buildShellMeshes(bin)) shellGroup.add(mesh);
    const names = bin.kind === "fr" ? ["端牆", "端牆"] : ["封閉端", "櫃門"];
    const closed = textSprite(names[0]);
    closed.scale.set(72, 26, 1);
    closed.position.set(-40, bin.h + 20, bin.w / 2);
    const door = textSprite(names[1]);
    door.scale.set(72, 26, 1);
    door.position.set(bin.l + 40, bin.h + 20, bin.w / 2);
    shellGroup.add(closed, door);
  }

  function fillCog() {
    clearGroup(cogGroup);
    const cog = bin.cog || centerOfGravity(bin);
    if (!cog) return;
    const warn = cog.longWarn || cog.latWarn;
    const color = warn ? 0xc4382b : 0x0f5c54;
    const span = Math.max(36, Math.min(bin.l, bin.w) * 0.28);
    const markMaterial = () => new THREE.MeshBasicMaterial({ color, depthTest: false });
    const armX = new THREE.Mesh(new THREE.BoxGeometry(span, span * 0.08, span * 0.08), markMaterial());
    const armZ = new THREE.Mesh(new THREE.BoxGeometry(span * 0.08, span * 0.08, span), markMaterial());
    const post = new THREE.Mesh(new THREE.BoxGeometry(span * 0.07, span * 0.55, span * 0.07), markMaterial());
    armX.position.set(cog.x, span * 0.08, cog.z);
    armZ.position.set(cog.x, span * 0.08, cog.z);
    post.position.set(cog.x, span * 0.32, cog.z);
    for (const mesh of [armX, armZ, post]) {
      mesh.renderOrder = 12;
      mesh.userData.role = "cog";
      cogGroup.add(mesh);
    }
    const sprite = textSprite(cogMark(cog));
    sprite.scale.set(span * 2.6, span * 0.74, 1);
    sprite.position.set(cog.x, Math.max(bin.h * 0.55, span), cog.z);
    sprite.userData.role = "cog";
    cogGroup.add(sprite);
  }

  function fillCargo() {
    clearGroup(cargoGroup);
    bin.placed.forEach((box, index) => {
      for (const mesh of buildCargoMeshes(box, bin, colorFor(box))) {
        mesh.userData.order = index;
        cargoGroup.add(mesh);
      }
      const tone = colorEntry(box);
      const number = textSprite(String(box.item.id), tone);
      const topSpan = Math.max(box.dl, box.dw);
      const numberWidth = Math.max(18, Math.min(42, topSpan * 0.22));
      number.scale.set(numberWidth, numberWidth * 0.42, 1);
      number.position.set(box.x + box.dl / 2, box.y + box.dh + numberWidth * 0.08, box.z + box.dw / 2);
      number.userData.pieceId = box.item.id;
      number.userData.order = index;
      cargoGroup.add(number);
      const marks = cargoMarks(box);
      if (!marks.length) return;
      const sprite = textSprite(marks.join(" "));
      const span = Math.min(box.dl, box.dw, box.dh);
      const width = Math.max(18, Math.min(48, span * 0.72));
      sprite.scale.set(width * (marks.length > 1 ? 1.85 : 1.25), width * 0.64, 1);
      sprite.position.set(box.x + width * 0.42, box.y + box.dh + width * 0.36, box.z + width * 0.36);
      sprite.userData.pieceId = box.item.id;
      sprite.userData.order = index;
      cargoGroup.add(sprite);
    });
    const stackedBoxes = bin.placed.filter((box) => box.topStacked);
    if (!stackedBoxes.length) return;
    const total = Math.max(...bin.placed.map((box) => box.y + box.dh));
    const label = heightLabel(stackedHeightText(bin));
    const host = stackedBoxes[stackedBoxes.length - 1];
    label.scale.set(380, 96, 1);
    label.position.set(bin.l / 2, total + 78, bin.w / 2);
    label.userData.order = bin.placed.indexOf(host);
    label.userData.role = "stack-height";
    cargoGroup.add(label);
  }

  function heightLabel(text) {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 160;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(255, 248, 234, 0.96)";
    roundRect(ctx, 8, 16, 1008, 128, 36);
    ctx.fill();
    ctx.lineWidth = 8;
    ctx.strokeStyle = "#9a5416";
    ctx.stroke();
    ctx.fillStyle = "#9a5416";
    ctx.font = "700 64px 'Microsoft JhengHei', 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 512, 82);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 9;
    return sprite;
  }

  function applyShown() {
    cargoGroup.traverse((obj) => {
      if (obj === cargoGroup || obj.userData.order == null) return;
      obj.visible = obj.userData.order < shown;
    });
    applyHighlight();
    updateChrome();
  }

  function applyHighlight() {
    cargoGroup.traverse((obj) => {
      if (!obj.material || !obj.material.emissive) return;
      const on = highlightId && String(obj.userData.pieceId) === highlightId && obj.visible;
      obj.material.emissive.set(on ? 0xe4b15a : 0x000000);
      obj.material.emissiveIntensity = on ? 0.72 : 0;
    });
  }

  function findBox(id) {
    for (const item of containers) {
      const box = item.placed.find((entry) => String(entry.item.id) === String(id));
      if (box) return { bin: item, box };
    }
    return null;
  }

  function writeDetail() {
    if (!highlightId) {
      detail.textContent = "移到或點選貨物，可看名稱、擺放尺寸、重量和位置。";
      return;
    }
    const found = findBox(highlightId);
    if (!found) {
      detail.textContent = "移到或點選貨物，可看名稱、擺放尺寸、重量和位置。";
      return;
    }
    const index = found.bin.placed.indexOf(found.box);
    if (found.bin !== bin || index >= shown) {
      detail.textContent = `編號 ${found.box.item.id} 還沒放進畫面。`;
      return;
    }
    detail.textContent = cargoInfoLines(found.box, found.bin).join("\n");
  }

  function updateChrome() {
    const total = bin.placed.length;
    playButton.textContent = playing ? "暫停" : "逐件播放";
    playButton.disabled = total === 0;
    jumpButton.disabled = total === 0;
    countLabel.textContent = `${shown} / ${total}`;
    for (const node of speedButtons) {
      const on = Number(node.dataset.speed) === speed;
      node.classList.toggle("is-on", on);
      node.setAttribute("aria-pressed", on ? "true" : "false");
    }
    for (const node of binButtons) {
      const on = node.dataset.bin === String(bin.index);
      node.classList.toggle("is-on", on);
      node.setAttribute("aria-pressed", on ? "true" : "false");
    }
    const text = sceneCaption(bin, visibleBoxes(bin, shown));
    captionTitle.textContent = text.title;
    captionDetail.textContent = text.detail;
    captionBalance.textContent = text.balance;
    captionBalance.classList.toggle("is-warn", text.warn);
    captionStacked.textContent = text.stacked || "";
    captionStacked.hidden = !text.stacked;
    renderer.domElement.setAttribute("aria-label", `${text.title} 立體配載`);
    markViews();
    writeDetail();
  }

  function pause() {
    playing = false;
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
    if (playButton) updateChrome();
  }

  function stepForward() {
    if (shown >= bin.placed.length) {
      pause();
      return;
    }
    shown += 1;
    applyShown();
    if (shown >= bin.placed.length) pause();
  }

  function togglePlay() {
    if (playing) {
      pause();
      return;
    }
    if (bin.placed.length === 0) return;
    if (shown >= bin.placed.length) {
      shown = 0;
      applyShown();
    }
    if (shown === 0) {
      shown = 1;
      applyShown();
    }
    if (shown >= bin.placed.length) return;
    playing = true;
    updateChrome();
    timer = setInterval(stepForward, playIntervalMs(speed));
  }

  function setSpeed(value) {
    speed = value;
    if (playing) {
      clearInterval(timer);
      timer = setInterval(stepForward, playIntervalMs(speed));
    }
    updateChrome();
  }

  function showAll() {
    pause();
    shown = bin.placed.length;
    applyShown();
  }

  function rebuild() {
    pause();
    shown = bin.placed.length;
    fillShell();
    fillCargo();
    fillCog();
    applyShown();
    resize();
    setView("reset");
  }

  function resize() {
    const rect = stageEl.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }

  function loop() {
    if (scheduled || !active) return;
    scheduled = true;
    raf = requestAnimationFrame(() => {
      scheduled = false;
      if (!active) return;
      controls.update();
      renderer.render(scene, camera);
      loop();
    });
  }

  function syncLoop() {
    active = enabled && !document.hidden;
    if (active) {
      resize();
      loop();
    }
  }

  function hideTip() {
    tip.hidden = true;
    tip.replaceChildren();
  }

  function showTip(event, id) {
    const box = bin.placed.find((entry) => String(entry.item.id) === String(id));
    if (!box) {
      hideTip();
      return;
    }
    tip.replaceChildren();
    for (const line of cargoInfoLines(box, bin)) {
      const row = document.createElement("p");
      row.textContent = line;
      tip.append(row);
    }
    const rect = stageEl.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(8, event.clientX - rect.left + 14), Math.max(8, rect.width - 280))}px`;
    tip.style.top = `${Math.min(Math.max(8, event.clientY - rect.top + 14), Math.max(8, rect.height - 130))}px`;
  }

  function pick(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return "";
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(cargoGroup.children, true);
    const hit = hits.find((item) => item.object.visible && item.object.userData.pieceId != null);
    return hit ? String(hit.object.userData.pieceId) : "";
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    press = { x: event.clientX, y: event.clientY, id: pick(event) };
    hideTip();
  }

  function onPointerUp(event) {
    if (!press || event.button !== 0) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    const id = press.id;
    press = null;
    if (dx * dx + dy * dy > 25 || !id) return;
    highlightId = id;
    applyHighlight();
    writeDetail();
    if (options.onSelect) options.onSelect(id);
  }

  function onPointerMove(event) {
    if (press) return;
    const id = pick(event);
    if (!id) hideTip();
    else showTip(event, id);
  }

  function onVisibility() {
    syncLoop();
  }

  function exportPng() {
    renderer.render(scene, camera);
    const text = sceneCaption(bin, visibleBoxes(bin, shown));
    const canvas = composePngCanvas(renderer.domElement, text);
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = `配載-第${bin.index}櫃-${bin.code}.png`;
    document.body.append(link);
    link.click();
    link.remove();
  }

  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerleave", hideTip);
  document.addEventListener("visibilitychange", onVisibility);
  const observer = new ResizeObserver(() => resize());
  observer.observe(stageEl);

  rebuild();
  requestAnimationFrame(() => {
    resize();
    setView("reset");
  });
  syncLoop();

  return {
    dispose() {
      enabled = false;
      active = false;
      pause();
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerleave", hideTip);
      controls.dispose();
      clearGroup(shellGroup);
      clearGroup(cargoGroup);
      clearGroup(cogGroup);
      for (const material of spriteMaterials.values()) {
        if (material.map) material.map.dispose();
        material.dispose();
      }
      spriteMaterials.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      host.replaceChildren();
    },
    setActive(next) {
      enabled = Boolean(next);
      if (!enabled) pause();
      syncLoop();
    },
    setHighlight(id) {
      highlightId = id ? String(id) : "";
      const found = findBox(highlightId);
      if (found && found.bin !== bin) {
        bin = found.bin;
        rebuild();
        return;
      }
      applyHighlight();
      writeDetail();
    },
  };
}
