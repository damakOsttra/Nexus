/**
 * src/Backup.js
 * Automated Google Drive compliance snapshot engine and Year-End rollover backup utilities.
 * Generates full spreadsheet backups as .xlsx files, logs them to Google Sheet database, and provides Admin API endpoints.
 */

/**
 * Exports the entire spreadsheet as an Excel (.xlsx) blob.
 * @returns {Blob} The .xlsx file blob.
 */
function exportSpreadsheetAsXlsx() {
  const ssId = CONFIG.SPREADSHEET_ID;
  const url = `https://docs.google.com/spreadsheets/d/${ssId}/export?format=xlsx`;
  const token = ScriptApp.getOAuthToken();
  
  const response = UrlFetchApp.fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + token
    },
    muteHttpExceptions: true
  });
  
  if (response.getResponseCode() !== 200) {
    throw new Error("Failed to export spreadsheet as XLSX: " + response.getContentText());
  }
  
  return response.getBlob();
}

/**
 * CORE BACKUP: Exports the entire Spreadsheet as an .xlsx workbook,
 * saves it inside a structured folder in Google Drive (Parent ID -> Nexus Application Data -> Year -> Month),
 * logs the event in the "Snapshot Logs" sheet, and sends an email to the administrator distribution list with the file attached.
 * 
 * @param {string} triggerType - The event that triggered this backup ("Close Cycle", "Ad-Hoc", "Purge")
 * @returns {string} - The permanent URL link to the saved file in Google Drive
 */
function triggerSnapshotAndNotify(triggerType) {
  const ss = getSpreadsheet();
  
  // 1. Export the entire spreadsheet as an XLSX file
  const fileBlob = exportSpreadsheetAsXlsx();
  
  // 2. Locate or Create structured folders under CONFIG.DRIVE_BACKUP_FOLDER_ID
  const parentFolder = DriveApp.getFolderById(CONFIG.DRIVE_BACKUP_FOLDER_ID);
  const nexusFolder = getOrCreateDriveFolder("Nexus Application Data", parentFolder);
  
  const activePeriod = getActivePeriod(); // Align backup folders with actual active period
  const periodParts = activePeriod.split(" ");
  const currentMonthName = periodParts[0];
  const currentYear = periodParts[1];
  
  const yearFolder = getOrCreateDriveFolder(currentYear, nexusFolder);
  const monthFolder = getOrCreateDriveFolder(currentMonthName, yearFolder);
  
  // 3. Assemble File Name
  const timestamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "yyyyMMdd_HHmmss");
  const fileName = `Nexus_Spreadsheet_Backup_${currentYear}_${currentMonthName}_${triggerType.replace(/\s+/g, '')}_${timestamp}.xlsx`;
  
  fileBlob.setName(fileName);
  
  // 4. Save XLSX file to Drive
  const file = monthFolder.createFile(fileBlob);
  const fileUrl = file.getUrl();
  
  // 5. Log transaction into Snapshot Logs sheet
  logSnapshotEvent(triggerType, fileUrl);
  
  // 6. Send Transaction Email Notification to Admins
  const adminEmails = getAdminEmails();
  const emailBlob = file.getBlob().setName(fileName);
  
  const formattedTime = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "dd/MM/yyyy HH:mm:ss");
  const execUser = Session.getActiveUser().getEmail() || "System Automator";
  
  const subject = `[NEXUS ARCHIVE] Full Workbook Snapshot - ${currentYear} ${currentMonthName} (${triggerType})`;
  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; border: 1px solid #e0e0e0; border-radius: 8px; padding: 24px; background-color: #ffffff;">
      <h2 style="color: #FF0061; margin-top: 0; font-weight: 900; letter-spacing: -0.5px;">NEXUS SYSTEM ARCHIVE</h2>
      <hr style="border: 0; border-top: 1px solid #e0e0e0; margin-bottom: 24px;" />
      <p style="font-size: 14px; color: #333333; line-height: 1.5;">This email confirms that an unalterable, full workbook snapshot of the Nexus database has been generated and archived successfully as an Excel spreadsheet.</p>
      
      <table style="width: 100%; border-collapse: collapse; margin-top: 24px; margin-bottom: 24px; font-size: 13px; color: #444444;">
        <tr style="background-color: #f8f8f8;">
          <td style="padding: 12px 10px; font-weight: bold; border-bottom: 1px solid #e0e0e0; width: 180px;">Trigger Type</td>
          <td style="padding: 12px 10px; border-bottom: 1px solid #e0e0e0;">${triggerType}</td>
        </tr>
        <tr>
          <td style="padding: 12px 10px; font-weight: bold; border-bottom: 1px solid #e0e0e0;">Compliance Period</td>
          <td style="padding: 12px 10px; border-bottom: 1px solid #e0e0e0;">${currentMonthName} ${currentYear}</td>
        </tr>
        <tr style="background-color: #f8f8f8;">
          <td style="padding: 12px 10px; font-weight: bold; border-bottom: 1px solid #e0e0e0;">Archived Timestamp</td>
          <td style="padding: 12px 10px; border-bottom: 1px solid #e0e0e0;">${formattedTime}</td>
        </tr>
        <tr>
          <td style="padding: 12px 10px; font-weight: bold; border-bottom: 1px solid #e0e0e0;">Executing Administrator</td>
          <td style="padding: 12px 10px; border-bottom: 1px solid #e0e0e0;">${execUser}</td>
        </tr>
        <tr style="background-color: #f8f8f8;">
          <td style="padding: 12px 10px; font-weight: bold; border-bottom: 1px solid #e0e0e0;">Permanent File Link</td>
          <td style="padding: 12px 10px; border-bottom: 1px solid #e0e0e0;"><a href="${fileUrl}" style="color: #FF0061; text-decoration: none; font-weight: bold;">View in Google Drive ↗</a></td>
        </tr>
      </table>
      
      <p style="font-size: 11px; color: #888888; margin-top: 32px; line-height: 1.4; border-top: 1px solid #e0e0e0; padding-top: 16px;">This is an automated transaction log. The compiled Excel payload has been attached directly to this message for secure offline vaulting.</p>
    </div>
  `;
  
  if (adminEmails && adminEmails.length > 0) {
    try {
      MailApp.sendEmail({
        to: adminEmails.join(","),
        subject: subject,
        htmlBody: htmlBody,
        attachments: [emailBlob]
      });
    } catch(mailErr) {
      console.error("Failed to send snapshot email notification:", mailErr.message);
    }
  }
  
  // Log the event securely into App System Logs
  logSystemEvent(execUser, "GLOBAL", `Archived ${triggerType} Workbook Snapshot to Drive`, "Entire Workbook", "Live Sheet", fileName);
  try {
    logBackendTelemetry("DB_BACKUP_EXECUTED", "Entire Workbook", `Trigger: ${triggerType} | Link: ${fileUrl}`, "GLOBAL");
  } catch (e) {
    console.warn("Failed to log DB_BACKUP_EXECUTED telemetry event:", e.message);
  }
  
  return fileUrl;
}

/**
 * PRIVATE HELPER: Logs snapshot details to the "Snapshot Logs" sheet.
 * Auto-creates the sheet if it doesn't already exist.
 */
function logSnapshotEvent(triggerType, fileUrl) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEETS.SNAPSHOT_LOGS);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEETS.SNAPSHOT_LOGS);
    const headers = ["Timestamp", "Trigger Type", "Month/Year", "Triggered By", "Drive Link"];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  }
  
  const timestamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "yyyy-MM-dd HH:mm:ss");
  const period = getActivePeriod(); // Align snapshot log month with actual active period
  const user = Session.getActiveUser().getEmail() || "System Automator";
  
  sheet.appendRow([timestamp, triggerType, period, user, fileUrl]);
  SpreadsheetApp.flush(); // Force the data to be written immediately so getSnapshotLogs sees it
}

/**
 * ADMIN: Fetch all snapshot logs for UI
 */
function getSnapshotLogs() {
  validateTier(3); // Admin Only
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.SNAPSHOT_LOGS);
    if (!sheet) return [];
    
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return [];
    
    const tz = ss.getSpreadsheetTimeZone();
    const headers = data.shift().map(h => String(h || "").trim());
    return data.map((row) => {
      const obj = {};
      headers.forEach((header, i) => {
        let val = row[i];
        if (val instanceof Date) {
          if (header === "Timestamp") {
            val = Utilities.formatDate(val, tz, "yyyy-MM-dd HH:mm:ss");
          } else if (header === "Month/Year" || header === "Month and Year" || header === "Period") {
            val = Utilities.formatDate(val, tz, "MMMM yyyy");
          } else {
            val = Utilities.formatDate(val, tz, "yyyy-MM-dd");
          }
        }
        obj[header] = val;
      });
      return obj;
    }).reverse(); // Latest first
  } catch (e) {
    console.error("Failed to get snapshot logs:", e.message);
    throw new Error("Failed to get snapshot logs: " + e.message);
  }
}

/**
 * ADMIN: Delete a snapshot log from tracking sheet (does not delete Drive file)
 */
function deleteSnapshotLog(timestamp) {
  validateTier(3); // Admin Only
  return runWithWriteLock(() => {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.SNAPSHOT_LOGS);
    if (!sheet) throw new Error("Snapshot Logs sheet not found.");
    
    const tz = ss.getSpreadsheetTimeZone();
    const data = sheet.getDataRange().getValues();
    const targetTimeStr = String(timestamp).trim();

    for (let i = 1; i < data.length; i++) {
      const rowTime = data[i][0];
      let rowTimeStr = "";
      if (rowTime instanceof Date) {
        rowTimeStr = Utilities.formatDate(rowTime, tz, "yyyy-MM-dd HH:mm:ss");
      } else {
        rowTimeStr = String(rowTime || "").trim();
      }

      if (rowTimeStr === targetTimeStr) {
        sheet.deleteRow(i + 1);
        return { success: true };
      }
    }
    throw new Error("Log record not found.");
  });
}

/**
 * ADMIN: Button 1 - Close Cycle
 */
function executeCloseCycleBackup() {
  validateTier(3); // Admin Only
  try {
    const fileUrl = triggerSnapshotAndNotify("Close Cycle");
    return { success: true, url: fileUrl };
  } catch (e) {
    console.error("[BACKUP] Close Cycle backup failed:", e.message);
    return { success: false, error: e.message };
  }
}

/**
 * ADMIN: Button 2 - Ad-Hoc Backup
 */
function executeAdHocBackup() {
  validateTier(3); // Admin Only
  try {
    const fileUrl = triggerSnapshotAndNotify("Ad-Hoc");
    return { success: true, url: fileUrl };
  } catch (e) {
    console.error("[BACKUP] Ad-Hoc backup failed:", e.message);
    return { success: false, error: e.message };
  }
}

/**
 * ADMIN: Button 3 - Year-End Purge
 * Overwrites allocation sheet with a clean state at year-end,
 * preserving headers, and resets all employee FTE summaries to 0%.
 * Runs a complete "Purge" snapshot prior to deletion for total safety.
 * 
 * @returns {string} - Status message confirming clean state reset
 */
function executeYearEndPurge() {
  const session = validateTier(3); // Admin Only
  return runWithWriteLock(() => {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
    if (!sheet) throw new Error("Allocation Historical sheet not found.");
    
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return "Database is already empty.";
    
    const headers = data[0];
    
    // 1. Perform automatic backup of the entire spreadsheet immediately before purge
    triggerSnapshotAndNotify("Purge");
    
    // 2. Clear contents and re-write headers
    sheet.clearContents();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    
    // 3. Reset Employee summaries in Master roster
    const empSheet = ss.getSheetByName(CONFIG.SHEETS.EMPLOYEES);
    if (empSheet) {
      const empData = empSheet.getDataRange().getValues();
      const empHeaders = empData[0].map(h => String(h || "").trim());
      const emailIdx = empHeaders.indexOf("Email Address");
      const bauIdx = empHeaders.indexOf("BAU (%)");
      const nbauIdx = empHeaders.indexOf("Non-BAU (%)");
      const mgmtIdx = empHeaders.indexOf("Management (%)");
      const fteIdx = empHeaders.indexOf("Total FTE (%)");
      
      if (emailIdx !== -1) {
        for (let i = 1; i < empData.length; i++) {
          if (bauIdx !== -1) empSheet.getRange(i + 1, bauIdx + 1).setValue(0);
          if (nbauIdx !== -1) empSheet.getRange(i + 1, nbauIdx + 1).setValue(0);
          if (mgmtIdx !== -1) empSheet.getRange(i + 1, mgmtIdx + 1).setValue(0);
          if (fteIdx !== -1) empSheet.getRange(i + 1, fteIdx + 1).setValue(0);
        }
      }
    }
    
    // 4. Clear all operational configs caches
    try {
      const cache = CacheService.getScriptCache();
      cache.removeAll(["system_config", "product_catalog", "filter_metadata"]);
    } catch(e) {
      console.warn("Failed to clear config caches during Year-End Purge:", e);
    }
    
    logSystemEvent(session.email, "GLOBAL", "Executed Year-End Cold Purge & Reset", CONFIG.SHEETS.ALLOCATION_HISTORICAL, `${data.length - 1} rows cleared`, "Headers Only (Clean Slate)");
    return "Success: The active allocations database has been rolled forward to a clean slate. An emergency backup snapshot of the entire workbook was generated prior to clearing.";
  });
}

/**
 * PRIVATE HELPER: Gets an existing folder by name or creates it under parent (or root)
 * @param {string} folderName - The folder name
 * @param {Folder} [parentFolder] - Optional parent folder instance
 * @returns {Folder} - The Folder instance
 */
function getOrCreateDriveFolder(folderName, parentFolder) {
  const parent = parentFolder || DriveApp.getRootFolder();
  const folders = parent.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return parent.createFolder(folderName);
}

/**
 * ADMIN SETUP: Explicit setup function to trigger the Google OAuth consent popup
 * for DriveApp and MailApp permissions when deploying the script or adding new scope dependencies.
 */
function setupAuthorization() {
  validateTier(3); // Admin Only
  console.log("[SETUP] Initializing explicit service authorization routine...");
  
  // Trivial calls to register AST tokens and force OAuth triggers
  const root = DriveApp.getRootFolder();
  console.log("[SETUP] Drive Service Authorized. Root folder located: " + root.getName());
  
  const mailQuota = MailApp.getRemainingDailyQuota();
  console.log("[SETUP] Mail Service Authorized. Daily email quota remaining: " + mailQuota);
  
  return "Authorization Successful! All core dependent services (DriveApp & MailApp) have been verified and authorized.";
}
