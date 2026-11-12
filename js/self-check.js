import { auditLayout, buildLayout, canTip, centerOfGravity, cogText, endHangText, sideOverhangText, stackedHeightText } from "./packer.js?v=2.1";
import {
  FIRST_OCR_LOAD,
  OCR_NOTICE,
  OCR_WORKING,
  classifyUpload,
  convertToItems,
  fileBadge,
  excelToItems,
  readJpegOrientation,
  uprightImage,
  wordToItems,
} from "./convert.js?v=2.1";
import { parseTextItems, summarize } from "./parser.js?v=2.1";
import { CONTAINERS, planLabel, suggestPlans, unplannedNote } from "./planner.js?v=2.1";
import {
  PLAY_SPEEDS,
  auditScene,
  buildCargoMeshes,
  cargoInfo,
  cargoMarks,
  cargoParts,
  composePngCanvas,
  disposeMeshes,
  formatRate,
  playIntervalMs,
  sceneCaption,
  shellFaces,
  titleBandHeight,
  unionAabb,
  visibleBoxes,
  volumeRate,
} from "./scene3d.js?v=2.1";

const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
}

function item(str, x, y) {
  return { str, x, y, w: String(str).length * 6 };
}

function tableItems(headers, dataRows) {
  const xs = headers.map((_, index) => 40 + index * 80);
  const items = headers.map((header, index) => item(header, xs[index], 700));
  dataRows.forEach((row, rowIndex) => {
    row.forEach((cell, index) => {
      if (cell !== "") items.push(item(String(cell), xs[index], 660 - rowIndex * 24));
    });
  });
  return items;
}

const small = suggestPlans(22.87, 1330);
check("小票有三個方案", small.length === 3);
check("小票建議 1 個 20GP", small[0] && small[0].id === "20GPx1", planLabel(small[0] || { counts: [] }));
check("小票剩餘空間 10.33", small[0] && small[0].remainCbm === 10.33, String(small[0] && small[0].remainCbm));
check("小票剩餘載重 26870", small[0] && small[0].remainKg === 26870, String(small[0] && small[0].remainKg));
check(
  "備選櫃型不同",
  new Set(small.map((plan) => plan.signature)).size === 3
);

const bulky = suggestPlans(150, 20000);
check("大票建議 2 個 40HQ", bulky[0] && bulky[0].id === "40HQx2", bulky[0] && bulky[0].id);
check("大票剩餘空間 2.6", bulky[0] && bulky[0].remainCbm === 2.6, String(bulky[0] && bulky[0].remainCbm));

const heavy = suggestPlans(10, 50000);
check("重貨建議 2 個 20GP", heavy[0] && heavy[0].id === "20GPx2", heavy[0] && heavy[0].id);
check("重貨載重放得下", heavy[0] && heavy[0].remainKg >= 0);

check("空明細沒有方案", suggestPlans(0, 0).length === 0);
check("超大票沒有方案", suggestPlans(2000, 1000).length === 0);

const unitParsed = parseTextItems(
  tableItems(
    ["項次", "品名", "長cm", "寬cm", "高cm", "數量", "單件毛重kg"],
    [
      ["1", "紙箱A", "120", "80", "100", "10", "25"],
      ["", "合計", "", "", "", "10", "250"],
    ]
  )
);
check("單件毛重讀成 25", unitParsed.rows.length === 1 && unitParsed.rows[0].unitKg === 25, JSON.stringify(unitParsed));
check("中文表頭有被認出來", unitParsed.warnings.every((warning) => !warning.includes("找不到完整表頭")));
check("合計列被略過", unitParsed.rows.length === 1);

const lineParsed = parseTextItems(
  tableItems(["品名", "尺寸", "數量", "總毛重kg"], [["零件盒", "60x40x40", "40", "320"]])
);
check(
  "總毛重除以數量",
  lineParsed.rows.length === 1 && lineParsed.rows[0].l === 60 && lineParsed.rows[0].unitKg === 8,
  JSON.stringify(lineParsed)
);
check("有總重換算提醒", lineParsed.warnings.some((warning) => warning.includes("單件毛重")));

const english = parseTextItems(
  tableItems(
    ["Item", "Description", "Measurement", "Qty", "G.W. (KGS)", "N.W. (KGS)"],
    [["1", "Tool box", "120x80x100", "10", "250", "200"]]
  )
);
check(
  "Measurement 與 G.W. 對到同一列",
  english.rows.length === 1 && english.rows[0].l === 120 && english.rows[0].w === 80 && english.rows[0].h === 100 && english.rows[0].qty === 10 && english.rows[0].unitKg === 25,
  JSON.stringify(english)
);
check("淨重沒有拿去當毛重", english.rows[0] && english.rows[0].unitKg === 25);

const starSize = parseTextItems(
  tableItems(["品名", "Dim", "CTNS", "Gross Weight"], [["零件", "60*40*40", "40", "320"]])
);
check("Dim 與星號尺寸", starSize.rows.length === 1 && starSize.rows[0].l === 60 && starSize.rows[0].unitKg === 8, JSON.stringify(starSize));

const sides = parseTextItems(
  tableItems(["Description", "L", "W", "H", "Cartons", "KGS"], [["Crate", "200", "100", "110", "4", "720"]])
);
check("單獨 L W H 與 KGS", sides.rows[0] && sides.rows[0].h === 110 && sides.rows[0].unitKg === 180, JSON.stringify(sides));

const combined = parseTextItems(
  tableItems(["品名", "長×寬×高", "數量", "單件毛重kg"], [["紙箱", "45x35x25", "16", "2.5"]])
);
check("長×寬×高整欄保留三邊", combined.rows[0] && combined.rows[0].l === 45 && combined.rows[0].w === 35 && combined.rows[0].h === 25, JSON.stringify(combined));

function spreadItems(separator, splitHeader) {
  const items = splitHeader
    ? [
        item("Dimensions", 240, 740),
        item("Quantity", 430, 740),
        item("Weight", 530, 740),
        item("Total Weight", 660, 740),
        item("(LxWxH)", 240, 716),
        item("(t)", 530, 716),
        item("(t)", 660, 716),
      ]
    : [
        item("Dimensions (LxWxH)", 240, 740),
        item("Quantity", 430, 740),
        item("Weight (t)", 530, 740),
        item("Total Weight (t)", 660, 740),
      ];
  const rows = [
    ["10 x 8 Worksop Container", `2981${separator}2438${separator}2675`, "1", "4.5", "4.5"],
    ["Constant Tension Winch", `2000${separator}2100${separator}2100`, "1", "4.1", "4.1"],
    ["CPT Seabed Unit", `2300${separator}2300${separator}2658`, "1", "7.1", "13.8"],
    ["6m Mast", `6800${separator}300${separator}150`, "1", "0.05", "0.05"],
    ["Total Spread Weight", "22.45", "", "", ""],
  ];
  const xs = [30, 240, 430, 530, 660];
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, index) => {
      if (cell !== "") items.push(item(cell, xs[index], 680 - rowIndex * 22));
    });
  });
  return items;
}

function spreadOk(parsed) {
  const expected = [
    ["10 x 8 Worksop Container", 298.1, 243.8, 267.5, 1, 4500],
    ["Constant Tension Winch", 200, 210, 210, 1, 4100],
    ["CPT Seabed Unit", 230, 230, 265.8, 1, 7100],
    ["6m Mast", 680, 30, 15, 1, 50],
  ];
  return (
    parsed.rows.length === 4 &&
    expected.every(([name, l, w, h, qty, unitKg]) =>
      parsed.rows.some((row) => row.name === name && row.l === l && row.w === w && row.h === h && row.qty === qty && row.unitKg === unitKg)
    )
  );
}

const spread = parseTextItems(spreadItems("*", false));
check("海上設備表讀出 4 列並換算", spreadOk(spread), JSON.stringify(spread, null, 2));
check("海上設備表略過合計", spread.rows.every((row) => !/total/i.test(row.name)));
check("海上設備表已由 mm 換算", spread.warnings.some((warning) => warning.includes("已由 mm 換算")));
check("海上設備表已由 t 換算", spread.warnings.some((warning) => warning.includes("已由 t 換算")));
check(
  "CPT 單重與總重不符時保留單重並警示",
  spread.rows.some((row) => row.name === "CPT Seabed Unit" && row.unitKg === 7100 && row.alert && row.alert.includes("7.1") && row.alert.includes("13.8")),
  JSON.stringify(spread.rows)
);
check(
  "尺寸分隔符 x X × 都拆成三邊",
  ["x", "X", "×"].every((separator) => spreadOk(parseTextItems(spreadItems(separator, false)))),
  "x X ×"
);
check("表頭拆成兩列時仍換算", spreadOk(parseTextItems(spreadItems("*", true))), JSON.stringify(parseTextItems(spreadItems("*", true))));
const weightOnly = parseTextItems(
  tableItems(["Description", "Dimensions", "Qty", "Weight"], [["Crate", "60x40x40", "4", "40"]])
);
check("只有 Weight 時仍當整列總重", weightOnly.rows[0] && weightOnly.rows[0].unitKg === 10, JSON.stringify(weightOnly));
const itemName = parseTextItems(tableItems(["Item", "Size", "Qty", "KGS"], [["Winch", "60x40x40", "2", "10"]]));
check("單獨 Item 欄當作品名", itemName.rows[0] && itemName.rows[0].name === "Winch" && itemName.rows[0].unitKg === 5, JSON.stringify(itemName));
const gluedNames = parseTextItems(
  [
    ["品名", "長cm", "寬cm", "高cm", "數量", "單件毛重kg"],
    ["CPTSeabedUnit", "230", "230", "265.8", "1", "7100"],
    ["6mMast", "680", "30", "15", "1", "50"],
    ["TensionWinch", "200", "210", "210", "1", "4100"],
    ["10x8Box", "100", "80", "60", "2", "15"],
  ].flatMap((row, rowIndex) => row.map((cell, index) => item(cell, index === 0 ? 30 : 260 + (index - 1) * 90, 700 - rowIndex * 24)))
);
check(
  "品名在大小寫與數字交界補空格",
  gluedNames.rows.length === 4 &&
    gluedNames.rows[0].name === "CPT Seabed Unit" &&
    gluedNames.rows[0].l === 230 &&
    gluedNames.rows[0].h === 265.8 &&
    gluedNames.rows[0].unitKg === 7100 &&
    gluedNames.rows[1].name === "6m Mast" &&
    gluedNames.rows[1].l === 680 &&
    gluedNames.rows[1].w === 30 &&
    gluedNames.rows[1].h === 15 &&
    gluedNames.rows[1].unitKg === 50 &&
    gluedNames.rows[2].name === "Tension Winch" &&
    gluedNames.rows[2].unitKg === 4100 &&
    gluedNames.rows[3].name === "10 x 8 Box" &&
    gluedNames.rows[3].qty === 2 &&
    gluedNames.rows[3].l === 100,
  JSON.stringify(gluedNames.rows)
);

const millimeters = parseTextItems([
  item("Description", 40, 700),
  item("Size", 160, 700),
  item("Qty", 280, 700),
  item("G.W.", 360, 700),
  { str: "零件", x: 40, y: 660, w: 24 },
  { str: "1200mm x 800mm x 1000mm", x: 160, y: 660, w: 90 },
  item("10", 280, 660),
  item("250", 360, 660),
]);
check(
  "尺寸字串裡的 mm 先換算成公分",
  millimeters.rows[0] &&
    millimeters.rows[0].l === 120 &&
    millimeters.rows[0].w === 80 &&
    millimeters.rows[0].h === 100 &&
    millimeters.rows[0].qty === 10 &&
    millimeters.rows[0].unitKg === 25,
  JSON.stringify(millimeters)
);

const pounds = parseTextItems(
  tableItems(["Description", "Size", "Qty", "G.W. (LBS)"], [["Box", "10x10x10", "2", "10"]])
);
check(
  "磅換算成公斤後再除以數量",
  pounds.rows[0] && Math.abs(pounds.rows[0].unitKg - 2.268) < 0.001,
  JSON.stringify(pounds)
);
check("有磅換算提醒", pounds.warnings.some((warning) => warning.includes("磅")));

const netOnly = parseTextItems(
  tableItems(["品名", "Size", "數量", "N.W."], [["紙箱", "60x40x40", "40", "100"]])
);
check("只有淨重時單件毛重留空", netOnly.rows[0] && netOnly.rows[0].l === 60 && netOnly.rows[0].unitKg === "", JSON.stringify(netOnly));
check("提醒毛重未在文件中找到", netOnly.warnings.some((warning) => warning.includes("未在文件中找到")));

const volumeOnly = parseTextItems(
  tableItems(["Description", "CBM", "Qty", "G.W."], [["箱子", "0.96", "10", "20"]])
);
check(
  "CBM 單值不補成長寬高",
  volumeOnly.rows[0] && volumeOnly.rows[0].l === "" && volumeOnly.rows[0].unitKg === 2,
  JSON.stringify(volumeOnly)
);
check("尺寸留空提醒", volumeOnly.warnings.some((warning) => warning.includes("尺寸未在文件中找到")));

const palletSheet = parseTextItems([
  item("Description of commodity", 40, 700),
  item("Packs", 300, 700),
  item("GROSS", 460, 700),
  item("PS SHAMPOO 1000ML", 40, 660),
  item("66", 300, 640),
  item("14.30", 460, 640),
  item("66CTNS X 12PCS/CTN = TOTAL 792PCS", 40, 620),
  item("Pallet #1 L120cm x W100cm x H179cm GROSS 957kgs", 40, 590),
  item("1", 300, 590),
  item("957.00", 460, 590),
  item("PS CONDITIONER 1000ML", 40, 540),
  item("10", 300, 520),
  item("13.30", 460, 520),
  item("10CTNS X 12PCS/CTN = TOTAL 120PCS", 40, 500),
  item("Pallet #2 L120cm x W100cm x H204cm GROSS 200kgs", 40, 470),
  item("1", 300, 470),
]);
check("棧板單讀出兩列", palletSheet.rows.length === 2, JSON.stringify(palletSheet));
check(
  "第一個棧板是 120×100×179、957 kg",
  palletSheet.rows[0] &&
    palletSheet.rows[0].l === 120 &&
    palletSheet.rows[0].w === 100 &&
    palletSheet.rows[0].h === 179 &&
    palletSheet.rows[0].qty === 1 &&
    palletSheet.rows[0].unitKg === 957 &&
    String(palletSheet.rows[0].name).includes("SHAMPOO"),
  JSON.stringify(palletSheet.rows[0])
);
check(
  "第二個棧板是 120×100×204、200 kg",
  palletSheet.rows[1] && palletSheet.rows[1].h === 204 && palletSheet.rows[1].qty === 1 && palletSheet.rows[1].unitKg === 200,
  JSON.stringify(palletSheet.rows[1])
);
check("紙箱列沒有另列成貨物", palletSheet.rows.every((row) => String(row.name).startsWith("Pallet #")));

const subheader = parseTextItems([
  item("Description", 40, 700),
  item("Qty", 220, 700),
  item("G.W.", 320, 700),
  item("Measurement", 460, 700),
  item("KGS", 320, 676),
  item("L", 430, 676),
  item("W", 510, 676),
  item("H", 590, 676),
  item("CM", 430, 652),
  item("Box", 40, 620),
  item("4", 220, 620),
  item("40", 320, 620),
  item("120", 430, 620),
  item("80", 510, 620),
  item("100", 590, 620),
]);
check(
  "雙層表頭的長寬高和毛重對到同一列",
  subheader.rows.length === 1 && subheader.rows[0].l === 120 && subheader.rows[0].w === 80 && subheader.rows[0].h === 100 && subheader.rows[0].qty === 4 && subheader.rows[0].unitKg === 10,
  JSON.stringify(subheader)
);

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const response = await fetch("sample/packing-list.pdf");
const bytes = new Uint8Array(await response.arrayBuffer());
const task = pdfjsLib.getDocument({ data: bytes });
const doc = await task.promise;
const extracted = [];
for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  for (const textItem of content.items) {
    if (!textItem.str || !textItem.str.trim()) continue;
    extracted.push({
      str: textItem.str,
      x: textItem.transform[4],
      y: textItem.transform[5],
      w: textItem.width || 0,
    });
  }
}
await task.destroy();

const parsed = parseTextItems(extracted);
const totals = summarize(parsed.rows);
check("PDF 讀出 4 列", parsed.rows.length === 4, JSON.stringify(parsed, null, 2));
check("PDF 第一列是工具組", parsed.rows[0] && String(parsed.rows[0].name).includes("工具組"));
check("PDF 總材積 22.87", Math.abs(totals.cbm - 22.87) < 0.011, String(totals.cbm));
check("PDF 總重量 1330", Math.abs(totals.kg - 1330) < 0.01, String(totals.kg));
const pdfPlans = suggestPlans(totals.cbm, totals.kg);
check("PDF 建議 1 個 20GP", pdfPlans[0] && pdfPlans[0].id === "20GPx1", pdfPlans[0] && pdfPlans[0].id);

const sampleRows = [
  { name: "工具組", l: "120", w: "80", h: "100", qty: "10", unitKg: "25" },
  { name: "零件盒", l: "60", w: "40", h: "40", qty: "40", unitKg: "8" },
  { name: "機台", l: "200", w: "100", h: "110", qty: "4", unitKg: "180" },
  { name: "配件", l: "45", w: "35", h: "25", qty: "16", unitKg: "2.5" },
];
const sampleLayout = buildLayout(suggestPlans(22.87, 1330)[0], sampleRows);
const sampleIssues = auditLayout(sampleLayout);
check("參考案例排入 70 件", sampleLayout.pieces.length === 70 && sampleLayout.unpacked.length === 0, String(sampleLayout.unpacked.length));
check("配載沒有重疊、超出或懸空", sampleIssues.length === 0, sampleIssues.slice(0, 6).join("；"));
check(
  "每件都有編號、尺寸、重量",
  sampleLayout.containers.every((bin) =>
    bin.placed.every((box) => box.item.id > 0 && box.item.l > 0 && box.item.w > 0 && box.item.h > 0 && box.item.kg >= 0)
  )
);
check(
  "每層俯視的貨不互相遮住",
  sampleLayout.containers.every((bin) =>
    bin.layers.every((layer) =>
      layer.every((box, index) =>
        layer.slice(index + 1).every((other) =>
          box.x + box.dl <= other.x + 0.05 ||
          other.x + other.dl <= box.x + 0.05 ||
          box.z + box.dw <= other.z + 0.05 ||
          other.z + other.dw <= box.z + 0.05
        )
      )
    )
  )
);

const heavyLayout = buildLayout(suggestPlans(2, 40000)[0], [
  { name: "重貨", l: "100", w: "100", h: "100", qty: "2", unitKg: "20000" },
]);
check(
  "單櫃載重不夠時拆到下一櫃",
  heavyLayout.unpacked.length === 0 && heavyLayout.containers.filter((bin) => bin.placed.length === 1).length === 2,
  heavyLayout.containers.map((bin) => bin.placed.length).join(",")
);
const overweight = buildLayout(suggestPlans(1, 30000)[0], [
  { name: "超重件", l: "80", w: "80", h: "80", qty: "1", unitKg: "30000" },
]);
check("單件超過一個櫃的載重就留在未排入", overweight.unpacked.length === 1);

const tenPallets = [957, 945, 945, 940, 941, 930, 919, 885].map((kg, index) => ({
  name: `Pallet #${index + 1}`,
  l: "120",
  w: "100",
  h: "179",
  qty: "1",
  unitKg: String(kg),
})).concat([
  { name: "Pallet #9", l: "120", w: "100", h: "204", qty: "1", unitKg: "963" },
  { name: "Pallet #10", l: "120", w: "100", h: "204", qty: "1", unitKg: "961" },
]);
const tenTotals = summarize(tenPallets);
const tenPlans = suggestPlans(tenTotals.cbm, tenTotals.kg, { rows: tenPallets });
check(
  "10 個棧板仍建議 1 個 20GP",
  tenPlans[0] && tenPlans[0].id === "20GPx1",
  tenPlans.map((plan) => plan.id).join(", ")
);
const tenLayout = buildLayout(tenPlans[0], tenPallets);
check(
  "棧板不放倒，高度維持直立並全部排入 20GP",
  tenLayout.unpacked.length === 0 &&
    tenLayout.containers.length === 1 &&
    tenLayout.containers[0].placed.length === 10 &&
    tenLayout.containers[0].placed.every((box) => box.dh === box.item.h) &&
    auditLayout(tenLayout).length === 0,
  `${tenLayout.unpacked.map((piece) => piece.id).join(",") || "全部排入"}；${tenLayout.containers[0] ? tenLayout.containers[0].placed.map((box) => box.dh).join(",") : ""}`
);
const otSpec = CONTAINERS.find((item) => item.code === "20OT");
const otTen = buildLayout({ counts: [{ ...otSpec, count: 1 }] }, tenPallets);
const piece8 = otTen.containers.flatMap((bin) => bin.placed).find((box) => box.item.id === 8);
const stackedStaysInside = otTen.containers.every((bin) =>
  bin.placed.every((box) => {
    const top = box.y + box.dh;
    if (box.y <= 0.05 && box.item.h > bin.h + 0.05 && Math.abs(box.dh - box.item.h) <= 0.011) {
      return top <= bin.h + (bin.maxOverH || 0) + 0.05;
    }
    return top <= bin.h + 0.05;
  })
);
check(
  "堆疊後不得超出內高",
  otTen.unpacked.length === 0 && stackedStaysInside && auditLayout(otTen).length === 0,
  piece8 ? `第8件離地 ${piece8.y}，頂部 ${piece8.y + piece8.dh}` : `未排入 ${otTen.unpacked.map((piece) => piece.id).join(",")}`
);
check(
  "櫃底有空位時不應堆疊",
  otTen.unpacked.length === 0 &&
    piece8 &&
    piece8.y <= 0.05 &&
    piece8.dh === 179 &&
    otTen.containers[0].placed.every((box) => box.y <= 0.05) &&
    otTen.containers[0].placed.some((box) => box.dl === 100 && box.dw === 120 && box.dh === box.item.h),
  piece8 ? `第8件離地 ${piece8.y}，${piece8.dl}×${piece8.dw}×${piece8.dh}` : "未排入"
);
const looseTen = tenPallets.map((row) => ({ ...row, name: "木箱" }));
const looseTenPlans = suggestPlans(tenTotals.cbm, tenTotals.kg, { rows: looseTen });
check(
  "同尺寸木箱可放倒，仍建議 1 個 20GP",
  looseTenPlans[0] && looseTenPlans[0].id === "20GPx1",
  looseTenPlans[0] && looseTenPlans[0].id
);

check("Pallet 預設不可放倒", canTip({ name: "Pallet #1" }) === false);
check("小寫 pallet 預設不可放倒", canTip({ name: "pallet A" }) === false);
check("棧板預設不可放倒", canTip({ name: "出口棧板" }) === false);
check("一般品名預設可放倒", canTip({ name: "木箱" }) === true);
check("可逐件改成可放倒", canTip({ name: "Pallet #1", tippable: true }) === true);
check("可逐件改成不可放倒", canTip({ name: "木箱", tippable: false }) === false);

const uprightPallet = [{ name: "出口棧板", l: "80", w: "80", h: "250", qty: "1", unitKg: "100" }];
const uprightTotals = summarize(uprightPallet);
const uprightPlans = suggestPlans(uprightTotals.cbm, uprightTotals.kg, { rows: uprightPallet });
check("高度 250 cm 的棧板建議 40HQ", uprightPlans[0] && uprightPlans[0].id === "40HQx1", uprightPlans[0] && uprightPlans[0].id);
const uprightLayout = buildLayout(uprightPlans[0], uprightPallet);
check(
  "棧板沒有放倒",
  uprightLayout.unpacked.length === 0 && uprightLayout.containers[0].placed[0].dh === 250,
  String(uprightLayout.containers[0] && uprightLayout.containers[0].placed[0] && uprightLayout.containers[0].placed[0].dh)
);
const tippedBox = [{ name: "木箱", l: "80", w: "80", h: "250", qty: "1", unitKg: "100" }];
const tippedPlans = suggestPlans(uprightTotals.cbm, uprightTotals.kg, { rows: tippedBox });
check("同尺寸木箱可放倒，建議 20GP", tippedPlans[0] && tippedPlans[0].id === "20GPx1", tippedPlans[0] && tippedPlans[0].id);
const forcedUpright = [{ name: "木箱", l: "80", w: "80", h: "250", qty: "1", unitKg: "100", tippable: false }];
const forcedPlans = suggestPlans(uprightTotals.cbm, uprightTotals.kg, { rows: forcedUpright });
check("木箱改成不可放倒後建議 40HQ", forcedPlans[0] && forcedPlans[0].id === "40HQx1", forcedPlans[0] && forcedPlans[0].id);

const tallPallet = [{ name: "Pallet 機台", l: "100", w: "100", h: "294", qty: "1", unitKg: "500" }];
const tallTotals = summarize(tallPallet);
const tallPlans = suggestPlans(tallTotals.cbm, tallTotals.kg, { rows: tallPallet });
check("超高 25 cm 的棧板建議 20OT", tallPlans[0] && tallPlans[0].id === "20OTx1", tallPlans.map((plan) => plan.id).join(", "));
check(
  "方案註明第 1 件超高 25 cm",
  tallPlans[0] && tallPlans[0].reasons && tallPlans[0].reasons.some((reason) => reason.includes("第 1 件超高 25 cm")),
  tallPlans[0] && tallPlans[0].reasons && tallPlans[0].reasons.join("；")
);
const tallLayout = buildLayout(tallPlans[0], tallPallet);
const tallBox = tallLayout.containers[0] && tallLayout.containers[0].placed[0];
check(
  "開頂頂部超出 59 cm",
  tallLayout.unpacked.length === 0 && tallBox && Math.abs(tallBox.y + tallBox.dh - tallLayout.containers[0].h - 59) < 0.2 && tallBox.dh === 294,
  tallBox ? `${tallBox.dh} / 超出 ${tallBox.y + tallBox.dh - tallLayout.containers[0].h}` : "未排入"
);
check("開頂配載沒有重疊或懸空", auditLayout(tallLayout).length === 0, auditLayout(tallLayout).slice(0, 4).join("；"));

const mixed = [
  { name: "紙箱", l: "100", w: "80", h: "60", qty: "1", unitKg: "20" },
  { name: "棧板", l: "100", w: "100", h: "294", qty: "1", unitKg: "500" },
];
const mixedTotals = summarize(mixed);
const mixedPlans = suggestPlans(mixedTotals.cbm, mixedTotals.kg, { rows: mixed });
check(
  "櫃數較少時整票開頂列為建議",
  mixedPlans[0] && mixedPlans[0].id === "20OTx1" && mixedPlans[0].recommended,
  mixedPlans.map((plan) => plan.id).join(", ")
);
check(
  "一般櫃加開頂列為備選",
  mixedPlans.some((plan, index) => index > 0 && plan.id === "20GPx1+20OTx1"),
  mixedPlans.map((plan) => plan.id).join(", ")
);

const sampleTall = [
  { name: "棧板", l: "120", w: "80", h: "294", qty: "1", unitKg: "25" },
  ...sampleRows.slice(1),
];
const sampleTallTotals = summarize(sampleTall);
const sampleTallPlans = suggestPlans(sampleTallTotals.cbm, sampleTallTotals.kg, { rows: sampleTall });
check(
  "範例改一件超高 294 cm 後建議 1 個 20OT",
  sampleTallPlans[0] && sampleTallPlans[0].id === "20OTx1" && sampleTallPlans[0].recommended,
  sampleTallPlans.map((plan) => plan.id).join(", ")
);
check(
  "範例超高的一般櫃加開頂列為備選",
  sampleTallPlans.some((plan, index) => index > 0 && plan.id === "20GPx1+20OTx1"),
  sampleTallPlans.map((plan) => plan.id).join(", ")
);
check(
  "範例超高仍註明第 1 件超高 25 cm",
  sampleTallPlans[0] && sampleTallPlans[0].reasons && sampleTallPlans[0].reasons.some((reason) => reason.includes("第 1 件超高 25 cm")),
  sampleTallPlans[0] && sampleTallPlans[0].reasons && sampleTallPlans[0].reasons.join("；")
);

const tied = [
  { name: "長貨", l: "1100", w: "200", h: "200", qty: "1", unitKg: "400" },
  { name: "棧板", l: "1100", w: "200", h: "294", qty: "1", unitKg: "500" },
];
const tiedTotals = summarize(tied);
const tiedPlans = suggestPlans(tiedTotals.cbm, tiedTotals.kg, { rows: tied });
check(
  "櫃數相同時一般貨留在一般櫃",
  tiedPlans[0] && tiedPlans[0].id === "40GPx1+40OTx1" && tiedPlans[0].recommended,
  tiedPlans.map((plan) => plan.id).join(", ")
);
check(
  "櫃數相同的整票開頂列為備選",
  tiedPlans.some((plan, index) => index > 0 && plan.containerCount === tiedPlans[0].containerCount && plan.id === "40OTx2"),
  tiedPlans.map((plan) => plan.id).join(", ")
);

const wide = [{ name: "鋼構", l: "300", w: "260", h: "250", qty: "1", unitKg: "800" }];
const wideTotals = summarize(wide);
const widePlans = suggestPlans(wideTotals.cbm, wideTotals.kg, { rows: wide });
check("超寬件建議 20FR", widePlans[0] && widePlans[0].id === "20FRx1", widePlans.map((plan) => plan.id).join(", "));
check(
  "方案註明超寬 25 cm",
  widePlans[0] && widePlans[0].reasons && widePlans[0].reasons.some((reason) => reason.includes("超寬 25 cm")),
  widePlans[0] && widePlans[0].reasons && widePlans[0].reasons.join("；")
);
const wideLayout = buildLayout(widePlans[0], wide);
const wideBox = wideLayout.containers[0] && wideLayout.containers[0].placed[0];
const wideBin = wideLayout.containers[0];
const sideHigh = wideBox ? Math.max(0, -wideBox.z) : 0;
const sideLow = wideBox ? Math.max(0, wideBox.z + wideBox.dw - wideBin.w) : 0;
check(
  "平板兩側各超出約 8.5 cm",
  wideLayout.unpacked.length === 0 && Math.abs(sideHigh - 8.5) < 0.2 && Math.abs(sideLow - 8.5) < 0.2,
  wideBox ? `上 ${sideHigh}、下 ${sideLow}` : "未排入"
);
check("平板配載沒有重疊或懸空", auditLayout(wideLayout).length === 0, auditLayout(wideLayout).slice(0, 4).join("；"));

const beam = [{ name: "鋼樑", l: "1500", w: "40", h: "40", qty: "1", unitKg: "100" }];
const beamTotals = summarize(beam);
check("超長沒有方案", suggestPlans(beamTotals.cbm, beamTotals.kg, { rows: beam }).length === 0);
check("超長原因寫明內長放不下", unplannedNote(beam).includes("超長"), unplannedNote(beam));

check("40HQ 只有一筆", CONTAINERS.filter((item) => item.code === "40HQ").length === 1);
check(
  "有 20OT、20FR、40OT、40FR",
  ["20OT", "20FR", "40OT", "40FR"].every((code) => CONTAINERS.some((item) => item.code === code))
);
const gp20 = CONTAINERS.find((item) => item.code === "20GP");
check(
  "20GP 規格不變",
  gp20.cbm === 33.2 && gp20.payloadKg === 28200 && gp20.innerL === 589 && gp20.innerW === 235 && gp20.innerH === 239
);

const floorCm2 = 10 * 120 * 80 + 40 * 60 * 40 + 4 * 200 * 100 + 16 * 45 * 35;
const flatPlans = suggestPlans(22.87, 1330, { stackable: false, floorCm2 });
check("不可堆疊不建議單個 20GP", flatPlans[0] && flatPlans[0].id !== "20GPx1", flatPlans[0] && flatPlans[0].id);
check("不可堆疊建議兩個櫃", flatPlans[0] && flatPlans[0].containerCount === 2, flatPlans[0] && flatPlans[0].id);
const flatLayout = buildLayout(flatPlans[0], sampleRows, { stackable: false });
const flatIssues = auditLayout(flatLayout);
check(
  "不可堆疊的貨全部貼在櫃底",
  flatLayout.unpacked.length === 0 && flatIssues.length === 0,
  flatIssues.slice(0, 4).join("；") || String(flatLayout.unpacked.length)
);

function sceneIssues(layout) {
  return auditScene(layout).slice(0, 6).join("；");
}

check("3D 參考案例與 packer 一致且不重疊", auditScene(sampleLayout).length === 0, sceneIssues(sampleLayout));
check("3D 不可堆疊與 packer 一致且不重疊", auditScene(flatLayout).length === 0, sceneIssues(flatLayout));
check("3D 開頂超高與 packer 一致", auditScene(tallLayout).length === 0, sceneIssues(tallLayout));
check("3D 平板超寬與 packer 一致", auditScene(wideLayout).length === 0, sceneIssues(wideLayout));
check("3D 一般櫃有頂板", shellFaces("general").includes("roof"));
check("3D 開頂不畫頂板", !shellFaces("ot").includes("roof") && shellFaces("ot").includes("floor") && shellFaces("ot").includes("side-high"));
check("3D 平板只有底板和兩端牆", shellFaces("fr").join(",") === "floor,end-closed,end-door");

const shellIssues = [];
for (const spec of CONTAINERS) {
  const issues = auditScene({
    containers: [{
      index: 1,
      code: spec.code,
      name: spec.name,
      l: spec.innerL,
      w: spec.innerW,
      h: spec.innerH,
      kind: spec.kind,
      maxOverH: spec.overHeightCm,
      maxOverW: spec.overWidthCm,
      placed: [],
    }],
  });
  if (issues.length) shellIssues.push(`${spec.code} ${issues.join(",")}`);
}
check("七種櫃的 3D 外殼符合櫃種與內徑", shellIssues.length === 0, shellIssues.join("；"));

const gp = CONTAINERS.find((item) => item.code === "20GP");
const turnLayout = buildLayout({ counts: [{ ...gp, count: 1 }] }, [
  { name: "橫放木箱", l: "200", w: "300", h: "80", qty: "1", unitKg: "40" },
]);
const turnBox = turnLayout.containers[0] && turnLayout.containers[0].placed[0];
check(
  "水平旋轉後 3D 用擺放尺寸並標轉",
  Boolean(turnBox) && turnBox.turned && turnBox.dl === 300 && turnBox.dw === 200 && turnBox.dh === 80 && cargoMarks(turnBox).join("") === "轉",
  turnBox ? `${turnBox.dl}×${turnBox.dw}×${turnBox.dh} turned=${turnBox.turned}` : "未排入"
);
const turnInfo = turnBox ? cargoInfo(turnBox, turnLayout.containers[0]) : null;
check(
  "3D 提示用旋轉後尺寸並寫已轉向",
  Boolean(turnInfo) && turnInfo.size.startsWith("300×200×80") && turnInfo.flags.includes("已轉向") && !turnInfo.flags.includes("堆疊"),
  turnInfo ? `${turnInfo.size} ${turnInfo.flags}` : "未排入"
);
if (turnBox) {
  const turnMeshes = buildCargoMeshes(turnBox, turnLayout.containers[0], "#0f5c54");
  const turnAabb = unionAabb(turnMeshes);
  disposeMeshes(turnMeshes);
  check(
    "3D 方塊還原後等於 packer 的水平旋轉",
    Math.abs(turnAabb.dl - 300) <= 0.02 && Math.abs(turnAabb.dw - 200) <= 0.02 && Math.abs(turnAabb.dh - 80) <= 0.02,
    `${turnAabb.dl}×${turnAabb.dw}×${turnAabb.dh}`
  );
} else {
  check("3D 方塊還原後等於 packer 的水平旋轉", false, "未排入");
}
check("水平旋轉配載沒有重疊或非法超出", auditScene(turnLayout).length === 0, sceneIssues(turnLayout));

const tipLayout = buildLayout({ counts: [{ ...gp, count: 1 }] }, [
  { name: "高木箱", l: "80", w: "80", h: "250", qty: "1", unitKg: "30" },
]);
const tipBox = tipLayout.containers[0] && tipLayout.containers[0].placed[0];
check(
  "換面當高度也標轉",
  Boolean(tipBox) && tipBox.turned && tipBox.dh !== tipBox.item.h && cargoMarks(tipBox).includes("轉"),
  tipBox ? `dh ${tipBox.dh}` : "未排入"
);
check("換面當高度的 3D 與 packer 一致", auditScene(tipLayout).length === 0, sceneIssues(tipLayout));

const stackLayout = buildLayout({ counts: [{ ...gp, count: 1 }] }, [
  { name: "扁箱", l: "500", w: "200", h: "50", qty: "2", unitKg: "20" },
]);
const stackBin = stackLayout.containers[0];
const lower = stackBin && stackBin.placed.find((box) => box.y <= 0.05);
const upper = stackBin && stackBin.placed.find((box) => box.y > 0.05);
check(
  "堆疊件疊在下層頂面並標疊",
  Boolean(upper && lower) && Math.abs(upper.y - (lower.y + lower.dh)) < 0.2 && cargoMarks(upper).includes("疊") && !cargoMarks(lower).includes("疊"),
  upper && lower ? `下 ${lower.y}+${lower.dh} 上 ${upper.y}` : `排入 ${stackBin ? stackBin.placed.length : 0}`
);
const stackInfo = upper ? cargoInfo(upper, stackBin) : null;
check(
  "3D 堆疊提示含離地高度",
  Boolean(stackInfo) && stackInfo.flags.includes("堆疊") && stackInfo.place.includes("離地"),
  stackInfo ? stackInfo.place : "未堆疊"
);
check("堆疊配載沒有重疊或超過內高", auditScene(stackLayout).length === 0, sceneIssues(stackLayout));

const tallInfo = tallBox ? cargoInfo(tallBox, tallLayout.containers[0]) : null;
check("3D 超高提示標出超出", Boolean(tallInfo) && tallInfo.flags.includes("頂部超出"), tallInfo ? tallInfo.flags : "未排入");

const sampleBin = sampleLayout.containers[0];
const sampleCaption = sceneCaption(sampleBin, sampleBin.placed);
const sampleKg = (1330).toLocaleString("zh-Hant", { maximumFractionDigits: 2 });
check(
  "3D 標題含櫃號、櫃型、件數、總重、體積使用率",
  sampleCaption.title.includes("第 1 櫃") &&
    sampleCaption.title.includes("20呎櫃") &&
    sampleCaption.title.includes("20GP") &&
    sampleCaption.detail.includes("70 件") &&
    sampleCaption.detail.includes(sampleKg) &&
    sampleCaption.detail.includes("總重") &&
    sampleCaption.detail.includes(formatRate(volumeRate(sampleBin, sampleBin.placed))),
  `${sampleCaption.title} / ${sampleCaption.detail}`
);
check(
  "20GP 體積使用率約 68.9%",
  Math.abs(volumeRate(sampleBin, sampleBin.placed) - 22.87 / 33.2) < 0.002,
  String(volumeRate(sampleBin, sampleBin.placed))
);
const wideRateBin = wideLayout.containers[0];
const wideInner = (594 * 243 * 223) / 1_000_000;
const wideUsed = wideRateBin.placed.reduce((sum, box) => sum + (box.dl * box.dw * box.dh) / 1_000_000, 0);
check(
  "平板用內徑體積計算使用率",
  wideRateBin.placed.length === 1 && Math.abs(volumeRate(wideRateBin, wideRateBin.placed) - wideUsed / wideInner) < 0.002,
  String(volumeRate(wideRateBin, wideRateBin.placed))
);

const pngSource = document.createElement("canvas");
pngSource.width = 200;
pngSource.height = 100;
pngSource.getContext("2d").fillStyle = "#ff0000";
pngSource.getContext("2d").fillRect(0, 0, 200, 100);
const pngOut = composePngCanvas(pngSource, sampleCaption);
const pngBand = titleBandHeight(pngSource.width);
const pngTop = pngOut.getContext("2d").getImageData(10, 10, 1, 1).data;
const pngBody = pngOut.getContext("2d").getImageData(10, pngOut.height - 2, 1, 1).data;
check(
  "PNG 上方是標題、下方是 3D 畫面",
  pngOut.width === 200 &&
    pngOut.height === 100 + pngBand &&
    pngTop[0] > 230 && pngTop[1] > 220 && pngTop[2] > 210 &&
    pngBody[0] > 200 && pngBody[1] < 40 && pngBody[2] < 40,
  `${pngOut.width}×${pngOut.height} top ${pngTop[0]},${pngTop[1]},${pngTop[2]} body ${pngBody[0]},${pngBody[1]},${pngBody[2]}`
);
check("播放速度有 1、5、20 倍", PLAY_SPEEDS.join(",") === "1,5,20");
check("20 倍間隔是 1 倍的二十分之一", playIntervalMs(20) * 20 === playIntervalMs(1) && playIntervalMs(5) * 5 === playIntervalMs(1));
check(
  "逐件播放依裝櫃順序",
  visibleBoxes(sampleBin, 3).map((box) => box.item.id).join(",") === sampleBin.placed.slice(0, 3).map((box) => box.item.id).join(",") &&
    visibleBoxes(sampleBin, 1)[0] === sampleBin.placed[0]
);

const parked = centerOfGravity({
  l: 589,
  w: 235,
  placed: [{ x: 0, y: 0, z: 0, dl: 100, dw: 100, dh: 100, item: { kg: 1000 } }],
});
check(
  "偏封閉端超過 5% 會警示",
  parked && parked.longWarn && parked.longRatio < -0.05 && cogText(parked).includes("超出"),
  parked ? cogText(parked) : "無重心"
);
const unevenText = sideOverhangText(
  { x: 10, y: 0, z: -5, dl: 100, dw: 260, dh: 40 },
  { l: 594, w: 243, h: 223 }
);
check(
  "左右超出不相等時分開寫",
  unevenText.some((line) => line.startsWith("左側超出")) && unevenText.some((line) => line.startsWith("右側超出")),
  unevenText.join("、")
);

const fr40 = CONTAINERS.find((item) => item.code === "40FR");
const frRows = [
  { name: "鋼樑甲", l: "280", w: "80", h: "40", qty: "1", unitKg: "8000" },
  { name: "鋼樑乙", l: "280", w: "80", h: "40", qty: "1", unitKg: "7000" },
  { name: "鋼樑丙", l: "280", w: "80", h: "40", qty: "1", unitKg: "4450" },
  { name: "鋼樑丁", l: "280", w: "80", h: "40", qty: "1", unitKg: "3000" },
];
const frPlan = { counts: [{ ...fr40, count: 1 }] };
const frLayout = buildLayout(frPlan, frRows);
const frBin = frLayout.containers[0];
const frPlaced = [...(frBin ? frBin.placed : [])].sort((left, right) => left.x - right.x);
const frHeavy = frBin && frBin.placed.find((box) => box.item.kg === 8000);
const frLight = frBin && frBin.placed.find((box) => box.item.kg === 3000);
const frGapOk = frPlaced.length === 4 && frPlaced.every((box, index) => {
  if (index === 0) return box.x >= 9.5;
  return box.x >= frPlaced[index - 1].x + frPlaced[index - 1].dl + 9.5;
}) && frBin.l - Math.max(...frPlaced.map((box) => box.x + box.dl)) >= 9.5;
check(
  "40FR 四件共 22450 kg 且重心在容許內",
  frLayout.unpacked.length === 0 &&
    frBin &&
    Math.abs(frBin.kg - 22450) < 0.2 &&
    frBin.cog &&
    !frBin.cog.longWarn &&
    !frBin.cog.latWarn &&
    Math.abs(frBin.cog.longRatio) <= 0.05 &&
    Math.abs(frBin.cog.latRatio) <= 0.02,
  frBin && frBin.cog ? cogText(frBin.cog) : "未排入"
);
check(
  "40FR 四件留有綁紮間距且重貨較靠近中央",
  Boolean(frGapOk && frHeavy && frLight) &&
    Math.abs(frHeavy.x + frHeavy.dl / 2 - frBin.l / 2) < Math.abs(frLight.x + frLight.dl / 2 - frBin.l / 2),
  frPlaced.map((box) => `${box.item.kg}@${box.x}`).join("，")
);
check("40FR 四件沒有重疊或懸空", auditLayout(frLayout).length === 0, auditLayout(frLayout).slice(0, 4).join("；"));

const barRows = [{ name: "橘色長條", l: "900", w: "280", h: "30", qty: "1", unitKg: "5000" }];
const barLayout = buildLayout(frPlan, barRows);
const barBin = barLayout.containers[0];
const barBox = barBin && barBin.placed[0];
const barLeft = barBox ? Math.max(0, -barBox.z) : 0;
const barRight = barBox ? Math.max(0, barBox.z + barBox.dw - barBin.w) : 0;
const barText = barBox ? sideOverhangText(barBox, barBin).join("、") : "";
check(
  "超寬長條左右超出相同並寫成左右各超出",
  barLayout.unpacked.length === 0 && Math.abs(barLeft - barRight) <= 0.5 && barLeft > 1 && barText.includes("左右各超出"),
  barBox ? `左 ${barLeft}、右 ${barRight}、${barText}` : "未排入"
);

const gpHeavyRows = [
  { name: "重機", l: "200", w: "100", h: "80", qty: "1", unitKg: "4000" },
  { name: "紙箱", l: "80", w: "80", h: "80", qty: "4", unitKg: "100" },
];
const gpHeavyLayout = buildLayout({ counts: [{ ...gp, count: 1 }] }, gpHeavyRows);
const gpHeavyBin = gpHeavyLayout.containers[0];
const gpHeavy = gpHeavyBin && gpHeavyBin.placed.find((box) => box.item.kg === 4000);
const gpLight = gpHeavyBin && gpHeavyBin.placed.find((box) => box.item.kg === 100);
check(
  "一般櫃重貨在底層且更靠近中央，重心有計算",
  gpHeavyLayout.unpacked.length === 0 &&
    gpHeavy &&
    gpLight &&
    gpHeavy.y <= 0.05 &&
    gpHeavyBin.cog &&
    !gpHeavyBin.cog.longWarn &&
    Math.abs(gpHeavy.x + gpHeavy.dl / 2 - gpHeavyBin.l / 2) <= Math.abs(gpLight.x + gpLight.dl / 2 - gpHeavyBin.l / 2) + 0.2,
  gpHeavyBin && gpHeavyBin.cog ? cogText(gpHeavyBin.cog) : "未排入"
);

const pileRows = [
  { name: "重箱", l: "400", w: "200", h: "40", qty: "1", unitKg: "3000" },
  { name: "輕箱", l: "400", w: "200", h: "40", qty: "1", unitKg: "200" },
];
const pileLayout = buildLayout({ counts: [{ ...gp, count: 1 }] }, pileRows);
const pileBin = pileLayout.containers[0];
const pileHeavy = pileBin && pileBin.placed.find((box) => box.item.kg === 3000);
const pileLight = pileBin && pileBin.placed.find((box) => box.item.kg === 200);
check(
  "一般櫃疊放時重貨在下，並顯示重心",
  pileLayout.unpacked.length === 0 &&
    pileHeavy &&
    pileLight &&
    pileHeavy.y <= 0.05 &&
    pileLight.y > 0.05 &&
    pileBin.cog &&
    cogText(pileBin.cog).includes("縱向") &&
    sceneCaption(pileBin, pileBin.placed).balance.includes("縱向"),
  pileBin && pileBin.cog ? `${cogText(pileBin.cog)} 輕貨離地 ${pileLight ? pileLight.y : ""}` : "未排入"
);

const wideText = wideBox ? sideOverhangText(wideBox, wideBin).join("、") : "";
check("既有超寬件的 2D 文字是左右各超出", wideText.includes("左右各超出"), wideText);

const sideBreach = {
  stackable: true,
  pieces: [{ id: 1, kg: 10 }],
  unpacked: [],
  containers: [{
    index: 1,
    l: 1206,
    w: 243,
    h: 196,
    maxOverW: 150,
    maxOverH: 200,
    payloadKg: 40000,
    kg: 10,
    placed: [{ item: { id: 1, kg: 10, name: "桅杆" }, x: 0, y: 0, z: 243.4, dl: 680, dw: 30, dh: 15 }],
  }],
};
check(
  "非超寬件超出內寬會被稽核擋下",
  auditLayout(sideBreach).some((issue) => issue.startsWith("side")),
  auditLayout(sideBreach).join("；")
);

const seaRows = [
  { name: "10 x 8 Worksop Container", l: "298.1", w: "243.8", h: "267.5", qty: "1", unitKg: "4500" },
  { name: "Constant Tension Winch", l: "200", w: "210", h: "210", qty: "1", unitKg: "4100" },
  { name: "CPT Seabed Unit", l: "230", w: "230", h: "265.8", qty: "1", unitKg: "7100" },
  { name: "6m Mast", l: "680", w: "30", h: "15", qty: "1", unitKg: "50" },
];
const seaTotals = summarize(seaRows);
const seaPlans = suggestPlans(seaTotals.cbm, seaTotals.kg, { rows: seaRows });
check(
  "海上設備方案把全部件貨排入",
  seaPlans.length > 0 && seaPlans.every((plan) => buildLayout(plan, seaRows).unpacked.length === 0),
  seaPlans.map((plan) => plan.id).join(", ")
);
check(
  "海上設備建議 1 個 40FR",
  Boolean(seaPlans[0] && seaPlans[0].id === "40FRx1" && seaPlans[0].recommended),
  seaPlans.map((plan) => plan.id).join(", ")
);
check(
  "40GP 加 20FR 列為備選",
  seaPlans.some((plan, index) => index > 0 && plan.id === "40GPx1+20FRx1"),
  seaPlans.map((plan) => plan.id).join(", ")
);
const seaAlt = seaPlans.find((plan) => plan.id === "40GPx1+20FRx1");
const seaSuggested = seaAlt ? buildLayout(seaAlt, seaRows) : { containers: [] };
const seaWinchBin = seaSuggested.containers.find((bin) => bin.placed.some((box) => /winch/i.test(box.item.name)));
const seaWinch = seaWinchBin && seaWinchBin.placed.find((box) => /winch/i.test(box.item.name));
const seaWinchMid = seaWinch ? Math.abs(seaWinch.x + seaWinch.dl / 2 - seaWinchBin.l / 2) / seaWinchBin.l : 1;
check(
  "40GP 絞車靠櫃中段且重心回到容許內",
  Boolean(seaWinchBin && seaWinchBin.kind === "general" && seaWinchBin.cog && !seaWinchBin.cog.longWarn && !seaWinchBin.cog.latWarn && seaWinchMid <= 0.08),
  seaWinchBin && seaWinchBin.cog ? `${seaWinchBin.code} ${cogText(seaWinchBin.cog)} 絞車距中 ${seaWinch ? (seaWinch.x + seaWinch.dl / 2).toFixed(0) : ""}` : "未排入"
);
const fr20 = CONTAINERS.find((item) => item.code === "20FR");
const shortSea = buildLayout({ counts: [{ ...gp, count: 1 }, { ...fr20, count: 1 }] }, seaRows);
check(
  "20GP 加 20FR 放不進 680 cm 桅杆",
  shortSea.unpacked.some((piece) => /mast/i.test(piece.name)),
  shortSea.unpacked.map((piece) => piece.name).join("、") || "全部排入"
);
const seaFr = buildLayout({ counts: [{ ...fr40, count: 1 }] }, seaRows);
const seaBin = seaFr.containers[0];
const seaMast = seaBin && seaBin.placed.find((box) => /mast/i.test(box.item.name));
const seaWide = seaBin && seaBin.placed.find((box) => /worksop/i.test(box.item.name));
const seaInside = seaBin && seaBin.placed.every((box) => box.dw > seaBin.w + 0.05 || (box.z >= -0.05 && box.z + box.dw <= seaBin.w + 0.05));
check(
  "40FR 非超寬件留在內寬",
  Boolean(seaInside) && (!seaMast || (seaMast.z >= -0.05 && seaMast.z + seaMast.dw <= seaBin.w + 0.05)) && auditLayout(seaFr).every((issue) => !issue.startsWith("side")),
  seaBin ? seaBin.placed.map((box) => `${box.item.name} z ${box.z} dw ${box.dw}`).join("；") : "無櫃"
);
const seaLeft = seaWide ? Math.max(0, -seaWide.z) : 0;
const seaRight = seaWide ? Math.max(0, seaWide.z + seaWide.dw - seaBin.w) : 0;
check(
  "Worksop 在 40FR 仍左右各超出約 0.4 cm",
  Boolean(seaWide) && Math.abs(seaLeft - 0.4) < 0.15 && Math.abs(seaRight - 0.4) < 0.15,
  seaWide ? `左 ${seaLeft}、右 ${seaRight}` : "未排入"
);
const seaHang = seaMast ? endHangText(seaMast) : "";
const seaInfo = seaMast && seaBin ? cargoInfo(seaMast, seaBin) : { flags: "" };
const seaTop = seaMast ? seaMast.y + seaMast.dh : 0;
check(
  "桅杆上疊在超高件頂面",
  seaFr.unpacked.length === 0 &&
    Boolean(seaMast && seaMast.topStacked && seaMast.y > seaBin.h && seaMast.dh <= 30) &&
    seaInfo.flags.includes("上疊，需綁紮") &&
    cargoMarks(seaMast).includes("上"),
  seaMast ? `離地 ${seaMast.y}、高 ${seaMast.dh}、${seaInfo.flags}` : "未排入"
);
check(
  "桅杆兩端懸空超過 50 cm",
  Boolean(seaMast && seaMast.endHangA > 50 && seaMast.endHangB > 50 && seaHang.includes("兩端懸空約") && seaHang.includes("需綁紮固定")),
  seaHang || "沒有懸空註記"
);
check(
  "40FR 含上疊總高並提示路線限高",
  Boolean(stackedHeightText(seaBin).includes("含上疊總高") && Math.abs(seaTop - 282.5) < 1) &&
    seaFr.notes.some((note) => note.includes("拖車") && note.includes("路線限高")) &&
    cargoParts(seaMast, seaBin).length > 0 &&
    cargoParts(seaMast, seaBin).every((part) => part.role === "body"),
  `${stackedHeightText(seaBin)}；${seaFr.notes.join(" / ")}`
);
check("40FR 上疊後沒有重疊或懸空", auditLayout(seaFr).length === 0, auditLayout(seaFr).slice(0, 4).join("；"));
check("40FR 上疊的 3D 與配載一致", auditScene(seaFr).length === 0, auditScene(seaFr).slice(0, 4).join("；"));
const tightRows = [
  { name: "長件甲", l: "589", w: "250", h: "220", qty: "1", unitKg: "1000", tippable: false },
  { name: "長件乙", l: "589.1", w: "250", h: "220", qty: "1", unitKg: "900", tippable: false },
];
const tightTotals = summarize(tightRows);
const tightPlans = suggestPlans(tightTotals.cbm, tightTotals.kg, { rows: tightRows });
const tightLayout = buildLayout({ counts: [{ ...fr40, count: 1 }] }, tightRows);
const tightPlaced = [...((tightLayout.containers[0] && tightLayout.containers[0].placed) || [])].sort((left, right) => left.x - right.x);
const tightGap = tightPlaced.length === 2 ? tightPlaced[1].x - (tightPlaced[0].x + tightPlaced[0].dl) : 99;
check(
  "差 2.1 cm 仍建議 1 個 40FR",
  Boolean(tightPlans[0] && tightPlans[0].id === "40FRx1" && tightPlans[0].containerCount === 1 && tightLayout.unpacked.length === 0),
  tightPlans.map((plan) => plan.id).join(", ") || "沒有方案"
);
check(
  "間距不足時降到 0",
  tightLayout.notes.some((note) => note.includes("間距不足")) &&
    tightLayout.containers[0] &&
    tightLayout.containers[0].lashingShort &&
    Math.abs(tightGap) < 0.6,
  `間距 ${tightGap}；${tightLayout.notes.join(" / ")}`
);

const spanRows = [
  { name: "左座", l: "250", w: "235", h: "40", qty: "1", unitKg: "800", tippable: false },
  { name: "右座", l: "250", w: "235", h: "40", qty: "1", unitKg: "800", tippable: false },
  { name: "橫樑", l: "400", w: "40", h: "20", qty: "1", unitKg: "40", tippable: false },
];
const spanLayout = buildLayout({ counts: [{ ...gp, count: 1 }] }, spanRows);
const spanBin = spanLayout.containers[0];
const spanBeam = spanBin && spanBin.placed.find((box) => box.item.name === "橫樑");
check(
  "輕貨跨放在兩件頂面",
  spanLayout.unpacked.length === 0 &&
    Boolean(spanBeam && spanBeam.spanned && spanBeam.y > 0.05) &&
    cargoMarks(spanBeam).includes("跨") &&
    cargoInfo(spanBeam, spanBin).flags.includes("跨放，需綁紮"),
  spanBeam ? `離地 ${spanBeam.y}、${cargoInfo(spanBeam, spanBin).flags}` : `未排入 ${spanLayout.unpacked.length}`
);
const tallSpanRows = [
  { name: "左座", l: "250", w: "235", h: "230", qty: "1", unitKg: "800", tippable: false },
  { name: "右座", l: "250", w: "235", h: "230", qty: "1", unitKg: "800", tippable: false },
  { name: "橫樑", l: "400", w: "40", h: "20", qty: "1", unitKg: "40", tippable: false },
];
const tallSpan = buildLayout({ counts: [{ ...gp, count: 1 }] }, tallSpanRows);
const tallBeam = tallSpan.containers[0] && tallSpan.containers[0].placed.find((box) => box.item.name === "橫樑");
const tallSpanTotals = summarize(tallSpanRows);
const tallSpanPlans = suggestPlans(tallSpanTotals.cbm, tallSpanTotals.kg, { rows: tallSpanRows });
check(
  "跨放會超過內高時不跨放，並改建議裝得下的櫃子",
  (!tallBeam || !tallBeam.spanned) &&
    tallSpanPlans.length > 0 &&
    tallSpanPlans[0].id !== "20GPx1" &&
    tallSpanPlans.every((plan) => buildLayout(plan, tallSpanRows).unpacked.length === 0),
  `${tallBeam ? `樑離地 ${tallBeam.y}` : "樑未放上 20GP"}；${tallSpanPlans.map((plan) => plan.id).join(", ")}`
);

check(
  "既有 PDF 範例列沒有信心值",
  parsed.rows.length === 4 && parsed.rows.every((row) => !Object.prototype.hasOwnProperty.call(row, "confidence"))
);

function sameCargo(row, l, w, h, qty, unitKg) {
  return row && row.l === l && row.w === w && row.h === h && row.qty === qty && row.unitKg === unitKg;
}

async function fetchBuffer(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(path);
  return response.arrayBuffer();
}

try {

const excelParsed = parseTextItems(excelToItems(await fetchBuffer("sample/packing-list.xlsx")));
const excelTotals = summarize(excelParsed.rows);
check("Excel 範例讀出 4 列", excelParsed.rows.length === 4, JSON.stringify(excelParsed.rows));
check("Excel 範例第一列是工具組", excelParsed.rows[0] && String(excelParsed.rows[0].name).includes("工具組"));
check("Excel 範例總材積 22.87", Math.abs(excelTotals.cbm - 22.87) < 0.011, String(excelTotals.cbm));
check("Excel 範例總重量 1330", Math.abs(excelTotals.kg - 1330) < 0.01, String(excelTotals.kg));

const csvParsed = parseTextItems(excelToItems(await fetchBuffer("sample/packing-list.csv")));
check(
  "CSV 範例與 Excel 第一列相同",
  csvParsed.rows.length === 4 && sameCargo(csvParsed.rows[0], 120, 80, 100, 10, 25),
  JSON.stringify(csvParsed.rows[0])
);

const xlsParsed = parseTextItems(excelToItems(await fetchBuffer("sample/packing-list.xls")));
check(
  "xls 範例讀出 4 列且第一列是工具組",
  xlsParsed.rows.length === 4 && xlsParsed.rows[0] && String(xlsParsed.rows[0].name).includes("工具組") && sameCargo(xlsParsed.rows[0], 120, 80, 100, 10, 25),
  JSON.stringify(xlsParsed.rows)
);

const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  book,
  XLSX.utils.aoa_to_sheet([
    ["品名", "長cm", "寬cm", "高cm", "數量", "單件毛重kg"],
    ["甲箱", 10, 10, 10, 1, 1],
  ]),
  "一"
);
XLSX.utils.book_append_sheet(
  book,
  XLSX.utils.aoa_to_sheet([
    ["品名", "長cm", "寬cm", "高cm", "數量", "單件毛重kg"],
    ["乙箱", 20, 20, 20, 2, 2],
  ]),
  "二"
);
const multiParsed = parseTextItems(excelToItems(XLSX.write(book, { type: "array", bookType: "xlsx" })));
check(
  "Excel 兩個工作表都讀入",
  multiParsed.rows.length === 2 && multiParsed.rows.some((row) => String(row.name).includes("甲")) && multiParsed.rows.some((row) => String(row.name).includes("乙")),
  JSON.stringify(multiParsed.rows)
);

const wordParsed = parseTextItems(await wordToItems(await fetchBuffer("sample/packing-list.docx")));
const wordTotals = summarize(wordParsed.rows);
check("Word 表格讀出 4 列", wordParsed.rows.length === 4 && String(wordParsed.rows[0].name).includes("工具組"), JSON.stringify(wordParsed.rows));
check("Word 表格總重量 1330", Math.abs(wordTotals.kg - 1330) < 0.01, String(wordTotals.kg));

const looseParsed = parseTextItems(await wordToItems(await fetchBuffer("sample/packing-loose.docx")));
check("Word 純文字走逐行讀法", looseParsed.rows.length === 1 && sameCargo(looseParsed.rows[0], 60, 40, 40, 4, 12), JSON.stringify(looseParsed));

const legacyDoc = classifyUpload("舊檔.doc");
check(".doc 提示另存為 .docx", Boolean(legacyDoc.error && legacyDoc.error.includes("舊檔.doc") && legacyDoc.error.includes("另存為 .docx")), legacyDoc.error || "");
const rejected = classifyUpload("備註.txt");
check(
  "不支援的格式會列出可接受的種類",
  Boolean(rejected.error && rejected.error.includes("不支援 備註.txt") && rejected.error.includes(".docx") && rejected.error.includes(".xlsx") && rejected.error.includes(".csv")),
  rejected.error || ""
);
check(
  "檔案標籤依副檔名",
  fileBadge("1793936304654.jpg") === "jpg" &&
    fileBadge("a.JPEG") === "jpg" &&
    fileBadge("a.png") === "png" &&
    fileBadge("a.PDF") === "pdf" &&
    fileBadge("a.docx") === "word" &&
    fileBadge("a.xlsx") === "excel",
  [fileBadge("1793936304654.jpg"), fileBadge("a.docx")].join(",")
);
check(
  "jpg、png、docx、xlsx、xls、csv、pdf 都接受",
  ["a.jpg", "a.jpeg", "a.PNG", "a.docx", "a.xlsx", "a.xls", "a.csv", "a.PDF"].every((name) => !classifyUpload(name).error)
);

const lowItems = tableItems(
  ["品名", "長cm", "寬cm", "高cm", "數量", "單件毛重kg"],
  [["木箱", "60", "40", "30", "2", "9"]]
).map((entry) => ({ ...entry, confidence: entry.str === "9" ? 42 : 96 }));
const lowParsed = parseTextItems(lowItems);
check(
  "信心低的單件毛重被標出",
  lowParsed.rows.length === 1 &&
    lowParsed.rows[0].unitKg === 9 &&
    lowParsed.rows[0].confidence &&
    lowParsed.rows[0].confidence.unitKg === 42 &&
    lowParsed.rows[0].confidence.l >= 70,
  JSON.stringify(lowParsed)
);
check("OCR 提示文字", OCR_NOTICE === "OCR 辨識，請核對");

const photo = document.createElement("canvas");
photo.width = 60;
photo.height = 30;
const photoCtx = photo.getContext("2d");
photoCtx.fillStyle = "#ffffff";
photoCtx.fillRect(0, 0, 60, 30);
photoCtx.fillStyle = "#000000";
photoCtx.fillRect(0, 0, 12, 30);
const photoBlob = await new Promise((resolve) => photo.toBlob(resolve, "image/jpeg", 0.95));
const photoRaw = new Uint8Array(await photoBlob.arrayBuffer());
const oriented = new Uint8Array(photoRaw.length + 36);
oriented.set(photoRaw.subarray(0, 2), 0);
const exif = new DataView(oriented.buffer, 2, 36);
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
exif.setUint16(28, 6, true);
oriented.set(photoRaw.subarray(2), 38);
check("讀得到 JPEG 方向 6", readJpegOrientation(oriented.buffer) === 6);
const upright = await uprightImage(new Blob([oriented], { type: "image/jpeg" }));
const uprightTop = upright.getContext("2d").getImageData(Math.floor(upright.width / 2), 2, 1, 1).data[0];
const uprightLower = upright.getContext("2d").getImageData(Math.floor(upright.width / 2), Math.max(0, upright.height - 8), 1, 1).data[0];
check("EXIF 方向 6 轉正後寬高對調", upright.width === 30 && upright.height === 60, `${upright.width}x${upright.height}`);
check("EXIF 方向 6 把左側內容轉到上方", uprightTop < 40 && uprightLower > 200, `上 ${uprightTop} 下 ${uprightLower}`);

const imageStatuses = [];
const imageBlob = await (await fetch("sample/packing-list.png")).blob();
const imageConverted = await convertToItems(new File([imageBlob], "packing-list.png", { type: "image/png" }), (text) => {
  imageStatuses.push(text);
});
const imageParsed = parseTextItems(imageConverted.items);
check("圖片轉換會先載入辨識模組", imageStatuses.includes(FIRST_OCR_LOAD) && imageStatuses.includes(OCR_WORKING), imageStatuses.join(" / "));
check("圖片結果標成 OCR", imageConverted.source === "image");
check(
  "PNG 讀出工具組尺寸",
  imageParsed.rows.some((row) => sameCargo(row, 120, 80, 100, 10, 25)),
  JSON.stringify(imageParsed.rows)
);
check(
  "PNG 讀出其餘三列",
  [[60, 40, 40, 40, 8], [200, 100, 110, 4, 180], [45, 35, 25, 16, 2.5]].every(([l, w, h, qty, unitKg]) =>
    imageParsed.rows.some((row) => sameCargo(row, l, w, h, qty, unitKg))
  ),
  JSON.stringify(imageParsed.rows)
);

const spreadBlob = await (await fetch("sample/1793936304654.jpg")).blob();
const photoConverted = await convertToItems(new File([spreadBlob], "1793936304654.jpg", { type: "image/jpeg" }));
const photoParsed = parseTextItems(photoConverted.items);
const photoExpect = [
  ["10 x 8", "worksop", 298.1, 243.8, 267.5, 4500],
  ["tension winch", "winch", 200, 210, 210, 4100],
  ["cpt seabed unit", "seabed", 230, 230, 265.8, 7100],
  ["6m mast", "mast", 680, 30, 15, 50],
];
check(
  "海上設備照片讀出四列貨物",
  photoParsed.rows.length === 4 &&
    photoExpect.every(([spaced, hint, l, w, h, unitKg]) =>
      photoParsed.rows.some((row) => {
        const name = String(row.name).toLowerCase();
        return name.includes(spaced) && name.includes(hint) && !name.includes("6 m mast") && sameCargo(row, l, w, h, 1, unitKg);
      })
    ),
  JSON.stringify(photoParsed, null, 2)
);
check(
  "海上設備照片換算並標出 CPT 不符",
  photoParsed.warnings.some((warning) => warning.includes("已由 mm 換算")) &&
    photoParsed.warnings.some((warning) => warning.includes("已由 t 換算")) &&
    photoParsed.rows.some((row) => String(row.name).toLowerCase().includes("seabed") && row.unitKg === 7100 && row.alert && row.alert.includes("13.8")),
  JSON.stringify(photoParsed, null, 2)
);

} catch (error) {
  check("新增格式測試沒有中斷", false, String(error && (error.stack || error)));
}

const failed = results.filter((result) => !result.ok);
document.body.innerHTML = `<h1>${failed.length ? "FAIL" : "PASS"} ${results.length - failed.length}/${results.length}</h1><ul>${results
  .map((result) => `<li>${result.ok ? "OK" : "NG"} ${result.name}${result.detail ? `<pre>${result.detail}</pre>` : ""}</li>`)
  .join("")}</ul>`;
document.title = failed.length ? "FAIL" : "PASS";
