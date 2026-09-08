/**
 * src/OpexBackend.js
 * Backend routines for OPEX Portfolio management and JIRA automated sync.
 */

/**
 * Standardizes Jira Status names into Nexus OPEX statuses:
 * 'Backlog', 'Active', 'Blocked', 'Completed'
 */
function mapJiraStatus(jiraStatusName) {
  const status = String(jiraStatusName || "").toLowerCase().trim();
  if (["in progress", "active", "selected for development", "development", "ready for development", "under review", "in review"].includes(status)) {
    return "Active";
  }
  if (["blocked", "stuck", "hold", "on hold", "paused"].includes(status)) {
    return "Blocked";
  }
  if (["done", "completed", "closed", "resolved", "approved", "deployed"].includes(status)) {
    return "Completed";
  }
  return "Backlog"; // Default for Open, To Do, Backlog, etc.
}

/**
 * Helper function to parse complex Jira fields into strings.
 * Directly aligned with Osttra's custom field data types.
 */
function getJiraValueAsString(f) {
  if (!f) return "";
  if (f.value) return String(f.value);
  if (f.displayName) return String(f.displayName);
  if (Array.isArray(f)) return f.map(i => i.value || i.displayName || String(i)).join('; ');
  return String(f);
}

/**
 * Resolves a Jira user object to their canonical OSTTRA employee email.
 * Cross-references the active Employee Roster to ensure 100% email accuracy.
 */
function resolveOpexLeadEmail(assigneeObj, employees) {
  if (!assigneeObj) return "unassigned@osttra.com";
  if (assigneeObj.emailAddress) return assigneeObj.emailAddress.toLowerCase().trim();
  
  const displayName = String(assigneeObj.displayName || "").toLowerCase().trim();
  if (!displayName) return "unassigned@osttra.com";
  
  for (let i = 0; i < employees.length; i++) {
    const emp = employees[i];
    const hrName = String(emp["HR Name"] || "").toLowerCase().trim();
    const chatName = String(emp["Google Chat Full Name"] || "").toLowerCase().trim();
    const firstLast = `${String(emp["First Name"] || "").trim()} ${String(emp["Last Name"] || "").trim()}`.toLowerCase().trim();
    if (hrName === displayName || chatName === displayName || firstLast === displayName) {
      return String(emp["Email Address"] || "").toLowerCase().trim();
    }
  }
  return "unassigned@osttra.com";
}

/**
 * Automates the synchronization of non-CTB initiatives from Jira into the OPEX tracker.
 * Fetches DigiOps (PRF JQL) and Process Improvements (NT JQL), merging updates in a single bulk operation.
 * Leverages the modern POST /rest/api/3/search/jql endpoint with cursor-based nextPageToken paging.
 */
function syncOpexJiraData() {
  const session = getCurrentUserSession();
  const isOpex = !!session.isOpexUser || session.tier >= 3;
  if (!isOpex) {
    throw new Error("Unauthorized: Only Admins and OPEX Representatives are permitted to run JIRA Sync.");
  }

  // 1. Fetch credentials
  const props = PropertiesService.getScriptProperties();
  const JIRA_BASE = props.getProperty("JIRA_BASE_URL") || "https://osttra.atlassian.net";

  const authHeader = getJiraHeaders();

  // 2. Load Employee Roster (to resolve lead emails)
  const employees = getSheetData(CONFIG.SHEETS.EMPLOYEES);

  // 3. Define JQL Queries & target streams
  const syncConfigs = [
    {
      stream: "DigiOps",
      jql: 'project = \'PRF\' AND type = Idea AND "teams[checkboxes]" = DigiOps'
    },
    {
      stream: "Process Improvements",
      jql: 'project = NT AND type = Project'
    }
  ];

  const FIELD_MAPPING = {
    'Theme': 'customfield_23804',
    'DigiOps Status': 'customfield_12983',
    'Summary': 'summary',
    'Assignee': 'assignee'
  };

  const fieldsToRequest = [
    FIELD_MAPPING['Summary'],
    FIELD_MAPPING['Assignee'],
    FIELD_MAPPING['Theme'],
    FIELD_MAPPING['DigiOps Status'],
    'status'
  ];

  const fetchedIssues = []; // array of { key, summary, status, assignee, stream }

  // 4. Query JIRA JQL search API
  syncConfigs.forEach(cfg => {
    let nextPageToken = null;
    const maxResults = 100;

    do {
      const payload = {
        jql: cfg.jql,
        maxResults: maxResults,
        fields: fieldsToRequest
      };
      if (nextPageToken) {
        payload.nextPageToken = nextPageToken;
      }

      const options = {
        method: 'post',
        contentType: 'application/json',
        headers: authHeader,
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      };

      const response = UrlFetchApp.fetch(`${JIRA_BASE}/rest/api/3/search/jql`, options);
      const statusCode = response.getResponseCode();
      const content = response.getContentText();
      const data = JSON.parse(content);

      if (statusCode !== 200 || data.errorMessages) {
        const errMsg = data.errorMessages ? data.errorMessages.join(", ") : `HTTP Status ${statusCode}`;
        throw new Error(`Jira Search Error [${cfg.stream}]: ${errMsg}`);
      }

      if (data.issues && data.issues.length > 0) {
        data.issues.forEach(issue => {
          const f = issue.fields;
          
          // Resolve status: try custom DigiOps status field first, fall back to standard Jira status name
          const rawStatus = f[FIELD_MAPPING['DigiOps Status']] 
            ? getJiraValueAsString(f[FIELD_MAPPING['DigiOps Status']]) 
            : (f.status ? f.status.name : "");
          
          fetchedIssues.push({
            key: issue.key,
            summary: f.summary || "No Summary",
            status: rawStatus,
            assignee: resolveOpexLeadEmail(f.assignee, employees),
            stream: cfg.stream
          });
        });
      }

      nextPageToken = data.nextPageToken || null;

    } while (nextPageToken);
  });

  if (fetchedIssues.length === 0) {
    return { success: true, message: "Sync finished. No matching tickets found in JIRA.", importedCount: 0 };
  }

  // 5. Load current spreadsheet records inside a Write Lock
  return runWithWriteLock(() => {
    const ss = getSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.OPEX_PROJECT_TRACKER);
    if (!sheet) throw new Error("OPEX Project Tracker sheet not found.");

    const rawData = sheet.getDataRange().getValues();
    const headers = rawData[0].map(h => String(h || "").trim());

    const idIdx = headers.indexOf("Project ID");
    const jiraIdx = headers.indexOf("Jira Key");
    const streamIdx = headers.indexOf("Stream");
    const nameIdx = headers.indexOf("Project Name");
    const leadIdx = headers.indexOf("Ops Ex Lead Email");
    const champIdx = headers.indexOf("Project Champion Emails");
    const statusIdx = headers.indexOf("Status");
    const updatedByIdx = headers.indexOf("Last Updated By");
    const dateIdx = headers.indexOf("Last Updated");

    if (idIdx === -1 || jiraIdx === -1 || statusIdx === -1) {
      throw new Error("Tracker database sheet headers are corrupted.");
    }

    // Map existing records by Jira Key for fast lookup
    const existingMap = {};
    const processedJiraKeys = new Set();
    
    // We will build a clean 2D array of rows to write back.
    // Keeps CTB manually-added projects (without Jira Key) untouched!
    const updatedRows = [headers];

    // Determine current highest OPX sequential integer
    let maxIdNum = 0;
    for (let i = 1; i < rawData.length; i++) {
      const idStr = String(rawData[i][idIdx]).trim();
      const match = idStr.match(/^OPX-(\d+)$/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxIdNum) maxIdNum = num;
      }
      
      const key = String(rawData[i][jiraIdx]).trim().toUpperCase();
      if (key && key !== "N/A" && key !== "") {
        existingMap[key] = rawData[i];
      } else {
        // Keeps CTB manually-added projects untouched!
        updatedRows.push(rawData[i]);
      }
    }

    let newlyCreatedCount = 0;
    let updatedCount = 0;

    // Loop through Jira-fetched issues to merge updates
    fetchedIssues.forEach(issue => {
      const cleanKey = issue.key.trim().toUpperCase();
      processedJiraKeys.add(cleanKey);

      const timestampStr = Utilities.formatDate(new Date(), tz, "dd/MM/yyyy HH:mm:ss");

      if (existingMap[cleanKey]) {
        // MERGE: Update JIRA-sourced columns, but strictly preserve manual inputs like Champions
        const existingRow = existingMap[cleanKey];
        const rowValues = headers.map((h, index) => {
          switch(h) {
            case "Project ID": return existingRow[idIdx];
            case "Jira Key": return cleanKey;
            case "Stream": return issue.stream;
            case "Project Name": return issue.summary;
            case "Ops Ex Lead Email": return issue.assignee;
            case "Status": return issue.status;
            case "Last Updated By": return "Jira Sync";
            case "Last Updated": return timestampStr;
            // PRESERVE Champion allocations
            case "Project Champion Emails": return existingRow[champIdx];
            default: return existingRow[index] || "";
          }
        });
        updatedRows.push(rowValues);
        updatedCount++;
      } else {
        // CREATE: Append new record and auto-increment Project ID
        maxIdNum++;
        const newProjId = "OPX-" + String(maxIdNum).padStart(3, "0");

        const rowValues = headers.map(h => {
          switch(h) {
            case "Project ID": return newProjId;
            case "Jira Key": return cleanKey;
            case "Stream": return issue.stream;
            case "Project Name": return issue.summary;
            case "Ops Ex Lead Email": return issue.assignee;
            case "Status": return issue.status;
            case "Project Champion Emails": return "";
            case "Last Updated By": return "Jira Sync";
            case "Last Updated": return timestampStr;
            default: return "";
          }
        });
        updatedRows.push(rowValues);
        newlyCreatedCount++;
      }
    });

    // Handle JIRA keys in spreadsheet that were NOT returned by JIRA search (keeps legacy or closed synced keys untouched)
    for (const key in existingMap) {
      if (!processedJiraKeys.has(key)) {
        updatedRows.push(existingMap[key]);
      }
    }

    // Write everything back in ONE bulk write operation
    sheet.clearContents();
    sheet.getRange(1, 1, updatedRows.length, updatedRows[0].length).setValues(updatedRows);

    // Clear caches
    clearSheetCache(CONFIG.SHEETS.OPEX_PROJECT_TRACKER);

    // Log telemetry
    logSystemEvent(
      session.realEmail || session.email,
      "SYSTEM",
      `Synchronized OPEX JIRA Data (Created: ${newlyCreatedCount} | Updated: ${updatedCount})`,
      CONFIG.SHEETS.OPEX_PROJECT_TRACKER,
      "N/A",
      `Active Sync`
    );

    try {
      logBackendTelemetry(
        "OPEX_JIRA_SYNCED",
        CONFIG.SHEETS.OPEX_PROJECT_TRACKER,
        `Sync count: ${newlyCreatedCount + updatedCount}`,
        "SYSTEM"
      );
    } catch (e) {
      console.warn("Failed to log sync telemetry:", e.message);
    }

    return {
      success: true,
      message: `JIRA Sync finished! Created ${newlyCreatedCount} new projects and updated ${updatedCount} existing project details.`,
      newlyCreatedCount,
      updatedCount
    };
  });
}

/**
 * Time-driven trigger setup for automatic background syncs.
 * Configured to run every 4 hours.
 */
function createOpexJiraSyncTrigger() {
  const functionsToRegister = ['syncOpexJiraData_UAT', 'syncOpexJiraData_PROD'];
  const triggers = ScriptApp.getProjectTriggers();
  
  triggers.forEach(t => {
    if (functionsToRegister.indexOf(t.getHandlerFunction()) !== -1 || t.getHandlerFunction() === 'syncOpexJiraData') {
      ScriptApp.deleteTrigger(t);
    }
  });

  functionsToRegister.forEach(fn => {
    ScriptApp.newTrigger(fn)
      .timeBased()
      .everyHours(4)
      .create();
  });
  console.log("[TRIGGER] Created background time triggers for syncOpexJiraData (UAT & PROD).");
}
