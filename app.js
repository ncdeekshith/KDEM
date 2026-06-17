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
  endpointPreset: document.querySelector("#endpointPreset"),
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

function normalizeKeyName(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseJsonMaybe(value) {
  let current = value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (typeof current !== "string") return current;
    const trimmed = current.trim();
    if (!trimmed || !["{", "[", '"'].includes(trimmed[0])) return current;
    try {
      current = JSON.parse(trimmed);
    } catch {
      return current;
    }
  }
  return current;
}

function normalizeResponseTree(value) {
  const parsed = parseJsonMaybe(value);

  if (Array.isArray(parsed)) {
    return parsed.map((item) => normalizeResponseTree(item));
  }

  if (!parsed || typeof parsed !== "object") {
    return parsed;
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([key, child]) => [key, normalizeResponseTree(child)]),
  );
}

function xmlTagValue(xmlText, candidateTags) {
  if (typeof xmlText !== "string" || !xmlText.trim().startsWith("<")) return "";
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "application/xml");
  if (xml.querySelector("parsererror")) return "";

  for (const tag of candidateTags) {
    const element = xml.querySelector(tag);
    const value = element?.textContent?.trim();
    if (value) return value;
  }

  return "";
}

function xmlTagValues(xmlText, candidateTags) {
  if (typeof xmlText !== "string" || !xmlText.trim().startsWith("<")) return [];
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "application/xml");
  if (xml.querySelector("parsererror")) return [];

  const values = [];
  for (const tag of candidateTags) {
    for (const element of xml.querySelectorAll(tag)) {
      const value = element.textContent?.trim();
      if (value) values.push(value);
    }
  }
  return [...new Set(values)];
}

function firstByNormalizedKey(data, candidateKeys) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const normalizedCandidates = new Set(candidateKeys.map(normalizeKeyName));
  return Object.entries(data).find(([key]) => normalizedCandidates.has(normalizeKeyName(key)))?.[1];
}

function findFirstValue(data, candidateKeys) {
  const normalizedCandidates = new Set(candidateKeys.map(normalizeKeyName));
  const queue = [data];

  while (queue.length) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    if (!current || typeof current !== "object") continue;

    for (const [key, value] of Object.entries(current)) {
      if (normalizedCandidates.has(normalizeKeyName(key)) && value !== null && value !== "") {
        return value;
      }
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }

  return "";
}

function collectObjectsByAncestorAndKey(data, ancestorKey, targetKey) {
  const matches = [];
  const normalizedAncestor = normalizeKeyName(ancestorKey);
  const normalizedTarget = normalizeKeyName(targetKey);

  function visit(value, ancestors = []) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, ancestors);
      return;
    }

    if (!value || typeof value !== "object") return;

    for (const [key, child] of Object.entries(value)) {
      const nextAncestors = [...ancestors, normalizeKeyName(key)];
      if (
        normalizeKeyName(key) === normalizedTarget &&
        Array.isArray(child) &&
        ancestors.includes(normalizedAncestor)
      ) {
        matches.push(...child.filter((item) => item && typeof item === "object"));
      }
      visit(child, nextAncestors);
    }
  }

  visit(data);
  return matches;
}

function collectObjectsWithNameKeys(data, candidateNameKeys) {
  const normalizedNameKeys = new Set(candidateNameKeys.map(normalizeKeyName));
  const objects = [];

  function visit(value) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;

    if (Object.keys(value).some((key) => normalizedNameKeys.has(normalizeKeyName(key)))) {
      objects.push(value);
    }

    for (const child of Object.values(value)) visit(child);
  }

  visit(data);
  return objects;
}

function unwrapPayload(payload) {
  payload = normalizeResponseTree(payload);
  if (!payload || typeof payload !== "object") return payload;

  let current = payload;
  for (let depth = 0; depth < 5; depth += 1) {
    const next = firstByNormalizedKey(current, [
      "data",
      "result",
      "company",
      "companyData",
      "masterData",
      "response",
      "reportData",
      "DirectorList",
    ]);
    if (next && typeof next === "object" && !Array.isArray(next)) {
      current = next;
    } else {
      break;
    }
  }

  return current;
}

function parseDirectors(companyData) {
  let directors = collectObjectsByAncestorAndKey(companyData, "DirectorCurrentMasterBasic", "Director");

  if (!directors.length) {
    const directDirectorArray =
      companyData.directors ||
      companyData.Directors ||
      companyData.currentDirectors ||
      deepGet(companyData, [
        ["directorData"],
        ["currentDirectors"],
        ["masterData", "directors"],
        ["management", "directors"],
      ]);
    if (Array.isArray(directDirectorArray)) directors = directDirectorArray;
  }

  if (!directors.length) {
    directors = collectObjectsWithNameKeys(companyData, ["DirectorName", "directorName", "name", "personName"]);
  }

  const names = [];
  for (const director of directors) {
    let name = "";
    let status = "";

    if (typeof director === "string") {
      name = director.trim();
    } else if (director && typeof director === "object") {
      name = String(
        director.DirectorName ||
          director.directorName ||
          director.name ||
          director.fullName ||
          director.personName ||
          "",
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

function parseContactDetails(companyData) {
  const email = findFirstValue(companyData, [
    "CompanyEmail",
    "EmailID",
    "EmailId",
    "Email",
    "email",
    "RegisteredEmail",
  ]);
  const phone = findFirstValue(companyData, [
    "ContactNo",
    "ContactNumber",
    "MobileNumber",
    "PhoneNumber",
    "Telephone",
    "CompanyPhone",
    "CompanyContactNo",
  ]);
  const website = findFirstValue(companyData, ["CompanyWebSite", "CompanyWebsite", "Website", "WebSite"]);

  return [
    email ? `Email: ${email}` : "",
    phone ? `Phone: ${phone}` : "",
    website ? `Website: ${website}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

function parseCompanyResponse(cin, payload) {
  const normalizedPayload = normalizeResponseTree(payload);
  const companyData = unwrapPayload(normalizedPayload);
  const rawText = typeof normalizedPayload === "string" ? normalizedPayload : "";
  const responseStatus = extractResponseStatus(normalizedPayload);
  const companyName = deepGet(companyData, [
    ["companyName"],
    ["name"],
    ["masterData", "companyName"],
    ["companyMasterData", "companyName"],
    ["basicDetails", "companyName"],
  ]) || findFirstValue(companyData, ["CompanyName", "EntityName", "LegalName"])
    || xmlTagValue(rawText, ["CompanyName", "EntityName", "LegalName"]);
  const registeredAddress = deepGet(companyData, [
    ["registeredAddress"],
    ["registeredOfficeAddress"],
    ["address"],
    ["masterData", "registeredAddress"],
    ["companyMasterData", "registeredAddress"],
    ["basicDetails", "registeredAddress"],
  ]) || findFirstValue(companyData, [
    "CompanyFullAddress",
    "RegisteredAddress",
    "CompanyAddress",
    "Address",
    "PrincipalPlaceofBusiness",
  ]) || xmlTagValue(rawText, [
    "CompanyFullAddress",
    "RegisteredAddress",
    "CompanyAddress",
    "Address",
    "PrincipalPlaceofBusiness",
  ]);
  const industrySector = deepGet(companyData, [
    ["industry"],
    ["sector"],
    ["activityDescription"],
    ["principalBusinessActivity"],
    ["masterData", "industry"],
    ["companyMasterData", "activityDescription"],
    ["basicDetails", "activityDescription"],
  ]) || findFirstValue(companyData, [
    "CompanyMcaIndustry",
    "CompanyMcaIndustryDivision",
    "Industry",
    "McaIndustry",
    "ActivityDescription",
    "PrincipalBusinessActivity",
  ]) || xmlTagValue(rawText, [
    "CompanyMcaIndustry",
    "CompanyMcaIndustryDivision",
    "Industry",
    "McaIndustry",
    "ActivityDescription",
    "PrincipalBusinessActivity",
  ]);
  const contactPerson =
    parseDirectors(companyData) || xmlTagValues(rawText, ["DirectorName", "ContactPerson", "SignatoryName"]).join(", ");
  const contactDetails = parseContactDetails(companyData) || [
    xmlTagValue(rawText, ["CompanyEmail", "EmailID", "Email", "RegisteredEmail"]),
    xmlTagValue(rawText, ["ContactNo", "ContactNumber", "MobileNumber", "PhoneNumber"]),
    xmlTagValue(rawText, ["CompanyWebSite", "CompanyWebsite", "Website", "WebSite"]),
  ].filter(Boolean).join(" | ");

  const result = {
    CIN: cin,
    "Company Name": String(companyName || "").trim(),
    "Company Address": String(registeredAddress || "").trim(),
    Sector: String(industrySector || "").trim(),
    "Contact Person": contactPerson,
    "Contact Details": contactDetails,
    "Enrichment Status": "Success",
    Error: "",
    "Debug Response": summarizeResponse(normalizedPayload),
  };

  if (
    !result["Company Name"] &&
    !result["Company Address"] &&
    !result.Sector &&
    !result["Contact Person"] &&
    !result["Contact Details"]
  ) {
    result["Enrichment Status"] = responseStatus
      ? "No company data returned"
      : "Completed - no mapped fields found";
    result.Error = responseStatus;
  }

  return result;
}

function extractResponseStatus(payload) {
  const response = firstByNormalizedKey(payload, ["Response", "StatusResponse", "Result", "Data"]) || payload;
  if (!response || typeof response !== "object" || Array.isArray(response)) return "";

  const parts = [];
  for (const key of [
    "Status",
    "Type",
    "Message",
    "Error",
    "ErrorMessage",
    "Remarks",
    "Description",
    "Reason",
  ]) {
    const value = firstByNormalizedKey(response, [key]);
    const displayValue = compactDebugValue(value);
    if (displayValue) {
      parts.push(`${key}: ${displayValue}`);
    }
  }

  return parts.join(" | ");
}

function compactDebugValue(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "object") return String(value);

  try {
    return JSON.stringify(value).slice(0, 400);
  } catch {
    return String(value);
  }
}

function summarizeResponse(payload) {
  const normalized = normalizeResponseTree(payload);
  if (typeof normalized === "string") return normalized.slice(0, 500);
  if (!normalized || typeof normalized !== "object") return String(normalized ?? "");

  const topKeys = Object.keys(normalized).slice(0, 12).join(", ");
  const reportKeys = firstByNormalizedKey(normalized, ["ReportData", "Response", "Data"]);
  const nestedKeys =
    reportKeys && typeof reportKeys === "object" && !Array.isArray(reportKeys)
      ? Object.keys(reportKeys).slice(0, 12).join(", ")
      : "";
  const responseStatus = extractResponseStatus(normalized);
  const responsePreview = reportKeys ? compactDebugValue(reportKeys) : "";

  return [
    nestedKeys ? `Top keys: ${topKeys} | Nested keys: ${nestedKeys}` : `Top keys: ${topKeys}`,
    responseStatus,
    responsePreview ? `Preview: ${responsePreview}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
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
  };
  if (authHeaderMode === "react-access-key") headers["react-access-key"] = apiKey;
  if (authHeaderMode === "user-key") headers["user-key"] = apiKey;
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
    headers["Content-Type"] = "application/json";
    request.body = usesTemplate ? "{}" : JSON.stringify({ cin, fcin: cin });
  }

  try {
    const response = await fetch(url, request);
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    return parseCompanyResponse(cin, text ? parseJsonMaybe(text) : {});
  } catch (error) {
    return {
      CIN: cin,
      "Company Name": "",
      "Company Address": "",
      Sector: "",
      "Contact Person": "",
      "Contact Details": "",
      "Enrichment Status": "Failed",
      Error: error.message,
      "Debug Response": "",
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
          <td>${escapeHtml(row["Contact Details"] || "")}</td>
          <td>${escapeHtml(row["Contact Person"] || "")}</td>
          <td>${escapeHtml(row["Company Address"] || "")}</td>
          <td>${escapeHtml(row.Sector || "")}</td>
          <td>${escapeHtml(row["Enrichment Status"] || "")}</td>
          <td class="${row.Error ? "error" : ""}">${escapeHtml(row.Error || "")}</td>
          <td>${escapeHtml(row["Debug Response"] || "")}</td>
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
  els.endpointPreset.addEventListener("change", () => {
    els.endpointTemplate.value = els.endpointPreset.value;
  });
  els.downloadCsv.addEventListener("click", downloadCsv);
  els.downloadXlsx.addEventListener("click", downloadXlsx);
  els.connectFirebase.addEventListener("click", connectFirebase);
  els.saveRun.addEventListener("click", saveRun);
  els.loadRuns.addEventListener("click", loadRuns);
}

init();
