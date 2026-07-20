/**
 * src/Telemetry.js
 * Project Nexus Telemetry Engine - Backend Interface
 * Provides robust endpoints for tracking application adoption and client-side performance.
 */

// Approved high-value tracking events
const ALLOWED_TELEMETRY_EVENTS = [
  'ALLOCATION_SUBMITTED',     // Employee Self-Serve
  'MANAGER_PROXY_SUBMITTED',  // Manager Override
  'ALLOCATION_UNLOCKED',      // Timecard Reset
  'PRODUCT_SCOPE_ASSIGNED',   // Manager Operational Mapping
  'SKILL_ASSIGNED',           // Manager Skill Rating
  'ANALYTICS_VIEWED',         // User opens a dashboard
  'MODULE_ACCESSED',          // General navigation telemetry
  'MANUAL_OVERRIDE_ADDED',    // Admin manually excludes employee
  'MANUAL_OVERRIDE_REMOVED',  // Admin restores employee
  'FINANCE_REPORT_EXPORTED',  // Admin/Leadership Data Pull
  'DB_BACKUP_EXECUTED',       // System Snapshot
  'REPORT_PUBLISHED',         // Admin Analytics Hub Upload
  'REPORT_DELETED',           // Admin Analytics Hub Removal
  'SYSTEM_STATE_CHANGED',     // Admin Locks/Unlocks App
  'DAYFORCE_AUDIT_RUN',       // Discrepancy Scan Executed
  'BULK_EMAILS_SENT'          // Compliance Reminders Dispatched
];

/**
 * Frontend Telemetry Receiver
 * Called asynchronously from the client via google.script.run.
 * Logs high-value user adoption events.
 * 
 * @param {string} actionType - The type of action (must be in ALLOWED_TELEMETRY_EVENTS)
 * @param {string} sheetOrModule - The affected module or UI tab name
 * @param {string} details - Additional contextual metadata
 */
function logFrontendEvent(actionType, sheetOrModule, details) {
  try {
    const session = getCurrentUserSession();
    
    // STRICT RULE: Never log simulated sessions in production telemetry
    if (session.isSimulated) {
      console.log(`[TELEMETRY BYPASS] Simulated session detected for ${session.email}. Ignoring event: ${actionType}`);
      return;
    }

    if (!ALLOWED_TELEMETRY_EVENTS.includes(actionType)) {
      console.warn(`[TELEMETRY REJECTED] Unknown action type: ${actionType}`);
      return;
    }
    
    // Leverage the existing system logger
    logSystemEvent(
      session.email,
      "TELEMETRY",
      actionType,
      sheetOrModule,
      "N/A",
      details || ""
    );
  } catch (error) {
    console.error("Critical error in telemetry logging:", error.message);
  }
}

/**
 * Backend Telemetry Helper
 * For internal server-side actions (Backups, Saves, Audits)
 */
function logBackendTelemetry(actionType, sheetOrModule, details, targetEmail = "SYSTEM") {
  try {
    const session = getCurrentUserSession();
    
    // STRICT RULE: Never log simulated sessions in production telemetry
    if (session.isSimulated) {
      console.log(`[TELEMETRY BYPASS] Simulated session detected for ${session.email}. Ignoring backend event: ${actionType}`);
      return;
    }

    if (!ALLOWED_TELEMETRY_EVENTS.includes(actionType)) {
      console.warn(`[TELEMETRY REJECTED] Unknown backend action type: ${actionType}`);
      return;
    }

    logSystemEvent(
      session.email,
      targetEmail,
      actionType,
      sheetOrModule,
      "N/A",
      details || ""
    );
  } catch (error) {
    console.warn("Backend telemetry failed silently:", error.message);
  }
}
