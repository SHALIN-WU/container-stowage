import * as THREE from "three";
import { OrbitControls } from "./vendor/three/OrbitControls.js";
import { centerOfGravity, cogMark, cogText, endHangText, sideOverhangText, stackedHeightText } from "./packer.js?v=2.1";
import { CONTAINERS } from "./planner.js?v=2.1";

const EPS = 0.05;
const SEAM = 0.2;
const BASE_PLAY_MS = 700;
const TONE_EXPOSURE = 1.1;
const HEMI_INTENSITY = 1.25;
const AMBIENT_INTENSITY = 0.4;
const KEY_INTENSITY = 2.0;
const FILL_INTENSITY = 0.7;
const SHADOW_MAP = 2048;
const BACKGROUND = 0xe4dccd;
const GROUND_COLOR = 0xc9bda6;
const GRID_COLOR = 0x8c7d63;
const SHELL_T = 2.6;
const RIB_PITCH = 27;
const VIEW_MS = 400;
const DROP_MS = 250;
const DROP_HEIGHT = 40;

/** 同一次開啟的畫面裡記住畫質選擇；換方案重建 3D 時沿用。 */
let qualityMode = "high";

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
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.82,
    metalness: 0,
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
    hatchLineMaterial = new THREE.LineBasicMaterial({ color: 0xc4382b, toneMapped: false });
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

const CONTACT_PAD = 9;
const CONTACT_LIFT = 0.25;
let contactMaterial = null;

function sharedContactMaterial() {
  if (!contactMaterial) {
    contactMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    contactMaterial.userData.shared = true;
  }
  return contactMaterial;
}

/** 貼地貨物底下的柔和暗影：內圈不透明、外圈漸淡，範圍限制在底板內。 */
export function contactShadowMesh(box, bin) {
  if (box.y > EPS) return null;
  const x0 = Math.max(0, box.x);
  const x1 = Math.min(bin.l, box.x + box.dl);
  const z0 = Math.max(0, box.z);
  const z1 = Math.min(bin.w, box.z + box.dw);
  if (x1 - x0 <= EPS || z1 - z0 <= EPS) return null;
  const ox0 = Math.max(0, x0 - CONTACT_PAD);
  const ox1 = Math.min(bin.l, x1 + CONTACT_PAD);
  const oz0 = Math.max(0, z0 - CONTACT_PAD);
  const oz1 = Math.min(bin.w, z1 + CONTACT_PAD);
  const y = CONTACT_LIFT;
  const positions = [
    x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1,
    ox0, y, oz0, ox1, y, oz0, ox1, y, oz1, ox0, y, oz1,
  ];
  const inner = [0.08, 0.06, 0.04, 0.42];
  const outer = [0.08, 0.06, 0.04, 0];
  const colors = [...inner, ...inner, ...inner, ...inner, ...outer, ...outer, ...outer, ...outer];
  const index = [0, 2, 1, 0, 3, 2];
  for (let side = 0; side < 4; side += 1) {
    const a = side;
    const b = (side + 1) % 4;
    index.push(a + 4, a, b, a + 4, b, b + 4);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
  geometry.setIndex(index);
  const mesh = new THREE.Mesh(geometry, sharedContactMaterial());
  mesh.userData.role = "deco";
  mesh.renderOrder = 2;
  mesh.raycast = () => {};
  return mesh;
}

export function buildCargoMeshes(box, bin, color) {
  const meshes = [];
  for (const part of cargoParts(box, bin)) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(part.dl, part.dh, part.dw), boxMaterial(color, part.role));
    mesh.position.set(part.x + part.dl / 2, part.y + part.dh / 2, part.z + part.dw / 2);
    mesh.userData.pieceId = box.item.id;
    mesh.userData.role = part.role;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    meshes.push(mesh);
    if (part.role !== "overhang") continue;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color: 0xc4382b, toneMapped: false })
    );
    mesh.add(edges);
    const lines = hatchLineSegments(part.dl, part.dh, part.dw, part.cut);
    if (lines) mesh.add(lines);
    const glow = new THREE.Mesh(new THREE.BoxGeometry(part.dl + 1.2, part.dh + 1.2, part.dw + 1.2), sharedOverhangGlow());
    glow.userData.role = "deco";
    glow.renderOrder = 6;
    glow.raycast = () => {};
    mesh.add(glow);
  }
  return meshes;
}

let overhangGlowMaterial = null;

function sharedOverhangGlow() {
  if (!overhangGlowMaterial) {
    overhangGlowMaterial = new THREE.MeshBasicMaterial({
      color: 0xd8402f,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      toneMapped: false,
    });
    overhangGlowMaterial.userData.shared = true;
  }
  return overhangGlowMaterial;
}

const textureCache = new Map();

function cachedTexture(key, width, height, draw, colorSpace) {
  if (typeof document === "undefined") return null;
  let texture = textureCache.get(key);
  if (!texture) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    draw(canvas.getContext("2d"), width, height);
    texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    if (colorSpace) texture.colorSpace = colorSpace;
    texture.userData.shared = true;
    textureCache.set(key, texture);
  }
  return texture;
}

/** 共用同一張畫布，只各自設定重複次數；clone 共用同一份上傳到顯示卡的影像。 */
function tiled(base, repeatX, repeatY) {
  if (!base) return null;
  const texture = base.clone();
  texture.userData = {};
  texture.repeat.set(repeatX, repeatY);
  return texture;
}

/** 波紋鐵皮一個週期：凸面、下斜面、凹面、上斜面。 */
const RIB_PROFILE = [
  { end: 0.3, shade: 1, alpha: 1, slope: 0 },
  { end: 0.42, shade: 0.62, alpha: 0.78, slope: -1 },
  { end: 0.8, shade: 0.8, alpha: 0, slope: 0 },
  { end: 0.92, shade: 0.92, alpha: 0.78, slope: 1 },
  { end: 1, shade: 1, alpha: 1, slope: 0 },
];

function ribSegment(u) {
  return RIB_PROFILE.find((part) => u < part.end) || RIB_PROFILE[RIB_PROFILE.length - 1];
}

function corrugatedTexture(valleyAlpha) {
  return cachedTexture(`rib-${valleyAlpha}`, 64, 4, (ctx, width, height) => {
    for (let x = 0; x < width; x += 1) {
      const part = ribSegment((x + 0.5) / width);
      const alpha = part.alpha === 0 ? valleyAlpha : part.alpha === 1 ? 1 : valleyAlpha + (1 - valleyAlpha) * part.alpha;
      const level = Math.round(255 * part.shade);
      ctx.fillStyle = `rgba(${level}, ${level}, ${level}, ${alpha})`;
      ctx.fillRect(x, 0, 1, height);
    }
  }, THREE.SRGBColorSpace);
}

function corrugatedNormal() {
  return cachedTexture("rib-normal", 64, 4, (ctx, width, height) => {
    for (let x = 0; x < width; x += 1) {
      const part = ribSegment((x + 0.5) / width);
      const nx = part.slope * 0.62;
      const nz = Math.sqrt(1 - nx * nx);
      ctx.fillStyle = `rgb(${Math.round((nx * 0.5 + 0.5) * 255)}, 128, ${Math.round((nz * 0.5 + 0.5) * 255)})`;
      ctx.fillRect(x, 0, 1, height);
    }
  });
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 一張圖代表 240 cm 見方的木地板，木板沿櫃長方向，上下左右可無縫重複。 */
function woodTexture() {
  return cachedTexture("wood", 512, 512, (ctx, width, height) => {
    const random = seededRandom(20261126);
    const rows = 8;
    const rowH = height / rows;
    for (let row = 0; row < rows; row += 1) {
      const top = row * rowH;
      const tone = 0.9 + random() * 0.16;
      ctx.fillStyle = `rgb(${Math.round(200 * tone)}, ${Math.round(176 * tone)}, ${Math.round(140 * tone)})`;
      ctx.fillRect(0, top, width, rowH);
      for (let line = 0; line < 16; line += 1) {
        const y = top + 4 + random() * (rowH - 8);
        const waves = 1 + Math.floor(random() * 3);
        const amp = 0.6 + random() * 1.6;
        const phase = random() * Math.PI * 2;
        ctx.strokeStyle = `rgba(92, 62, 32, ${0.06 + random() * 0.12})`;
        ctx.lineWidth = 0.6 + random() * 1.2;
        ctx.beginPath();
        for (let x = 0; x <= width; x += 8) {
          const yy = y + Math.sin((x / width) * Math.PI * 2 * waves + phase) * amp;
          if (x === 0) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      const joint = random() * width;
      ctx.fillStyle = "rgba(58, 38, 20, 0.45)";
      ctx.fillRect(joint, top, 2, rowH);
      ctx.fillStyle = "rgba(48, 32, 18, 0.55)";
      ctx.fillRect(0, top, width, 2);
      ctx.fillStyle = "rgba(255, 244, 220, 0.18)";
      ctx.fillRect(0, top + 2, width, 1);
    }
  }, THREE.SRGBColorSpace);
}

function groundFadeTexture() {
  return cachedTexture("ground-fade", 256, 256, (ctx, width, height) => {
    const gradient = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, width / 2);
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.55, "#ffffff");
    gradient.addColorStop(1, "#000000");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  });
}

function shellMaterial(color, opacity, extra = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.7,
    metalness: 0.05,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: opacity >= 0.5,
    ...extra,
  });
}

function corrugatedMaterial(color, opacity, ribs, valleyAlpha) {
  const map = tiled(corrugatedTexture(valleyAlpha), ribs, 1);
  const normalMap = tiled(corrugatedNormal(), ribs, 1);
  return shellMaterial(color, opacity, map ? { map, normalMap, normalScale: new THREE.Vector2(1, 1) } : {});
}

function addShell(list, face, size, center, material) {
  const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(center.x, center.y, center.z);
  mesh.userData.face = face;
  mesh.renderOrder = face === "floor" ? 1 : 4;
  mesh.receiveShadow = face === "floor";
  list.push(mesh);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0x143e39, toneMapped: false })
  );
  edges.position.copy(mesh.position);
  edges.userData.role = "edge";
  edges.renderOrder = 5;
  list.push(edges);
}

export function buildShellMeshes(bin) {
  const list = [];
  const faces = new Set(shellFaces(bin.kind));
  const thickness = SHELL_T;
  const l = bin.l;
  const w = bin.w;
  const h = bin.h;
  const fr = bin.kind === "fr";
  const wallColor = bin.kind === "ot" ? 0x8a5a2b : 0x1d4e89;
  const doorColor = 0xd0893a;
  const valley = fr ? 1 : 0.34;
  if (faces.has("floor")) {
    const map = tiled(woodTexture(), l / 240, w / 240);
    const material = shellMaterial(map ? 0xffffff : 0xc8b496, 1, map ? { map, roughness: 0.88, side: THREE.FrontSide } : {});
    addShell(list, "floor", { x: l, y: thickness, z: w }, { x: l / 2, y: -thickness / 2, z: w / 2 }, material);
  }
  if (faces.has("roof")) {
    addShell(list, "roof", { x: l, y: thickness, z: w }, { x: l / 2, y: h + thickness / 2, z: w / 2 }, shellMaterial(0x143e39, 0.12));
  }
  if (faces.has("side-high")) {
    const material = corrugatedMaterial(wallColor, 0.3, l / RIB_PITCH, valley);
    addShell(list, "side-high", { x: l, y: h, z: thickness }, { x: l / 2, y: h / 2, z: -thickness / 2 }, material);
  }
  if (faces.has("side-low")) {
    const material = corrugatedMaterial(wallColor, 0.3, l / RIB_PITCH, valley);
    addShell(list, "side-low", { x: l, y: h, z: thickness }, { x: l / 2, y: h / 2, z: w + thickness / 2 }, material);
  }
  if (faces.has("end-closed")) {
    const material = corrugatedMaterial(wallColor, fr ? 0.78 : 0.36, w / RIB_PITCH, valley);
    addShell(list, "end-closed", { x: thickness, y: h, z: w }, { x: -thickness / 2, y: h / 2, z: w / 2 }, material);
  }
  if (faces.has("end-door")) {
    const material = corrugatedMaterial(doorColor, fr ? 0.88 : 0.42, w / RIB_PITCH, valley);
    addShell(list, "end-door", { x: thickness, y: h, z: w }, { x: l + thickness / 2, y: h / 2, z: w / 2 }, material);
  }
  list.push(...buildShellDeco(bin));
  return list;
}

/** 貨櫃外框的底面高度（底樑下緣），地面放在這裡。 */
export function shellBaseY(bin) {
  return bin.kind === "fr" ? -SHELL_T - 26 : -SHELL_T - 10;
}

function boxGeometry(x, y, z) {
  const geometry = new THREE.BoxGeometry(x[1] - x[0], y[1] - y[0], z[1] - z[0]);
  geometry.translate((x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2);
  return geometry;
}

/** 斷面四角倒角的長條鋼材，沿最長的那一軸擺放。 */
function barGeometry(x, y, z, chamfer) {
  const dx = x[1] - x[0];
  const dy = y[1] - y[0];
  const dz = z[1] - z[0];
  const extrude = (sizeA, sizeB, length) => {
    const a = sizeA / 2;
    const b = sizeB / 2;
    const c = Math.min(chamfer, a * 0.45, b * 0.45);
    const shape = new THREE.Shape();
    shape.moveTo(-a + c, -b);
    shape.lineTo(a - c, -b);
    shape.lineTo(a, -b + c);
    shape.lineTo(a, b - c);
    shape.lineTo(a - c, b);
    shape.lineTo(-a + c, b);
    shape.lineTo(-a, b - c);
    shape.lineTo(-a, -b + c);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false, steps: 1, curveSegments: 1 });
    geometry.translate(0, 0, -length / 2);
    return geometry;
  };
  let geometry;
  if (dx >= dy && dx >= dz) {
    geometry = extrude(dz, dy, dx);
    geometry.rotateY(Math.PI / 2);
  } else if (dy >= dz) {
    geometry = extrude(dx, dz, dy);
    geometry.rotateX(-Math.PI / 2);
  } else {
    geometry = extrude(dx, dy, dz);
  }
  geometry.translate((x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2);
  return geometry;
}

function mergeGeometries(list) {
  const parts = list.map((geometry) => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (!flat.attributes.normal) flat.computeVertexNormals();
    return flat;
  });
  const count = parts.reduce((sum, part) => sum + part.attributes.position.count, 0);
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  let offset = 0;
  for (const part of parts) {
    position.set(part.attributes.position.array, offset * 3);
    normal.set(part.attributes.normal.array, offset * 3);
    offset += part.attributes.position.count;
  }
  for (const geometry of new Set([...list, ...parts])) geometry.dispose();
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(position, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** 角柱、上下樑、角件、門鎖桿、開頂弓形樑、平板底樑。全部在內徑之外，只當外觀。 */
function buildShellDeco(bin) {
  const t = SHELL_T;
  const l = bin.l;
  const w = bin.w;
  const h = bin.h;
  const fr = bin.kind === "fr";
  const yB = shellBaseY(bin);
  const yT = h + t + 6;
  const xr = (end, near, far) => (end ? [l + near, l + t + far] : [-t - far, -near]);
  const zr = (side, near, far) => (side ? [w + near, w + t + far] : [-t - far, -near]);
  const frame = [];
  const cast = [];
  const steel = [];
  const dark = [];

  for (const end of [0, 1]) {
    for (const side of [0, 1]) {
      frame.push(barGeometry(xr(end, 0.5, 8), [yB, yT], zr(side, 0.5, 8), 2));
      for (const y of [[yB - 1, yB + 10], [yT - 10, yT + 1]]) {
        const x = xr(end, 0.3, 9.6);
        const z = zr(side, 0.3, 9.6);
        cast.push(barGeometry(x, y, z, 0.9));
        const xo = end ? x[1] : x[0];
        const zo = side ? z[1] : z[0];
        const xm = (x[0] + x[1]) / 2;
        const ym = (y[0] + y[1]) / 2;
        const zm = (z[0] + z[1]) / 2;
        dark.push(boxGeometry([xo - 0.4, xo + 0.4], [ym - 2.2, ym + 2.2], [zm - 3, zm + 3]));
        dark.push(boxGeometry([xm - 3, xm + 3], [ym - 2.2, ym + 2.2], [zo - 0.4, zo + 0.4]));
      }
    }
    frame.push(barGeometry(xr(end, 0.5, 6), [yB, 4], [-0.5, w + 0.5], 1.5));
    frame.push(barGeometry(xr(end, 0.5, 6), [h - 6, yT], [-0.5, w + 0.5], 1.5));
  }
  for (const side of [0, 1]) {
    frame.push(barGeometry([-0.5, l + 0.5], fr ? [yB, 0.5] : [yB, 4], zr(side, 0.5, fr ? 9 : 6), 1.5));
    if (!fr) frame.push(barGeometry([-0.5, l + 0.5], [h - 6, yT], zr(side, 0.5, 6), 1.5));
    if (fr) {
      for (let x = 60; x < l - 30; x += 120) {
        frame.push(barGeometry([x - 6, x + 6], [yB + 5, -t - 3], zr(side, 8.5, 12.5), 1));
      }
    }
  }

  if (!fr) {
    const xd = l + t;
    for (const f of [0.11, 0.37, 0.63, 0.89]) {
      const z = w * f;
      const rod = new THREE.CylinderGeometry(1.5, 1.5, h - 20, 10);
      rod.translate(xd + 2.6, h / 2, z);
      steel.push(rod);
      for (const y of [14, h - 14]) steel.push(boxGeometry([xd, xd + 4.6], [y - 3, y + 3], [z - 3.5, z + 3.5]));
      const hy = h * 0.42;
      steel.push(boxGeometry([xd + 1.6, xd + 4.4], [hy - 1.6, hy + 1.6], f < 0.5 ? [z, z + 22] : [z - 22, z]));
      const tip = f < 0.5 ? z + 20 : z - 20;
      steel.push(boxGeometry([xd, xd + 3], [hy - 4, hy + 4], [tip - 2.5, tip + 2.5]));
    }
    dark.push(boxGeometry([xd, xd + 0.9], [0, h], [w / 2 - 0.7, w / 2 + 0.7]));
    for (const z of [4, w - 4]) {
      for (const y of [h * 0.14, h * 0.5, h * 0.86]) steel.push(boxGeometry([xd, xd + 3.6], [y - 4, y + 4], [z - 3, z + 3]));
    }
  }

  if (bin.kind === "ot") {
    const count = Math.max(3, Math.round(l / 140));
    for (let i = 1; i <= count; i += 1) {
      const x = (l * i) / (count + 1);
      const blocked = (bin.placed || []).some((box) => box.y + box.dh > h + EPS && box.x - 8 < x && box.x + box.dl + 8 > x);
      if (blocked) continue;
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(x, yT - 1, -t - 3),
        new THREE.Vector3(x, yT + 30, w / 2),
        new THREE.Vector3(x, yT - 1, w + t + 3)
      );
      frame.push(new THREE.TubeGeometry(curve, 24, 1.8, 6, false));
    }
  }

  const frameColor = new THREE.Color(bin.kind === "ot" ? 0x6b4422 : 0x183a63);
  const castColor = frameColor.clone().lerp(new THREE.Color(0x9aa1a8), 0.35);
  const meshes = [];
  const add = (geometries, material) => {
    if (!geometries.length) return;
    const mesh = new THREE.Mesh(mergeGeometries(geometries), material);
    mesh.userData.role = "deco";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.raycast = () => {};
    meshes.push(mesh);
  };
  add(frame, new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.55, metalness: 0.25 }));
  add(cast, new THREE.MeshStandardMaterial({ color: castColor, roughness: 0.6, metalness: 0.3 }));
  add(steel, new THREE.MeshStandardMaterial({ color: 0xb8bec4, roughness: 0.38, metalness: 0.45 }));
  add(dark, new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.85 }));
  return meshes;
}

export function disposeMeshes(meshes) {
  for (const mesh of meshes) {
    const objects = [];
    if (mesh.traverse) mesh.traverse((obj) => objects.push(obj));
    else objects.push(mesh);
    for (const obj of objects) {
      if (obj.geometry) obj.geometry.dispose();
      disposeMaterial(obj.material);
    }
  }
}

function disposeMaterial(material) {
  if (!material || material.userData.shared) return;
  for (const key of ["map", "normalMap", "alphaMap"]) {
    const texture = material[key];
    if (texture && !texture.userData.shared) texture.dispose();
  }
  material.dispose();
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
  for (const mesh of shell) {
    if (mesh.userData.role !== "deco") continue;
    if (mesh.userData.face || mesh.userData.pieceId != null) issues.push(`deco-tag ${bin.code || bin.kind}`);
    const position = mesh.geometry.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i) + mesh.position.x;
      const y = position.getY(i) + mesh.position.y;
      const z = position.getZ(i) + mesh.position.z;
      if (x > 0.01 && x < bin.l - 0.01 && y > 0.01 && y < bin.h - 0.01 && z > 0.01 && z < bin.w - 0.01) {
        issues.push(`deco-inside ${bin.code || bin.kind}`);
        break;
      }
    }
  }
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
  let needsRender = false;
  let raf = 0;
  let currentView = "reset";
  let press = null;
  let transition = null;
  let drops = [];
  const spriteMaterials = new Map();
  const motionQuery = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const reducedMotion = () => Boolean(motionQuery && motionQuery.matches);

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

  renderer.setClearColor(BACKGROUND, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = TONE_EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
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
    transition = null;
    currentView = "";
    markViews();
  });
  controls.addEventListener("change", () => invalidate());

  scene.add(new THREE.HemisphereLight(0xfffaf0, 0xb8a88c, HEMI_INTENSITY));
  scene.add(new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY));
  const key = new THREE.DirectionalLight(0xffffff, KEY_INTENSITY);
  // packer 從封閉端、上緣往外排，影子要落向櫃門與下緣那側的空地板才看得到。
  const keyDir = new THREE.Vector3(-520, 1600, 760).normalize();
  key.castShadow = true;
  key.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 1.2;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xffffff, FILL_INTENSITY);
  fill.position.set(1000, 520, 260);
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
    front: button("secondary", "正面", () => setView("front", true)),
    side: button("secondary", "側面", () => setView("side", true)),
    top: button("secondary", "俯視", () => setView("top", true)),
    reset: button("secondary", "重設視角", () => setView("reset", true)),
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

  const qualityGroup = group("畫質");
  const qualityButtons = {
    high: button("secondary", "高", () => setQuality("high")),
    saver: button("secondary", "省電", () => setQuality("saver")),
  };
  qualityButtons.high.title = "柔和陰影";
  qualityButtons.saver.title = "關閉陰影，比較省電";
  qualityGroup.append(qualityButtons.high, qualityButtons.saver);

  const exportButton = button("secondary", "匯出 PNG", exportPng);
  exportButton.title = "下載目前這個櫃子的 3D 畫面";
  if (containers.length > 1) toolbar.append(binGroup);
  toolbar.append(viewGroup, playGroup, qualityGroup, exportButton);

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
      material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, toneMapped: false });
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
      disposeMeshes([child]);
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

  function viewPose(name) {
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
    const position = new THREE.Vector3();
    if (name === "front") {
      position.set(bounds.maxX + fit(sizeZ, sizeY) + outside, center.y + sizeY * 0.04, center.z);
    } else if (name === "side") {
      position.set(center.x, center.y + sizeY * 0.04, bounds.maxZ + fit(sizeX, sizeY) + outside);
    } else if (name === "top") {
      const distance = fit(sizeX, sizeZ);
      position.set(center.x, bounds.maxY + distance + outside, center.z + distance * 0.015);
    } else {
      const dir = new THREE.Vector3(0.78, 0.5, 0.9).normalize();
      position.copy(center).addScaledVector(dir, obliqueDistance(dir, bounds, center, aspectRatio));
    }
    return { target: center, position };
  }

  /** 斜向視角：把八個角投到畫面上，左右上下都放得下。 */
  function obliqueDistance(dir, bounds, center, aspectRatio) {
    const forward = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    let halfW = 0;
    let halfH = 0;
    let depth = 0;
    for (const x of [bounds.minX, bounds.maxX]) {
      for (const y of [bounds.minY, bounds.maxY]) {
        for (const z of [bounds.minZ, bounds.maxZ]) {
          const v = new THREE.Vector3(x, y, z).sub(center);
          halfW = Math.max(halfW, Math.abs(v.dot(right)));
          halfH = Math.max(halfH, Math.abs(v.dot(up)));
          depth = Math.max(depth, v.dot(dir));
        }
      }
    }
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const tanH = tanV * aspectRatio;
    return (Math.max(halfW / tanH, halfH / tanV) + depth) * 1.12;
  }

  function applyPose(pose) {
    controls.target.copy(pose.target);
    camera.position.copy(pose.position);
    camera.up.set(0, 1, 0);
    camera.lookAt(pose.target);
    controls.update();
  }

  function setView(name, animate = false) {
    currentView = name === "front" || name === "side" || name === "top" ? name : "reset";
    const pose = viewPose(currentView);
    camera.near = 0.5;
    camera.far = 100000;
    camera.updateProjectionMatrix();
    transition = null;
    if (animate && !reducedMotion()) {
      const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
      const to = new THREE.Spherical().setFromVector3(pose.position.clone().sub(pose.target));
      const turn = to.theta - from.theta;
      const dTheta = turn - Math.PI * 2 * Math.round(turn / (Math.PI * 2));
      transition = { fromTarget: controls.target.clone(), from, to, dTheta, pose, start: performance.now() };
    } else {
      applyPose(pose);
    }
    markViews();
    invalidate();
  }

  function stepTransition(now) {
    const t = Math.min(1, Math.max(0, (now - transition.start) / VIEW_MS));
    if (t >= 1) {
      const pose = transition.pose;
      transition = null;
      applyPose(pose);
      needsRender = true;
      return false;
    }
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const { from, to } = transition;
    const target = transition.fromTarget.clone().lerp(transition.pose.target, e);
    const spherical = new THREE.Spherical(
      from.radius + (to.radius - from.radius) * e,
      from.phi + (to.phi - from.phi) * e,
      from.theta + transition.dTheta * e
    );
    controls.target.copy(target);
    camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(spherical));
    camera.lookAt(target);
    return true;
  }

  function decoOnly(obj) {
    obj.userData.role = "deco";
    obj.raycast = () => {};
    return obj;
  }

  function groundMeshes() {
    const y = shellBaseY(bin);
    const cx = bin.l / 2;
    const cz = bin.w / 2;
    const radius = Math.max(bin.l, bin.w) / 2 + 360;
    const size = radius * 2.5;
    const plane = new THREE.PlaneGeometry(size, size);
    plane.rotateX(-Math.PI / 2);
    const fade = groundFadeTexture();
    const ground = new THREE.Mesh(plane, new THREE.MeshStandardMaterial({
      color: GROUND_COLOR,
      roughness: 1,
      metalness: 0,
      transparent: true,
      alphaMap: fade,
      depthWrite: false,
    }));
    ground.position.set(cx, y - 0.3, cz);
    ground.receiveShadow = true;
    ground.renderOrder = -2;

    const step = 100;
    const seg = 50;
    const tone = new THREE.Color(GRID_COLOR);
    const positions = [];
    const colors = [];
    const alphaAt = (x, z) => {
      const d = Math.hypot(x - cx, z - cz) / radius;
      return d >= 1 ? 0 : 0.5 * Math.pow(1 - d, 1.3);
    };
    const push = (x0, z0, x1, z1) => {
      positions.push(x0, y - 0.15, z0, x1, y - 0.15, z1);
      colors.push(tone.r, tone.g, tone.b, alphaAt(x0, z0), tone.r, tone.g, tone.b, alphaAt(x1, z1));
    };
    for (let gx = Math.ceil((cx - radius) / step) * step; gx <= cx + radius; gx += step) {
      for (let z = cz - radius; z < cz + radius; z += seg) push(gx, z, gx, z + seg);
    }
    for (let gz = Math.ceil((cz - radius) / step) * step; gz <= cz + radius; gz += step) {
      for (let x = cx - radius; x < cx + radius; x += seg) push(x, gz, x + seg, gz);
    }
    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    gridGeometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
    const grid = new THREE.LineSegments(gridGeometry, new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }));
    grid.renderOrder = -1;
    return [decoOnly(ground), decoOnly(grid)];
  }

  /** 內徑的長、寬、高標線，放在櫃子與超出貨物的外側。 */
  function dimensionMeshes() {
    const bounds = contentBounds();
    const t = SHELL_T;
    const y = shellBaseY(bin) + 0.5;
    const zL = Math.max(bin.w + t + 8, bounds.maxZ) + 45;
    const xW = Math.max(bin.l + t + 8, bounds.maxX) + 45;
    const xH = Math.min(-t - 8, bounds.minX) - 26;
    const zH = Math.max(bin.w + t + 8, bounds.maxZ) + 26;
    const tick = 7;
    const p = [];
    const seg = (a, b) => p.push(...a, ...b);
    seg([0, y, zL], [bin.l, y, zL]);
    seg([0, y, bin.w + t + 10], [0, y, zL + tick]);
    seg([bin.l, y, bin.w + t + 10], [bin.l, y, zL + tick]);
    seg([xW, y, 0], [xW, y, bin.w]);
    seg([bin.l + t + 10, y, 0], [xW + tick, y, 0]);
    seg([bin.l + t + 10, y, bin.w], [xW + tick, y, bin.w]);
    seg([xH, 0, zH], [xH, bin.h, zH]);
    seg([xH - tick, 0, zH - tick], [xH + tick, 0, zH + tick]);
    seg([xH - tick, bin.h, zH - tick], [xH + tick, bin.h, zH + tick]);
    for (const [cx, cz] of [[0, zL], [bin.l, zL], [xW, 0], [xW, bin.w]]) {
      seg([cx - tick * 0.7, y, cz - tick * 0.7], [cx + tick * 0.7, y, cz + tick * 0.7]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x5c4a30, toneMapped: false }));
    lines.renderOrder = 7;
    const label = (text, x, ly, z) => {
      const sprite = textSprite(text);
      sprite.scale.set(118, 29.5, 1);
      sprite.position.set(x, ly, z);
      return decoOnly(sprite);
    };
    return [
      decoOnly(lines),
      label(`內長 ${formatDim(bin.l)} cm`, bin.l / 2, y + 16, zL),
      label(`內寬 ${formatDim(bin.w)} cm`, xW, y + 16, bin.w / 2),
      label(`內高 ${formatDim(bin.h)} cm`, xH, bin.h / 2, zH),
    ];
  }

  function fillShell() {
    clearGroup(shellGroup);
    for (const mesh of buildShellMeshes(bin)) shellGroup.add(mesh);
    for (const mesh of groundMeshes()) shellGroup.add(mesh);
    for (const mesh of dimensionMeshes()) shellGroup.add(mesh);
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
    const markMaterial = () => new THREE.MeshBasicMaterial({ color, depthTest: false, toneMapped: false });
    const armX = new THREE.Mesh(new THREE.BoxGeometry(span, span * 0.08, span * 0.08), markMaterial());
    const armZ = new THREE.Mesh(new THREE.BoxGeometry(span * 0.08, span * 0.08, span), markMaterial());
    const post = new THREE.Mesh(new THREE.BoxGeometry(span * 0.07, span * 0.55, span * 0.07), markMaterial());
    armX.position.set(cog.x, span * 0.08, cog.z);
    armZ.position.set(cog.x, span * 0.08, cog.z);
    post.position.set(cog.x, span * 0.32, cog.z);
    const ringGeometry = new THREE.RingGeometry(span * 0.62, span * 0.74, 48);
    ringGeometry.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    }));
    ring.position.set(cog.x, 0.4, cog.z);
    ring.raycast = () => {};
    for (const mesh of [ring, armX, armZ, post]) {
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
      const contact = contactShadowMesh(box, bin);
      if (contact) {
        contact.userData.order = index;
        cargoGroup.add(contact);
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
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, toneMapped: false });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 9;
    return sprite;
  }

  function fitShadow() {
    const bounds = contentBounds();
    const center = new THREE.Vector3(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      (bounds.minZ + bounds.maxZ) / 2
    );
    const radius = 0.5 * Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ) + 40;
    key.target.position.copy(center);
    key.position.copy(center).addScaledVector(keyDir, radius * 2);
    const cam = key.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = radius * 0.5;
    cam.far = radius * 3.5;
    cam.updateProjectionMatrix();
    key.target.updateMatrixWorld();
    key.updateMatrixWorld();
    renderer.shadowMap.needsUpdate = true;
  }

  function applyShown() {
    cargoGroup.traverse((obj) => {
      if (obj === cargoGroup || obj.userData.order == null) return;
      obj.visible = obj.userData.order < shown;
    });
    renderer.shadowMap.needsUpdate = true;
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
    invalidate();
  }

  /** 新放入的貨物由上方落下；結束、跳過或重建時一律回到 packer 給的位置。 */
  function startDrop(order) {
    if (reducedMotion()) return;
    const duration = Math.min(DROP_MS, playIntervalMs(speed) * 0.7);
    const moving = [];
    const hidden = [];
    for (const obj of cargoGroup.children) {
      if (obj.userData.order !== order) continue;
      if (obj.userData.role === "deco") {
        obj.visible = false;
        hidden.push(obj);
      } else {
        obj.position.y = obj.userData.restY + DROP_HEIGHT;
        moving.push(obj);
      }
    }
    if (!moving.length) return;
    drops.push({ moving, hidden, start: performance.now(), duration });
    invalidate();
  }

  function finishDrop(drop) {
    for (const obj of drop.moving) obj.position.y = obj.userData.restY;
    for (const obj of drop.hidden) obj.visible = obj.userData.order < shown;
  }

  function settleDrops() {
    if (!drops.length) return;
    drops.forEach(finishDrop);
    drops = [];
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  }

  function stepDrops(now) {
    drops = drops.filter((drop) => {
      const t = Math.min(1, Math.max(0, (now - drop.start) / drop.duration));
      if (t >= 1) {
        finishDrop(drop);
        return false;
      }
      const lift = DROP_HEIGHT * Math.pow(1 - t, 2);
      for (const obj of drop.moving) obj.position.y = obj.userData.restY + lift;
      return true;
    });
    renderer.shadowMap.needsUpdate = true;
    needsRender = true;
    return drops.length > 0;
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
    startDrop(shown - 1);
    if (shown >= bin.placed.length) pause();
  }

  function togglePlay() {
    if (playing) {
      pause();
      return;
    }
    if (bin.placed.length === 0) return;
    if (shown >= bin.placed.length) {
      settleDrops();
      shown = 0;
      applyShown();
    }
    if (shown === 0) {
      shown = 1;
      applyShown();
      startDrop(0);
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
    settleDrops();
    shown = bin.placed.length;
    applyShown();
  }

  function rebuild() {
    pause();
    drops = [];
    transition = null;
    shown = bin.placed.length;
    fillShell();
    fillCargo();
    for (const obj of cargoGroup.children) obj.userData.restY = obj.position.y;
    fillCog();
    fitShadow();
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
    invalidate();
  }

  function markQuality() {
    for (const [name, node] of Object.entries(qualityButtons)) {
      const on = name === qualityMode;
      node.classList.toggle("is-on", on);
      node.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function applyQuality() {
    const high = qualityMode === "high";
    if (renderer.shadowMap.enabled !== high) {
      renderer.shadowMap.enabled = high;
      scene.traverse((obj) => {
        if (obj.material) obj.material.needsUpdate = true;
      });
    }
    key.castShadow = high;
    renderer.shadowMap.needsUpdate = true;
    markQuality();
    invalidate();
  }

  function setQuality(mode) {
    qualityMode = mode === "saver" ? "saver" : "high";
    applyQuality();
  }

  /** 只有畫面內容、相機或尺寸改變時才重畫；轉場與落下動畫進行中才連續重畫。 */
  function invalidate() {
    needsRender = true;
    schedule();
  }

  function schedule() {
    if (scheduled || !active) return;
    scheduled = true;
    raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    scheduled = false;
    if (!active) return;
    let animating = false;
    if (transition && stepTransition(now)) animating = true;
    if (drops.length && stepDrops(now)) animating = true;
    if (needsRender || animating) {
      needsRender = false;
      renderer.render(scene, camera);
    }
    if (animating) schedule();
  }

  function syncLoop() {
    active = enabled && !document.hidden;
    if (active) {
      resize();
      invalidate();
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
    settleDrops();
    if (transition) {
      const pose = transition.pose;
      transition = null;
      applyPose(pose);
    }
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

  applyQuality();
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
      drops = [];
      transition = null;
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
