# CareerForge

CareerForge is a working Phase 1 web app for preparing and tracking job applications. The local edition uses Node.js 24 and SQLite. The private hosted edition uses ChatGPT sign-in and D1.

## Run locally

1. Install Node.js 24 or newer.
2. Extract this folder and open a terminal in it.
3. Run `node server.mjs`.
4. Open [CareerForge](http://127.0.0.1:4310) in your browser.

The app opens with a sample workspace. Create an account for a separate workspace with data saved on this computer. The app binds to loopback, and keeps account and workspace data in the `data` folder. Use Settings to export or delete your workspace data.

## Try the workflow

1. Add career details in **My Career Profile**, or import a résumé and review the extracted fields.
2. In **Opportunity Analyzer**, paste a job description or enter a supported public job URL. The app highlights recognized skills and gaps using your saved profile.
3. Generate a résumé or cover letter. Use **Document Studio** to edit drafts, review prior revisions, and export PDF or DOCX.
4. Save the opportunity to **Application Tracker**, then add a deadline and update its status.
5. Use **Career Assistant** for profile, skills, and tracking guidance based on the current workspace.

## Current implementation

- Drafts, matching, import field suggestions, and the career assistant use local rules and templates. They do not call a language-model API. Review imported data and drafts before using them.
- DOCX and TXT imports are available locally and on the hosted edition. Local PDF import needs Python with `pypdf`. Scanned PDFs need OCR before import. URL extraction is local and supports publicly accessible HTTPS postings with structured JobPosting data. Pasting descriptions works in either edition. DOCX export preserves scripts that the built-in PDF font cannot render.
- The hosted edition uses ChatGPT sign-in for its private workspace. The local edition has email/password accounts without email verification or recovery mail. The current storage and server stack is lightweight for this release.
- Scholarship workflows, browser extension, interview preparation, opportunity discovery, and advanced analytics are later roadmap items.

For PDF import with Python, run `python -m pip install pypdf`. For supported public links that decline automated access, paste the posting text.
