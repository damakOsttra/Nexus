/**
 * src/Triggers.js
 * Centralized background job routing for UAT and PROD environments.
 * Allows running separate triggers for UAT and PROD within the same Apps Script project.
 */

// =========================================================================
// ENVIRONMENT WRAPPERS
// =========================================================================

// 1. Rolling Backup (Backup.js)
function executeRollingBackup_UAT() {
  setEnvironment('UAT');
  executeRollingBackup();
}
function executeRollingBackup_PROD() {
  setEnvironment('PROD');
  executeRollingBackup();
}

// 2. Dayforce Sync Audit (Db.js)
function auditDayforceVsGoogle_UAT() {
  setEnvironment('UAT');
  auditDayforceVsGoogle();
}
function auditDayforceVsGoogle_PROD() {
  setEnvironment('PROD');
  auditDayforceVsGoogle();
}

// 3. Automated Allocation Reminders (Db.js)
function runAutomatedAllocationReminders_UAT() {
  setEnvironment('UAT');
  runAutomatedAllocationReminders();
}
function runAutomatedAllocationReminders_PROD() {
  setEnvironment('PROD');
  runAutomatedAllocationReminders();
}

// 4. Monthly Allocation Snapshot (Db.js)
function generateMonthlyAllocationSnapshot_UAT() {
  setEnvironment('UAT');
  generateMonthlyAllocationSnapshot();
}
function generateMonthlyAllocationSnapshot_PROD() {
  setEnvironment('PROD');
  generateMonthlyAllocationSnapshot();
}

// 5. Opex Jira Sync (OpexBackend.js)
function syncOpexJiraData_UAT() {
  setEnvironment('UAT');
  syncOpexJiraData();
}
function syncOpexJiraData_PROD() {
  setEnvironment('PROD');
  syncOpexJiraData();
}

// 6. TPM Compliance Nudge (TpmBackend.js)
function executeAutomatedTpmNudge_UAT() {
  setEnvironment('UAT');
  executeAutomatedTpmNudge();
}
function executeAutomatedTpmNudge_PROD() {
  setEnvironment('PROD');
  executeAutomatedTpmNudge();
}

// 7. Master Data Export (AllEmployee.js)
function exportAnupOrgMasterData_UAT() {
  setEnvironment('UAT');
  exportAnupOrgMasterData();
}
function exportAnupOrgMasterData_PROD() {
  setEnvironment('PROD');
  exportAnupOrgMasterData();
}

// 8. TPM Jira Sync (TpmBackend.js)
function syncTpmJiraData_UAT() {
  setEnvironment('UAT');
  syncTpmJiraData();
}
function syncTpmJiraData_PROD() {
  setEnvironment('PROD');
  syncTpmJiraData();
}
function syncTpmJiraDataFull_UAT() {
  setEnvironment('UAT');
  syncTpmJiraDataFull();
}
function syncTpmJiraDataFull_PROD() {
  setEnvironment('PROD');
  syncTpmJiraDataFull();
}

// =========================================================================
// PROGRAMMATIC TRIGGER SETUP ACTIONS
// =========================================================================

/**
 * ADMIN: Setup daily automated Master Data Export for Anup's Org.
 * Runs daily at 1:00 AM.
 */
function setupOrgMasterDataTrigger() {
  validateTier(3); // Admin Only
  const functionsToRegister = ["exportAnupOrgMasterData_UAT", "exportAnupOrgMasterData_PROD"];

  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (functionsToRegister.indexOf(t.getHandlerFunction()) !== -1 || t.getHandlerFunction() === "exportAnupOrgMasterData") {
      ScriptApp.deleteTrigger(t);
    }
  });

  functionsToRegister.forEach(fn => {
    ScriptApp.newTrigger(fn)
      .timeBased()
      .everyDays(1)
      .atHour(1)
      .create();
  });

  console.log("[TRIGGERS] Successfully established daily Master Data Export triggers for UAT and PROD.");
  return { success: true, message: "Successfully established daily 1 AM Master Data Export triggers for UAT and PROD." };
}

/**
 * ADMIN: Setup daily automated TPM Jira Sync.
 * Runs daily at 2:00 AM.
 */
function setupTpmJiraDataTrigger() {
  validateTier(3); // Admin Only
  const functionsToRegister = ["syncTpmJiraData_UAT", "syncTpmJiraData_PROD"];

  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (functionsToRegister.indexOf(t.getHandlerFunction()) !== -1 || t.getHandlerFunction() === "syncTpmJiraData") {
      ScriptApp.deleteTrigger(t);
    }
  });

  functionsToRegister.forEach(fn => {
    ScriptApp.newTrigger(fn)
      .timeBased()
      .everyDays(1)
      .atHour(2)
      .create();
  });

  console.log("[TRIGGERS] Successfully established daily TPM Jira Sync triggers for UAT and PROD.");
  return { success: true, message: "Successfully established daily 2 AM TPM Jira Sync triggers for UAT and PROD." };
}
