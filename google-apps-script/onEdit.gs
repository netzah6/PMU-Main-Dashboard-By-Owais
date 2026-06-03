/**
 * Google Apps Script — PMU Dashboard onEdit Webhook
 *
 * INSTALLATION INSTRUCTIONS:
 * 1. Open your Google Sheet (SHEET1: Clients Master, etc.)
 * 2. Go to Extensions > Apps Script
 * 3. Replace the default code with this script
 * 4. Update VERCEL_WEBHOOK_URL below with your actual Vercel domain
 * 5. Save (Ctrl+S)
 * 6. Go to Triggers (clock icon on left sidebar)
 * 7. Click "+ Add Trigger"
 * 8. Choose function: onEdit
 * 9. Event type: From spreadsheet > On edit
 * 10. Click Save
 * 11. Authorize the script when prompted
 *
 * REPEAT for each spreadsheet (SHEET2, SHEET3, SHEET4) by opening each
 * sheet and installing this same script with the same webhook URL.
 */

var VERCEL_WEBHOOK_URL = "https://YOUR-VERCEL-DOMAIN.vercel.app/api/webhooks/sheets";

function onEdit(e) {
  try {
    var sheet = e.source.getActiveSheet();
    var sheetName = sheet.getName();
    var range = e.range;
    var rowNumber = range.getRow();
    var spreadsheetId = e.source.getId();

    // Skip header row
    if (rowNumber <= 1) return;

    // Get all data in the edited row
    var lastCol = sheet.getLastColumn();
    var rowRange = sheet.getRange(rowNumber, 1, 1, lastCol);
    var rowValues = rowRange.getValues()[0];

    // Get headers from row 1
    var headerRange = sheet.getRange(1, 1, 1, lastCol);
    var headers = headerRange.getValues()[0];

    // Build row data object
    var rowData = {};
    for (var i = 0; i < headers.length; i++) {
      var header = String(headers[i]).trim();
      if (header) {
        rowData[header] = rowValues[i];
      }
    }

    var payload = {
      sheetName: sheetName,
      rowNumber: rowNumber,
      rowData: rowData,
      spreadsheetId: spreadsheetId,
      timestamp: new Date().toISOString()
    };

    var options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(VERCEL_WEBHOOK_URL, options);
    var responseCode = response.getResponseCode();

    if (responseCode !== 200) {
      Logger.log("Webhook error: " + responseCode + " - " + response.getContentText());
    } else {
      Logger.log("Webhook sent successfully for row " + rowNumber + " in " + sheetName);
    }
  } catch (error) {
    Logger.log("onEdit error: " + error.toString());
  }
}

/**
 * Test function — run this manually to verify the webhook works
 */
function testWebhook() {
  var payload = {
    sheetName: "TEST",
    rowNumber: 2,
    rowData: { test: "value", name: "Test Client" },
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    timestamp: new Date().toISOString()
  };

  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(VERCEL_WEBHOOK_URL, options);
  Logger.log("Test response: " + response.getResponseCode() + " - " + response.getContentText());
}
