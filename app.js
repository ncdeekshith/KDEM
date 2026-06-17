import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  addDoc,
  collection,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const els = {
  apiKey: document.querySelector("#apiKey"),
  endpointTemplate: document.querySelector("#endpointTemplate"),
  authHeaderMode: document.querySelector("#authHeaderMode"),
  httpMethod: document.querySelector("#httpMethod"),
  delaySeconds: document.querySelector("#delaySeconds"),
  firebaseConfig: document.querySelector("#firebaseConfig"),
  connectFirebase: document.querySelector("#connectFirebase"),
  firebaseStatus: document.querySelector("#firebaseStatus"),
  fileInput: document.querySelector("#fileInput"),
  fileName: document.querySelector("#fileName"),
  dropZone: document.querySelector("#dropZone"),
  manualCins: document.querySelector("#manualCins"),
  startEnrichment: document.querySelector("#startEnrichment"),
  saveRun: document.querySelector("#saveRun"),
  loadRuns: document.querySelector("#loadRuns"),
  runHistory: document.querySelector("#runHistory"),
  runStatus: document.querySelector("#runStatus"),
  recordCount: document.querySelector("#recordCount"),
  progressBar: document.querySelector("#progressBar"),
  previewTableBody: document.querySelector("#previewTable tbody"),
  downloadCsv: document.querySelector("#downloadCsv"),
  downloadXlsx: document.querySelector("#downloadXlsx"),
};

const STORAGE_KEY = "kdemFirebaseConfig";

let sourceRows = [];
let cinColumn = "CIN";
let enrichedRows = [];
let firestore = null;

const sleep = (seconds) => new Promise((resolve) => window.setTimeout(resolve, seconds * 1000));

const normalizeCin = (value) => String(value ?? "").trim().toUpperCase();

const normalizeColumn = (column) => column.toLowerCase().replace(/[^a-z0-9]/g, "");

function findCinColumn(columns) {
  const exact = columns.find((column) => ["cin", "fcin"].includes(normalizeColumn(column)));
  if (exact) return exact;
  return columns.find((column) => normalizeColumn(column).includes("cin")) || null;
}

function deepGet(data, paths) {
  for (const path of paths) {
    let current = data;
    for (const key of path) {
      if (!current || typeof current !== "object" || !(key in current)) {
        current = "";
        break;
      }
      current = current[key];
    }
    if (current !== undefined && current !== null && current !== "") return current;
  }
  return "";
}

function unwrapPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  for (const key of ["data", "result", "company", "companyData", "masterData", "response"]) {
    if (payload[key] && typeof payload[key] === "object" && !Array.isArray(payload[key])) {
      return payload[key];
    }
  }
  return payload;
}

function parseDirectors(companyData) {
  let directors =
    companyData.directors ||
    deepGet(companyData, [
      ["directorData"],
      ["currentDirectors"],
      ["masterData", "directors"],
      ["management", "directors"],
    ]);

  if (!Array.isArray(directors)) return "";

  const names = [];
  for (const director of directors) {
    let name = "";
    let status = "";

    if (typeof director === "string") {
      name = director.trim();
    } else if (director && typeof director === "object") {
      name = String(
        director.name || director.directorName || director.fullName || director.personName || "",
      ).trim();
      status = String(
        director.status || director.directorStatus || director.currentStatus || "",
      ).toLowerCase();
    }

    if (name && !["resigned", "inactive", "ceased"].includes(status)) {
      names.push(name);
    }
  }

  return [...new Set(names)].join(", ");
}

function parseCompanyResponse(cin, payload) {
  const companyData = unwrapPayload(payload);
  const companyName = deepGet(companyData, [
    ["companyName"],
    ["name"],
    ["masterData", "companyName"],
    ["companyMasterData", "companyName"],
    ["basicDetails", "companyName"],
  ]);
  const registeredAddress = deepGet(companyData, [
    ["registeredAddress"],
    ["registeredOfficeAddress"],
    ["address"],
    ["masterData", "registeredAddress"],
    ["companyMasterData", "registeredAddress"],
    ["basicDetails", "registeredAddress"],
  ]);
  const industrySector = deepGet(companyData, [
    ["industry"],
    ["sector"],
    ["activityDescription"],
    ["principalBusinessActivity"],
    ["masterData", "industry"],
    ["companyMasterData", "activityDescription"],
    ["basicDetails", "activityDescription"],
  ]);

  const result = {
    CIN: cin,
    "Company Name": String(companyName || "").trim(),
    "Registered Address": String(registeredAddress || "").trim(),
    "Industry/Sector": String(industrySector || "").trim(),
    "Director Names": parseDirectors(companyData),
    "Enrichment Status": "Success",
    Error: "",
  };

  if (
    !result["Company Name"] &&
    !result["Registered Address"] &&
    !result["Industry/Sector"] &&
    !result["Director Names"]
  ) {
    result["Enrichment Status"] = "Completed - no mapped fields found";
  }

  return result;
}

async function callInstaBasic(cin) {
  const apiKey = els.apiKey.value.trim();
  const endpointTemplate = els.endpointTemplate.value.trim();
  const method = els.httpMethod.value;
  const authHeaderMode = els.authHeaderMode.value;
  const requestUrl = endpointTemplate.replaceAll("{cin}", encodeURIComponent(cin)).replaceAll(
    "{fcin}",
    encodeURIComponent(cin),
  );
  const usesTemplate = requestUrl !== endpointTemplate;
  const url = new URL(requestUrl);

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (authHeaderMode === "react-access-key") headers["react-access-key"] = apiKey;
  if (authHeaderMode === "authorization") headers.Authorization = apiKey;
  if (authHeaderMode === "bearer") headers.Authorization = `Bearer ${apiKey}`;
  if (authHeaderMode === "x-api-key") headers["X-API-Key"] = apiKey;

  const request = {
    method,
    headers,
  };

  if (method === "GET" && !usesTemplate) {
    url.searchParams.set("cin", cin);
    url.searchParams.set("fcin", cin);
  }

  if (method === "POST") {
    request.body = usesTemplate ? "{}" : JSON.stringify({ cin, fcin: cin });
  }

  try {
    const response = await fetch(url, request);
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    return parseCompanyResponse(cin, text ? JSON.parse(text) : {});
  } catch (error) {
    return {
      CIN: cin,
      "Company Name": "",
      "Registered Address": "",
      "Industry/Sector": "",
      "Director Names": "",
      "Enrichment Status": "Failed",
      Error: error.message,
    };
  }
}

function rowsFromManualInput() {
  return els.manualCins.value
    .split(/\r?\n/)
    .map(normalizeCin)
    .filter(Boolean)
    .map((cin) => ({ CIN: cin }));
}

async function readSelectedFile() {
  const file = els.fileInput.files[0];
  if (!file) return [];

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
}

function renderTable(rows) {
  const displayRows = rows.slice(0, 250);
  els.previewTableBody.innerHTML = displayRows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.CIN || "")}</td>
          <td>${escapeHtml(row["Company Name"] || "")}</td>
          <td>${escapeHtml(row["Registered Address"] || "")}</td>
          <td>${escapeHtml(row["Industry/Sector"] || "")}</td>
          <td>${escapeHtml(row["Director Names"] || "")}</td>
          <td>${escapeHtml(row["Enrichment Status"] || "")}</td>
          <td class="${row.Error ? "error" : ""}">${escapeHtml(row.Error || "")}</td>
        </tr>
      `,
    )
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function mergeResults(originalRows, results) {
  const resultMap = new Map(results.map((row) => [normalizeCin(row.CIN), row]));
  return originalRows.map((row) => {
    const cin = normalizeCin(row[cinColumn] || row.CIN);
    return { ...row, ...(resultMap.get(cin) || {}) };
  });
}

function setDownloadState(enabled) {
  els.downloadCsv.disabled = !enabled;
  els.downloadXlsx.disabled = !enabled;
  els.saveRun.disabled = !enabled || !firestore;
}

async function startEnrichment() {
  if (!els.apiKey.value.trim()) {
    alert("Enter your InstaFinancials API key first.");
    return;
  }

  const uploadedRows = await readSelectedFile();
  const manualRows = rowsFromManualInput();

  if (uploadedRows.length) {
    sourceRows = uploadedRows;
    cinColumn = findCinColumn(Object.keys(uploadedRows[0] || {}));
    if (!cinColumn) {
      alert("Could not find a CIN or FCIN column in the uploaded file.");
      return;
    }
  } else if (manualRows.length) {
    sourceRows = manualRows;
    cinColumn = "CIN";
  } else {
    alert("Upload a file or paste at least one CIN/FCIN.");
    return;
  }

  const uniqueCins = [
    ...new Set(sourceRows.map((row) => normalizeCin(row[cinColumn] || row.CIN)).filter(Boolean)),
  ];

  if (!uniqueCins.length) {
    alert("No valid CIN/FCIN values were found.");
    return;
  }

  enrichedRows = [];
  setDownloadState(false);
  els.startEnrichment.disabled = true;
  els.recordCount.textContent = `${uniqueCins.length} records`;
  els.progressBar.value = 0;
  renderTable([]);

  const delay = Number(els.delaySeconds.value || 0);
  for (let index = 0; index < uniqueCins.length; index += 1) {
    const cin = uniqueCins[index];
    els.runStatus.textContent = `Processing company ${index + 1} of ${uniqueCins.length}: ${cin}`;
    enrichedRows.push(await callInstaBasic(cin));
    els.progressBar.value = Math.round(((index + 1) / uniqueCins.length) * 100);
    renderTable(enrichedRows);

    if (index < uniqueCins.length - 1 && delay > 0) {
      await sleep(delay);
    }
  }

  enrichedRows = mergeResults(sourceRows, enrichedRows);
  els.runStatus.textContent = `Complete. Processed ${uniqueCins.length} CIN/FCIN values.`;
  renderTable(enrichedRows);
  setDownloadState(true);
  els.startEnrichment.disabled = false;
}

function downloadCsv() {
  const worksheet = XLSX.utils.json_to_sheet(enrichedRows);
  const csv = XLSX.utils.sheet_to_csv(worksheet);
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), "enriched_company_data.csv");
}

function downloadXlsx() {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(enrichedRows);
  XLSX.utils.book_append_sheet(workbook, worksheet, "Enriched Data");
  XLSX.writeFile(workbook, "enriched_company_data.xlsx");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function connectFirebase() {
  try {
    const config = JSON.parse(els.firebaseConfig.value);
    const firebaseApp = initializeApp(config);
    firestore = getFirestore(firebaseApp);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config, null, 2));
    els.firebaseStatus.textContent = `Connected to project ${config.projectId || "unknown"}`;
    els.saveRun.disabled = !enrichedRows.length;
  } catch (error) {
    firestore = null;
    els.firebaseStatus.textContent = `Firebase connection failed: ${error.message}`;
    els.saveRun.disabled = true;
  }
}

async function saveRun() {
  if (!firestore) {
    alert("Connect Firebase first.");
    return;
  }
  if (!enrichedRows.length) {
    alert("Run enrichment before saving.");
    return;
  }

  els.saveRun.disabled = true;
  els.runStatus.textContent = "Saving enrichment run to Firebase...";

  try {
    await addDoc(collection(firestore, "enrichmentRuns"), {
      createdAt: serverTimestamp(),
      source: els.fileInput.files[0]?.name || "manual-input",
      totalRecords: enrichedRows.length,
      successfulRecords: enrichedRows.filter((row) => row["Enrichment Status"] !== "Failed").length,
      failedRecords: enrichedRows.filter((row) => row["Enrichment Status"] === "Failed").length,
      rows: enrichedRows,
    });
    els.runStatus.textContent = "Saved enrichment run to Firebase.";
  } catch (error) {
    els.runStatus.textContent = `Firebase save failed: ${error.message}`;
  } finally {
    els.saveRun.disabled = false;
  }
}

async function loadRuns() {
  if (!firestore) {
    alert("Connect Firebase first.");
    return;
  }

  els.runHistory.innerHTML = "<p>Loading...</p>";
  try {
    const runsQuery = query(collection(firestore, "enrichmentRuns"), orderBy("createdAt", "desc"), limit(10));
    const snapshot = await getDocs(runsQuery);
    if (snapshot.empty) {
      els.runHistory.innerHTML = "<p>No saved runs found.</p>";
      return;
    }

    els.runHistory.innerHTML = snapshot.docs
      .map((doc) => {
        const run = doc.data();
        const createdAt = run.createdAt?.toDate?.().toLocaleString() || "Pending timestamp";
        return `
          <article class="history-item">
            <div>
              <p><strong>${escapeHtml(run.source || "Unknown source")}</strong></p>
              <small>${escapeHtml(createdAt)}</small>
            </div>
            <div>
              <p>${Number(run.totalRecords || 0)} records</p>
              <small>${Number(run.successfulRecords || 0)} successful, ${Number(run.failedRecords || 0)} failed</small>
            </div>
          </article>
        `;
      })
      .join("");
  } catch (error) {
    els.runHistory.innerHTML = `<p class="error">Unable to load runs: ${escapeHtml(error.message)}</p>`;
  }
}

function wireFileDrop() {
  els.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.dropZone.classList.add("dragover");
  });
  els.dropZone.addEventListener("dragleave", () => els.dropZone.classList.remove("dragover"));
  els.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("dragover");
    const [file] = event.dataTransfer.files;
    if (file) {
      els.fileInput.files = event.dataTransfer.files;
      els.fileName.textContent = file.name;
    }
  });
  els.fileInput.addEventListener("change", () => {
    els.fileName.textContent = els.fileInput.files[0]?.name || "No file selected";
  });
}

function init() {
  const savedConfig = localStorage.getItem(STORAGE_KEY);
  if (savedConfig) els.firebaseConfig.value = savedConfig;

  wireFileDrop();
  els.startEnrichment.addEventListener("click", startEnrichment);
  els.downloadCsv.addEventListener("click", downloadCsv);
  els.downloadXlsx.addEventListener("click", downloadXlsx);
  els.connectFirebase.addEventListener("click", connectFirebase);
  els.saveRun.addEventListener("click", saveRun);
  els.loadRuns.addEventListener("click", loadRuns);
}

init();
