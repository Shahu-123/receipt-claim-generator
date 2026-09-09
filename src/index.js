require('dotenv').config();
const OpenAI = require('openai');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { TextractClient, AnalyzeExpenseCommand } = require('@aws-sdk/client-textract');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const ImageModule = require('docxtemplater-image-module-free');
const JSZip = require('jszip');
const imageSize = require('image-size');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/signatures', express.static(path.join(__dirname, '..', 'signatures')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Prefer credentials from .env if provided; fall back to default provider chain otherwise
function getAwsCredentialsFromEnv() {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY;
    const sessionToken = process.env.AWS_SESSION_TOKEN || process.env.AWS_SECURITY_TOKEN;
    if (accessKeyId && secretAccessKey) {
        return sessionToken
            ? { accessKeyId, secretAccessKey, sessionToken }
            : { accessKeyId, secretAccessKey };
    }
    return undefined;
}

const awsRegion = process.env.AWS_REGION || 'us-east-1';
const awsCredentials = getAwsCredentialsFromEnv();
const textract = new TextractClient({ region: awsRegion, credentials: awsCredentials });
const bedrock = process.env.BEDROCK_MODEL
    ? new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || awsRegion, credentials: awsCredentials })
    : null;

function extractFieldsFromAnalyzeExpense(expenseResponse) {
	const docs = expenseResponse.ExpenseDocuments || [];
	const extracted = [];
	const threshold = Number(process.env.CONFIDENCE_THRESHOLD || 85);
	
	docs.forEach((doc, idx) => {
		const byType = {};
		(doc.SummaryFields || []).forEach((field) => {
			const type = field.Type?.Text || field.Type?.Text || 'UNKNOWN';
			const key = field.Type?.Text || 'UNKNOWN';
			const value = field.ValueDetection?.Text || '';
			const confidence = field.ValueDetection?.Confidence || field.Confidence || 0;
			
			// Only include fields that meet confidence threshold
			if (confidence >= threshold) {
				byType[type] = { key, value, confidence };
			}
		});
		extracted.push(byType);
	});
	return extracted;
}

async function runTextractAnalyzeExpense(buffers) {
	const perImage = [];
	for (const buffer of buffers) {
		const input = { Document: { Bytes: buffer } };
		const cmd = new AnalyzeExpenseCommand(input);
		const resp = await textract.send(cmd);
		perImage.push(resp);
	}
	return perImage;
}

function pickTopTotals(extracted, threshold) {
	const results = [];
	extracted.forEach((fields) => {
		const candidates = [];
		for (const [type, data] of Object.entries(fields)) {
			if (!data || !data.value) continue;
			const t = type.toUpperCase();
			if (t.includes('TOTAL') || t.includes('AMOUNT') || t.includes('BALANCE') || t.includes('NET') || t.includes('SUBTOTAL')) {
				candidates.push(data);
			}
		}
		candidates.sort((a,b)=> (b.confidence||0)-(a.confidence||0));
		const top = candidates[0];
		if (top && (top.confidence||0) >= threshold) {
			results.push({ total: top.value, confidence: top.confidence });
		} else {
			results.push({ total: null, confidence: top?.confidence || 0 });
		}
	});
	return results;
}

async function askAiToChooseTotal(context) {
	const numericBaseline = (context || []).map((c)=> ({...c, num: parseFloat((c.value||'').replace(/[^0-9.]/g,''))})).filter(c=>!isNaN(c.num));
	numericBaseline.sort((a,b)=> b.num - a.num);
	const fallback = numericBaseline[0]?.num ?? null;
	if (!bedrock || !process.env.BEDROCK_MODEL) return fallback;
	const prompt = `You are given extracted fields from a receipt. Pick the numeric value that represents the total (grand total after taxes/discounts). If unsure, return null. Respond with a single JSON object {"total": number|null}.

Candidates: ${JSON.stringify(context)}\n`;
	const input = {
		modelId: process.env.BEDROCK_MODEL,
		contentType: 'application/json',
		accept: 'application/json',
		body: JSON.stringify({
			anthropic_version: 'bedrock-2023-05-31',
			max_tokens: 64,
			temperature: 0,
			messages: [
				{ role: 'user', content: [ { type: 'text', text: prompt } ] }
			]
		})
	};
	try {
		const resp = await bedrock.send(new InvokeModelCommand(input));
		const json = JSON.parse(new TextDecoder().decode(resp.body));
		const text = json?.content?.[0]?.text || '';
		const parsed = JSON.parse(text);
		return typeof parsed.total === 'number' ? parsed.total : fallback;
	} catch (e) {
		return fallback;
	}
}

// Category selection now comes from the client form (no AI categorization)

// Check if a value meets the confidence threshold
function meetsConfidenceThreshold(value, threshold) {
	if (!value || typeof value !== 'object') return false;
	return (value.confidence || 0) >= threshold;
}

// Filter values based on confidence threshold
function filterByConfidence(values, threshold) {
	if (!values || typeof values !== 'object') return values;
	
	const filtered = {};
	for (const [key, value] of Object.entries(values)) {
		if (meetsConfidenceThreshold(value, threshold)) {
			filtered[key] = value;
		}
	}
	return filtered;
}

function parseDateMaybe(text) {
	if (!text) return null;
	const normalized = text.replace(/[.\\-]/g, '/');
	const candidates = [text, normalized];
	for (const t of candidates) {
		const d = new Date(t);
		if (!isNaN(d.getTime())) {
			// Convert to DD/MM/YYYY format
			const day = String(d.getDate()).padStart(2, '0');
			const month = String(d.getMonth() + 1).padStart(2, '0');
			const year = d.getFullYear();
			return `${day}/${month}/${year}`;
		}
	}
	return null;
}

// Prefer 9-19 digit identifiers as receipt numbers, score by label keywords; preserve leading zeros
function chooseReceiptNumber(summary) {
	const candidates = [];
	function scoreLabel(label) {
		if (!label) return 0;
		const s = String(label).toLowerCase();
		let score = 0;
		if (/receipt/.test(s)) score += 6;
		if (/rept/.test(s)) score += 4;
		if (/(ref|reference)\b/.test(s)) score += 3;
		if (/#|\bno\b|number\b/.test(s)) score += 1;
		if (/(invoice|po|order)\b/.test(s)) score -= 1;
		return score;
	}
	for (const [type, f] of Object.entries(summary || {})) {
		const label = f.label || type;
		const raw = f.value || '';
		const digits = String(raw).replace(/\D/g, '');
		if (digits.length >= 9 && digits.length <= 19) {
			candidates.push({ raw, digitsLen: digits.length, conf: f.confidence || 0, score: scoreLabel(label) });
		}
	}
	candidates.sort((a,b)=> (b.score - a.score) || (b.digitsLen - a.digitsLen) || (b.conf - a.conf));
	if (candidates[0]) return String(candidates[0].raw);
	for (const f of Object.values(summary || {})) {
		const m = String(f.value||'').match(/\d{9,19}/);
		if (m) return m[0];
	}
	return null;
}

function extractDocInfoFromResponse(resp) {
	const docs = resp.ExpenseDocuments || [];
	if (!docs.length) return null;
	const doc = docs[0];
	const summaryByType = {};
	(doc.SummaryFields || []).forEach((field) => {
		const type = field.Type?.Text || 'UNKNOWN';
		summaryByType[type] = {
			label: field.LabelDetection?.Text,
			value: field.ValueDetection?.Text || '',
			confidence: field.ValueDetection?.Confidence || field.Confidence || 0
		};
	});

	// Apply confidence threshold filtering
	const threshold = Number(process.env.CONFIDENCE_THRESHOLD || 85);
	const filteredSummaryByType = filterByConfidence(summaryByType, threshold);

	const receiptNumber = chooseReceiptNumber(filteredSummaryByType);

	let receiptDate = filteredSummaryByType['INVOICE_RECEIPT_DATE']?.value
		|| filteredSummaryByType['RECEIPT_DATE']?.value
		|| filteredSummaryByType['INVOICE_DATE']?.value
		|| null;
	if (!receiptDate) {
		for (const f of Object.values(filteredSummaryByType)) {
			if (f.label && /date/i.test(f.label)) { receiptDate = f.value; break; }
		}
	}
	const receiptDateIso = parseDateMaybe(receiptDate) || receiptDate;

	const vendorName = filteredSummaryByType['VENDOR_NAME']?.value
		|| filteredSummaryByType['SUPPLIER']?.value
		|| filteredSummaryByType['MERCHANT']?.value
		|| null;

	const lineItems = [];
	(doc.LineItemGroups || []).forEach((group) => {
		(group.LineItems || []).forEach((li) => {
			const rec = { description: null, amount: null, quantity: null };
			(li.LineItemExpenseFields || []).forEach((f) => {
				const t = (f.Type?.Text || '').toUpperCase();
				const label = f.LabelDetection?.Text || '';
				const val = f.ValueDetection?.Text || '';
				const confidence = f.ValueDetection?.Confidence || f.Confidence || 0;
				
				// Only include values that meet confidence threshold
				if (confidence >= threshold) {
					if (!rec.description && (t.includes('ITEM') || t.includes('DESCRIPTION') || /item|desc/i.test(label))) {
						rec.description = val;
					}
					if (!rec.amount && (t.includes('PRICE') || t.includes('AMOUNT') || t.includes('TOTAL'))) {
						rec.amount = parseFloat(val.replace(/[^0-9.]/g, ''));
					}
					if (!rec.quantity && (t.includes('QUANTITY') || /qty/i.test(label))) {
						rec.quantity = parseFloat(val.replace(/[^0-9.]/g, ''));
					}
				}
			});
			if (rec.description || !isNaN(rec.amount)) lineItems.push(rec);
		});
	});

	const totalCandidates = [];
	for (const [type, data] of Object.entries(filteredSummaryByType)) {
		if (!data || !data.value) continue;
		const t = type.toUpperCase();
		if (t.includes('TOTAL') || t.includes('AMOUNT') || t.includes('BALANCE') || t.includes('NET') || t.includes('SUBTOTAL')) {
			totalCandidates.push({ label: type, value: data.value, confidence: data.confidence });
		}
	}

	return { summaryByType: filteredSummaryByType, receiptNumber, receiptDate: receiptDateIso, vendorName, lineItems, totalCandidates };
}

async function askOpenAIForItemName(docInfo) {
	if (!openai || !docInfo) {
		console.warn('[ItemNameAI] OpenAI not configured or docInfo missing');
		return null;
	}
  
	// Clean vendor name - remove common suffixes and country names
	const cleanVendorName = (vendor) => {
		if (!vendor) return null;
		
		// Remove common business suffixes (including variations with dots)
		let cleaned = vendor
			.replace(/\s+(PTE\.?LTD\.?|PTE|LTD\.?|LIMITED|PRIVATE|CORP\.?|CORPORATION|CO\.?|COMPANY|INC\.?|LLC|SINGAPORE|MALAYSIA|INDONESIA|THAILAND|VIETNAM|PHILIPPINES|CHINA|JAPAN|KOREA|INDIA|AUSTRALIA|USA|UNITED STATES|UK|UNITED KINGDOM)\s*$/gi, '')
			.replace(/\s+/g, ' ')
			.trim();
		
		// Remove common country abbreviations and variations
		cleaned = cleaned
			.replace(/\s+(SG|MY|ID|TH|VN|PH|CN|JP|KR|IN|AU|US|GB|UK)\s*$/gi, '')
			.replace(/\s+/g, ' ')
			.trim();
		
		// Remove standalone country names that might be in the middle
		cleaned = cleaned
			.replace(/\b(Singapore|Malaysia|Indonesia|Thailand|Vietnam|Philippines|China|Japan|Korea|India|Australia|USA|United States|UK|United Kingdom)\b/gi, '')
			.replace(/\s+/g, ' ')
			.trim();
		
		// Remove any remaining business suffixes with dots
		cleaned = cleaned
			.replace(/\s+(PTE\.|LTD\.|CORP\.|INC\.|CO\.)\s*$/gi, '')
			.replace(/\s+/g, ' ')
			.trim();
		
		return cleaned;
	};
	
	const vendor = cleanVendorName(docInfo.vendorName);
	const items = (docInfo.lineItems || []).map(li => ({
	  description: li.description || null,
	  amount: (typeof li.amount === 'number' && !Number.isNaN(li.amount)) ? li.amount : null,
	  quantity: (typeof li.quantity === 'number' && !Number.isNaN(li.quantity)) ? li.quantity : null,
	}));
  
	// Enforce a tiny JSON schema so Make/your code can parse consistently
	let response;
	try {
		console.log('[ItemNameAI] Calling OpenAI', { model: OPENAI_MODEL, vendor, itemsCount: items.length });
		response = await openai.responses.create({
		  model: OPENAI_MODEL,
		  temperature: 0,
		  max_output_tokens: 64,
		  text: {
			format: {
				type: 'json_schema',
				name: 'item_name_schema',
				strict: true,
				schema: {
					type: 'object',
					additionalProperties: false,
					required: ['item'],
					properties: {
						item: { type: 'string', minLength: 3, maxLength: 40 }
					}
				}
			}
		  },
		  input: [
			{
			  role: 'system',
			  content:
	`You label receipts with a short, generic purchase phrase (2–5 words), not brand names.
	Rules:
	- Prefer generic categories such as snacks, groceries, stationery, fuel, hotel, delivery, mobile plan, conference fee, visa fee, ride.
	- Convenience store/cafe: often drinks/refreshments or snacks.
	- Restaurants/food places: meal or a specific food concept if clear (e.g., wings and sides, coffee).
	- Only include the vendor if it truly clarifies the type (usually don't).
	- Output must be JSON (field: "item").`
			},
			{
			  role: 'user',
			  content: JSON.stringify({ vendor, items }, null, 0)
			}
		  ]
		});
	} catch (err) {
		console.error('[ItemNameAI] OpenAI request failed:', err?.response?.data || err?.message || err);
		return null;
	}
  
	// Parse JSON output robustly
	let out;
	try {
		const text = response?.output_text
			|| response?.output?.[0]?.content?.[0]?.text
			|| response?.choices?.[0]?.message?.content
			|| '';
		out = JSON.parse(typeof text === 'string' ? text : String(text));
	} catch (parseErr) {
		console.error('[ItemNameAI] Failed to parse OpenAI output:', parseErr, 'raw response:', JSON.stringify(response, null, 2));
		return null;
	}
	let phrase = (out && typeof out.item === 'string') ? out.item.trim() : '';
	if (!phrase) {
		console.warn('[ItemNameAI] Empty item phrase from OpenAI');
		return null;
	}
  
	return phrase;
}

async function askAiForGeneralItemName(docInfo) {
	if (!bedrock || !process.env.BEDROCK_MODEL) return null;
	const vendor = docInfo?.vendorName || null;
	const items = (docInfo?.lineItems || []).map(li => ({ description: li.description, amount: li.amount, quantity: li.quantity }));
	const prompt = `Summarize what was purchased in 2-5 generic words, not exact product names. Prefer phrases like "refreshments", "drinks", "groceries", "stationery", "fuel", "hotel", "delivery". Include vendor only if it truly adds clarity; otherwise omit it (e.g., drinks from 7/11 -> "drinks" or "refreshments"). Return ONLY JSON like {"item":"<short phrase>"}.

Vendor: ${JSON.stringify(vendor)}
Line items: ${JSON.stringify(items)}
`;
	const input = {
		modelId: process.env.BEDROCK_MODEL,
		contentType: 'application/json',
		accept: 'application/json',
		body: JSON.stringify({
			anthropic_version: 'bedrock-2023-05-31',
			max_tokens: 48,
			temperature: 0,
			messages: [ { role: 'user', content: [ { type: 'text', text: prompt } ] } ]
		})
	};
	try {
		const resp = await bedrock.send(new InvokeModelCommand(input));
		const json = JSON.parse(new TextDecoder().decode(resp.body));
		const text = json?.content?.[0]?.text || '';
		const parsed = JSON.parse(text);
		const item = String(parsed?.item || '').trim();
		if (item) return item;
	} catch {}
	return null;
}
// Category selection removed from backend; will use client-provided category

// AI function to enhance claim data
async function getAiEnhancedClaimData(documents, category) {
	if (!openai) {
		console.warn("OpenAI API key not configured. Skipping AI enhancement.");
		return {
			purpose: `Expense claim for ${category || 'various items'}`,
			enhancedReceipts: documents.map(doc => ({
				...doc,
				itemDescriptionWithVendor: doc.itemName && doc.vendorName ? `${doc.itemName} from ${doc.vendorName}` : doc.itemName || doc.vendorName || 'N/A',
				gstStatus: 'Unsure'
			}))
		};
	}

	const receiptSummaries = documents.map((doc, index) => {
		const lineItemsSummary = (doc.lineItems || []).map(li => {
			const desc = li.description || 'item';
			const amt = li.amount ? ` ($${li.amount.toFixed(2)})` : '';
			return `${desc}${amt}`;
		}).join('; ');

		return `Receipt ${index + 1}:
		Vendor: ${doc.vendorName || 'N/A'}
		Date: ${doc.receiptDate || 'N/A'}
		Total Amount: ${doc.finalAmount ? `$${doc.finalAmount.toFixed(2)}` : 'N/A'}
		Primary Item: ${doc.itemName || 'N/A'}
		Detailed Line Items: ${lineItemsSummary || 'N/A'}
		`;
	}).join('\n---\n');

	const prompt = `You are an expert in processing expense claims. Analyze the following receipt information for an expense claim categorized as "${category || 'General Expenses'}".

Receipts:
${receiptSummaries}

Based on this information, provide the following:
1. A single, concise overall purpose for this expense claim (e.g., "Team building refreshments", "Office supplies purchase", "Staff welfare activities").
2. For each receipt, provide an enhanced item description that combines the primary item description with a clean vendor name (e.g., "Refreshments from ShengShiong", "Stationery from Popular Bookstore"). IMPORTANT: The vendor names provided have already been cleaned to remove business suffixes and country names. Use them as-is without adding back "Singapore", "PTE LTD", etc.
   If a primary item description is not clear, use the vendor name as the description.
3. For each receipt, determine if GST (Goods and Services Tax) is likely included in the total amount. Respond with "Yes", "No", or "Unsure". If there are any indications of tax (e.g., "GST", "Tax", "VAT" mentioned, or a separate tax line item), assume "Yes". If no tax information is present and you cannot infer, respond "Unsure".

Format your response as a JSON object with the following structure:
{
  "purpose": "Overall purpose of the claim",
  "receiptDetails": [
    {
      "originalIndex": 0, // The 0-based index of the original receipt in the input array
      "itemDescriptionWithVendor": "Enhanced item description including vendor",
      "gstStatus": "Yes" | "No" | "Unsure"
    },
    // ... for each receipt
  ]
}`;

	try {
		const response = await openai.chat.completions.create({
			model: OPENAI_MODEL,
			messages: [{ role: 'user', content: prompt }],
			response_format: { type: "json_object" },
			temperature: 0
		});

		const aiResponse = JSON.parse(response.choices[0].message.content);

		const enhancedReceipts = documents.map((doc, index) => {
			const aiDetail = aiResponse.receiptDetails.find(d => d.originalIndex === index);
			return {
				...doc,
				itemDescriptionWithVendor: aiDetail?.itemDescriptionWithVendor || (doc.itemName && doc.vendorName ? `${doc.itemName} from ${doc.vendorName}` : doc.itemName || doc.vendorName || 'N/A'),
				gstStatus: aiDetail?.gstStatus || 'Unsure'
			};
		});

		return {
			purpose: aiResponse.purpose,
			enhancedReceipts: enhancedReceipts
		};

	} catch (error) {
		console.error("Error calling OpenAI API for claim enhancement:", error);
		return {
			purpose: `Expense claim for ${category || 'various items'}`,
			enhancedReceipts: documents.map(doc => ({
				...doc,
				itemDescriptionWithVendor: doc.itemName && doc.vendorName ? `${doc.itemName} from ${doc.vendorName}` : doc.itemName || doc.vendorName || 'N/A',
				gstStatus: 'Unsure'
			}))
		};
	}
}

// Function to set tight text wrapping for signature images
function setTightTextWrapping(docBuffer) {
	try {
		const zip = new PizZip(docBuffer);
		const filePath = 'word/document.xml';
		const xml = zip.file(filePath).asText();
		
		// Only modify if we find wp:wrapNone elements
		if (xml.includes('<wp:wrapNone')) {
			let modifiedXml = xml;
			
			// Replace wp:wrapNone with wp:wrapSquare for tight text wrapping
			modifiedXml = modifiedXml.replace(
				/<wp:wrapNone\/>/g,
				'<wp:wrapSquare distT="0" distB="0" distL="0" distR="0"/>'
			);
			
			// Update the zip file with modified XML
			zip.file(filePath, modifiedXml);
			
			console.log('Applied tight text wrapping to signature images');
			return zip.generate({ type: 'nodebuffer' });
		} else {
			console.log('No wp:wrapNone elements found, skipping text wrapping modification');
			return docBuffer;
		}
	} catch (error) {
		console.warn('Failed to set tight text wrapping:', error.message);
		return docBuffer; // Return original if modification fails
	}
}

// Function to merge purpose column cells (visually) by adding w:vMerge to the Purpose column
function mergePurposeColumn(docBuffer, receiptCount) {
	try {
		if (!receiptCount || receiptCount < 2) return docBuffer;
		const zip = new PizZip(docBuffer);
		const filePath = 'word/document.xml';
		const xml = zip.file(filePath).asText();
		const headerText = 'Purpose';

		const purposeHeaderIdx = xml.indexOf(`<w:t>${headerText}</w:t>`);
		if (purposeHeaderIdx === -1) return docBuffer;

		const tblStart = xml.lastIndexOf('<w:tbl', purposeHeaderIdx);
		const tblEnd = xml.indexOf('</w:tbl>', purposeHeaderIdx);
		if (tblStart === -1 || tblEnd === -1) return docBuffer;
		const tblXml = xml.slice(tblStart, tblEnd + 8);

		const rowRegex = /<w:tr[\s\S]*?<\/w:tr>/g;
		const rows = tblXml.match(rowRegex) || [];
		if (rows.length < 2) return docBuffer;

		const dataRows = rows.slice(1, 1 + receiptCount);
		const purposeColIndex = 2; // 0-based: S/N(0), Item(1), Purpose(2), Total(3), GST(4)

		function applyVMerge(tcXml, restart) {
			const hasTcPr = /<w:tcPr[\s\S]*?<\/w:tcPr>/.test(tcXml);
			const vMerge = restart ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>';
			if (hasTcPr) {
				return tcXml.replace(/<w:tcPr(.*?)>/, (m) => `${m}${vMerge}`);
			}
			return tcXml.replace(/<w:tc(.*?)>/, (m) => `${m}<w:tcPr>${vMerge}</w:tcPr>`);
		}

		function clearCellContent(tcXml) {
			const tcPrMatch = tcXml.match(/<w:tcPr[\s\S]*?<\/w:tcPr>/);
			const tcPr = tcPrMatch ? tcPrMatch[0] : '';
			return `<w:tc>${tcPr}<w:p/></w:tc>`;
		}

		const newRows = rows.slice();
		for (let i = 0; i < dataRows.length; i++) {
			const rIdx = 1 + i;
			let rowXml = rows[rIdx];
			const cellRegex = /<w:tc[\s\S]*?<\/w:tc>/g;
			const cells = rowXml.match(cellRegex) || [];
			if (cells.length <= purposeColIndex) continue;
			let targetCell = cells[purposeColIndex];
			targetCell = applyVMerge(targetCell, i === 0);
			if (i > 0) targetCell = clearCellContent(targetCell);
			const rebuiltCells = cells.slice();
			rebuiltCells[purposeColIndex] = targetCell;
			let rebuiltRow = rowXml;
			for (let c = 0; c < cells.length; c++) {
				rebuiltRow = rebuiltRow.replace(cells[c], rebuiltCells[c]);
			}
			newRows[rIdx] = rebuiltRow;
		}

		let newTblXml = tblXml;
		for (let i = 0; i < rows.length; i++) {
			newTblXml = newTblXml.replace(rows[i], newRows[i]);
		}

		const newXml = xml.slice(0, tblStart) + newTblXml + xml.slice(tblEnd + 8);
		zip.file(filePath, newXml);
		return zip.generate({ type: 'nodebuffer' });
	} catch (e) {
		console.warn('mergePurposeColumn failed (non-fatal):', e?.message || e);
		return docBuffer;
	}
}

// Generate Word document from template
async function generateWordDocument(data, templatePath = 'templates/default-template.docx') {
	try {
		// Check if template file exists and is valid
		const fs = require('fs');
		if (!fs.existsSync(templatePath)) {
			throw new Error(`Template file not found: ${templatePath}. Please place your Word template in the templates/ directory.`);
		}
		
		const stats = fs.statSync(templatePath);
		if (stats.size === 0) {
			throw new Error(`Template file is empty: ${templatePath}. Please ensure your Word template file is not empty.`);
		}
		
		console.log(`Template file found: ${templatePath}, size: ${stats.size} bytes`);

		// Prepare data for template with AI-enhanced information
		const enhancedReceipts = data.enhancedReceipts || data.documents || [];
		
		// Create template data with loop structure for dynamic rows
		const purpose = data.purpose || 'General Purpose';
		const expenseType = data.expenseType || '';
		const othersCategory = data.othersCategory || '';
		
		// Extract category code from expense type
		const getCategoryCode = (type) => {
			const codeMatch = type.match(/\(([^)]+)\)/);
			return codeMatch ? codeMatch[1] : '';
		};
		const categoryCode = expenseType ? getCategoryCode(expenseType) : '';
		
		// Load claimant (selected on request) if claimantId provided
		let claimant = null;
		try {
			const all = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'claimants.json')));
			if (data.claimantId) claimant = (all || []).find(c=> c.id === data.claimantId) || null;
		} catch {}

		// Load approving officer (selected on request) if approvingOfficerId provided
		let approvingOfficer = null;
		try {
			const all = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'approving-officers.json')));
			if (data.approvingOfficerId) approvingOfficer = (all || []).find(o=> o.id === data.approvingOfficerId) || null;
		} catch {}

		const sgDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore' }).format(new Date());

		// Determine which expense type is selected and set individual placeholders
		const isCampaignsExhibitions = expenseType === 'Campaigns & Exhibitions';
		const isCeremoniesCelebrations = expenseType === 'Ceremonies & Celebrations';
		const isMiscReimb = expenseType === 'Misc Reimb\'';
		const isOfficeSupplies = expenseType === 'Office Supplies';
		const isOrganisationalExcellence = expenseType === 'Organisational Excellence Award';
		const isOtherSupplies = expenseType === 'Other Supplies';
		const isStaffRecWelfare = expenseType === 'Staff Rec & Welfare';
		const isOthers = expenseType === 'Others';

		const templateData = {
			// Basic claim info
			claim_date: sgDate, // DD/MM/YYYY
			date: sgDate,
			employee_name: claimant?.name || 'Employee Name',
			
			// User-entered purpose (single purpose for entire claim)
			Purpose: purpose,
			
			// Category code
			categoryCode: categoryCode,
			
			// Individual expense type placeholders for checkmarks
			campaignsExhibitions: isCampaignsExhibitions ? '╳' : '',
			ceremoniesCelebrations: isCeremoniesCelebrations ? '╳' : '',
			miscReimb: isMiscReimb ? '╳' : '',
			officeSupplies: isOfficeSupplies ? '╳' : '',
			organisationalExcellence: isOrganisationalExcellence ? '╳' : '',
			otherSupplies: isOtherSupplies ? '╳' : '',
			staffRecWelfare: isStaffRecWelfare ? '╳' : '',
			others: isOthers ? '╳' : '',
			othersCategory: othersCategory,
			
			// Claimant fields
			claimantName: claimant?.name?.toUpperCase() || '',
			claimantNRIC: claimant?.nric?.toUpperCase() || '',
			claimantDesignation: claimant?.designation?.toUpperCase() || '',
			claimantDept: claimant?.dept?.toUpperCase() || '',
			claimantUnit: claimant?.unit?.toUpperCase() || '',
			claimantPHNumber: claimant?.phNumber?.toUpperCase() || '',
			claimantEmail: claimant?.email?.toUpperCase() || '',
			claimantSignature: claimant?.signaturePath || '',

			// Approving Officer fields
			approvingOfficerName: approvingOfficer?.name || '',
			approvingOfficerRank: approvingOfficer?.rank || '',
			approvingOfficerDesignation: approvingOfficer?.designation || '',
			approvingOfficerFull: approvingOfficer ? `${approvingOfficer.rank} ${approvingOfficer.name}` : '',
			
			// Uppercase Approving Officer fields
			APPROVINGOFFICERDESIGNATION: approvingOfficer?.designation?.toUpperCase() || '',
			APPROVINGOFFICERFULL: approvingOfficer ? `${approvingOfficer.rank} ${approvingOfficer.name}`.toUpperCase() : '',

			// Summary
			total_claim_amount: data.totalAmount || 'N/A',
			currency: 'SGD',
			receipt_count: enhancedReceipts.length,
			
			// Receipts array for loop processing with Purpose included in each row
			receipts: enhancedReceipts.map((receipt, index) => ({
				sn: index + 1,
				itemDescription: receipt.itemDescriptionWithVendor || receipt.itemName || 'N/A',
				purpose: purpose, // Same purpose for all rows
				showPurpose: index === 0, // Only show purpose in first row for visual merging
				total: receipt.finalAmount ? `$${receipt.finalAmount.toFixed(2)}` : 'N/A',
				gst: 'Yes' // Always set GST to "Yes"
			}))
		};

		// Generate the document using docxtemplater
		console.log('Generating document with template:', templatePath);
		console.log('Template data keys:', Object.keys(templateData));
		console.log('Sample template data:', JSON.stringify(templateData, null, 2).substring(0, 1000));
		
		// Read the template file
		const content = fs.readFileSync(templatePath, 'binary');
		
		// Create a new instance of PizZip with the content
		const zip = new PizZip(content);
		
		// Configure image module for signatures
		const imageOpts = {
			getImage: function(tagValue) {
				if (!tagValue) return null;
				try {
					// Convert relative path to absolute path
					const absolutePath = path.join(__dirname, '..', tagValue);
					console.log('Loading signature image from:', absolutePath);
					const imageBuffer = fs.readFileSync(absolutePath);
					console.log('Signature image loaded, size:', imageBuffer.length, 'bytes');
					return imageBuffer;
				} catch (error) {
					console.warn('Failed to load signature image:', tagValue, error.message);
					return null;
				}
			},
			getSize: function(imgBuffer) {
				// Fit within max 160x60 while preserving aspect ratio
				const MAX_W = 160;
				const MAX_H = 60;
				try {
					const { width, height } = imageSize(imgBuffer);
					if (!width || !height) return [MAX_W, MAX_H];
					let scale = Math.min(MAX_W / width, MAX_H / height, 1);
					const w = Math.round(width * scale);
					const h = Math.round(height * scale);
					return [w, h];
				} catch {
					return [MAX_W, MAX_H];
				}
			},
			getAltText: function(tagValue) {
				return 'Signature';
			}
		};
		const doc = new Docxtemplater(zip, { modules: [new ImageModule(imageOpts)], paragraphLoop: true, linebreaks: true });
		
		// Render the document with the data
		doc.render(templateData);
		
		// Get the document as a buffer
		let buffer = doc.getZip().generate({ type: 'nodebuffer' });
		
		// Post-process to add vertical merge on Purpose column
		buffer = mergePurposeColumn(buffer, enhancedReceipts.length);
		
		// Post-process to set tight text wrapping for signature images
		// Temporarily disabled to fix file corruption issue
		// buffer = setTightTextWrapping(buffer);
		
		console.log('Document generated successfully, size:', buffer.length, 'bytes');
		return buffer;
	} catch (error) {
		console.error('Error generating Word document:', error);
		console.error('Template path:', templatePath);
		throw error;
	}
}

// Email functionality removed per requirements; results are shown on the website

app.get('/', (req,res)=>{
	res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Claimants API ---
// Simple JSON file store at data/claimants.json; signaturePath points to /signatures/*.png
function readClaimants() {
	try {
		const p = path.join(__dirname, '..', 'data', 'claimants.json');
		console.log('Reading claimants from:', p);
		const data = fs.readFileSync(p, 'utf-8');
		const claimants = JSON.parse(data);
		console.log('Read claimants from file, count:', claimants.length);
		return claimants;
	} catch (error) {
		console.warn('Failed to read claimants file:', error.message);
		return [];
	}
}
function writeClaimants(list) {
	const p = path.join(__dirname, '..', 'data', 'claimants.json');
	console.log('Writing claimants to file:', p);
	console.log('Data to write:', JSON.stringify(list, null, 2));
	fs.writeFileSync(p, JSON.stringify(list, null, 2));
	console.log('Claimants file written successfully');
}

// --- Approving Officers API ---
// Simple JSON file store at data/approving-officers.json
function readApprovingOfficers() {
	try {
		const p = path.join(__dirname, '..', 'data', 'approving-officers.json');
		return JSON.parse(fs.readFileSync(p, 'utf-8'));
	} catch {
		return [];
	}
}
function writeApprovingOfficers(list) {
	const p = path.join(__dirname, '..', 'data', 'approving-officers.json');
	fs.writeFileSync(p, JSON.stringify(list, null, 2));
}

app.get('/claimants', (req, res) => {
	return res.json({ ok: true, claimants: readClaimants() });
});

const addClaimantUpload = multer({ storage: multer.memoryStorage() });
app.post('/claimants', addClaimantUpload.single('signature'), (req, res) => {
	try {
		const { name, nric, designation, dept, unit, phNumber, email } = req.body || {};
		if (!name || !nric) return res.status(400).json({ ok: false, error: 'name and nric are required' });
		
		console.log('Adding new claimant:', { name, nric, designation, dept, unit, phNumber, email });
		
		const list = readClaimants();
		console.log('Current claimants list length:', list.length);
		
		const id = 'c' + (Date.now().toString(36));
		let signaturePath = null;
		if (req.file && req.file.buffer) {
			const fileName = `${name.toLowerCase().replace(/[^a-z0-9]+/g,'_')}_${Date.now()}.png`;
			const dir = path.join(__dirname, '..', 'signatures');
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			const abs = path.join(dir, fileName);
			fs.writeFileSync(abs, req.file.buffer);
			signaturePath = path.join('signatures', fileName);
			console.log('Signature saved to:', signaturePath);
		}
		
		const newClaimant = { id, name, nric, designation, dept, unit, phNumber, email, signaturePath };
		list.push(newClaimant);
		
		console.log('Writing claimants to file, new list length:', list.length);
		writeClaimants(list);
		
		// Verify the file was written
		const verifyList = readClaimants();
		console.log('Verification - claimants in file after write:', verifyList.length);
		
		return res.json({ ok: true, claimant: newClaimant });
	} catch (error) {
		console.error('Error adding claimant:', error);
		return res.status(500).json({ ok: false, error: 'Failed to add claimant' });
	}
});

app.get('/approving-officers', (req, res) => {
	return res.json({ ok: true, approvingOfficers: readApprovingOfficers() });
});

// accept multipart/form-data without files
const addOfficerUpload = multer({ storage: multer.memoryStorage() });
app.post('/approving-officers', addOfficerUpload.none(), (req, res) => {
	try {
		console.log('Approving officer request body:', req.body);
		console.log('Request headers:', req.headers);
		
		const { name, rank, designation } = req.body || {};
		console.log('Extracted fields:', { name, rank, designation });
		
		if (!name || !rank) {
			console.log('Missing required fields - name:', !!name, 'rank:', !!rank);
			return res.status(400).json({ ok: false, error: 'name and rank are required' });
		}
		
		const list = readApprovingOfficers();
		const id = 'ao' + (Date.now().toString(36));
		const newOfficer = { id, name, rank, designation: designation || '' };
		list.push(newOfficer);
		writeApprovingOfficers(list);
		return res.json({ ok: true, approvingOfficer: newOfficer });
	} catch (error) {
		console.error('Error adding approving officer:', error);
		return res.status(500).json({ ok: false, error: 'Failed to add approving officer' });
	}
});

app.post('/upload', upload.array('receipts'), async (req, res) => {
	try {
		const files = req.files || [];
		if (!files.length) return res.status(400).json({ error: 'At least one receipt image is required' });

		const buffers = files.map(f=> f.buffer);
		const textractResponses = await runTextractAnalyzeExpense(buffers);
		const docInfos = textractResponses.map(extractDocInfoFromResponse);
		const extracted = textractResponses.map(extractFieldsFromAnalyzeExpense).map(arr=> arr[0] || {});

		// Evaluate by threshold
		const threshold = Number(process.env.CONFIDENCE_THRESHOLD || 85);
		const thresholdTotals = pickTopTotals(extracted, threshold);

		// Gather candidates for AI agent from summary fields
		const allCandidates = (docInfos || []).map((d)=> d?.totalCandidates || []);

		const aiDecisions = [];
		for (let i = 0; i < allCandidates.length; i++) {
			const candidates = allCandidates[i];
			const eligible = (thresholdTotals[i]?.confidence || 0) >= threshold;
			aiDecisions.push(eligible ? await askAiToChooseTotal(candidates) : null);
		}

		// Item name via OpenAI only (no heuristic fallback); category comes from client form
		const itemNames = [];
		for (let i = 0; i < (docInfos || []).length; i++) {
			const aiName = await askOpenAIForItemName(docInfos[i]);
			console.log(`[ItemNameAI] Document ${i+1} item:`, aiName);
			itemNames.push(aiName);
		}
		const selectedCategory = req.body?.category || null;

		const documents = (docInfos || []).map((info, i) => ({
			receiptNumber: info?.receiptNumber || null,
			receiptDate: info?.receiptDate || null,
			vendorName: info?.vendorName || null,
			itemName: itemNames[i] || null,
			category: selectedCategory,
			thresholdPick: thresholdTotals[i] || null,
			aiTotal: aiDecisions[i] || null
		}));

		res.json({ ok: true, fileCount: files.length, documents, extractedFields: extracted });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'Processing failed', details: err.message });
	}
});

// Generate Word document endpoint
app.post('/generate-document', async (req, res) => {
	try {
		const { documents, purpose, expenseType, othersCategory, claimantId, approvingOfficerId } = req.body;
		
		if (!documents || !Array.isArray(documents) || documents.length === 0) {
			return res.status(400).json({ error: 'No documents provided' });
		}

		// Calculate totals and prepare data
		let totalAmount = 0;
		const processedDocs = documents.map(doc => {
			const amount = doc.aiTotal || doc.thresholdPick?.total || 0;
			totalAmount += amount;
			return {
				...doc,
				finalAmount: amount,
				confidenceScore: doc.thresholdPick?.confidence || doc.aiTotal ? 'AI Verified' : 'Threshold Met'
			};
		});

		// Get AI-enhanced claim data
		console.log('Getting AI-enhanced claim data...');
		const aiEnhancedData = await getAiEnhancedClaimData(processedDocs, expenseType);

		// Prepare data for template with AI enhancements
		const templateData = {
			expenseType: expenseType || 'General',
			othersCategory: othersCategory || '',
			purpose: purpose || 'General Purpose', // Use user-entered purpose
			claimantId: claimantId, // Pass claimantId to document generation
			approvingOfficerId: approvingOfficerId, // Pass approvingOfficerId to document generation
			documents: processedDocs,
			enhancedReceipts: aiEnhancedData.enhancedReceipts,
			totalAmount: totalAmount.toFixed(2),
			claimDate: new Date().toLocaleDateString('en-GB'),
			receiptCount: documents.length
		};

		// Try to find template file
		const fs = require('fs');
		const possibleTemplates = [
			'templates/claim-template.docx',
			'templates/template.docx',
			'templates/default-template.docx'
		];
		
		let templatePath = null;
		for (const template of possibleTemplates) {
			if (fs.existsSync(template)) {
				templatePath = template;
				break;
			}
		}
		
		if (!templatePath) {
			throw new Error('No Word template found. Please place a .docx template file in the templates/ directory. See templates/README.md for instructions.');
		}

		// Generate document
		const docBuffer = await generateWordDocument(templateData, templatePath);
		
		// Set response headers for file download
		res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
		res.setHeader('Content-Disposition', `attachment; filename="claim-${Date.now()}.docx"`);
		res.setHeader('Content-Length', docBuffer.length);
		
		res.send(docBuffer);
	} catch (err) {
		console.error('Document generation error:', err);
		res.status(500).json({ error: 'Document generation failed', details: err.message });
	}
});

// Test endpoint to verify template file
app.get('/test-template', (req, res) => {
	try {
		const fs = require('fs');
		const templatePath = 'templates/claim-template.docx';
		
		if (!fs.existsSync(templatePath)) {
			return res.json({ error: 'Template file not found' });
		}
		
		const stats = fs.statSync(templatePath);
		const buffer = fs.readFileSync(templatePath);
		
		res.json({
			success: true,
			templatePath,
			fileSize: stats.size,
			bufferSize: buffer.length,
			fileType: 'Microsoft Word 2007+'
		});
	} catch (error) {
		res.json({ error: error.message });
	}
});

const port = process.env.PORT || 3000;
app.listen(port, ()=> console.log(`Server listening on :${port}`));
