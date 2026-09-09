# Word Template Setup

## How to Add Your Word Template

1. **Create your Word document** (.docx format) with placeholders
2. **Place it in this directory** (templates/)
3. **Name it** `claim-template.docx` (or any name you prefer)
4. **Restart the server** if it's running

## Available Placeholders

Use these placeholders in your Word template:

### Basic Information
- `{employeeName}` - Employee's full name
- `{claimDate}` - Current date (DD/MM/YYYY format)
- `{date}` - Current date (DD/MM/YYYY format)
- `{expenseType}` - Selected expense type
- `{categoryCode}` - Category code extracted from expense type (e.g., "e.g. 0000")
- `{othersCategory}` - User-specified category when "Others" is selected
- `{receiptCount}` - Number of receipts processed
- `{Purpose}` - **User-entered purpose for entire claim (merged across all rows)**

### Financial Information
- `{totalAmount}` - Total claim amount
- `{total_claim_amount}` - Total claim amount
- `{currency}` - Currency (SGD)

### Expense Type Table (with checkmarks)
Use these individual placeholders in your existing table cells:

- `{campaignsExhibitions}` - Checkmark (✓) for Campaigns & Exhibitions
- `{ceremoniesCelebrations}` - Checkmark (✓) for Ceremonies & Celebrations
- `{miscReimb}` - Checkmark (✓) for Misc Reimb'
- `{officeSupplies}` - Checkmark (✓) for Office Supplies
- `{organisationalExcellence}` - Checkmark (✓) for Organisational Excellence Award
- `{otherSupplies}` - Checkmark (✓) for Other Supplies
- `{staffRecWelfare}` - Checkmark (✓) for Staff Rec & Welfare
- `{others}` - Checkmark (✓) for Others
- `{othersCategory}` - User-specified category when "Others" is selected

### Receipt Details (for table rows using loops)
Use this structure in your Word template for dynamic rows with merged Purpose column:

```
{#receipts}
| {sn} | {itemDescription} | {#showPurpose}{purpose}{/showPurpose} | {total} | {gst} |
{/receipts}
```

**How it works:** The purpose will only show in the first row, creating a visual merge effect.

- `{sn}` - Serial number (1, 2, 3, etc.)
- `{itemDescription}` - Enhanced descriptions with vendor (e.g., "Refreshments from PRIME Supermarket")
- `{#showPurpose}{purpose}{/showPurpose}` - Purpose shown only in first row for merging effect
- `{total}` - Final amounts with currency formatting (e.g., "$25.50")
- `{gst}` - Always set to "Yes"

### Claimant Information
- `{claimantName}` - Claimant's full name
- `{claimantNRIC}` - Claimant's NRIC
- `{claimantDesignation}` - Claimant's designation
- `{claimantDept}` - Claimant's department
- `{claimantUnit}` - Claimant's unit
- `{claimantPHNumber}` - Claimant's phone number
- `{claimantEmail}` - Claimant's email
- `{claimantSignature}` - Claimant's signature (image)

### Approving Officer Information
- `{approvingOfficerName}` - Approving officer's name
- `{approvingOfficerRank}` - Approving officer's rank
- `{approvingOfficerDesignation}` - Approving officer's designation
- `{approvingOfficerFull}` - Full name with rank (e.g., "LTC Joe Ong")

## Uppercase Placeholders

The following placeholders will automatically render in ALL CAPS:

### Claimant Fields (All Uppercase)
- `{claimantName}` - Claimant's full name (UPPERCASE)
- `{claimantNRIC}` - Claimant's NRIC (UPPERCASE)
- `{claimantDesignation}` - Claimant's designation (UPPERCASE)
- `{claimantDept}` - Claimant's department (UPPERCASE)
- `{claimantUnit}` - Claimant's unit (UPPERCASE)
- `{claimantPHNumber}` - Claimant's phone number (UPPERCASE)
- `{claimantEmail}` - Claimant's email (UPPERCASE)

### Approving Officer Fields (All Uppercase)
- `{APPROVINGOFFICERDESIGNATION}` - Approving officer's designation (UPPERCASE)
- `{APPROVINGOFFICERFULL}` - Approving officer's full title (UPPERCASE)

### Additional Receipt Info
- `{receiptNumber}` - Receipt number
- `{receiptDate}` - Receipt date (DD/MM/YYYY)
- `{vendorName}` - Vendor/store name

## Example Template Structure

```
GENERAL CLAIM FORM

To: [Approving Officer]
Rank and Name of Approving Officer

May I have your approval for the following purchase(s):

| S/N | Item Description | Purpose | Estimate Cost (includes GST) | Is GST included in this amount? |
|-----|------------------|---------|------------------------------|----------------------------------|
{#receipts}
| {sn} | {itemDescription} | {#showPurpose}{purpose}{/showPurpose} | {total} | {gst} |
{/receipts}
```

**How it works:** The purpose will only appear in the first row, creating a visual merge effect.

## Table Structure for Multiple Receipts

For a table with multiple receipts, use this structure in your Word template:

**Loop Structure:** Use `{#receipts}...{/receipts}` to create dynamic rows
**Purpose Column:** Use `{#showPurpose}{purpose}{/showPurpose}` - shows only in first row
**Dynamic Rows:** The table will automatically expand based on number of receipts
**Item Description:** Use `{itemDescription}` for enhanced descriptions
**Total Column:** Use `{total}` for amounts with currency
**GST Column:** Use `{gst}` - always shows "Yes"
**Serial Number:** Use `{sn}` for row numbering

## Important Notes

- Use `{placeholder}` format (curly braces)
- The system will automatically replace placeholders with actual data
- Make sure your template is a valid .docx file (Word 2007+ format)
- Test with a few receipts first to ensure formatting works correctly
- The system now uses `docxtemplater` library for better compatibility

## Troubleshooting

If you encounter issues with document generation:

1. **Check template format**: Ensure your template is saved as `.docx` (not `.doc`)
2. **Verify placeholders**: Use exact placeholder names as listed above
3. **Test template**: Try with a simple template first before adding complex formatting
4. **Check file size**: Template should not be empty or corrupted
