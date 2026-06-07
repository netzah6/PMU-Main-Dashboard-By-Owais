/**
 * PMU Dashboard — Supabase realtime sync
 *
 * IMPORTANT: This sheet already has other .gs files that may define onEdit().
 * Google allows only ONE simple onEdit() per project, so this uses a UNIQUELY
 * named function (pmuSyncToSupabase) wired as an INSTALLABLE trigger instead.
 * Installable triggers can coexist with existing onEdit functions.
 *
 * INSTALL:
 * 1. In Apps Script, click the + next to "Files" → Script → name it "SupabaseSync"
 * 2. Paste this entire file into it and Save (Ctrl+S)
 * 3. Click the Triggers icon (clock, left sidebar) → "+ Add Trigger"
 * 4. Choose:
 *      function to run:     pmuSyncToSupabase
 *      deployment:          Head
 *      event source:        From spreadsheet
 *      event type:          On edit
 * 5. Save → authorize when prompted
 * 6. Repeat for each of the other 3 spreadsheets (LTV, Tracking, CPL)
 */

var VERCEL_WEBHOOK_URL = "https://pmu-main-dashboard-by-owais1.vercel.app/api/webhooks/sheets";

function pmuSyncToSupabase(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    var sheetName = sheet.getName();
    var rowNumber = e.range.getRow();

    // Skip header row
    if (rowNumber <= 1) return;

    var lastCol = sheet.getLastColumn();

    // Header row (row 1) → column keys
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    // The edited row's values
    var rowValues = sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];

    var rowData = {};
    for (var i = 0; i < headers.length; i++) {
      var key = String(headers[i]).trim();
      if (key === "") key = "col_" + (i + 1);
      var val = rowValues[i];
      rowData[key] = (val === "" || val === null || val === undefined) ? "" : val;
    }
    rowData["row_number"] = rowNumber;

    var payload = {
      sheetName: sheetName,
      rowNumber: rowNumber,
      rowData: rowData
    };

    UrlFetchApp.fetch(VERCEL_WEBHOOK_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log("pmuSyncToSupabase error: " + err);
  }
}

/** Run this once manually to test the webhook connection */
function pmuTestWebhook() {
  var res = UrlFetchApp.fetch(VERCEL_WEBHOOK_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      sheetName: "Clients Master",
      rowNumber: 2,
      rowData: { "Business Name": "TEST WRITE", row_number: 2 }
    }),
    muteHttpExceptions: true
  });
  Logger.log(res.getResponseCode() + " — " + res.getContentText());
}
