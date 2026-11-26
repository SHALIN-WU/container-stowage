import { LOW_CONFIDENCE, OCR_NOTICE, classifyUpload, convertToItems, fileBadge } from "./convert.js?v=2.1";
import { buildLayout, canTip, cogText, endHangText, sideOverhangText, stackedHeightText } from "./packer.js?v=2.1";
import { lineMetrics, parseTextItems, summarize } from "./parser.js?v=2.1";
import { CONTAINERS, planLabel, suggestPlans, unplannedNote } from "./planner.js?v=2.1";
import { createSceneView } from "./scene3d.js?v=2.1";

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const stage = document.querySelector("#stage");
const stepItems = [...document.querySelectorAll(".steps li")];
const MAX_BYTES = 20 * 1024 * 1024;
const MANUAL_DRAFT_KEY = "cargo-manual-draft";
const MANUAL_FIELDS = ["name", "l", "w", "h", "qty", "unitKg"];

const state = {
  step: 1,
  source: "upload",
  filename: "",
  files: [],
  warnings: [],
  error: "",
  loading: false,
  loadingText: "",
  ocr: false,
  rows: [],
  rowsFrom: "",
  uploadSnapshot: null,
  plans: [],
  totals: null,
  selectedId: "",
  layout: null,
  highlightId: "",
  stackable: true,
  manualRows: [],
  manualStackable: true,
  manualShowErrors: false,
  planNote: "",
  diagramView: "2d",
};

let sceneView = null;
let deckFitObserver = null;
const DECK_LABEL_MIN_PX = 11;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text != null) node.textContent = props.text;
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) {
      if (value == null) continue;
      node.setAttribute(key, String(value));
    }
  }
  if (props.on) {
    for (const [type, handler] of Object.entries(props.on)) node.addEventListener(type, handler);
  }
  for (const child of children) {
    if (child != null) node.append(child);
  }
  return node;
}

function formatCbm(value) {
  return Number(value || 0).toLocaleString("zh-Hant", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatKg(value) {
  return Number(value || 0).toLocaleString("zh-Hant", { maximumFractionDigits: 2 });
}

function formatQty(value) {
  return Number(value || 0).toLocaleString("zh-Hant", { maximumFractionDigits: 2 });
}

function formatPct(ratio) {
  return `${(Math.max(0, ratio) * 100).toLocaleString("zh-Hant", { maximumFractionDigits: 1 })}%`;
}

function blankRow() {
  return { name: "", l: "", w: "", h: "", qty: "", unitKg: "" };
}

function fullest(plan) {
  const floor = plan.floorUse == null ? -1 : plan.floorUse;
  const volume = plan.volumeUse == null ? -1 : plan.volumeUse;
  if (floor >= volume + 0.02 && floor >= plan.weightUse + 0.02) return "floor";
  if (volume >= 0 && plan.weightUse > volume + 0.02) return "weight";
  if (volume < 0) return "weight";
  return "volume";
}

function stackLabel() {
  return state.stackable ? "可堆疊" : "不可堆疊";
}

function disposeScene() {
  if (!sceneView) return;
  sceneView.dispose();
  sceneView = null;
}

function render() {
  disposeScene();
  document.body.dataset.step = String(state.step);
  stepItems.forEach((item) => {
    const number = Number(item.dataset.step);
    const current = number === state.step;
    item.classList.toggle("is-current", current);
    item.classList.toggle("is-done", number < state.step);
    if (current) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  });
  stage.replaceChildren();
  if (state.step === 1) stage.append(renderUpload());
  if (state.step === 2) stage.append(renderReview());
  if (state.step === 3) stage.append(renderPlans());
  if (state.step === 4) stage.append(renderDiagram());
  if (state.step === 4) {
    syncDiagramView();
    watchDeckFit();
  } else if (deckFitObserver) {
    deckFitObserver.disconnect();
    deckFitObserver = null;
  }
}

function uploadIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("class", "drop-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML =
    '<rect x="14" y="8" width="28" height="36" rx="3" fill="none" stroke="currentColor" stroke-width="2.4"/>' +
    '<path d="M22 18h12M22 24h12M22 30h8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
    '<path d="M32 40v14M25 47l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
  return svg;
}

function renderUpload() {
  const manual = state.source === "manual";
  const children = [sourceTabs()];
  if (manual) children.push(...renderManualPanel());
  else children.push(...renderUploadPanel());
  return el("section", {
    class: manual ? "panel panel-manual" : "panel panel-upload",
    attrs: {
      id: manual ? "source-panel-manual" : "source-panel-upload",
      role: "tabpanel",
      "aria-labelledby": manual ? "source-tab-manual" : "source-tab-upload",
    },
  }, children);
}

function sourceTabs() {
  return el("div", { class: "source-tabs", attrs: { role: "tablist", "aria-label": "輸入方式" } }, [
    sourceTab("upload", "上傳裝箱單"),
    sourceTab("manual", "手動輸入"),
  ]);
}

function sourceTab(id, label) {
  const selected = state.source === id;
  return el("button", {
    text: label,
    attrs: {
      type: "button",
      role: "tab",
      id: `source-tab-${id}`,
      "aria-selected": selected ? "true" : "false",
      "aria-controls": `source-panel-${id}`,
      tabindex: selected ? "0" : "-1",
    },
    on: {
      click: () => {
        if (state.source === id) return;
        state.source = id;
        render();
      },
    },
  });
}

function renderUploadPanel() {
  const fileInput = el("input", {
    class: "file-input",
    attrs: {
      type: "file",
      multiple: "multiple",
      accept: ".pdf,.jpg,.jpeg,.png,.docx,.xlsx,.xls,.csv,application/pdf",
      "aria-label": "選擇裝箱單，可多選",
    },
  });
  fileInput.hidden = true;
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length) readFiles(fileInput.files);
  });

  const chooseButton = el("button", {
    text: "選擇檔案",
    attrs: { type: "button" },
    on: { click: () => fileInput.click() },
  });
  const sampleButton = el("button", {
    class: "secondary",
    text: state.loading ? "正在讀取…" : "用範例裝箱單",
    attrs: { type: "button" },
    on: { click: loadSample },
  });
  chooseButton.disabled = state.loading;
  sampleButton.disabled = state.loading;

  const drop = el("div", { class: "drop" }, [
    uploadIcon(),
    el("p", { text: state.loading ? state.loadingText || "正在讀取裝箱單…" : "把裝箱單拖到這裡，可一次拖多個" }),
    el("div", { class: "actions" }, [chooseButton, sampleButton, fileInput]),
    el("ul", { class: "hints" }, [
      el("li", { text: "PDF、JPG、PNG、Word（.docx）、Excel（.xlsx、.xls、.csv）" }),
      el("li", { text: "可多選，也可拖曳" }),
      el("li", { text: "舊版 Word（.doc）請另存為 .docx" }),
      el("li", { text: "每個檔案上限 20 MB" }),
      el("li", { text: "內容只在這台電腦讀取" }),
    ]),
  ]);

  drop.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    if (!state.loading) fileInput.click();
  });
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (!state.loading) drop.classList.add("is-hot");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-hot"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("is-hot");
    if (state.loading) return;
    const files = event.dataTransfer.files;
    if (files && files.length) readFiles(files);
  });

  const children = [
    el("div", { class: "screen-head" }, [
      el("h2", { text: "上傳客戶的裝箱單" }),
      el("p", {
        class: "quiet",
        text: "系統會讀出尺寸、重量、數量。PDF、Excel、Word 直接讀內容；JPG、PNG 在這台電腦辨識，請再核對。",
      }),
    ]),
  ];
  if (state.error) {
    children.push(el("p", { class: "banner error", attrs: { role: "alert" }, text: state.error }));
  }
  children.push(drop);
  return children;
}

function renderManualPanel() {
  const children = [
    el("div", { class: "screen-head" }, [
      el("h2", { text: "手動輸入貨物明細" }),
      el("p", {
        class: "quiet",
        text: "欄位和上傳後的核對明細相同。長、寬、高是公分，重量是單件毛重（公斤）。填完按開始配載，會用同一套櫃型計算和配載圖。",
      }),
    ]),
    el("p", { class: "scroll-hint", text: "表格可左右滑動，查看尺寸、重量和是否需正放。" }),
    el("div", { class: "table-wrap" }, [manualTable()]),
    renderStackChoice({
      legend: "可否堆疊",
      note: "這票貨共用一種堆疊方式。可堆疊的貨可以疊在別的貨上面；不可堆疊時，每一件都放在櫃底。",
      value: state.manualStackable,
      group: "manual-stackable",
      onChange: (value) => {
        state.manualStackable = value;
        saveManualDraft();
      },
    }),
    manualActions(),
  ];
  return children;
}

function manualTable() {
  const table = el("table", { class: "manual-table" });
  table.append(
    el("thead", {}, [
      el("tr", {}, [
        ["品名", false],
        ["長 cm", true],
        ["寬 cm", true],
        ["高 cm", true],
        ["數量", true],
        ["單件毛重 kg", true],
        ["需正放", false],
        ["", false],
      ].map(([label, numeric]) => el("th", {
        class: numeric ? "num" : "",
        attrs: label ? { scope: "col" } : null,
        text: label,
      }))),
    ])
  );
  const tbody = el("tbody");
  state.manualRows.forEach((row, index) => {
    tbody.append(
      el("tr", {}, [
        el("td", {}, [manualField(index, "name", "text")]),
        el("td", { class: "num" }, [manualField(index, "l", "number")]),
        el("td", { class: "num" }, [manualField(index, "w", "number")]),
        el("td", { class: "num" }, [manualField(index, "h", "number")]),
        el("td", { class: "num" }, [manualField(index, "qty", "number")]),
        el("td", { class: "num" }, [manualField(index, "unitKg", "number")]),
        el("td", { class: "tip-cell" }, [uprightInput(index, row)]),
        el("td", {}, [
          el("button", {
            class: "tiny",
            text: "刪除",
            attrs: { type: "button", "aria-label": `刪除第 ${index + 1} 列` },
            on: { click: () => removeManualRow(index) },
          }),
        ]),
      ])
    );
  });
  table.append(tbody);
  return table;
}

function manualField(index, key, type) {
  const row = state.manualRows[index];
  const errorId = `manual-error-${index}-${key}`;
  const message = manualRowShowsErrors(index) ? manualFieldError(row, key) : "";
  const input = el("input", {
    attrs: {
      type,
      "data-index": String(index),
      "data-key": key,
      inputmode: type === "number" ? "decimal" : "text",
      autocomplete: "off",
      "aria-label": `${manualKeyLabel(key)}，第 ${index + 1} 列`,
      "aria-invalid": message ? "true" : "false",
      "aria-describedby": message ? errorId : null,
    },
  });
  input.value = row[key] == null ? "" : String(row[key]);
  if (type === "number") {
    input.step = "any";
    input.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
  }
  input.addEventListener("input", () => {
    state.manualRows[index][key] = input.value;
    saveManualDraft();
    if (state.manualShowErrors) refreshManualErrors();
  });
  const error = el("p", {
    class: "field-error",
    attrs: { id: errorId, "data-error-for": key },
    text: message,
  });
  error.hidden = !message;
  return el("div", { class: "manual-field" }, [input, error]);
}

function uprightInput(index, row) {
  const input = el("input", {
    attrs: {
      type: "checkbox",
      "data-key": "upright",
      "aria-label": `是否需正放，第 ${index + 1} 列`,
    },
  });
  input.checked = row.upright === true;
  input.addEventListener("change", () => {
    state.manualRows[index].upright = input.checked;
    saveManualDraft();
    if (state.manualShowErrors) refreshManualErrors();
  });
  return input;
}

function manualActions() {
  const importButton = el("button", {
    class: "secondary",
    text: "從上傳結果帶入",
    attrs: { type: "button" },
    on: { click: importUploadToManual },
  });
  const canImport = Boolean(state.uploadSnapshot && state.uploadSnapshot.rows.length);
  importButton.disabled = !canImport;
  importButton.title = canImport ? "把目前上傳或核對過的明細抄進這張表" : "請先上傳裝箱單";
  return el("div", { class: "bottom manual-bottom" }, [
    importButton,
    el("div", { class: "row-actions" }, [
      el("button", {
        class: "secondary",
        text: "清空",
        attrs: { type: "button" },
        on: { click: clearManualDraft },
      }),
      el("button", {
        class: "secondary",
        text: "新增一列",
        attrs: { type: "button" },
        on: { click: addManualRow },
      }),
      el("button", {
        text: "開始配載",
        attrs: { type: "button" },
        on: { click: startManualLoad },
      }),
    ]),
  ]);
}

function renderReview() {
  const totals = summarize(state.rows);
  const children = [
    el("div", { class: "screen-head" }, [
      el("h2", { text: "核對明細" }),
      el("p", {
        class: "quiet",
        text: "黃底是還沒填的數字。長、寬、高、數量要大於 0，單件毛重要已填且不小於 0，這一列才會計入。名稱含 Pallet 或棧板的列，預設不可放倒，高度維持直立；其他貨物放不下時仍可放倒。可逐列改。",
      }),
      ...state.files.map((file) =>
        el("p", {
          class: "filechip",
          attrs: file.kind ? { "data-kind": file.kind } : null,
          text: file.name,
        })
      ),
    ]),
  ];

  if (state.ocr) {
    children.push(el("p", { class: "banner", attrs: { role: "status" }, text: `${OCR_NOTICE}。底色偏紅的欄位辨識信心較低。` }));
  }
  if (state.error) {
    children.push(el("p", { class: "banner error", attrs: { role: "alert" }, text: state.error }));
  }
  for (const warning of state.warnings) {
    children.push(el("p", { class: "banner", text: warning }));
  }
  if (state.selectedId) {
    children.push(el("p", { class: "banner", text: "重新計算後，先前選定的方案會清除。" }));
  }

  const table = el("table");
  table.append(
    el("thead", {}, [
      el("tr", {}, [
        ["品名", false],
        ["長 cm", true],
        ["寬 cm", true],
        ["高 cm", true],
        ["數量", true],
        ["單件毛重 kg", true],
        ["可放倒", false],
        ["材積 CBM", true],
        ["列總重 kg", true],
        ["", false],
      ].map(([label, numeric]) => el("th", { class: numeric ? "num" : "", attrs: label ? { scope: "col" } : null, text: label }))),
    ])
  );

  const tbody = el("tbody");
  state.rows.forEach((row, index) => {
    const metrics = lineMetrics(row);
    const flag = el("span", { class: "flag", attrs: { "data-col": "flag" }, text: "未完成，不計入" });
    flag.hidden = metrics.complete;
    const nameCell = el("td", {}, [
      flag,
      fieldInput(index, "name", "text", row.name),
      row.alert ? el("p", { class: "row-alert", text: row.alert }) : null,
    ]);
    tbody.append(
      el("tr", { class: metrics.complete ? "" : "is-open" }, [
        nameCell,
        el("td", { class: "num" }, [fieldInput(index, "l", "number", row.l)]),
        el("td", { class: "num" }, [fieldInput(index, "w", "number", row.w)]),
        el("td", { class: "num" }, [fieldInput(index, "h", "number", row.h)]),
        el("td", { class: "num" }, [fieldInput(index, "qty", "number", row.qty)]),
        el("td", { class: "num" }, [fieldInput(index, "unitKg", "number", row.unitKg)]),
        el("td", { class: "tip-cell" }, [tipInput(index, row)]),
        el("td", { class: "num computed", attrs: { "data-col": "cbm" }, text: metrics.complete ? formatCbm(metrics.cbm) : "—" }),
        el("td", { class: "num computed", attrs: { "data-col": "kg" }, text: metrics.complete ? formatKg(metrics.kg) : "—" }),
        el("td", {}, [
          el("button", {
            class: "tiny",
            text: "刪除",
            attrs: { type: "button", "aria-label": `刪除第 ${index + 1} 列` },
            on: { click: () => removeRow(index) },
          }),
        ]),
      ])
    );
  });
  table.append(tbody);
  children.push(el("p", { class: "scroll-hint", text: "表格可左右滑動，查看尺寸、重量和材積。" }));
  children.push(el("div", { class: "table-wrap" }, [table]));

  children.push(
    el("div", { class: "totals" }, [
      stat("可計算筆數", String(totals.lines)),
      stat("總材積 CBM", formatCbm(totals.cbm)),
      stat("總重量 kg", formatKg(totals.kg)),
    ])
  );

  const note = el("p", {
    class: "banner incomplete-note",
    text: `還有 ${totals.incomplete} 列沒填完，這幾列不會計入櫃型方案。`,
  });
  note.hidden = totals.incomplete === 0;
  children.push(note);
  children.push(renderStackChoice());

  const calcButton = el("button", {
    text: "計算櫃型方案",
    attrs: { type: "button" },
    on: { click: goToPlans },
  });
  calcButton.disabled = totals.lines === 0;
  calcButton.title = totals.lines === 0 ? "至少要有一列尺寸、數量和單件毛重都填完" : "";

  children.push(
    el("div", { class: "bottom" }, [
      el("button", { class: "secondary", text: "返回上傳", attrs: { type: "button" }, on: { click: () => setStep(1) } }),
      el("div", { class: "row-actions" }, [
        el("button", { class: "secondary", text: "新增一列", attrs: { type: "button" }, on: { click: addRow } }),
        calcButton,
      ]),
    ])
  );

  return el("section", { class: "panel" }, children);
}

function renderStackChoice(options = {}) {
  const legend = options.legend || "堆疊";
  const note = options.note || "核對完明細後選一種。可堆疊的貨可以疊在別的貨上面；不可堆疊時，每一件都放在櫃底。";
  const current = options.value === undefined ? state.stackable : options.value;
  const onChange = options.onChange || ((value) => {
    state.stackable = value;
    syncUploadSnapshot();
  });
  return el("fieldset", { class: "stack-block" }, [
    el("legend", { text: legend }),
    el("p", { class: "quiet", text: note }),
    el("div", { class: "stack-choice" }, [
      stackOption(true, "可堆疊", "貨可以疊在別的貨上面。", current, onChange, options.group),
      stackOption(false, "不可堆疊", "每一件都放在櫃底，不往上疊。", current, onChange, options.group),
    ]),
  ]);
}

function stackOption(value, title, detail, current = state.stackable, onChange = null, groupName = "stackable") {
  const input = el("input", {
    attrs: { type: "radio", name: groupName, value: value ? "yes" : "no" },
  });
  input.checked = current === value;
  input.addEventListener("change", () => {
    if (!input.checked) return;
    if (onChange) onChange(value);
    else {
      state.stackable = value;
      syncUploadSnapshot();
    }
  });
  return el("label", { class: "stack-option" }, [
    input,
    el("span", { class: "stack-copy" }, [el("strong", { text: title }), el("span", { text: detail })]),
  ]);
}

function stat(label, value) {
  return el("div", { class: "stat" }, [el("span", { text: label }), el("strong", { text: value })]);
}

function tipInput(index, row) {
  const input = el("input", {
    attrs: {
      type: "checkbox",
      "data-key": "tippable",
      "aria-label": `可放倒，第 ${index + 1} 列`,
    },
  });
  input.checked = canTip(row);
  input.addEventListener("change", () => {
    state.rows[index].tippable = input.checked;
    syncUploadSnapshot();
  });
  return input;
}

function fieldInput(index, key, type, value) {
  const missing = type === "number" && (value === "" || value == null);
  const score = state.rows[index].confidence && state.rows[index].confidence[key];
  const low = Number.isFinite(score) && score < LOW_CONFIDENCE;
  const input = el("input", {
    class: [missing ? "is-missing" : "", low ? "is-low" : ""].filter(Boolean).join(" "),
    attrs: {
      type,
      "data-index": index,
      "data-key": key,
      inputmode: type === "number" ? "decimal" : "text",
      autocomplete: "off",
      "aria-label": `${keyLabel(key)}，第 ${index + 1} 列`,
      title: low ? "辨識信心較低，請核對" : null,
    },
  });
  input.value = value == null ? "" : String(value);
  if (type === "number") {
    input.step = "any";
    input.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
  }
  input.addEventListener("input", () => {
    state.rows[index][key] = input.value;
    if (state.rows[index].confidence) delete state.rows[index].confidence[key];
    if ((key === "qty" || key === "unitKg") && state.rows[index].alert) {
      state.rows[index].alert = "";
      const note = input.closest("tr")?.querySelector(".row-alert");
      if (note) note.remove();
    }
    input.classList.remove("is-low");
    input.removeAttribute("title");
    refreshRow(input.closest("tr"));
    refreshTotals();
    syncUploadSnapshot();
  });
  return input;
}

function keyLabel(key) {
  return {
    name: "品名",
    l: "長",
    w: "寬",
    h: "高",
    qty: "數量",
    unitKg: "單件毛重",
  }[key];
}

function refreshRow(rowElement) {
  if (!rowElement) return;
  const index = Number(rowElement.querySelector("input").dataset.index);
  const metrics = lineMetrics(state.rows[index]);
  rowElement.classList.toggle("is-open", !metrics.complete);
  rowElement.querySelector('[data-col="cbm"]').textContent = metrics.complete ? formatCbm(metrics.cbm) : "—";
  rowElement.querySelector('[data-col="kg"]').textContent = metrics.complete ? formatKg(metrics.kg) : "—";
  const flag = rowElement.querySelector('[data-col="flag"]');
  if (flag) flag.hidden = metrics.complete;
  const tip = rowElement.querySelector('input[data-key="tippable"]');
  if (tip && state.rows[index].tippable == null) tip.checked = canTip(state.rows[index]);
  rowElement.querySelectorAll('input[type="number"]').forEach((input) => {
    input.classList.toggle("is-missing", input.value === "");
  });
}

function refreshTotals() {
  const totals = summarize(state.rows);
  const blocks = stage.querySelectorAll(".totals strong");
  if (blocks.length >= 3) {
    blocks[0].textContent = String(totals.lines);
    blocks[1].textContent = formatCbm(totals.cbm);
    blocks[2].textContent = formatKg(totals.kg);
  }
  const note = stage.querySelector(".incomplete-note");
  if (note) {
    note.textContent = `還有 ${totals.incomplete} 列沒填完，這幾列不會計入櫃型方案。`;
    note.hidden = totals.incomplete === 0;
  }
  const calcButton = [...stage.querySelectorAll("button")].find((button) => button.textContent === "計算櫃型方案");
  if (calcButton) {
    calcButton.disabled = totals.lines === 0;
    calcButton.title = totals.lines === 0 ? "至少要有一列尺寸、數量和單件毛重都填完" : "";
  }
}

function renderPlans() {
  const totals = state.totals || summarize(state.rows);
  const children = [
    el("div", { class: "screen-head" }, [
      el("h2", { text: "櫃型方案" }),
      el("p", {
        class: "quiet",
        text: state.stackable
          ? "選定一組後會依櫃的內徑排出配載圖，每一件都標編號、尺寸和重量。這次是可堆疊，貨可以疊在別的貨上面。上面的剩餘空間仍是容積相減。"
          : "選定一組後會依櫃的內徑排出配載圖，每一件都標編號、尺寸和重量。這次是不可堆疊，每一件都放在櫃底，所以方案還要有夠大的櫃底。",
      }),
    ]),
    el("div", { class: "summary" }, [
      stat("總材積 CBM", formatCbm(totals.cbm)),
      stat("總重量 kg", formatKg(totals.kg)),
      stat("件數", formatQty(totals.qty)),
    ]),
  ];

  if (state.plans.length === 0) {
    children.push(
      el("p", {
        class: "banner",
        attrs: { role: "status" },
        text: state.planNote || (state.stackable
          ? "這票貨超過 12 個櫃子的粗算範圍，或單位有誤，請回核對頁檢查公分與公斤。"
          : "這票貨以不可堆疊來排，12 個櫃子的櫃底仍不夠，或單位有誤。請回核對頁檢查公分與公斤，或改成可堆疊。"),
      })
    );
  } else {
    const count = Math.min(state.plans.length, 3);
    children.push(el("div", { class: `plans plans-${count}` }, state.plans.map(renderPlan)));
  }

  const selected = state.plans.find((plan) => plan.id === state.selectedId);
  if (selected) {
    children.push(
      el("p", {
        class: "choice",
        attrs: { role: "status" },
        text: `已選定 ${planLabel(selected)}。${stackLabel()}。配載圖用的就是這組櫃量與櫃型。`,
      })
    );
  }

  children.push(renderBasis());
  children.push(
      el("div", { class: "bottom" }, [
      el("button", {
        class: "secondary",
        text: "返回修改明細",
        attrs: { type: "button" },
        on: { click: () => setStep(2) },
      }),
      selected
        ? el("button", {
            text: "打開配載圖",
            attrs: { type: "button" },
            on: { click: () => openDiagram(selected.id) },
          })
        : null,
    ])
  );
  return el("section", { class: "panel" }, children);
}

function renderPlan(plan) {
  const selected = plan.id === state.selectedId;
  const limit = fullest(plan);
  const tags = [el("span", { class: "tag tag-role", text: plan.recommended ? "建議" : "備選" })];
  if (selected) tags.push(el("span", { class: "tag tag-picked", text: "已選定" }));
  const remain = [
    plan.spaceByDiagram
      ? el("div", {}, [el("span", { text: "剩餘空間" }), el("strong", { text: "看配載圖" })])
      : el("div", {}, [el("span", { text: "剩餘空間" }), el("strong", {}, [document.createTextNode(`${formatCbm(plan.remainCbm)} `), el("small", { text: "CBM" })])]),
    el("div", {}, [el("span", { text: "剩餘載重" }), el("strong", {}, [document.createTextNode(`${formatKg(plan.remainKg)} `), el("small", { text: "kg" })])]),
  ];
  if (plan.remainFloorM2 != null) {
    remain.push(
      el("div", { class: "wide" }, [
        el("span", { text: "剩餘櫃底" }),
        el("strong", {}, [document.createTextNode(`${formatM2(plan.remainFloorM2)} `), el("small", { text: "m²" })]),
      ])
    );
  }
  const limitText = plan.spaceByDiagram
    ? "有平板櫃，封閉容積不算這組的空間"
    : { floor: "這組先滿的是櫃底", weight: "這組先滿的是載重", volume: "這組先滿的是空間" }[limit];

  return el(
    "article",
    { class: `plan${plan.recommended ? " is-best" : ""}${selected ? " is-selected" : ""}` },
    [
      el("div", { class: "tags" }, tags),
      el("div", { class: "codes" }, plan.counts.map((part) => el("span", { class: "code", text: `${part.code} × ${part.count}` }))),
      el("h3", { text: planLabel(plan) }),
      plan.reasons && plan.reasons.length ? el("p", { class: "plan-reason", text: plan.reasons.join("；") }) : null,
      plan.reasons && plan.reasons.length ? el("p", { class: "plan-warn", text: "超限貨需另洽船公司與拖車。" }) : null,
      el("div", { class: "remain" }, remain),
      plan.volumeUse == null ? null : usageMeter("空間", plan.volumeUse, ""),
      usageMeter("載重", plan.weightUse, limit === "weight" ? "weight" : ""),
      plan.floorUse == null ? null : usageMeter("櫃底", plan.floorUse, limit === "floor" ? "floor" : ""),
      el("p", {
        class: limit === "volume" ? "limit" : `limit is-${limit}`,
        text: limitText,
      }),
      el("button", {
        class: "pick",
        text: selected ? "查看配載圖" : "用這個方案產生配載圖",
        attrs: { type: "button", "aria-pressed": selected ? "true" : "false" },
        on: { click: () => openDiagram(plan.id) },
      }),
    ]
  );
}

function usageMeter(label, ratio, kind) {
  const width = Math.max(0, Math.min(100, ratio * 100));
  const meterClass = kind === "weight" || kind === "floor" ? `meter is-${kind}` : "meter";
  return el("div", {}, [
    el("div", { class: "use-label" }, [el("span", { text: `${label}使用比例` }), el("span", { text: formatPct(ratio) })]),
    el("div", { class: meterClass }, [
      el("span", { attrs: { style: `width:${width}%` } }),
    ]),
  ]);
}

function renderBasis() {
  return el("aside", { class: "basis" }, [
    el("p", { class: "basis-title", text: "估算基準" }),
    el("ul", {}, CONTAINERS.map((item) =>
      el("li", {}, [
        el("strong", { text: `${item.code} ${item.name}` }),
        el("span", { text: basisText(item) }),
      ])
    )),
    el("p", { class: "footnote", text: "這是常見粗算值，可在程式設定區依船公司修改。門高只供對照，不拿來判斷裝不裝得進。平板不計封閉容積。超限貨需另洽船公司與拖車。" }),
  ]);
}

const CARGO_COLORS = [
  { fill: "#1d4e89", ink: "#f4f8fc" },
  { fill: "#e07a1f", ink: "#1d1408" },
  { fill: "#2f7d4a", ink: "#f4fbf6" },
  { fill: "#6d4ea8", ink: "#f8f4fb" },
  { fill: "#d6a400", ink: "#241c04" },
  { fill: "#0e8a8a", ink: "#f2fbfb" },
  { fill: "#3d5a99", ink: "#f4f7fc" },
  { fill: "#c46b2c", ink: "#1d1408" },
];

function basisText(item) {
  const volume = item.cbm ? `內容積 ${formatCbm(item.cbm)} CBM · ` : "不計封閉容積 · ";
  const door = item.doorW ? `門 ${item.doorW}×${item.doorH} cm` : "無門";
  const extra = item.overWidthCm > 0 ? " · 可超側邊與櫃頂" : item.overHeightCm > 0 ? " · 可超櫃頂" : "";
  return `${volume}載重 ${formatKg(item.payloadKg)} kg · 內徑 ${item.innerL}×${item.innerW}×${item.innerH} cm · ${door}${extra}`;
}

function formatM2(value) {
  return Number(value || 0).toLocaleString("zh-Hant", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDim(value) {
  return Number(value || 0).toLocaleString("zh-Hant", { maximumFractionDigits: 2 });
}

function sizeText(item) {
  return `${formatDim(item.l)}×${formatDim(item.w)}×${formatDim(item.h)}`;
}

function cargoPalette(pieces) {
  const colors = new Map();
  for (const piece of pieces) {
    if (!colors.has(piece.name)) colors.set(piece.name, CARGO_COLORS[colors.size % CARGO_COLORS.length]);
  }
  return colors;
}

function pieceCbm(item) {
  return (item.l * item.w * item.h) / 1_000_000;
}

function appendOverhangPattern(svg) {
  const id = `overhatch-${appendOverhangPattern.next}`;
  appendOverhangPattern.next += 1;
  const defs = svgEl("defs");
  const pattern = svgEl("pattern", {
    id,
    patternUnits: "userSpaceOnUse",
    width: "10",
    height: "10",
    patternTransform: "rotate(45)",
  });
  pattern.append(svgEl("line", { x1: "0", y1: "0", x2: "0", y2: "10", stroke: "#c4382b", "stroke-width": "3" }));
  defs.append(pattern);
  svg.append(defs);
  return id;
}
appendOverhangPattern.next = 1;

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) node.setAttribute(key, String(value));
  }
  return node;
}

function renderDiagram() {
  const layout = state.layout;
  const plan = state.plans.find((item) => item.id === state.selectedId);
  if (!layout || !plan) {
    return el("section", { class: "panel" }, [
      el("h2", { text: "配載圖" }),
      el("p", { class: "quiet", text: "請先在櫃型方案選定一組。" }),
      el("div", { class: "bottom" }, [
        el("button", {
          text: "返回方案",
          attrs: { type: "button" },
          on: { click: () => setStep(3) },
        }),
      ]),
    ]);
  }

  const colors = cargoPalette(layout.pieces);
  const placedCount = layout.containers.reduce((sum, bin) => sum + bin.placed.length, 0);
  const children = [
    el("div", { class: "screen-head" }, [
      el("h2", { text: "配載圖" }),
      el("p", {
        class: "quiet",
        text: "可切換 2D 俯視或 3D 立體。2D 格子寫編號、尺寸（公分）和單件重量（公斤），太小時只留編號，完整資料在下方明細。一般櫃左是封閉端、右是櫃門。開頂沒有櫃頂，平板沒有側牆。3D 用同一套位置，可旋轉、縮放，並匯出 PNG。已計算整櫃重心，縱向超過櫃長 ±5% 或橫向超過櫃寬 ±2% 會警示。門能不能關，以及公路限重，仍要人工確認。",
      }),
    ]),
    el("p", {
      class: "choice",
      attrs: { role: "status" },
      text: layout.unpacked.length
        ? `已選定 ${planLabel(plan)}。${stackLabel()}。還有 ${layout.unpacked.length} 件未排入，這組還沒排完。`
        : `已選定 ${planLabel(plan)}。${stackLabel()}。圖上 ${placedCount} 件，編號沿明細順序。`,
    }),
  ];

  for (const note of layout.notes) {
    children.push(el("p", { class: "banner", text: note }));
  }
  if (layout.containers.some((bin) => bin.placed.some((box) => overhangParts(box, bin).length > 0))) {
    children.push(el("p", { class: "banner", text: "超限貨需另洽船公司與拖車。" }));
  }
  if (layout.containers.some((bin) => bin.cog && (bin.cog.longWarn || bin.cog.latWarn))) {
    children.push(el("p", { class: "banner", text: "有櫃子的重心超出容許範圍。縱向以櫃長 ±5% 為限，橫向以櫃寬 ±2% 為限。" }));
  }
  if (layout.unpacked.length > 0) {
    const preview = layout.unpacked
      .slice(0, 8)
      .map((piece) => `${piece.id}（${sizeText(piece)} cm，${formatKg(piece.kg)} kg）`)
      .join("、");
    const more = layout.unpacked.length > 8 ? `，其餘 ${layout.unpacked.length - 8} 件列在下方明細` : "";
    children.push(
      el("p", {
        class: "banner",
        attrs: { role: "status" },
        text: `還有 ${layout.unpacked.length} 件依內徑或載重排不進去：${preview}${more}。可改選別的方案，或回明細檢查單件尺寸。`,
      })
    );
  }

  const view2d = el("div", { class: "view-2d", attrs: { id: "panel-2d", role: "tabpanel", "aria-labelledby": "tab-2d" } });
  for (const bin of layout.containers) view2d.append(renderContainerSheet(bin, colors));
  const view3d = el("div", {
    class: "view-3d",
    attrs: { id: "panel-3d", role: "tabpanel", "aria-labelledby": "tab-3d" },
  }, [el("div", { class: "view-3d-host" })]);
  children.push(
    el("div", { class: "view-tabs", attrs: { role: "tablist", "aria-label": "配載圖畫面" } }, [
      viewTab("2d", "2D 配載圖"),
      viewTab("3d", "3D 立體"),
    ]),
    view2d,
    view3d,
    renderPieceTable(layout, colors)
  );
  children.push(
    el("div", { class: "bottom" }, [
      el("button", {
        class: "secondary",
        text: "返回方案",
        attrs: { type: "button" },
        on: { click: () => setStep(3) },
      }),
      el("div", { class: "row-actions" }, [
        el("button", {
          class: "secondary",
          text: "返回修改明細",
          attrs: { type: "button" },
          on: { click: () => setStep(2) },
        }),
        el("button", {
          text: "列印配載圖",
          attrs: { type: "button" },
          on: { click: () => window.print() },
        }),
      ]),
    ])
  );
  return el("section", { class: "panel" }, children);
}

function overhangParts(box, bin) {
  return sideOverhangText(box, bin);
}

function binOverhangSummary(bin) {
  let top = 0;
  let left = 0;
  let right = 0;
  for (const box of bin.placed) {
    if (box.topStacked) continue;
    top = Math.max(top, box.y + box.dh - bin.h);
    left = Math.max(left, -box.z);
    right = Math.max(right, box.z + box.dw - bin.w);
  }
  const parts = [];
  if (top > 0.05) parts.push(`頂部最高超出 ${formatDim(top)} cm`);
  if (left > 0.05 || right > 0.05) {
    if (Math.abs(left - right) <= 0.5) parts.push(`左右各超出 ${formatDim((left + right) / 2)} cm`);
    else {
      if (left > 0.05) parts.push(`左側超出 ${formatDim(left)} cm`);
      if (right > 0.05) parts.push(`右側超出 ${formatDim(right)} cm`);
    }
  }
  return parts.join("、");
}

function cogLine(bin) {
  if (!bin.cog) return null;
  const warn = bin.cog.longWarn || bin.cog.latWarn;
  return el("p", { class: warn ? "cg-line is-warn" : "cg-line", text: `重心 ${cogText(bin.cog)}` });
}

function renderContainerSheet(bin, colors) {
  const cbm = bin.placed.reduce((sum, box) => sum + pieceCbm(box.item), 0);
  const over = binOverhangSummary(bin);
  const head = el("div", { class: "sheet-head" }, [
    el("h3", { text: `第 ${bin.index} 櫃 · ${bin.name}（${bin.code}）` }),
    el("p", {
      text: `內徑 ${formatDim(bin.l)}×${formatDim(bin.w)}×${formatDim(bin.h)} cm · 已排 ${bin.placed.length} 件 · ${formatCbm(cbm)} CBM · ${formatKg(bin.kg)} / ${formatKg(bin.payloadKg)} kg`,
    }),
    over ? el("p", { class: "over-line", text: over }) : null,
    stackedHeightText(bin) ? el("p", { class: "over-line", text: stackedHeightText(bin) }) : null,
    bin.lashingShort ? el("p", { class: "over-line", text: "間距不足" }) : null,
    cogLine(bin),
  ]);
  const sheetClass = `sheet${bin.kind === "ot" ? " is-ot" : ""}${bin.kind === "fr" ? " is-fr" : ""}`;
  if (bin.placed.length === 0) {
    return el("section", { class: sheetClass }, [
      head,
      el("p", { class: "quiet", text: "這櫃沒有排入貨物。方案仍保留這個櫃子。" }),
    ]);
  }
  const decks = bin.layers.map((layer, index) => renderDeck(bin, layer, index, colors, bin.placed));
  const scrollText = bin.kind === "fr"
    ? "整櫃已縮放在畫面內。上下兩邊是沒有側牆的兩側。格子太小時只留編號，滑鼠移上去可看尺寸、重量和超出。"
    : bin.kind === "ot"
      ? "整櫃已縮放在畫面內。這是開頂櫃，從封閉端看到櫃門。格子太小時只留編號，滑鼠移上去可看完整資訊。"
      : "整櫃已縮放在畫面內，從封閉端看到櫃門。格子太小時只留編號，滑鼠移上去可看尺寸、重量和超出。";
  return el("section", { class: sheetClass }, [
    head,
    el("p", { class: "scroll-hint", text: scrollText }),
    ...decks,
  ]);
}

function renderDeck(bin, layer, index, colors, placed) {
  const floorY = Math.min(...layer.map((box) => box.y));
  const under = placed.filter(
    (box) => box.y + box.dh <= floorY + 0.2 && layer.some((top) => footprintsTouch(top, box))
  );
  const svg = renderDeckSvg(bin, layer, colors, under, index === 0);
  svg.addEventListener("click", (event) => {
    const group = event.target.closest("[data-piece]");
    if (group) focusPiece(group.getAttribute("data-piece"), "svg");
  });
  const caption =
    index === 0
      ? `第 1 層 · ${layer.length} 件 · 貼在櫃底`
      : `第 ${index + 1} 層 · ${layer.length} 件 · 疊在下面的貨上，淡色虛線是下一層`;
  const scroll = el("div", { class: "view-scroll" }, [svg]);
  bindDeckHover(scroll);
  return el("figure", { class: index === 0 ? "deck" : "deck is-stacked" }, [
    el("figcaption", { text: caption }),
    scroll,
  ]);
}

function bindDeckHover(scroll) {
  const tip = el("div", { class: "deck-tip", attrs: { role: "tooltip" } });
  tip.hidden = true;
  scroll.append(tip);
  const show = (event) => {
    const group = event.target.closest ? event.target.closest(".cargo") : null;
    if (!group || !scroll.contains(group) || !cargoNeedsTip(group)) {
      tip.hidden = true;
      return;
    }
    const lines = (group.getAttribute("data-tip") || "").split("\n").filter(Boolean);
    tip.replaceChildren(...lines.map((line) => el("p", { text: line })));
    tip.hidden = false;
    placeDeckTip(tip, scroll, event);
  };
  scroll.addEventListener("pointerover", show);
  scroll.addEventListener("pointermove", show);
  scroll.addEventListener("pointerleave", () => {
    tip.hidden = true;
  });
}

function cargoNeedsTip(group) {
  return group.classList.contains("is-compact")
    || group.classList.contains("is-id-only")
    || group.classList.contains("is-oog-hidden");
}

function placeDeckTip(tip, scroll, event) {
  const host = scroll.getBoundingClientRect();
  let left = event.clientX - host.left + 12;
  let top = event.clientY - host.top + 14;
  const tipBox = tip.getBoundingClientRect();
  if (left + tipBox.width > host.width - 8) left = Math.max(8, event.clientX - host.left - tipBox.width - 12);
  if (top + tipBox.height > host.height - 8) top = Math.max(8, event.clientY - host.top - tipBox.height - 12);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function fitDeckLabels(root) {
  if (!root) return;
  root.querySelectorAll(".deck svg").forEach((svg) => {
    const box = svg.viewBox.baseVal;
    const rendered = svg.getBoundingClientRect().width;
    if (!(box.width > 0) || rendered < 2) return;
    const scale = rendered / box.width;
    const hideOog = 11 * scale < DECK_LABEL_MIN_PX;
    svg.classList.toggle("hide-oog", hideOog);
    svg.querySelectorAll(".cargo").forEach((group) => {
      const font = parseFloat(group.getAttribute("data-label-size")) || 0;
      const compact = font > 0 && font * scale < DECK_LABEL_MIN_PX;
      group.classList.toggle("is-compact", compact);
      group.classList.toggle("is-oog-hidden", hideOog && Boolean(group.querySelector(".oog-label")));
      const alt = group.querySelector(".cargo-id-alt");
      if (alt) {
        if (!alt.hasAttribute("data-base-size")) alt.setAttribute("data-base-size", alt.getAttribute("font-size"));
        const base = parseFloat(alt.getAttribute("data-base-size")) || 0;
        const maxFit = parseFloat(group.getAttribute("data-id-max")) || base;
        const target = compact ? DECK_LABEL_MIN_PX / scale : base;
        alt.setAttribute("font-size", String(Math.round(Math.min(Math.max(base, target), maxFit) * 10) / 10));
      }
    });
  });
}

function watchDeckFit() {
  if (deckFitObserver) {
    deckFitObserver.disconnect();
    deckFitObserver = null;
  }
  const view = stage.querySelector(".view-2d");
  if (!view) return;
  const run = () => fitDeckLabels(view);
  requestAnimationFrame(run);
  if (typeof ResizeObserver !== "function") return;
  deckFitObserver = new ResizeObserver(run);
  deckFitObserver.observe(view);
}

function footprintsTouch(top, below) {
  return (
    top.x < below.x + below.dl - 0.05 &&
    top.x + top.dl > below.x + 0.05 &&
    top.z < below.z + below.dw - 0.05 &&
    top.z + top.dw > below.z + 0.05
  );
}

function renderDeckSvg(bin, layer, colors, underlay, showCog) {
  const boxes = [...layer, ...underlay];
  let minZ = 0;
  let maxZ = bin.w;
  for (const box of boxes) {
    minZ = Math.min(minZ, box.z);
    maxZ = Math.max(maxZ, box.z + box.dw);
  }
  const hangs = boxes.some((box) => overhangParts(box, bin).length > 0);
  const padLeft = 58;
  const padRight = 42;
  const padY = hangs || bin.kind === "ot" || bin.kind === "fr" ? 22 : 10;
  const px = 1.48;
  const width = bin.l + padLeft + padRight;
  const height = maxZ - minZ + padY * 2;
  const kindLabel = bin.kind === "ot" ? "開頂" : bin.kind === "fr" ? "平板" : "";
  const svg = svgEl("svg", {
    viewBox: `${-padLeft} ${minZ - padY} ${width} ${height}`,
    width: Math.round(width * px),
    height: Math.round(height * px),
    role: "img",
    "aria-label": `第 ${bin.index} 櫃${kindLabel}俯視圖，${layer.length} 件`,
  });
  drawBinFloor(svg, bin);
  const closed = svgEl("text", {
    x: -8,
    y: bin.w / 2,
    "text-anchor": "end",
    "dominant-baseline": "middle",
    "font-size": 12,
    fill: "#5c6a76",
  });
  closed.textContent = bin.kind === "fr" ? "端牆" : "封閉端";
  const door = svgEl("text", {
    x: bin.l + 8,
    y: bin.w / 2,
    "dominant-baseline": "middle",
    "font-size": 12,
    fill: "#5c6a76",
  });
  door.textContent = bin.kind === "fr" ? "端牆" : "櫃門";
  svg.append(closed, door);
  const hatchId = appendOverhangPattern(svg);
  if (bin.kind === "ot" || bin.kind === "fr") {
    const tag = svgEl("text", {
      x: bin.l / 2,
      y: minZ - 6,
      "text-anchor": "middle",
      "font-size": 12,
      "font-weight": "700",
      fill: "#8a4b12",
    });
    tag.textContent = bin.kind === "ot" ? "開頂" : "無側牆";
    svg.append(tag);
  }

  for (const box of underlay) {
    const ghost = svgEl("rect", {
      class: "underlay",
      x: box.x,
      y: box.z,
      width: box.dl,
      height: box.dw,
    });
    const label = svgEl("text", {
      class: "underlay-label",
      x: box.x + 6,
      y: box.z + 14,
      "font-size": 11,
    });
    label.textContent = String(box.item.id);
    svg.append(ghost, label);
  }

  for (const box of [...layer].sort((left, right) => left.x - right.x || left.z - right.z)) {
    svg.append(renderCargo(box, bin, colors, hatchId));
  }
  drawBinFrames(svg, bin);
  if (showCog) drawCog(svg, bin);
  return svg;
}

function drawCog(svg, bin) {
  const cog = bin.cog;
  if (!cog) return;
  const warn = cog.longWarn || cog.latWarn;
  const stroke = warn ? "#9a3412" : "#0f5c54";
  const mark = svgEl("g", { class: warn ? "cg-mark is-warn" : "cg-mark" });
  mark.append(
    svgEl("circle", { cx: cog.x, cy: cog.z, r: 7, fill: warn ? "#fff4ee" : "#f4faf8", stroke, "stroke-width": 1.8 }),
    svgEl("line", { x1: cog.x - 12, y1: cog.z, x2: cog.x + 12, y2: cog.z, stroke, "stroke-width": 1.6 }),
    svgEl("line", { x1: cog.x, y1: cog.z - 12, x2: cog.x, y2: cog.z + 12, stroke, "stroke-width": 1.6 })
  );
  const label = svgEl("text", {
    x: cog.x + 14,
    y: cog.z - 8,
    "font-size": 11,
    "font-weight": "700",
    fill: stroke,
  });
  label.textContent = "重心";
  mark.append(label);
  svg.append(mark);
}

function drawBinFloor(svg, bin) {
  if (bin.kind === "fr") {
    svg.append(
      svgEl("rect", { x: 0, y: 0, width: bin.l, height: bin.w, fill: "#eef3f8" }),
      svgEl("line", {
        x1: 0, y1: 0, x2: bin.l, y2: 0, stroke: "#1d4e89", "stroke-width": 1.2, "stroke-dasharray": "8 6",
      }),
      svgEl("line", {
        x1: 0, y1: bin.w, x2: bin.l, y2: bin.w, stroke: "#1d4e89", "stroke-width": 1.2, "stroke-dasharray": "8 6",
      })
    );
    return;
  }
  svg.append(
    svgEl("rect", {
      x: 0,
      y: 0,
      width: bin.l,
      height: bin.w,
      fill: bin.kind === "ot" ? "#f8f4ea" : "#f6f0e4",
      stroke: "#143e39",
      "stroke-width": bin.kind === "ot" ? 1.6 : 1.4,
      "stroke-dasharray": bin.kind === "ot" ? "10 6" : null,
    })
  );
}

function drawBinFrames(svg, bin) {
  if (bin.kind === "fr") {
    svg.append(
      svgEl("rect", { class: "fr-end", x: 0, y: 0, width: 10, height: bin.w, fill: "#1d4e89" }),
      svgEl("rect", { class: "fr-end", x: bin.l - 10, y: 0, width: 10, height: bin.w, fill: "#1d4e89" })
    );
    return;
  }
  if (bin.kind !== "ot") return;
  const post = 12;
  for (const [x, y] of [[0, 0], [bin.l - post, 0], [0, bin.w - post], [bin.l - post, bin.w - post]]) {
    svg.append(svgEl("rect", { class: "ot-post", x, y, width: post, height: post, fill: "#143e39" }));
  }
}

function renderCargo(box, bin, colors, hatchId) {
  const color = colors.get(box.item.name) || CARGO_COLORS[0];
  const dim = sizeText(box.item);
  const weight = `${formatKg(box.item.kg)} kg`;
  const over = overhangParts(box, bin);
  const group = svgEl("g", {
    class: state.highlightId === String(box.item.id) ? "cargo is-hot" : "cargo",
    "data-piece": box.item.id,
  });
  const title = svgEl("title");
  title.textContent = `編號 ${box.item.id}　${box.item.name}　${dim} cm　${weight}　離地 ${formatDim(box.y)} cm${over.length ? `　${over.join("、")}` : ""}`;
  group.append(title);
  const x0 = box.x;
  const z0 = box.z;
  const z1 = box.z + box.dw;
  group.append(
    svgEl("rect", {
      x: x0,
      y: z0,
      width: box.dl,
      height: box.dw,
      fill: color.fill,
      rx: 1.5,
    })
  );
  const markOver = (attrs) => {
    group.append(svgEl("rect", {
      class: "overhang",
      fill: `url(#${hatchId})`,
      ...attrs,
    }));
  };
  if (z0 < -0.05) {
    markOver({
      x: x0,
      y: z0,
      width: box.dl,
      height: Math.min(z1, 0) - z0,
    });
  }
  if (z1 > bin.w + 0.05) {
    markOver({
      x: x0,
      y: Math.max(z0, bin.w),
      width: box.dl,
      height: z1 - Math.max(z0, bin.w),
    });
  }

  const longest = Math.max(String(box.item.id).length, dim.length, weight.length);
  const size = Math.min((box.dl * 0.88) / (longest * 0.62), (box.dw * 0.78) / 3.5, 16);
  if (box.y > 0.05) group.append(stackMark(box));
  const tipLines = [
    `編號 ${box.item.id}　${box.item.name}`,
    `${dim} cm`,
    weight,
  ];
  if (over.length) tipLines.push(over.join("、"));
  group.setAttribute("data-tip", tipLines.join("\n"));
  const centerX = box.x + box.dl / 2;
  const centerY = box.z + box.dw / 2;
  if (size >= 5.2) {
    group.setAttribute("data-label-size", String(roundFont(size)));
    const clipId = `piece-${box.item.id}`;
    const clip = svgEl("clipPath", { id: clipId });
    clip.append(
      svgEl("rect", {
        x: box.x + 1,
        y: box.z + 1,
        width: Math.max(0, box.dl - 2),
        height: Math.max(0, box.dw - 2),
      })
    );
    group.append(clip);
    const label = svgEl("g", { class: "cargo-full", "clip-path": `url(#${clipId})` });
    const gap = size * 1.22;
    label.append(
      cargoText(String(box.item.id), centerX, centerY - gap, size * 1.12, color.ink, "700"),
      cargoText(dim, centerX, centerY, size, color.ink, "600"),
      cargoText(weight, centerX, centerY + gap, size, color.ink, "600")
    );
    group.append(label);
    group.setAttribute("data-id-max", String(roundFont(Math.min(box.dl * 0.72, box.dw * 0.7))));
    group.append(cargoText(
      String(box.item.id),
      centerX,
      centerY,
      Math.min(box.dl * 0.46, box.dw * 0.46, 14),
      color.ink,
      "700",
      "cargo-id-alt"
    ));
  } else {
    group.classList.add("is-id-only");
    group.append(cargoText(
      String(box.item.id),
      centerX,
      centerY,
      Math.min(box.dl * 0.46, box.dw * 0.46, 14),
      color.ink,
      "700",
      "cargo-id"
    ));
  }
  if (over.length > 0) {
    const note = svgEl("text", {
      class: "oog-label",
      x: box.x + box.dl / 2,
      y: box.z - 4,
      "text-anchor": "middle",
      "font-size": 11,
      "font-weight": "700",
      fill: "#8a4b12",
    });
    note.textContent = over.join("、");
    group.append(note);
  }
  return group;
}

function stackMark(box) {
  const mark = svgEl("g", { class: "stack-mark", "aria-hidden": "true" });
  const x = box.x + 5;
  const y = box.z + 5;
  mark.append(svgEl("rect", { class: "stack-badge", x, y, width: 36, height: 16, rx: 4 }));
  mark.append(
    svgEl("rect", { x: x + 4, y: y + 3, width: 8, height: 4.5, rx: 0.8 }),
    svgEl("rect", { x: x + 2.2, y: y + 6.4, width: 8, height: 4.5, rx: 0.8 })
  );
  const text = svgEl("text", {
    x: x + 22,
    y: y + 8.6,
    "font-size": 9,
    "font-weight": "700",
    fill: "#9a5416",
    "dominant-baseline": "middle",
  });
  text.textContent = box.topStacked ? "上" : "疊";
  mark.append(text);
  return mark;
}

function cargoText(value, x, y, size, fill, weight, className) {
  const text = svgEl("text", {
    class: className,
    x,
    y,
    "text-anchor": "middle",
    "dominant-baseline": "middle",
    "font-size": roundFont(size),
    "font-weight": weight,
    fill,
  });
  text.textContent = value;
  return text;
}

function roundFont(size) {
  return Math.round(size * 10) / 10;
}

function visualWidth(text) {
  let width = 0;
  for (const char of text) width += char.charCodeAt(0) > 255 ? 1 : 0.55;
  return width;
}

function sharedPrefix(items) {
  const base = items[0];
  let end = 0;
  while (end < base.length && items.every((item) => item[end] === base[end])) end += 1;
  if (end === 0) return "";
  const shortest = Math.min(...items.map((item) => item.length));
  if (end >= shortest) {
    const cut = base.lastIndexOf(" ", shortest - 1);
    return cut > 0 ? base.slice(0, cut + 1) : "";
  }
  const prev = base[end - 1];
  const next = base[end];
  if (/[A-Za-z0-9]/.test(prev || "") && /[A-Za-z0-9]/.test(next || "")) {
    const cut = base.lastIndexOf(" ", end - 1);
    return cut > 0 ? base.slice(0, cut + 1) : "";
  }
  return base.slice(0, end);
}

function briefPieceName(full) {
  const stripped = String(full || "").replace(/^(?:pallet\s*)?#\s*\d+\s*/i, "").trim();
  if (!stripped) return "—";
  const items = stripped.split(" / ").map((item) => item.trim()).filter(Boolean);
  if (items.length <= 1) return stripped;
  const tails = items.map((item) => item.slice(sharedPrefix(items).length).trim()).filter(Boolean);
  if (tails.length === 0) return items[0];
  if (tails.length === 1) return tails[0];
  const lastShared = sharedPrefix(items).trim().split(/\s+/).filter(Boolean).pop() || "";
  const tailsAreShort = tails.every((tail) => visualWidth(tail) <= 8);
  const head = tailsAreShort && lastShared && /[^\u0000-\u00ff]/.test(lastShared) ? `${lastShared} ` : "";
  const joined = `${head}${tails.join(" / ")}`.trim();
  if (visualWidth(joined) > 22) return `${head}${tails[0]} 等 ${items.length} 項`.trim();
  return joined;
}

function renderPieceTable(layout, colors) {
  const showBin = layout.containers.length > 1;
  const rows = [];
  for (const bin of layout.containers) {
    for (const box of bin.placed) {
      rows.push({
        piece: box.item,
        binLabel: String(bin.index),
        binTitle: `第 ${bin.index} 櫃`,
        y: box.y,
        x: box.x,
        z: box.z,
        turned: Boolean(box.turned),
        spanned: Boolean(box.spanned),
        topStacked: Boolean(box.topStacked),
        endHang: endHangText(box),
        overhang: overhangParts(box, bin).join("、"),
        unpacked: false,
      });
    }
  }
  for (const piece of layout.unpacked) {
    rows.push({
      piece,
      binLabel: "未",
      binTitle: "未排入",
      y: "",
      x: "",
      z: "",
      turned: false,
      spanned: false,
      topStacked: false,
      endHang: "",
      overhang: "",
      unpacked: true,
    });
  }
  rows.sort((left, right) => left.piece.id - right.piece.id);
  const showNote = rows.some((row) => row.turned || row.spanned || row.topStacked || row.endHang || row.overhang || (!showBin && row.unpacked));

  const columns = [
    { key: "color", label: "顏色", sr: true },
    { key: "id", label: "編號" },
    { key: "name", label: "品名" },
    { key: "size", label: "尺寸", title: "公分，長×寬×高", num: true },
    { key: "kg", label: "重量", title: "公斤", num: true },
  ];
  if (showBin) columns.push({ key: "bin", label: "櫃", title: "第幾櫃" });
  columns.push(
    { key: "y", label: "離地", title: "離地高度（公分）", num: true },
    { key: "x", label: "距封閉端", title: "距封閉端（公分）", num: true },
    { key: "z", label: "距上緣", title: "距上緣（公分）", num: true }
  );
  if (showNote) columns.push({ key: "note", label: "註", title: "轉向、超出或未排入" });

  const table = el("table", { class: "piece-table" });
  table.append(
    el("thead", {}, [
      el("tr", {}, columns.map((column) =>
        el("th", {
          class: [column.num ? "num" : "", column.key === "color" ? "swatch-col" : "", column.key === "bin" ? "bin" : ""].filter(Boolean).join(" "),
          text: column.sr ? null : column.label,
          attrs: { scope: "col", title: column.title || null },
        }, column.sr ? [el("span", { class: "sr-only", text: column.label })] : [])
      )),
    ])
  );

  const tbody = el("tbody");
  for (const row of rows) {
    const hot = state.highlightId === String(row.piece.id);
    const color = colors.get(row.piece.name) || CARGO_COLORS[0];
    const fullName = row.piece.name;
    const briefName = briefPieceName(fullName);
    const nameButton = el("button", {
      class: "piece-name",
      attrs: {
        type: "button",
        title: fullName,
        "aria-label": fullName,
        "data-shortened": briefName === fullName ? null : "true",
      },
      on: {
        click: (event) => {
          const nameNode = event.currentTarget;
          const open = nameNode.classList.contains("is-open");
          const shortened = nameNode.dataset.shortened === "true";
          if (open || shortened || nameNode.scrollWidth > nameNode.clientWidth + 1) {
            nameNode.classList.toggle("is-open");
            nameNode.setAttribute("aria-expanded", nameNode.classList.contains("is-open") ? "true" : "false");
          }
        },
      },
    }, [
      el("span", { class: "name-brief", text: briefName }),
      el("span", { class: "name-full", text: fullName }),
    ]);
    const cells = [
      el("td", { class: "swatch-cell" }, [
        el("i", { class: "swatch", attrs: { style: `background:${color.fill}`, "aria-hidden": "true" } }),
      ]),
      el("td", { text: String(row.piece.id) }),
      el("td", { class: "name-cell" }, [nameButton]),
      el("td", { class: "num", text: sizeText(row.piece) }),
      el("td", { class: "num", text: formatKg(row.piece.kg) }),
    ];
    if (showBin) cells.push(el("td", { class: "bin", attrs: { title: row.binTitle }, text: row.binLabel }));
    cells.push(
      el("td", { class: "num", text: row.y === "" ? "—" : formatDim(row.y) }),
      el("td", { class: "num", text: row.x === "" ? "—" : formatDim(row.x) }),
      el("td", { class: "num", text: row.z === "" ? "—" : formatDim(row.z) })
    );
    if (showNote) cells.push(el("td", { class: "note" }, [pieceNote(row, showBin)]));
    const tr = el("tr", { class: hot ? "is-hot" : "", attrs: { "data-piece": row.piece.id, tabindex: "0" } }, cells);
    tr.addEventListener("click", () => focusPiece(row.piece.id, "row"));
    tr.addEventListener("keydown", (event) => {
      if (event.target !== tr) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        focusPiece(row.piece.id, "row");
      }
    });
    tbody.append(tr);
  }
  table.append(tbody);
  return el("div", { class: "piece-list" }, [
    el("h3", { text: "每件明細" }),
    el("p", { class: "quiet", text: "點一列、2D 或 3D 上的貨，會互相標出來。明細尺寸是原本的長×寬×高（公分）；3D 提示用擺放後的長×寬×高。重量是公斤，距離是公分。" }),
    el("div", { class: "table-wrap" }, [table]),
  ]);
}

function pieceNote(row, showBin) {
  const bits = [];
  if (row.turned) bits.push(el("span", { class: "turn-mark", attrs: { title: "已轉向" }, text: "轉" }));
  if (row.topStacked) bits.push(el("span", { class: "over-mark", text: "上疊，需綁紮" }));
  else if (row.spanned) bits.push(el("span", { class: "over-mark", text: "跨放，需綁紮" }));
  if (row.endHang) bits.push(el("span", { class: "over-mark", text: row.endHang }));
  if (row.overhang) bits.push(el("span", { class: "over-mark", text: row.overhang }));
  if (!showBin && row.unpacked) bits.push(el("span", { attrs: { title: "排不進這組櫃" }, text: "未排入" }));
  if (bits.length === 0) return null;
  return el("span", { class: "note-bits" }, bits);
}

function viewTab(view, label) {
  const selected = state.diagramView === view;
  return el("button", {
    class: selected ? "view-tab is-on" : "view-tab secondary",
    text: label,
    attrs: {
      type: "button",
      role: "tab",
      id: `tab-${view}`,
      "data-view": view,
      "aria-selected": selected ? "true" : "false",
      "aria-controls": `panel-${view}`,
    },
    on: { click: () => setDiagramView(view) },
  });
}

function setDiagramView(view) {
  if (view !== "2d" && view !== "3d") return;
  state.diagramView = view;
  syncDiagramView();
}

function ensureScene() {
  if (!state.layout) return;
  if (sceneView) {
    sceneView.setActive(true);
    sceneView.setHighlight(state.highlightId);
    return;
  }
  const host = stage.querySelector(".view-3d-host");
  if (!host) return;
  sceneView = createSceneView(host, {
    layout: state.layout,
    colors: cargoPalette(state.layout.pieces),
    highlightId: state.highlightId,
    onSelect(id) {
      focusPiece(id, "3d");
    },
  });
}

function syncDiagramView() {
  const two = stage.querySelector(".view-2d");
  const three = stage.querySelector(".view-3d");
  if (!two || !three) return;
  const show3d = state.diagramView === "3d";
  two.hidden = show3d;
  three.hidden = !show3d;
  for (const button of stage.querySelectorAll(".view-tab")) {
    const on = button.dataset.view === state.diagramView;
    button.classList.toggle("is-on", on);
    button.classList.toggle("secondary", !on);
    button.setAttribute("aria-selected", on ? "true" : "false");
  }
  if (show3d) ensureScene();
  else {
    if (sceneView) sceneView.setActive(false);
    requestAnimationFrame(() => fitDeckLabels(two));
  }
}

function focusPiece(id, source) {
  state.highlightId = String(id);
  stage.querySelectorAll("[data-piece]").forEach((node) => {
    node.classList.toggle("is-hot", node.getAttribute("data-piece") === state.highlightId);
  });
  if (sceneView) sceneView.setHighlight(state.highlightId);
  const row = stage.querySelector(`tr[data-piece="${state.highlightId}"]`);
  const mark = stage.querySelector(`g[data-piece="${state.highlightId}"]`);
  const twoHidden = Boolean(stage.querySelector(".view-2d") && stage.querySelector(".view-2d").hidden);
  if (source !== "row" && row) row.scrollIntoView({ block: "nearest" });
  if (source !== "svg" && source !== "3d" && !twoHidden && mark) mark.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function setStep(step) {
  state.step = step;
  state.error = "";
  render();
}

function addRow() {
  state.rows.push(blankRow());
  syncUploadSnapshot();
  render();
}

function removeRow(index) {
  state.rows.splice(index, 1);
  if (state.rows.length === 0) state.rows.push(blankRow());
  syncUploadSnapshot();
  render();
}

function goToPlans() {
  state.totals = summarize(state.rows);
  state.plans = suggestPlans(state.totals.cbm, state.totals.kg, {
    stackable: state.stackable,
    floorCm2: state.totals.floorCm2,
    rows: state.rows,
  });
  state.planNote = state.plans.length ? "" : unplannedNote(state.rows, { stackable: state.stackable });
  state.selectedId = "";
  state.layout = null;
  state.highlightId = "";
  state.step = 3;
  render();
}

function openDiagram(planId) {
  const plan = state.plans.find((item) => item.id === planId);
  if (!plan) return;
  state.selectedId = planId;
  state.layout = buildLayout(plan, state.rows, { stackable: state.stackable });
  state.highlightId = "";
  state.diagramView = "2d";
  state.step = 4;
  render();
}

async function readFiles(fileList) {
  const files = [...fileList];
  const failures = [];
  const accepted = [];
  for (const file of files) {
    const classified = classifyUpload(file.name);
    if (classified.error) {
      failures.push(classified.error);
      continue;
    }
    if (file.size > MAX_BYTES) {
      failures.push(`${file.name} 超過 20 MB，請改傳裝箱單頁面。`);
      continue;
    }
    accepted.push({ file, kind: classified.kind });
  }
  if (!accepted.length) {
    state.loading = false;
    state.loadingText = "";
    state.error = failures.join(" ");
    render();
    return;
  }

  state.loading = true;
  state.error = "";
  state.loadingText = "正在讀取裝箱單…";
  render();

  const rows = [];
  const warnings = [];
  const names = [];
  let anyOcr = false;
  const prefix = accepted.length > 1;
  for (const entry of accepted) {
    try {
      const parsed = await parseUpload(entry.file, entry.kind, (text) => {
        state.loadingText = text;
        render();
      });
      if (parsed.ocr) anyOcr = true;
      rows.push(...parsed.rows);
      const tagged = prefix ? parsed.warnings.map((warning) => `${entry.file.name}：${warning}`) : parsed.warnings;
      warnings.push(...tagged);
      names.push(entry.file.name);
    } catch (error) {
      failures.push(failureText(entry.file, entry.kind));
    }
  }

  state.loading = false;
  state.loadingText = "";
  if (!names.length) {
    state.error = failures.join(" ");
    state.step = 1;
    render();
    return;
  }
  state.filename = names.join("、");
  state.files = accepted.filter((entry) => names.includes(entry.file.name)).map((entry) => ({
    name: entry.file.name,
    kind: fileBadge(entry.file.name),
  }));
  state.warnings = warnings;
  state.rows = rows.length ? rows.map(asEditable) : [blankRow()];
  state.ocr = anyOcr;
  state.stackable = true;
  state.rowsFrom = "upload";
  syncUploadSnapshot();
  state.selectedId = "";
  state.layout = null;
  state.highlightId = "";
  state.error = failures.join(" ");
  state.step = 2;
  render();
}

async function parseUpload(file, kind, onStatus) {
  if (kind === "pdf") {
    const items = await extractItems(await file.arrayBuffer());
    return { ...parseTextItems(items), ocr: false };
  }
  const converted = await convertToItems(file, onStatus);
  return { ...parseTextItems(converted.items), ocr: converted.source === "image" };
}

function failureText(file, kind) {
  if (kind === "pdf") return `${file.name}：PDF 讀取失敗。若是掃描圖片，請改傳該頁的 JPG 或 PNG。`;
  if (kind === "word") return `${file.name}：Word 讀取失敗。請確認是 .docx。`;
  if (kind === "image") return `${file.name}：圖片辨識失敗。請改傳較清楚的照片，或改傳 PDF、Excel、Word。`;
  if (kind === "excel") return `${file.name}：Excel 讀取失敗。請確認是 .xlsx、.xls 或 .csv。`;
  return `${file.name}：讀取失敗。`;
}

async function loadSample() {
  state.loading = true;
  state.error = "";
  state.ocr = false;
  state.loadingText = "正在讀取裝箱單…";
  render();
  try {
    const response = await fetch("sample/packing-list.pdf");
    if (!response.ok) throw new Error("sample missing");
    const items = await extractItems(await response.arrayBuffer());
    const parsed = parseTextItems(items);
    state.filename = "packing-list.pdf";
    state.files = [{ name: "packing-list.pdf", kind: "pdf" }];
    state.warnings = parsed.warnings;
    state.rows = parsed.rows.length ? parsed.rows.map(asEditable) : [blankRow()];
    state.stackable = true;
    state.rowsFrom = "upload";
    syncUploadSnapshot();
    state.selectedId = "";
    state.layout = null;
    state.highlightId = "";
    state.step = 2;
  } catch (error) {
    state.error = "範例裝箱單讀不到，請改選自己的 PDF。";
    state.step = 1;
  } finally {
    state.loading = false;
    state.loadingText = "";
    render();
  }
}

function asEditable(row) {
  const editable = {
    name: row.name,
    l: String(row.l),
    w: String(row.w),
    h: String(row.h),
    qty: String(row.qty),
    unitKg: row.unitKg === "" || row.unitKg == null ? "" : String(row.unitKg),
  };
  if (row.confidence) editable.confidence = { ...row.confidence };
  if (row.alert) editable.alert = row.alert;
  return editable;
}

async function extractItems(buffer) {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const doc = await task.promise;
  const items = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      items.push({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5] + pageNumber * 10000,
        w: item.width || 0,
      });
    }
  }
  await task.destroy();
  return items;
}

function blankManualRow() {
  return { name: "", l: "", w: "", h: "", qty: "", unitKg: "", upright: false };
}

function normalizeManualRow(row) {
  const next = blankManualRow();
  if (!row || typeof row !== "object") return next;
  next.name = row.name == null ? "" : String(row.name);
  for (const key of ["l", "w", "h", "qty", "unitKg"]) {
    next[key] = row[key] == null ? "" : String(row[key]);
  }
  next.upright = row.upright === true;
  return next;
}

function isBlankManualRow(row) {
  if (!row) return true;
  const textEmpty = MANUAL_FIELDS.every((key) => String(row[key] ?? "").trim() === "");
  return textEmpty && row.upright !== true;
}

function manualDraftHasData() {
  return state.manualRows.some((row) => !isBlankManualRow(row));
}

function manualKeyLabel(key) {
  return {
    name: "品名",
    l: "長",
    w: "寬",
    h: "高",
    qty: "數量",
    unitKg: "單件毛重",
  }[key];
}

function manualFieldError(row, key) {
  const label = manualKeyLabel(key);
  const raw = String(row[key] ?? "").trim();
  if (key === "name") return raw ? "" : "請填品名";
  if (!raw) return `請填${label}`;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return `${label}要大於 0`;
  return "";
}

function manualRowsToCheck() {
  const filled = state.manualRows.filter((row) => !isBlankManualRow(row));
  return filled.length ? filled : state.manualRows;
}

function manualRowShowsErrors(index) {
  if (!state.manualShowErrors) return false;
  return manualRowsToCheck().includes(state.manualRows[index]);
}

function refreshManualErrors() {
  const table = stage.querySelector(".manual-table");
  if (!table) return;
  table.querySelectorAll("tbody tr").forEach((tr, index) => {
    const row = state.manualRows[index];
    const show = manualRowShowsErrors(index);
    tr.querySelectorAll("[data-error-for]").forEach((node) => {
      const key = node.dataset.errorFor;
      const message = show && row ? manualFieldError(row, key) : "";
      node.textContent = message;
      node.hidden = !message;
      const input = tr.querySelector(`[data-key="${key}"]`);
      if (!input) return;
      input.setAttribute("aria-invalid", message ? "true" : "false");
      if (message) input.setAttribute("aria-describedby", node.id);
      else input.removeAttribute("aria-describedby");
    });
  });
}

function loadManualDraft() {
  state.manualRows = [blankManualRow()];
  state.manualStackable = true;
  try {
    const raw = localStorage.getItem(MANUAL_DRAFT_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.rows)) return;
    const rows = data.rows.map(normalizeManualRow);
    state.manualRows = rows.length ? rows : [blankManualRow()];
    if (typeof data.stackable === "boolean") state.manualStackable = data.stackable;
  } catch (error) {
    state.manualRows = [blankManualRow()];
    state.manualStackable = true;
  }
}

function saveManualDraft() {
  try {
    localStorage.setItem(MANUAL_DRAFT_KEY, JSON.stringify({
      rows: state.manualRows.map(normalizeManualRow),
      stackable: state.manualStackable,
    }));
  } catch (error) {
    /* 這台瀏覽器不讓網頁寫入本機儲存時，這次仍可繼續配載。 */
  }
}

function addManualRow() {
  state.manualRows.push(blankManualRow());
  saveManualDraft();
  render();
  const names = stage.querySelectorAll('.manual-table input[data-key="name"]');
  const last = names[names.length - 1];
  if (last) last.focus();
}

function removeManualRow(index) {
  state.manualRows.splice(index, 1);
  if (state.manualRows.length === 0) state.manualRows.push(blankManualRow());
  saveManualDraft();
  render();
}

function clearManualDraft() {
  if (!window.confirm("要清空手動輸入的資料嗎？清空後無法還原。")) return;
  state.manualRows = [blankManualRow()];
  state.manualStackable = true;
  state.manualShowErrors = false;
  try {
    localStorage.removeItem(MANUAL_DRAFT_KEY);
  } catch (error) {
    /* 清不掉儲存時，畫面仍先回到空白列。 */
  }
  render();
}

function toManualRow(row) {
  const upright = row.tippable === true ? false : row.tippable === false ? true : !canTip(row);
  return {
    name: row.name == null ? "" : String(row.name),
    l: row.l == null ? "" : String(row.l),
    w: row.w == null ? "" : String(row.w),
    h: row.h == null ? "" : String(row.h),
    qty: row.qty == null ? "" : String(row.qty),
    unitKg: row.unitKg == null ? "" : String(row.unitKg),
    upright,
  };
}

function importUploadToManual() {
  const snapshot = state.uploadSnapshot;
  if (!snapshot || !snapshot.rows.length) return;
  if (manualDraftHasData() && !window.confirm("目前的手動輸入會被上傳結果取代，要繼續嗎？")) return;
  state.manualRows = snapshot.rows.map(toManualRow);
  if (!state.manualRows.length) state.manualRows.push(blankManualRow());
  state.manualStackable = snapshot.stackable !== false;
  state.manualShowErrors = false;
  state.source = "manual";
  saveManualDraft();
  render();
}

function startManualLoad() {
  state.manualShowErrors = true;
  const targets = manualRowsToCheck();
  const invalid = targets.some((row) => MANUAL_FIELDS.some((key) => manualFieldError(row, key)));
  if (invalid) {
    render();
    const first = stage.querySelector('.manual-table input[aria-invalid="true"]');
    if (first) first.focus();
    return;
  }
  const usable = state.manualRows.filter((row) => !isBlankManualRow(row));
  state.rows = usable.map((row) => ({
    name: String(row.name).trim(),
    l: String(row.l).trim(),
    w: String(row.w).trim(),
    h: String(row.h).trim(),
    qty: String(row.qty).trim(),
    unitKg: String(row.unitKg).trim(),
    tippable: !row.upright,
  }));
  state.stackable = state.manualStackable;
  state.rowsFrom = "manual";
  state.filename = "手動輸入";
  state.files = [{ name: "手動輸入" }];
  state.warnings = [];
  state.ocr = false;
  state.error = "";
  state.manualShowErrors = false;
  goToPlans();
}

function cloneEditableRow(row) {
  const copy = {
    name: row.name,
    l: row.l,
    w: row.w,
    h: row.h,
    qty: row.qty,
    unitKg: row.unitKg,
  };
  if (row.tippable === true || row.tippable === false) copy.tippable = row.tippable;
  if (row.confidence) copy.confidence = { ...row.confidence };
  if (row.alert) copy.alert = row.alert;
  return copy;
}

function syncUploadSnapshot() {
  if (state.rowsFrom !== "upload") return;
  state.uploadSnapshot = {
    stackable: state.stackable,
    rows: state.rows.map(cloneEditableRow),
  };
}

loadManualDraft();
render();
