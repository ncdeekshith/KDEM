from __future__ import annotations

import io
import re
import time
from dataclasses import dataclass
from typing import Any

import pandas as pd
import requests
import streamlit as st


DEFAULT_API_ENDPOINT = "https://api.instafinancials.com/InstaReports/v1/InstaBasic/CompanyCIN/{cin}/All"
REQUEST_TIMEOUT_SECONDS = 30


@dataclass
class EnrichmentResult:
    cin: str
    company_name: str = ""
    registered_address: str = ""
    industry_sector: str = ""
    director_names: str = ""
    status: str = "Success"
    error: str = ""


def normalize_cin(value: Any) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip().upper()


def find_cin_column(columns: list[str]) -> str | None:
    normalized_columns = {column: re.sub(r"[^a-z0-9]", "", column.lower()) for column in columns}

    for column, normalized in normalized_columns.items():
        if normalized in {"cin", "fcin"}:
            return column

    for column, normalized in normalized_columns.items():
        if "cin" in normalized or "fcin" in normalized:
            return column

    return None


def read_uploaded_file(uploaded_file: Any) -> pd.DataFrame:
    file_name = uploaded_file.name.lower()

    if file_name.endswith(".csv"):
        return pd.read_csv(uploaded_file, dtype=str).fillna("")

    if file_name.endswith(".xlsx"):
        return pd.read_excel(uploaded_file, dtype=str, engine="openpyxl").fillna("")

    raise ValueError("Unsupported file type. Please upload a CSV or XLSX file.")


def build_manual_dataframe(raw_text: str) -> pd.DataFrame:
    cins = [normalize_cin(line) for line in raw_text.splitlines()]
    cins = [cin for cin in cins if cin]
    return pd.DataFrame({"CIN": cins})


def deep_get(data: dict[str, Any], candidate_paths: list[tuple[str, ...]]) -> Any:
    for path in candidate_paths:
        current: Any = data
        for key in path:
            if not isinstance(current, dict) or key not in current:
                current = None
                break
            current = current[key]
        if current not in (None, ""):
            return current
    return ""


def unwrap_api_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}

    for key in ("data", "result", "company", "companyData", "masterData", "response"):
        value = payload.get(key)
        if isinstance(value, dict):
            payload = value
            break

    return payload if isinstance(payload, dict) else {}


def parse_directors(company_data: dict[str, Any]) -> str:
    directors = company_data.get("directors")

    if directors is None:
        directors = deep_get(
            company_data,
            [
                ("directorData",),
                ("currentDirectors",),
                ("masterData", "directors"),
                ("management", "directors"),
            ],
        )

    if not isinstance(directors, list):
        return ""

    names: list[str] = []
    for director in directors:
        if isinstance(director, str):
            name = director.strip()
        elif isinstance(director, dict):
            name = str(
                director.get("name")
                or director.get("directorName")
                or director.get("fullName")
                or director.get("personName")
                or ""
            ).strip()
        else:
            name = ""

        status = ""
        if isinstance(director, dict):
            status = str(
                director.get("status")
                or director.get("directorStatus")
                or director.get("currentStatus")
                or ""
            ).strip().lower()

        if name and status not in {"resigned", "inactive", "ceased"}:
            names.append(name)

    return ", ".join(dict.fromkeys(names))


def parse_company_response(cin: str, payload: Any) -> EnrichmentResult:
    company_data = unwrap_api_payload(payload)

    company_name = deep_get(
        company_data,
        [
            ("companyName",),
            ("name",),
            ("masterData", "companyName"),
            ("companyMasterData", "companyName"),
            ("basicDetails", "companyName"),
        ],
    )
    registered_address = deep_get(
        company_data,
        [
            ("registeredAddress",),
            ("registeredOfficeAddress",),
            ("address",),
            ("masterData", "registeredAddress"),
            ("companyMasterData", "registeredAddress"),
            ("basicDetails", "registeredAddress"),
        ],
    )
    industry_sector = deep_get(
        company_data,
        [
            ("industry",),
            ("sector",),
            ("activityDescription",),
            ("principalBusinessActivity",),
            ("masterData", "industry"),
            ("companyMasterData", "activityDescription"),
            ("basicDetails", "activityDescription"),
        ],
    )

    return EnrichmentResult(
        cin=cin,
        company_name=str(company_name or "").strip(),
        registered_address=str(registered_address or "").strip(),
        industry_sector=str(industry_sector or "").strip(),
        director_names=parse_directors(company_data),
    )


def call_instabasic_api(
    *,
    cin: str,
    api_key: str,
    endpoint: str,
    method: str,
) -> EnrichmentResult:
    request_url = endpoint.format(cin=cin, fcin=cin)
    uses_url_template = request_url != endpoint
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-API-Key": api_key,
        "Authorization": api_key,
    }

    try:
        if method == "GET":
            response = requests.get(
                request_url,
                params={} if uses_url_template else {"cin": cin, "fcin": cin},
                headers=headers,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        else:
            response = requests.post(
                request_url,
                json={} if uses_url_template else {"cin": cin, "fcin": cin},
                headers=headers,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )

        response.raise_for_status()
        payload = response.json()
        result = parse_company_response(cin, payload)

        if not any([result.company_name, result.registered_address, result.industry_sector, result.director_names]):
            result.status = "Completed - no mapped fields found"

        return result

    except requests.Timeout:
        return EnrichmentResult(cin=cin, status="Failed", error="Request timed out")
    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else "Unknown"
        return EnrichmentResult(cin=cin, status="Failed", error=f"HTTP {status_code}: {exc}")
    except requests.RequestException as exc:
        return EnrichmentResult(cin=cin, status="Failed", error=f"Request error: {exc}")
    except ValueError as exc:
        return EnrichmentResult(cin=cin, status="Failed", error=f"Invalid JSON response: {exc}")
    except Exception as exc:
        return EnrichmentResult(cin=cin, status="Failed", error=f"Unexpected error: {exc}")


def results_to_dataframe(results: list[EnrichmentResult]) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "CIN": result.cin,
                "Company Name": result.company_name,
                "Registered Address": result.registered_address,
                "Industry/Sector": result.industry_sector,
                "Director Names": result.director_names,
                "Enrichment Status": result.status,
                "Error": result.error,
            }
            for result in results
        ]
    )


def dataframe_to_xlsx_bytes(df: pd.DataFrame) -> bytes:
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Enriched Data")
    return output.getvalue()


def dataframe_to_csv_bytes(df: pd.DataFrame) -> bytes:
    return df.to_csv(index=False).encode("utf-8-sig")


def merge_original_with_results(original_df: pd.DataFrame, cin_column: str, results_df: pd.DataFrame) -> pd.DataFrame:
    working_df = original_df.copy()
    working_df["_normalized_cin_for_join"] = working_df[cin_column].map(normalize_cin)

    enrichment_df = results_df.copy()
    enrichment_df["_normalized_cin_for_join"] = enrichment_df["CIN"].map(normalize_cin)

    merged_df = working_df.merge(
        enrichment_df.drop(columns=["CIN"]),
        how="left",
        on="_normalized_cin_for_join",
    )
    return merged_df.drop(columns=["_normalized_cin_for_join"])


def render_sidebar() -> tuple[str, float, str, str]:
    st.sidebar.header("Configuration")
    api_key = st.sidebar.text_input("InstaFinancials API Key", type="password")
    delay_seconds = st.sidebar.number_input(
        "Delay between requests (in seconds)",
        min_value=0.0,
        max_value=60.0,
        value=1.0,
        step=0.5,
    )

    with st.sidebar.expander("Advanced API settings"):
        endpoint = st.text_input("InstaBasic API endpoint", value=DEFAULT_API_ENDPOINT)
        method = st.selectbox("HTTP method", options=["GET", "POST"], index=0)

    return api_key, float(delay_seconds), endpoint.strip(), method


def main() -> None:
    st.set_page_config(page_title="B2B Data Enrichment Tool", page_icon="IF", layout="wide")

    st.title("B2B Data Enrichment Tool")
    st.caption("Upload Indian company CIN/FCIN data, enrich it through InstaFinancials InstaBasic, and export the result.")

    api_key, delay_seconds, endpoint, method = render_sidebar()

    left_column, right_column = st.columns(2)
    with left_column:
        uploaded_file = st.file_uploader("Upload a CSV or Excel file", type=["csv", "xlsx"])
    with right_column:
        manual_cins = st.text_area("Or paste CINs/FCINs manually", height=150, placeholder="U12345MH2020PLC123456")

    start = st.button("Start Enrichment", type="primary")

    if not start:
        return

    if not api_key:
        st.error("Please enter your InstaFinancials API key in the sidebar.")
        return

    if not endpoint:
        st.error("Please enter the InstaBasic API endpoint.")
        return

    try:
        if uploaded_file is not None:
            source_df = read_uploaded_file(uploaded_file)
            cin_column = find_cin_column(list(source_df.columns))
            if cin_column is None:
                st.error("Could not find a CIN or FCIN column in the uploaded file.")
                return
        elif manual_cins.strip():
            source_df = build_manual_dataframe(manual_cins)
            cin_column = "CIN"
        else:
            st.error("Please upload a file or paste at least one CIN/FCIN.")
            return
    except Exception as exc:
        st.error(f"Unable to read input: {exc}")
        return

    source_df[cin_column] = source_df[cin_column].map(normalize_cin)
    cin_values = [cin for cin in source_df[cin_column].dropna().map(normalize_cin).tolist() if cin]
    unique_cins = list(dict.fromkeys(cin_values))

    if not unique_cins:
        st.error("No valid CIN/FCIN values were found.")
        return

    st.info(f"Found {len(unique_cins)} unique CIN/FCIN values to enrich.")

    progress_bar = st.progress(0)
    status_text = st.empty()
    result_container = st.empty()

    results: list[EnrichmentResult] = []
    total = len(unique_cins)

    for index, cin in enumerate(unique_cins, start=1):
        status_text.write(f"Processing company {index} of {total}: {cin}")

        result = call_instabasic_api(
            cin=cin,
            api_key=api_key,
            endpoint=endpoint,
            method=method,
        )
        results.append(result)

        progress_bar.progress(index / total)
        result_container.dataframe(results_to_dataframe(results), use_container_width=True, hide_index=True)

        if index < total and delay_seconds > 0:
            time.sleep(delay_seconds)

    status_text.success(f"Enrichment complete. Processed {total} CIN/FCIN values.")

    results_df = results_to_dataframe(results)
    final_df = merge_original_with_results(source_df, cin_column, results_df)

    st.subheader("Preview")
    preview_columns = [
        column
        for column in ["CIN", "Company Name", "Registered Address", "Industry/Sector", "Director Names", "Enrichment Status", "Error"]
        if column in final_df.columns
    ]
    if cin_column not in preview_columns:
        preview_columns.insert(0, cin_column)

    st.dataframe(final_df[preview_columns].head(100), use_container_width=True, hide_index=True)

    xlsx_bytes = dataframe_to_xlsx_bytes(final_df)
    csv_bytes = dataframe_to_csv_bytes(final_df)

    download_col_1, download_col_2 = st.columns(2)
    with download_col_1:
        st.download_button(
            "Download Enriched Data as XLSX",
            data=xlsx_bytes,
            file_name="enriched_company_data.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
    with download_col_2:
        st.download_button(
            "Download Enriched Data as CSV",
            data=csv_bytes,
            file_name="enriched_company_data.csv",
            mime="text/csv",
        )


if __name__ == "__main__":
    main()
