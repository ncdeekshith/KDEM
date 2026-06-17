# B2B Data Enrichment Tool

Lightweight Streamlit app for enriching Indian company CIN/FCIN data through the InstaFinancials InstaBasic API.

## Install

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
streamlit run app.py
```

## Notes

- Upload `.csv` or `.xlsx` files, or paste CIN/FCIN values manually.
- The app automatically detects a column named `CIN`, `FCIN`, or a close case-insensitive equivalent.
- Use the sidebar to enter your API key and delay between requests.
- The default endpoint follows the public InstaFinancials docs example format:
  `https://api.instafinancials.com/InstaReports/v1/InstaBasic/CompanyCIN/{cin}/All`.
- Use **Advanced API settings** if your InstaFinancials account uses a different InstaBasic endpoint or request method.
- Failed CIN/FCIN lookups are captured in `Enrichment Status` and `Error` columns without stopping the batch.
