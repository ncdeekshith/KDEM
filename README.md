# KDEM B2B Data Enrichment Tool

Static web app for enriching Indian company CIN/FCIN records through the InstaFinancials InstaBasic API and saving completed runs to Firebase Firestore.

This version is designed for GitHub Pages. It does not need Python, Streamlit, Node, or a build step.

## Features

- Upload `.csv` or `.xlsx` files.
- Paste CIN/FCIN values manually.
- Auto-detect a `CIN` or `FCIN` column.
- Call InstaFinancials InstaBasic with a configurable endpoint and delay.
- Select the authentication header format expected by your InstaFinancials account.
- Preview company name, contact details, contact person, company address, and sector in the browser.
- Download enriched data as CSV or XLSX.
- Save enrichment runs to Firebase Firestore.
- Load recent saved runs from Firestore.

## GitHub Pages Deployment

The app is a static site that can be served directly from the repository root.

To enable GitHub Pages:

1. Open the repository on GitHub.
2. Go to **Settings** → **Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Select branch `main` and folder `/ (root)`.
5. Save.

The site will be available at:

```text
https://ncdeekshith.github.io/KDEM/
```

## Firebase Setup

1. Create a Firebase project.
2. Add a Web App in Firebase project settings.
3. Copy the Firebase config object.
4. Enable Firestore Database.
5. Open the deployed app and paste the Firebase config JSON in the sidebar.

Example config shape:

```json
{
  "apiKey": "YOUR_FIREBASE_WEB_API_KEY",
  "authDomain": "YOUR_PROJECT.firebaseapp.com",
  "projectId": "YOUR_PROJECT_ID",
  "storageBucket": "YOUR_PROJECT.appspot.com",
  "messagingSenderId": "123456789",
  "appId": "1:123456789:web:abcdef"
}
```

For quick testing, Firestore rules can temporarily allow writes from your app. For production, restrict access with Firebase Authentication and rules that match your user model.

## Important Security Note

GitHub Pages is static hosting. Static browser apps cannot keep the InstaFinancials API key secret, because every request runs from the user's browser.

This app keeps the InstaFinancials key out of GitHub by asking for it at runtime, but the key is still visible to the browser session and network inspector. For a stricter production deployment, put a Firebase Cloud Function or another backend proxy in front of InstaFinancials, store the InstaFinancials key as a server-side secret, and have this app call that proxy instead.

## Local Preview

Serve the folder locally:

```bash
python3 -m http.server 8080
```

Then visit:

```text
http://localhost:8080
```

## InstaFinancials Endpoint

The default endpoint template is the public JSON InstaBasic URL shown in InstaFinancials examples:

```text
https://instafinancials.com/api/InstaBasic/v1/json/CompanyCIN/{cin}/All
```

If your account uses a different endpoint, update it in the sidebar. The app supports `{cin}` and `{fcin}` placeholders, and also includes the `api.instafinancials.com/InstaReports/...` endpoint as a preset.

The default auth header is `user-key`, which the InstaFinancials docs describe as the header key for a user's public API key. If your account documentation specifies another format, change **Auth header** in the sidebar.
