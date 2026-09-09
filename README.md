# Receipt Claim Generator

Photograph the receipts, get back a completed finance claim form.

Built in August 2025 while I was serving as a firefighter with the Singapore Civil Defence Force. Station officers spent hours each week reading receipts and typing the figures, vendor, category codes and claimant details into a Word claim template. This tool does that from photos, and the officer checks the result instead of producing it. In use it saved roughly six hours a week per officer.

## Pipeline

```
Up to 5 receipt photos
   │
   ▼
AWS Textract AnalyzeExpense  ──▶  fields with per-field confidence (vendor, date, receipt no., line items, totals)
   │
   ▼
Confidence gate + total selection
   • fields below the threshold are dropped, not guessed
   • candidate totals are scored (NET / TOTAL / AMOUNT DUE labels, position, magnitude)
   • if candidates disagree, Claude on Amazon Bedrock is asked to pick, given the receipt text
   │
   ▼
Item naming (OpenAI)  ──▶  "Refreshments from PRIME Supermarket" instead of "PRIME SUPERMKT 0342"
   │                        plus a suggested purpose and expense category
   ▼
docxtemplater  ──▶  .docx claim form: dynamic receipt rows, a merged Purpose column,
                    expense-category tick boxes, claimant block in caps, signature image. Category codes are configured per organisation.
```

The Word template is the organisation's own claim form, which is not included here. The generator fills placeholders (`{claimantName}`, `{#receipts}...{/receipts}`) and post-processes the document XML to vertically merge the Purpose cell across rows and set tight text wrapping on the signature image. `templates/README.md` lists every placeholder.

## Why it is built this way

- **The model is never the source of truth for numbers.** Amounts come from Textract with a confidence score. The LLMs only choose between candidates Textract already produced, or write descriptive text. A wrong item name is an annoyance. A wrong total is a finance incident.
- **Fail visibly.** Low-confidence fields are shown as blank in the preview so the officer fills them in, rather than silently filled with a guess.
- **Directory, not re-entry.** Claimants and approving officers are stored once (name, designation, unit, signature image) and picked from a list. The repository ships example entries only.

## Stack

Node.js, Express 5 · AWS Textract, Amazon Bedrock (Claude), OpenAI · docxtemplater, PizZip, JSZip · Docker

## Run it

```bash
cp .env.example .env          # AWS credentials, region, confidence threshold, optional OpenAI and Bedrock settings
cp data/claimants.example.json data/claimants.json
cp data/approving-officers.example.json data/approving-officers.json
npm install
npm run dev                   # http://localhost:3000
```

Or `docker compose up`. A `render.yaml` is included for one-click hosting on Render.

## Notes on data

The production deployment held the organisation's claim form, real claimant details and signature images. None of that is in this repository: supply your own `templates/claim-template.docx` using the placeholders in `templates/README.md`. `data/*.json` and `signatures/` are git-ignored except for the example files.

---

Shahu Wagh · [shahuwagh.com](https://www.shahuwagh.com) · [github.com/Shahu-123](https://github.com/Shahu-123)
