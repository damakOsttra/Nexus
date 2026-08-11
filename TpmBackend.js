/**
 * src/TpmBackend.js
 * Backend logic, Jira syncing, timesheet CRUD, and compliance dashboard metrics for TPM.
 */

/**
 * Sync Jira Epic tickets for the TPM project into the local cache sheet.
 * Accessible to Admins (or triggered via a schedule).
 */
/**
 * Sync Jira Epic tickets for the TPM project into the local cache sheet.
 * Performs a fast incremental sync (only fetches tickets updated in the last 14 days) to prevent UI lag.
 */
function syncTpmJiraData() {
  validateTier(1); 
  const JQL = 'project in ("TPM", "PSS", "BSM") AND updated >= -60d ORDER BY updated DESC';
  return executeJiraSyncEngine(JQL, false);
}

/**
 * Fully sync all Jira Epic tickets into the local cache sheet.
 * Intended to be run safely in the background (e.g., via a weekly schedule trigger).
 */
function syncTpmJiraDataFull() {
  validateTier(1); 
  const JQL = 'project in ("TPM", "PSS", "BSM") ORDER BY updated DESC';
  return executeJiraSyncEngine(JQL, true);
}

/**
 * Core engine executing the actual Jira fetching, mapping, and merging logic.
 * Correctly paginates using Jira Cloud startAt and maxResults.
 */
function executeJiraSyncEngine(JQL, isFullSync) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const JIRA_BASE = scriptProperties.getProperty('JIRA_BASE_URL') || 'https://osttra.atlassian.net';

  const COLUMNS_TO_EXTRACT = [
    "Key", "Issue_Type", "Parent_Key", "Account_Name", "Summary", "Status", "Go Live & Onboarding EE",
    "Project start date", "Go-live date", "UAT Estimate", "Effort Estimate (Effort days)",
    "Expected Go Live Date", "UAT start date", "Project Sizing", "Expected UAT start date",
    "Expected project start date", "Created", "Updated", "Technical go-live date", "Opportunity Close Date", "Assignee", "Secondary Assignee", "Planned end", "Planned start"
  ];

  const authHeader = getJiraHeaders();

  // 1. Fetch Field Metadata to map names to field IDs
  const fieldResponse = UrlFetchApp.fetch(`${JIRA_BASE}/rest/api/3/field`, {
    method: 'get',
    headers: authHeader,
    muteHttpExceptions: true
  });

  const fieldData = JSON.parse(fieldResponse.getContentText());
  const nameToIdMap = {};

  if (Array.isArray(fieldData)) {
    fieldData.forEach(f => {
      nameToIdMap[f.name] = f.id;
      nameToIdMap[f.name.toLowerCase()] = f.id;
    });
  }

  // Ensure standard fields are mapped correctly
  nameToIdMap["Assignee"] = "assignee";
  nameToIdMap["Status"] = "status";
  nameToIdMap["Summary"] = "summary";
  nameToIdMap["Issue_Type"] = "issuetype";
  nameToIdMap["Parent_Key"] = "parent";

  const apiFieldsToRequest = COLUMNS_TO_EXTRACT
    .map(name => nameToIdMap[name] || nameToIdMap[name.toLowerCase()])
    .filter(id => id !== undefined); 

  apiFieldsToRequest.push('key'); 

  // 2. Fetch all matching issues using the mandatory /search/jql endpoint with cursor-based pagination
  let nextPageToken = null;
  let allIssues = [];

  do {
    const payload = {
      jql: JQL,
      maxResults: 100,
      fields: apiFieldsToRequest
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
    const data = JSON.parse(response.getContentText());

    if (data.errorMessages) throw new Error("Jira API Error: " + data.errorMessages.join(", "));

    if (data.issues && data.issues.length > 0) {
      data.issues.forEach(issue => allIssues.push(issue));
    }

    nextPageToken = data.nextPageToken;

  } while (nextPageToken);

  // 3. Resolve assignee emails using the employees roster
  const employees = getSheetData(CONFIG.SHEETS.EMPLOYEES);

  const getValueAsString = (f) => {
    if (f === null || f === undefined) return "";
    if (typeof f !== 'object') return String(f);
    if (f.value) return String(f.value);
    if (f.name) return String(f.name);
    if (f.displayName) return String(f.displayName);
    if (f.emailAddress) return String(f.emailAddress);
    if (Array.isArray(f)) {
      return f.map(i => getValueAsString(i)).filter(Boolean).join('; ');
    }
    return JSON.stringify(f);
  };

  const resolveEmail = (assigneeObj) => {
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
  };

  // 4. Map columns to headers
  const headers = [
    "Key", "Issue_Type", "Parent_Key", "Assignee_Email", "Secondary_Assignee_Email", "Account_Name", "Summary", "Status", 
    "Go Live & Onboarding EE", "Project start date", "Go-live date", 
    "UAT Estimate", "Effort Estimate (Effort days)", "Expected Go Live Date", 
    "UAT start date", "Project Sizing", "Expected UAT start date", 
    "Expected project start date", "Created", "Updated", "Technical go-live date", "Opportunity Close Date", "Planned end", "Planned start"
  ];

  const rows = [headers];

  allIssues.forEach(issue => {
    const f = issue.fields;
    const row = [];

    headers.forEach(h => {
      if (h === "Key") {
        row.push(issue.key);
      } else if (h === "Issue_Type") {
        row.push(f["issuetype"] && f["issuetype"].name ? f["issuetype"].name : "");
      } else if (h === "Parent_Key") {
        row.push(f["parent"] ? f["parent"].key : (f["customfield_10014"] || ""));
      } else if (h === "Assignee_Email") {
        row.push(resolveEmail(f["assignee"]));
      } else if (h === "Secondary_Assignee_Email") {
        const id = nameToIdMap["Secondary Assignee"] || nameToIdMap["secondary assignee"];
        row.push(id && f[id] ? resolveEmail(f[id]) : "");
      } else if (h === "Account_Name") {
        const id = nameToIdMap["Account_Name"] || nameToIdMap["Account Name"];
        row.push(id ? getValueAsString(f[id]) : "");
      } else if (h === "Summary") {
        row.push(getValueAsString(f["summary"]));
      } else if (h === "Status") {
        row.push(f["status"] && f["status"].name ? f["status"].name : "");
      } else if (h === "Updated") {
        row.push(f["updated"] ? String(f["updated"]) : "");
      } else {
        // Dynamic custom fields
        const id = nameToIdMap[h] || nameToIdMap[h.toLowerCase()];
        row.push(id ? getValueAsString(f[id]) : "");
      }
    });

    rows.push(row);
  });

  // 5. Overwrite/Merge local cache sheet
  return runWithWriteLock(() => {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    let sheet = ss.getSheetByName(CONFIG.SHEETS.TPM_JIRA_CACHE);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.SHEETS.TPM_JIRA_CACHE);
    }

    let mergedRows = [];
    if (!isFullSync) {
      // Incremental Sync Merge logic
      let existingData = [];
      try {
        existingData = sheet.getDataRange().getValues();
      } catch (e) {}

      if (existingData.length > 0 && existingData[0].length > 0) {
        const headerRow = existingData[0];
        mergedRows.push(headerRow);

        const keyColIndex = headerRow.indexOf("Key");
        const existingRowsMap = {};
        for (let i = 1; i < existingData.length; i++) {
          const r = existingData[i];
          const key = String(r[keyColIndex]).toUpperCase().trim();
          if (key) {
            existingRowsMap[key] = r;
          }
        }

        // Merge newly fetched tickets
        for (let i = 1; i < rows.length; i++) {
          const newRow = rows[i];
          const key = String(newRow[0]).toUpperCase().trim();
          existingRowsMap[key] = newRow;
        }

        Object.keys(existingRowsMap).forEach(k => {
          mergedRows.push(existingRowsMap[k]);
        });
      } else {
        mergedRows = rows;
      }
    } else {
      // Full sync overwrite
      mergedRows = rows;
    }

    sheet.clearContents();
    sheet.getRange(1, 1, mergedRows.length, mergedRows[0].length).setValues(mergedRows);
    clearSheetCache(CONFIG.SHEETS.TPM_JIRA_CACHE);

    // Instrument telemetry & system events for Jira sync
    try {
      const activeUser = getCurrentUserSession().email || "System Sync";
      logSystemEvent(activeUser, "GLOBAL", "TPM Jira Sync Executed", CONFIG.SHEETS.TPM_JIRA_CACHE, "N/A", isFullSync ? "Full Sync" : "Delta Sync");
      logBackendTelemetry("TPM_JIRA_SYNCED", CONFIG.SHEETS.TPM_JIRA_CACHE, isFullSync ? "Full Sync" : "Delta Sync", "SYSTEM");
    } catch(telErr) {
      console.warn("Failed to log TPM Jira sync telemetry: " + telErr.message);
    }

    if (isFullSync) {
      return `Full Sync Complete. Replaced cache with ${mergedRows.length - 1} total active tickets from Jira.`;
    } else {
      return `Quick Sync Complete. Incremental fetch merged ${allIssues.length} updated tickets. Total tickets in cache: ${mergedRows.length - 1}.`;
    }
  });
}

/**
 * Retrieve timesheet Epics and existing weekly logs for the current logged-in user.
 * @param {string} weekStartDateStr "YYYY-MM-DD" representing Monday.
 * @param {boolean} showAllEpics Flag to bypass status-based Epic exclusions.
 */
function getTpmTimesheetData(weekStartDateStr, showAllEpics = false, forceRefresh = false) {
  const session = getCurrentUserSession();
  if (!session.isTpmUser && !session.isAdmin && session.identityTier !== 3) {
    throw new Error("Unauthorized: TPM Workspace is restricted to Tier-4 TPM hierarchy.");
  }

  if (forceRefresh) {
    clearSheetCache(CONFIG.SHEETS.TPM_JIRA_CACHE);
    clearSheetCache(CONFIG.SHEETS.TPM_TIMESHEET_LOGS);
    console.log("[CACHE_BUST] Successfully busted timesheet and jira cache for fresh load.");
  }

  // 1. Fetch user's Epics and associated tickets from local Jira Cache
  const cacheData = getSheetData(CONFIG.SHEETS.TPM_JIRA_CACHE);
  const userEmail = session.email.toLowerCase().trim();

  // Fetch logged hours to determine historically logged keys
  const logData = getSheetData(CONFIG.SHEETS.TPM_TIMESHEET_LOGS);
  const allUserLoggedKeys = new Set(
    logData
      .filter(row => String(row["User_Email"] || "").toLowerCase().trim() === userEmail)
      .map(row => String(row["Jira_Key"] || "").toUpperCase().trim())
  );

  // Pre-process logData to build O(1) lookup objects (resolves script timeout)
  const logDataSplitsMap = {};
  const logDataStatusMap = {};
  logData.forEach(row => {
    const key = String(row["Jira_Key"] || "").toUpperCase().trim();
    if (!key) return;

    const hasSplits = (parseFloat(row["UAT_Hours"]) || 0) > 0 || (parseFloat(row["Int_Hours"]) || 0) > 0;
    if (hasSplits) {
      logDataSplitsMap[key] = true;
    }

    const status = String(row["Jira_Status"] || "").trim();
    if (status) {
      logDataStatusMap[key] = status;
    }
  });
  
  // Calculate Monday-Sunday date strings robustly to prevent timezone shifting
  const weekDates = [];
  const parts = String(weekStartDateStr).split('-');
  if (parts.length === 3) {
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.UTC(year, month, day + i)); 
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      weekDates.push(`${yyyy}-${mm}-${dd}`);
    }
  }

  // Support 7-day status transition rule for Completed/Canceled
  const now = new Date();
  const sevenDaysAgoStr = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const fourteenDaysAgoStr = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const activeTpmStatuses = [
    'assigned', 'preparing deployment', 'initiation', 'implementation', 
    'tpm handover approved', 'go live', 'uat', 'technical go live',
    'returned', 'reopened', 'answered', 'retracted', 'preparing development', 'completed'
  ];
  const activePssStatuses = [
    'flow seen', 'flow pending', 'awaiting implementation', 'new', 
    '4-eye approval', 'review', 'completed', 'rolled back'
  ];

  const userEpics = cacheData.filter(row => {
    const assignee = String(row["Assignee_Email"] || "").toLowerCase().trim();
    const secondaryAssignee = String(row["Secondary_Assignee_Email"] || "").toLowerCase().trim();
    if (!userEmail) return false;
    
    const isAssigned = (assignee === userEmail || secondaryAssignee === userEmail);
    if (!isAssigned) return false;

    // Filter statuses
    const status = String(row["Status"] || "").toLowerCase().trim();
    const isEpic = String(row["Issue_Type"] || "Epic").toLowerCase() === "epic";
    if (!isEpic) return false;

    if (!showAllEpics) {
      if (!activeTpmStatuses.includes(status) && !allUserLoggedKeys.has(String(row["Key"]).toUpperCase().trim())) {
        return false;
      }
    }

    return true;
  });

  const epicKeys = userEpics.map(e => String(e["Key"]).trim().toUpperCase());

  // Non-Epic tickets assigned to this user OR child tickets of user's epics
  const childTickets = cacheData.filter(row => {
    const isEpic = String(row["Issue_Type"] || "Epic").toLowerCase() === "epic";
    if (isEpic) return false;

    const issueType = String(row["Issue_Type"] || "").toLowerCase().trim();
    const key = String(row["Key"] || "").toUpperCase();
    const isPss = (issueType === "pss" || key.startsWith("PSS-"));

    const parentKey = String(row["Parent_Key"] || "").trim().toUpperCase();
    const assignee = String(row["Assignee_Email"] || "").toLowerCase().trim();
    const secondaryAssignee = String(row["Secondary_Assignee_Email"] || "").toLowerCase().trim();
    
    const isAssigned = (assignee === userEmail || secondaryAssignee === userEmail);
    const isChildOfMyEpic = parentKey && epicKeys.includes(parentKey);

    if (!isAssigned && !isChildOfMyEpic) return false;

    // Filter statuses
    const status = String(row["Status"] || "").toLowerCase().trim();

    if (!showAllEpics) {
      const whitelist = isPss ? activePssStatuses : activeTpmStatuses;
      if (!whitelist.includes(status) && !allUserLoggedKeys.has(key)) {
        return false;
      }
    }

    return true;
  });

  // 2. Fetch logged hours for this week from TPM_Timesheet_Logs
  // (logData already fetched above)
  
  const userLogs = logData.filter(row => {
    const rowEmail = String(row["User_Email"] || "").toLowerCase().trim();
    const rowDate = normalizeDateToYMD(row["Date_Logged"]);
    return rowEmail === userEmail && weekDates.includes(rowDate);
  });

  const formattedLogs = userLogs.map(log => {
    return { ...log, "Date_Logged": normalizeDateToYMD(log["Date_Logged"]) };
  });

  // Ensure any ticket in the user logs (current week + historically logged keys) is included in userEpics or childTickets (Resolves disappearing logs bug)
  const loggedKeys = [...new Set([
    ...formattedLogs.map(l => String(l["Jira_Key"] || "").toUpperCase().trim()),
    ...Array.from(allUserLoggedKeys)
  ].filter(k => k && k !== 'ooo' && k !== 'ADMIN' && k !== 'MGMT'))];
  
  const existingEpicKeys = new Set(userEpics.map(e => String(e["Key"] || e["key"] || "").toUpperCase().trim()));
  const existingChildKeys = new Set(childTickets.map(c => String(c["Key"] || c["key"] || "").toUpperCase().trim()));

  loggedKeys.forEach(key => {
    if (existingEpicKeys.has(key) || existingChildKeys.has(key)) return;

    // Look up in cacheData
    const foundRow = cacheData.find(row => String(row["Key"] || "").toUpperCase().trim() === key);
    if (foundRow) {
      const isEpic = String(foundRow["Issue_Type"] || "Epic").toLowerCase() === "epic";
      if (isEpic) {
        userEpics.push(foundRow);
        existingEpicKeys.add(key);
      } else {
        childTickets.push(foundRow);
        existingChildKeys.add(key);
      }
    } else {
      // Fallback placeholder if not in cache (check if it was logged with split hours in the logs or starts with TPM-)
      const hasSplits = !!logDataSplitsMap[key];
      const isFallbackEpic = hasSplits || key.startsWith("TPM-");
      
      // Attempt to retrieve existing Jira_Status from previous logs to prevent overwriting with "Active"
      const fallbackStatus = logDataStatusMap[key] || "Active";

      const placeholder = {
        "Key": key,
        "Issue_Type": isFallbackEpic ? "Epic" : "Task",
        "Summary": isFallbackEpic ? "Manually Logged Project Epic" : "Manually Logged Support Ticket",
        "Status": fallbackStatus,
        "Assignee_Email": session.email,
        "Secondary_Assignee_Email": ""
      };
      if (isFallbackEpic) {
        userEpics.push(placeholder);
        existingEpicKeys.add(key);
      } else {
        childTickets.push(placeholder);
        existingChildKeys.add(key);
      }
    }
  });

  // Extract a unique list of all active PSS tickets with summaries from cache
  const activePssTickets = [];
  const pssSet = new Set();
  cacheData.forEach(row => {
    const issueType = String(row["Issue_Type"] || "").toLowerCase().trim();
    const key = String(row["Key"] || "").toUpperCase();
    const status = String(row["Status"] || "").toLowerCase().trim();
    
    const excludedPssStatuses = ['declined', 'rollbackbacked', 'rollbacked', 'completed', 'canceled'];
    if (excludedPssStatuses.includes(status)) return;
    
    const isPss = issueType === "pss" || key.startsWith("PSS-");
    if (isPss && !pssSet.has(key)) {
      pssSet.add(key);
      activePssTickets.push({
        key: key,
        summary: row["Summary"] || "PSS support deployment",
        status: row["Status"] || "Active",
        issueType: "PSS",
        plannedStart: row["Planned start"] || "N/A",
        plannedEnd: row["Planned end"] || "N/A"
      });
    }
  });
  activePssTickets.sort((a, b) => a.key.localeCompare(b.key));

  // Extract a unique list of all active Epics from cache
  const activeEpicsList = [];
  const epicSet = new Set();
  cacheData.forEach(row => {
    const issueType = String(row["Issue_Type"] || "").toLowerCase().trim();
    const key = String(row["Key"] || "").toUpperCase();
    const status = String(row["Status"] || "").toLowerCase().trim();
    
    const excludedTpmStatuses = [
      'with client', 'returned', 'scheduled', 'backlog', 'retracted', 
      'answered', 'not started', 'backlog - with client', 'pending internal', 
      'canceled', 'completed', 'closed'
    ];
    if (excludedTpmStatuses.includes(status)) return;
    
    const isEpic = issueType === "epic" || key.startsWith("TPM-");
    if (isEpic && !epicSet.has(key) && !key.startsWith("PSS-")) {
      epicSet.add(key);
      activeEpicsList.push({
        key: key,
        summary: row["Summary"] || "BAU project epic",
        status: row["Status"] || "Active",
        issueType: "Epic"
      });
    }
  });
  activeEpicsList.sort((a, b) => a.key.localeCompare(b.key));

  // Extract a unique list of all active BSM tickets with summaries from cache
  const activeBsmTickets = [];
  const bsmSet = new Set();
  cacheData.forEach(row => {
    const issueType = String(row["Issue_Type"] || "").toLowerCase().trim();
    const key = String(row["Key"] || "").toUpperCase();
    const status = String(row["Status"] || "").toLowerCase().trim();
    
    const excludedBsmStatuses = ['completed', 'canceled', 'closed', 'resolved', 'done', 'declined'];
    if (excludedBsmStatuses.includes(status)) return;
    
    const isBsm = issueType === "bsm" || key.startsWith("BSM-");
    if (isBsm && !bsmSet.has(key)) {
      bsmSet.add(key);
      activeBsmTickets.push({
        key: key,
        summary: row["Summary"] || "BSM support ticket",
        status: row["Status"] || "Active",
        issueType: "BSM"
      });
    }
  });
  activeBsmTickets.sort((a, b) => a.key.localeCompare(b.key));

  // Determine if user is in Nikita Jain's hierarchy (direct/indirect reports, or Nikita herself)
  let isSolutionDesignEligible = false;
  if (userEmail === 'nikita.jain@osttra.com') {
    isSolutionDesignEligible = true;
  } else {
    try {
      const allEmployees = getSheetData(CONFIG.SHEETS.EMPLOYEES);
      const empMap = {};
      allEmployees.forEach(emp => {
        const email = String(emp["Email Address"] || "").trim().toLowerCase();
        if (email) empMap[email] = emp;
      });

      let current = userEmail;
      let depth = 0;
      const visited = new Set();
      while (current && depth <= 10) {
        visited.add(current);
        const rec = empMap[current];
        const nextMgr = rec ? String(rec["Direct Manager Email"] || "").trim().toLowerCase() : "";
        if (!nextMgr || nextMgr === current || visited.has(nextMgr)) break;
        if (nextMgr === 'nikita.jain@osttra.com') {
          isSolutionDesignEligible = true;
          break;
        }
        current = nextMgr;
        depth++;
      }
    } catch (e) {
      console.error("Failed to trace Nikita Jain hierarchy:", e);
    }
  }

  return {
    epics: userEpics,
    childTickets: childTickets,
    logs: formattedLogs,
    weekDates: weekDates,
    allPssTickets: activePssTickets,
    allEpics: activeEpicsList,
    allBsmTickets: activeBsmTickets,
    historicalLoggedKeys: Array.from(allUserLoggedKeys),
    isSolutionDesignEligible: isSolutionDesignEligible
  };
}

/**
 * Save user timesheet logs for a given week.
 * @param {object} payload { weekStartDate: "YYYY-MM-DD", logs: [{ jiraKey: "TPM-xxx", date: "YYYY-MM-DD", hours: 4.5, uatHours: 0, intHours: 0, goLiveHours: 0 }] }
 */
function saveTpmTimesheetData(payload) {
  const session = getCurrentUserSession();
  if (!session.isTpmUser && !session.isAdmin && session.identityTier !== 3) {
    throw new Error("Unauthorized: TPM Workspace is restricted to Tier-4 TPM hierarchy.");
  }

  if (!payload || !payload.weekStartDate || !Array.isArray(payload.logs)) {
    throw new Error("Invalid timesheet save payload.");
  }

  // Guardrail 1: Lifesaving Safeguard - Block empty timesheet submissions to prevent accidental wipeouts
  if (payload.logs.length === 0) {
    throw new Error("Validation Error: Cannot submit an empty timesheet.");
  }

  // Guardrail 2: Strict Older-Week Locking (Block modifications on any week before the previous week)
  try {
    const today = new Date();
    const todayDay = today.getDay();
    const todayDiff = today.getDate() - todayDay;
    const currentWeekSundayObj = new Date(today.setDate(todayDiff));
    currentWeekSundayObj.setHours(0,0,0,0);

    const prevWeekSundayObj = new Date(currentWeekSundayObj);
    prevWeekSundayObj.setDate(prevWeekSundayObj.getDate() - 7);
    prevWeekSundayObj.setHours(0,0,0,0);

    const parts = String(payload.weekStartDate).split('-');
    if (parts.length === 3) {
      const loadedSundayObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      loadedSundayObj.setHours(0,0,0,0);

      const isOlderWeek = loadedSundayObj < prevWeekSundayObj;
      if (isOlderWeek) {
        throw new Error("Validation Error: This timesheet is locked because editing is restricted for older weeks.");
      }
    }
  } catch (e) {
    if (e.message.indexOf("Validation Error") !== -1) {
      throw e;
    }
    console.error("Backend lock check failed", e);
  }

  const userEmail = session.email.toLowerCase().trim();

  // Compute Mon-Sun dates robustly to prevent timezone shifting
  const weekDates = [];
  const parts = String(payload.weekStartDate).split('-');
  if (parts.length === 3) {
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.UTC(year, month, day + i)); 
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      weekDates.push(`${yyyy}-${mm}-${dd}`);
    }
  }

  return runWithWriteLock(() => {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.SHEETS.TPM_TIMESHEET_LOGS);
    if (!sheet) throw new Error("TPM Timesheet Logs sheet not found.");

    // Calculate a safe future date threshold (adding 1 day) to act as a timezone grace period for APAC users
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const safeFutureStr = Utilities.formatDate(tomorrow, ss.getSpreadsheetTimeZone(), "yyyy-MM-dd");

    // Block any attempt to log hours for future dates (exempting weekends) and enforce strict 24-hour daily limits
    const dailyTotals = {};
    const oooSet = new Set(payload.logs.filter(l => l.jiraKey.toLowerCase() === "ooo").map(l => l.date));

    payload.logs.forEach(log => {
      const parts = log.date.split('-');
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;

      if (log.date > safeFutureStr && !isWeekend) {
        throw new Error("Validation Error: Cannot log hours for future dates (" + log.date + ").");
      }

      const hours = parseFloat(log.hours) || 0;
      if (hours < 0 || hours > 24.01) {
        throw new Error("Validation Error: Individual ticket hours cannot exceed 24.00 hours. Found " + hours.toFixed(2) + "h on " + log.date + " for " + log.jiraKey + ".");
      }

      // Strict OOO conflict check: cannot log hours against a ticket if that day is marked OOO
      if (log.jiraKey.toLowerCase() !== "ooo" && oooSet.has(log.date) && hours > 0) {
        throw new Error("Validation Error: Cannot log hours against " + log.jiraKey + " on " + log.date + " because it is marked as Out of Office (OOO).");
      }
      
      if (log.jiraKey !== "ooo") {
        dailyTotals[log.date] = (dailyTotals[log.date] || 0) + hours;
      }
    });

    for (const date in dailyTotals) {
      const sum = dailyTotals[date];
      if (sum > 24.01) {
        const contribs = [];
        payload.logs.forEach(l => {
          if (l.date === date && (parseFloat(l.hours) || 0) > 0) {
            contribs.push(l.jiraKey + " (" + (parseFloat(l.hours) || 0).toFixed(2) + "h)");
          }
        });
        throw new Error("Validation Error: Total logged hours on " + date + " is " + sum.toFixed(2) + "h, which exceeds the 24-hour daily limit. Breakdown: " + contribs.join(', ') + ".");
      }
    }

    const data = sheet.getDataRange().getValues();
    let headers = data[0].map(h => String(h || "").trim());

    // Self-healing migration: Add "Week_Of" column to sheet if missing
    if (headers.indexOf("Week_Of") === -1) {
      sheet.getRange(1, headers.length + 1).setValue("Week_Of");
      headers.push("Week_Of");
    }

    const emailIdx = headers.indexOf("User_Email");
    const dateIdx = headers.indexOf("Date_Logged");
    const keyColumnIdx = headers.indexOf("Jira_Key");
    const statusIdx = headers.indexOf("Jira_Status");

    // 1. Build a lookup of existing statuses for the rows we are replacing
    const oldStatusLookup = {};
    for (let i = 1; i < data.length; i++) {
      const rowEmail = String(data[i][emailIdx]).toLowerCase().trim();
      const rowDate = normalizeDateToYMD(data[i][dateIdx]);
      const isTarget = (rowEmail === userEmail && weekDates.includes(rowDate));
      if (isTarget && keyColumnIdx !== -1 && statusIdx !== -1) {
        const key = String(data[i][keyColumnIdx] || "").toUpperCase().trim();
        const status = String(data[i][statusIdx] || "").trim();
        if (key && status) {
          oldStatusLookup[key] = status;
        }
      }
    }

    // 2. Build a lookup of live Jira statuses from cacheData
    const cacheStatusLookup = {};
    try {
      const cacheData = getSheetData(CONFIG.SHEETS.TPM_JIRA_CACHE);
      cacheData.forEach(row => {
        const key = String(row["Key"] || "").toUpperCase().trim();
        const status = String(row["Status"] || "").trim();
        if (key && status) {
          cacheStatusLookup[key] = status;
        }
      });
    } catch(e) {
      console.warn("Could not load TPM_JIRA_CACHE for status lookup: " + e.message);
    }

    const filteredRows = [headers];

    // Keep all rows that DO NOT belong to this user for these specific dates
    for (let i = 1; i < data.length; i++) {
      const rowEmail = String(data[i][emailIdx]).toLowerCase().trim();
      const rowDate = normalizeDateToYMD(data[i][dateIdx]);
      const isTarget = (rowEmail === userEmail && weekDates.includes(rowDate));
      if (!isTarget) {
        filteredRows.push(data[i]);
      }
    }

    // Append new logs with hours > 0
    payload.logs.forEach(log => {
      const hours = parseFloat(log.hours) || 0;
      if (hours <= 0) return;

      const otherHours = Math.max(0, hours - ((parseFloat(log.uatHours) || 0) + (parseFloat(log.intHours) || 0)));

      const row = headers.map((h, idx) => {
        if (h === "Log_ID") {
          return idx === 0 ? "LOG-" + Utilities.getUuid().substring(0, 8).toUpperCase() : "";
        }
        switch(h) {
          case "User_Email": return userEmail;
          case "Jira_Key": return log.jiraKey;
          case "Date_Logged": return log.date;
          case "Hours_Logged": return hours;
          case "Created_Timestamp": return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
          case "UAT_Hours": return parseFloat(log.uatHours) || 0;
          case "Int_Hours": return parseFloat(log.intHours) || 0;
          case "Other_Hours": return otherHours;
          case "Jira_Status": 
            const keyUpper = String(log.jiraKey || "").toUpperCase().trim();
            if (keyUpper === "ADMIN" || keyUpper === "MGMT" || keyUpper === "OOO" || keyUpper === "SOLUTION-DESIGN") return "Persistent";
            // Resolve status strictly from backend lookups to completely prevent frontend overwrite corruptions
            return cacheStatusLookup[keyUpper] || oldStatusLookup[keyUpper] || log.jiraStatus || "Active";
          case "Week_Of": return payload.weekStartDate;
          default: return "";
        }
      });
      filteredRows.push(row);
    });

    sheet.clearContents();
    sheet.getRange(1, 1, filteredRows.length, filteredRows[0].length).setValues(filteredRows);
    clearSheetCache(CONFIG.SHEETS.TPM_TIMESHEET_LOGS);

    // Instrument telemetry & system events for timesheet submission
    try {
      logSystemEvent(userEmail, "SYSTEM", "TPM Timesheet Submitted", CONFIG.SHEETS.TPM_TIMESHEET_LOGS, "N/A", `Logged ${payload.logs.length} entries for week of ${payload.weekStartDate}`);
      logBackendTelemetry("TPM_TIMESHEET_SUBMITTED", CONFIG.SHEETS.TPM_TIMESHEET_LOGS, `Logged ${payload.logs.length} entries for week of ${payload.weekStartDate}`, userEmail);
    } catch(telErr) {
      console.warn("Failed to log TPM Timesheet submission telemetry: " + telErr.message);
    }

    // NOTE: The TPM Timesheet Auto-Sync bridge to the Allocation Historical database
    // has been intentionally removed per user request.

    return true;
  });
}

/**
 * Fetch timesheet compliance data for all employees rolling up to the current manager.
 * @param {string} weekStartDateStr "YYYY-MM-DD" representing Monday.
 * @param {boolean} forceRefresh Optional flag to bypass cache.
 */
/**
 * Fetch timesheet compliance data for all employees rolling up to the current manager.
 * @param {string} startDateStr "YYYY-MM-DD" representing range start.
 * @param {string|boolean} endDateStr "YYYY-MM-DD" representing range end (or forceRefresh boolean if omitted).
 * @param {boolean} forceRefresh Optional flag to bypass cache.
 */
function getTpmDashboardData(startDateStr, endDateStr, forceRefresh = false) {
  const session = getCurrentUserSession();
  if (!session.isTpmManager && !session.isAdmin && session.identityTier !== 3) {
    throw new Error("Unauthorized: TPM Monitoring Dashboard is restricted to Tier-4 managers.");
  }

  // Handle backward compatibility for older week-based calls or omitted end dates
  if (!endDateStr || typeof endDateStr === 'boolean') {
    if (typeof endDateStr === 'boolean') {
      forceRefresh = endDateStr;
    }
    const parts = String(startDateStr).split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      const d = new Date(year, month, day + 6);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      endDateStr = `${yyyy}-${mm}-${dd}`;
    }
  }

  const cacheKey = "TPM_COMPLIANCE_DASHBOARD_" + session.email.toLowerCase().trim() + "_" + startDateStr + "_" + endDateStr;
  if (!forceRefresh) {
    const cached = getCachedData(cacheKey);
    if (cached) {
      console.log("Instant Dashboard: Returning cached computed dashboard payload.");
      return cached;
    }
  }

  if (forceRefresh) {
    clearSheetCache(CONFIG.SHEETS.TPM_TIMESHEET_LOGS);
    clearSheetCache(CONFIG.SHEETS.EMPLOYEES);
    console.log("[CACHE_BUST] Successfully busted sheet cache for dashboard load.");
  }

  const targetSheetName = "App All Employee Data (Read / Write)";
  const allEmployees = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  
  // 1. Resolve team roster under the manager's hierarchy (or see all if Admin/Head)
  const managerEmail = session.email.toLowerCase().trim();
  const viewAll = session.identityTier === 3 || managerEmail === 'jack.jeffreys@osttra.com';
  
  const empMap = {};
  allEmployees.forEach(e => {
    const email = String(e["Email Address"] || "").toLowerCase().trim();
    if (email) empMap[email] = e;
  });

  const team = [];
  allEmployees.forEach(e => {
    const email = String(e["Email Address"] || "").toLowerCase().trim();
    if (!email) return;

    // Filter strictly for tagged TPM users, always allowing the logged-in manager themselves
    const isTpmVal = String(e["is_tpm"] || e["Is_TPM"] || e["IS_TPM"] || "").trim().toLowerCase();
    const isTpm = ["yes", "true", "y", "1"].includes(isTpmVal);
    const isSelf = (email === managerEmail);
    if (!isTpm && !isSelf) return;

    // Check hierarchy rollup (skip for Admins who should view the entire TPM list)
    let isMember = viewAll;
    if (!isMember) {
      let current = email;
      const visited = new Set();
      while (current) {
        visited.add(current);
        if (current === managerEmail) {
          isMember = true;
          break;
        }
        const rec = empMap[current];
        const nextMgr = rec ? String(rec["Direct Manager Email"] || "").trim().toLowerCase() : "";
        if (!nextMgr || nextMgr === current || visited.has(nextMgr)) {
          break;
        }
        current = nextMgr;
      }
    }

    // Include managers themselves (e.g. Jack Jeffreys can see himself or nested team)
    // Or if the logged in user is jack, everyone in TPM rolls up to him.
    if (isMember) {
      team.push({
        email: email,
        name: (e["Google Chat Full Name"] || e["HR Name"] || `${e["First Name"] || ""} ${e["Last Name"] || ""}`).trim(),
        region: String(e["Region"] || e["Location"] || e["Office"] || "Global").trim()
      });
    }
  });

  // Sort team alphabetically by name
  team.sort((a, b) => a.name.localeCompare(b.name));

  // 2. Fetch logged hours dynamically between start and end date bounds (Capped at 31 days)
  const weekDates = [];
  const startParts = String(startDateStr).split('-');
  const endParts = String(endDateStr).split('-');
  if (startParts.length === 3 && endParts.length === 3) {
    const sDate = new Date(parseInt(startParts[0], 10), parseInt(startParts[1], 10) - 1, parseInt(startParts[2], 10));
    const eDate = new Date(parseInt(endParts[0], 10), parseInt(endParts[1], 10) - 1, parseInt(endParts[2], 10));
    
    // Limit to maximum 31 days to prevent script execution timeouts or browser freeze
    const diffTime = Math.abs(eDate - sDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    const limitDays = Math.min(diffDays, 31);
    
    for (let i = 0; i < limitDays; i++) {
      const d = new Date(Date.UTC(sDate.getFullYear(), sDate.getMonth(), sDate.getDate() + i));
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      weekDates.push(`${yyyy}-${mm}-${dd}`);
    }
  }

  const logData = getSheetData(CONFIG.SHEETS.TPM_TIMESHEET_LOGS);
  
  // SELF-HEALING ROSTER ENHANCEMENT:
  // Identify all unique emails that logged hours for this specific range.
  const existingTeamEmails = new Set(team.map(t => t.email));
  logData.forEach(row => {
    const email = String(row["User_Email"] || "").toLowerCase().trim();
    const date = normalizeDateToYMD(row["Date_Logged"]);
    if (email && weekDates.includes(date) && !existingTeamEmails.has(email)) {
      // Validate Hierarchy for Self-Healing Roster (skip for Admins who see all)
      let isMember = viewAll;
      if (!isMember) {
        let current = email;
        const visited = new Set();
        while (current) {
          visited.add(current);
          if (current === managerEmail) {
            isMember = true;
            break;
          }
          const rec = empMap[current];
          const nextMgr = rec ? String(rec["Direct Manager Email"] || "").trim().toLowerCase() : "";
          if (!nextMgr || nextMgr === current || visited.has(nextMgr)) {
            break;
          }
          current = nextMgr;
        }
      }

      if (isMember) {
        const emp = empMap[email];
        // Resolve name nicely (fallback to formatting email handle if not in employee database)
        const name = emp ? (emp["Google Chat Full Name"] || emp["HR Name"] || `${emp["First Name"] || ""} ${emp["Last Name"] || ""}`).trim() : email.split('@')[0].split('.').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
        const region = emp ? String(emp["Region"] || emp["Location"] || emp["Office"] || "Global").trim() : "Global";
        
        team.push({
          email: email,
          name: name,
          region: region
        });
        existingTeamEmails.add(email);
      }
    }
  });

  // Re-sort the team list alphabetically since we dynamically appended members
  team.sort((a, b) => a.name.localeCompare(b.name));

  const teamEmails = team.map(t => t.email);

  // Group hours and OOO dates by email and date
  const hoursMap = {};
  const oooMap = {};
  teamEmails.forEach(email => {
    hoursMap[email] = {};
    oooMap[email] = new Set();
    weekDates.forEach(date => {
      hoursMap[email][date] = 0;
    });
  });

  logData.forEach(row => {
    const email = String(row["User_Email"] || "").toLowerCase().trim();
    const date = normalizeDateToYMD(row["Date_Logged"]);
    const hours = parseFloat(row["Hours_Logged"]) || 0;
    const key = String(row["Jira_Key"] || "").toLowerCase().trim();

    if (teamEmails.includes(email) && weekDates.includes(date)) {
      if (key === "ooo") {
        oooMap[email].add(date);
      }
      hoursMap[email][date] = (hoursMap[email][date] || 0) + hours;
    }
  });

  // 3. Process TPM Jira Cache for Epics & Build Map for Ticket Details
  const cacheData = getSheetData(CONFIG.SHEETS.TPM_JIRA_CACHE);
  const epicsMap = {};
  const jiraEpicDetailsMap = {};
  teamEmails.forEach(email => epicsMap[email] = []);
  const unassignedEpics = [];

  cacheData.forEach(row => {
    const isEpic = String(row["Issue_Type"] || "Epic").toLowerCase() === "epic";
    const key = row["Key"];
    if (key) {
      jiraEpicDetailsMap[key] = {
        summary: row["Summary"] || "No Summary",
        status: row["Status"] || "Backlog",
        created: row["Created"] ? String(row["Created"]).substring(0, 10) : "N/A",
        projectStart: row["Project start date"] ? String(row["Project start date"]).substring(0, 10) : "N/A"
      };
    }

    // Only add to compliance epics mapping if it is an actual Epic
    if (isEpic) {
      const assignee = String(row["Assignee_Email"] || "").toLowerCase().trim();
      const epicData = {
        key: row["Key"],
        summary: row["Summary"],
        status: row["Status"]
      };

      if (assignee === "unassigned@osttra.com") {
        unassignedEpics.push(epicData);
      } else if (epicsMap[assignee] !== undefined) {
        epicsMap[assignee].push(epicData);
      }
    }
  });

  // Group detailed ticket hours by email and Jira Key for Drill-Down
  const ticketLogsMap = {};
  teamEmails.forEach(email => {
    ticketLogsMap[email] = {};
  });

  logData.forEach(row => {
    const email = String(row["User_Email"] || "").toLowerCase().trim();
    let key = String(row["Jira_Key"] || "ADMIN").trim();
    if (key.toUpperCase() === "NON-BAU") {
      key = "ADMIN";
    }
    const date = normalizeDateToYMD(row["Date_Logged"]);
    const hours = parseFloat(row["Hours_Logged"]) || 0;

    if (teamEmails.includes(email) && weekDates.includes(date) && hours > 0) {
      const intHrs = parseFloat(row["Int_Hours"]) || 0;
      const uatHrs = parseFloat(row["UAT_Hours"]) || 0;

      if (!ticketLogsMap[email][key]) {
        const details = jiraEpicDetailsMap[key] || {};
        let summaryText = details.summary || "Unknown Epic Summary";
        let statusText = details.status || "N/A";
        
        const keyUpper = key.toUpperCase();
        if (keyUpper === "ADMIN") {
          summaryText = "Meetings, admin tasks, and unticketed operations";
          statusText = "Persistent";
        } else if (keyUpper === "OOO") {
          summaryText = "Out of Office / Leave / Time Off";
          statusText = "Persistent";
        } else if (keyUpper === "MGMT") {
          summaryText = "Time spent in management activity";
          statusText = "Persistent";
        } else if (keyUpper === "SOLUTION-DESIGN") {
          summaryText = "Solution Design Cases (Salesforce)";
          statusText = "Persistent";
        }

        const isPersistentKey = ["ADMIN", "MGMT", "OOO", "SOLUTION-DESIGN"].includes(keyUpper);

        ticketLogsMap[email][key] = {
          key: key,
          summary: summaryText,
          status: statusText,
          created: isPersistentKey ? "-" : (details.created || "N/A"),
          projectStart: isPersistentKey ? "-" : (details.projectStart || "N/A"),
          int: 0,
          uat: 0,
          other: 0,
          total: 0
        };
      }
      
      const otherHrs = parseFloat(row["Other_Hours"]) || 0;
      ticketLogsMap[email][key].int += intHrs;
      ticketLogsMap[email][key].uat += uatHrs;
      ticketLogsMap[email][key].other += otherHrs;
      ticketLogsMap[email][key].total += hours;
    }
  });

  // 4. Build compliance matrix rows with Date-Aware compliance checks
  const todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const targetMonthYear = getMonthYearFromDateStr(startDateStr);

  // Determine if selected week is the current active week
  const isCurrentWeek = (weekDates[0] <= todayStr && weekDates[6] >= todayStr);

  // Count standard weekdays in the selected week dates (Mon-Fri)
  let standardWeekdaysCount = 0;
  let pastWeekdaysCount = 0;
  weekDates.forEach(dateStr => {
    const parts = dateStr.split('-');
    const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    const dayOfWeek = d.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    if (!isWeekend) {
      standardWeekdaysCount++;
      if (dateStr <= todayStr) {
        pastWeekdaysCount++;
      }
    }
  });

  const matrix = team.map(member => {
    const dailyHours = weekDates.map(date => hoursMap[member.email][date] || 0);
    const weeklyTotal = dailyHours.reduce((acc, h) => acc + h, 0);
    const memberOooDates = Array.from(oooMap[member.email] || []);
    
    // 1. Strict past-weekday daily gap check (for past weeks)
    const hasDailyGaps = weekDates.some((dateStr, i) => {
      const parts = dateStr.split('-');
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      const dayOfWeek = d.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      if (isWeekend) return false;
      if (dateStr > todayStr) return false;
      if (memberOooDates.includes(dateStr)) return false;
      return dailyHours[i] <= 0;
    });

    // 2. Compute targets (standard 100% FTE baseline)
    const weeklyTargetHours = Math.max(standardWeekdaysCount * 8, 0);

    // Compute expected pace-to-date
    const paceTarget = Math.max(pastWeekdaysCount * 8, 0);

    // Default to standard 100% FTE (keep it simple, no allocation handshake)
    const allocatedFte = 100;

    // 3. Classify compliance status using the intelligent engine
    let status = "Compliant";
    let isCompliant = true;

    if (isCurrentWeek) {
      if (weeklyTotal >= weeklyTargetHours) {
        status = "Complete";
        isCompliant = true;
      } else if (weeklyTotal === 0) {
        status = "Unstarted";
        isCompliant = false;
      } else {
        // Evaluate pace
        if (weeklyTotal >= 0.8 * paceTarget) {
          status = "On Track";
          isCompliant = true; // On Track is treated as compliant during active week
        } else {
          status = "Lagging";
          isCompliant = false; // Lagging is non-compliant
        }
      }
    } else {
      // Past Week: strict daily audit
      if (!hasDailyGaps) {
        status = "Compliant";
        isCompliant = true;
      } else {
        status = "Incomplete";
        isCompliant = false;
      }
    }

    // Build the status counts for this member
    const statusSummary = { total: 0 };
    const memberEpics = epicsMap[member.email] || [];
    memberEpics.forEach(epic => {
      statusSummary.total++;
      const s = epic.status || "Backlog";
      statusSummary[s] = (statusSummary[s] || 0) + 1;
    });

    return {
      name: member.name,
      email: member.email,
      region: member.region,
      dailyHours: dailyHours,
      total: weeklyTotal,
      isCompliant: isCompliant,
      complianceStatus: status, // New status field
      paceTarget: paceTarget, // New pace target
      weeklyTarget: weeklyTargetHours, // New weekly target
      allocatedFte: allocatedFte,
      epics: memberEpics,
      statusSummary: statusSummary,
      ticketLogs: Object.values(ticketLogsMap[member.email] || {}),
      oooDates: memberOooDates
    };
  });

  // 5. Calculate high-level compliance percentages
  const totalTeam = matrix.length;
  const compliantCount = matrix.filter(r => r.isCompliant).length;
  const compliantPercentage = totalTeam > 0 ? Math.round((compliantCount / totalTeam) * 100) : 100;

  // 6. In-memory Historical Trend Calculation (no database overhead)
  const trend = [];
  const calculateWeeklyComplianceForDate = (weekStartStr) => {
    const dates = [];
    const parts = weekStartStr.split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      for (let i = 0; i < 7; i++) {
        const d = new Date(Date.UTC(year, month, day + i)); 
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        dates.push(`${yyyy}-${mm}-${dd}`);
      }
    } else {
      return 100;
    }

    const tMap = {};
    const oMap = {};
    teamEmails.forEach(email => {
      tMap[email] = {};
      oMap[email] = new Set();
      dates.forEach(d => {
        tMap[email][d] = 0;
      });
    });

    logData.forEach(row => {
      const email = String(row["User_Email"] || "").toLowerCase().trim();
      const date = normalizeDateToYMD(row["Date_Logged"]);
      const hours = parseFloat(row["Hours_Logged"]) || 0;
      const key = String(row["Jira_Key"] || "").toLowerCase().trim();

      if (teamEmails.includes(email) && dates.includes(date)) {
        if (key === "ooo") {
          oMap[email].add(date);
        }
        tMap[email][date] = (tMap[email][date] || 0) + hours;
      }
    });

    const compliant = teamEmails.filter(email => {
      return dates.every((dateStr, i) => {
        const parts = dateStr.split('-');
        const dateObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        const dayOfWeek = dateObj.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) return true;
        if (dateStr > todayStr) return true;
        if (oMap[email].has(dateStr)) return true;
        return tMap[email][dateStr] > 0;
      });
    }).length;

    return teamEmails.length > 0 ? Math.round((compliant / teamEmails.length) * 100) : 100;
  };

  const parts = startDateStr.split('-');
  if (parts.length === 3) {
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    
    // Past 6 weeks (from oldest to newest)
    for (let w = 5; w >= 0; w--) {
      const d = new Date(Date.UTC(year, month, day - (w * 7)));
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const prevWeekStart = `${yyyy}-${mm}-${dd}`;
      
      const compRate = calculateWeeklyComplianceForDate(prevWeekStart);
      trend.push({
        weekStart: prevWeekStart,
        percentage: compRate
      });
    }
  }

  return {
    matrix: matrix,
    weekDates: weekDates,
    unassignedEpics: unassignedEpics,
    allEpics: cacheData.filter(row => String(row["Issue_Type"] || "Epic").toLowerCase() === "epic"),
    childTickets: cacheData.filter(row => String(row["Issue_Type"] || "").toLowerCase() !== "epic"),
    complianceStats: {
      total: totalTeam,
      compliant: compliantCount,
      nonCompliant: totalTeam - compliantCount,
      percentage: compliantPercentage,
      trend: trend
    }
  };
}

/**
 * HELPER: Parses "YYYY-MM-DD" date string and returns "Month Year" format (e.g. "July 2026").
 */
function getMonthYearFromDateStr(dateStr) {
  const parts = dateStr.split('-');
  const year = parseInt(parts[0], 10);
  const monthIdx = parseInt(parts[1], 10) - 1;
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return months[monthIdx] + " " + year;
}

/**
 * HELPER: Syncs the raw logged mgmt hours for a TPM Manager to their monthly core allocation card.
 */
/**
 * HELPER: Syncs the raw logged hours for a TPM user to their monthly core allocation card generically.
 */
function syncTpmAllocationHours(ss, userEmail, targetMonthYear, product, subProduct, hours) {
  const allocSheet = ss.getSheetByName(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
  if (!allocSheet) {
    console.error("Allocation Historical sheet not found.");
    return;
  }

  const data = allocSheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h || "").trim());

  const emailIdx = headers.indexOf("Email Address");
  const periodIdx = headers.indexOf("Month and Year") !== -1 ? headers.indexOf("Month and Year") : headers.indexOf("Period");
  const productIdx = headers.indexOf("Product");
  const subProductIdx = headers.indexOf("Sub-Product");
  const bauIdx = headers.indexOf("Allocation BAU");
  const commentIdx = headers.indexOf("Allocation Comment");
  const lastUpdatedIdx = headers.indexOf("Last Updated By");
  const timestampIdx = headers.indexOf("Date and time of Submission");
  const weekdaysIdx = headers.indexOf("Standard Weekdays in Month");

  if (emailIdx === -1 || periodIdx === -1 || productIdx === -1 || subProductIdx === -1 || bauIdx === -1) {
    console.error("Required allocation headers missing.");
    return;
  }

  // Calculate Standard Weekdays
  const getStandardWeekdaysInMonth = (monthYearStr) => {
    const parts = monthYearStr.split(' ');
    const monthName = parts[0];
    const year = parseInt(parts[1], 10);
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const monthIdx = months.indexOf(monthName);
    let weekdaysCount = 0;
    const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, monthIdx, day);
      const dayOfWeek = date.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        weekdaysCount++;
      }
    }
    return weekdaysCount;
  };

  const standardWeekdays = getStandardWeekdaysInMonth(targetMonthYear);
  const totalAvailableHours = standardWeekdays * 8; // 8 hours per day rule
  const ftePct = totalAvailableHours > 0 ? Math.round((hours / totalAvailableHours) * 100) : 0;

  let existingRowIdx = -1;
  const prodLower = String(product).trim().toLowerCase();
  const subProdLower = String(subProduct).trim().toLowerCase();

  for (let i = 1; i < data.length; i++) {
    const rowEmail = String(data[i][emailIdx]).toLowerCase().trim();
    const rawP = data[i][periodIdx];
    const rowPeriod = (rawP instanceof Date) ? Utilities.formatDate(rawP, "GMT", "MMMM yyyy") : String(rawP).trim();
    const rowProduct = String(data[i][productIdx]).trim().toLowerCase();
    const rowSubProduct = String(data[i][subProductIdx]).trim().toLowerCase();

    if (rowEmail === userEmail && 
        rowPeriod.toLowerCase().trim() === targetMonthYear.toLowerCase().trim() && 
        rowProduct === prodLower && 
        rowSubProduct === subProdLower) {
      existingRowIdx = i + 1; // 1-based index for getRange
      break;
    }
  }

  const timestamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "yyyy-MM-dd HH:mm:ss");

  if (existingRowIdx !== -1) {
    // Update existing row
    allocSheet.getRange(existingRowIdx, bauIdx + 1).setValue(ftePct);
    if (commentIdx !== -1) allocSheet.getRange(existingRowIdx, commentIdx + 1).setValue("Auto-calculated from TPM Timesheet (" + hours + " hrs)");
    if (lastUpdatedIdx !== -1) allocSheet.getRange(existingRowIdx, lastUpdatedIdx + 1).setValue("TPM Timesheet Auto-Sync");
    if (timestampIdx !== -1) allocSheet.getRange(existingRowIdx, timestampIdx + 1).setValue(timestamp);
    if (weekdaysIdx !== -1) allocSheet.getRange(existingRowIdx, weekdaysIdx + 1).setValue(standardWeekdays);
    console.log("Updated existing " + product + " allocation row for " + userEmail + " for " + targetMonthYear + " with " + ftePct + "%");
  } else {
    // Append new row
    const newRow = headers.map(h => {
      switch(h) {
        case "Email Address": return userEmail;
        case "Month and Year":
        case "Period": return targetMonthYear;
        case "Product": return product;
        case "Sub-Product": return subProduct;
        case "Allocation BAU": return ftePct;
        case "Allocation Non-BAU": return 0;
        case "Allocation Comment": return "Auto-calculated from TPM Timesheet (" + hours + " hrs)";
        case "Last Updated By": return "TPM Timesheet Auto-Sync";
        case "Date and time of Submission": return timestamp;
        case "Standard Weekdays in Month": return standardWeekdays;
        case "Regular Days Worked": return 0;
        case "Worked Weekend": return false;
        case "Weekend Days Worked": return 0;
        case "Comments": return "Auto-calculated from TPM Timesheet";
        default: return "";
      }
    });
    allocSheet.appendRow(newRow);
    console.log("Appended new " + product + " allocation row for " + userEmail + " for " + targetMonthYear + " with " + ftePct + "%");
  }
}

/**
 * Automated Operational Nudge: Sends individual compliance reminder emails to team members with incomplete timesheets.
 */
function sendTpmComplianceNudge(emails, weekStartDateStr, customSubject = "", customBody = "", missedDatesMap = {}) {
  const session = getCurrentUserSession();
  if (!session.isTpmManager && !session.isAdmin && session.identityTier !== 3) {
    throw new Error("Unauthorized: Only TPM Team Managers can send compliance nudges.");
  }
  if (!Array.isArray(emails) || emails.length === 0) {
    return "No emails to nudge.";
  }

  // Fetch employee list to map emails to First Names
  const allEmployees = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  const empNameMap = {};
  allEmployees.forEach(e => {
    const email = String(e["Email Address"] || "").toLowerCase().trim();
    if (email) {
      empNameMap[email] = String(e["First Name"] || e["Google Chat Full Name"] || "Team Member").trim();
    }
  });

  // Common Header/Footer Styles matching OSTTRA Branding
  const getEmailHtml = (title, contentHtml) => {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Neue Haas Grotesk Text Pro', 'Helvetica Neue', Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #F0F0F0; color: #222222; }
          .container { max-width: 600px; margin: 20px auto; background-color: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border: 1px solid #E5E5E5; }
          .header-gradient { height: 8px; background: linear-gradient(90deg, #FE952D 0%, #FF0061 50%, #9125BF 100%); }
          .content { padding: 40px; }
          .title { color: #FF0061; font-size: 18px; font-weight: bold; margin-bottom: 24px; text-transform: uppercase; letter-spacing: 1px; }
          .body-text { font-size: 14px; line-height: 1.6; color: #555555; margin-bottom: 24px; }
          .btn-container { text-align: center; margin: 30px 0 10px 0; }
          .btn { display: inline-block; background: linear-gradient(90deg, #FE952D 0%, #FF0061 100%); color: #FFFFFF !important; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; box-shadow: 0 4px 10px rgba(255,0,97,0.2); }
          .footer { background-color: #F9F9F9; padding: 24px; text-align: center; border-top: 1px solid #EAEAEA; }
          .footer-logo { font-size: 14px; font-weight: bold; color: #222222; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 8px; }
          .footer-text { font-size: 11px; color: #888888; line-height: 1.5; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header-gradient"></div>
          <div class="content">
            <div class="title">${title}</div>
            ${contentHtml}
          </div>
          <div class="footer">
            <div class="footer-logo">OSTTRA | NEXUS</div>
            <div class="footer-text">This is an automated operational notification. Please do not reply directly to this email. For questions or support, contact your TPM manager.</div>
          </div>
        </div>
      </body>
      </html>
    `;
  };

  emails.forEach(email => {
    const lowerEmail = email.toLowerCase().trim();
    let subject = customSubject || ("Action Required: Outstanding Timesheet Logs - Week of " + weekStartDateStr);

    let body = customBody || (
      "Hi [Name],\n\n" +
      "This is an automated reminder from the Nexus.\n\n" +
      "Our records indicate that your timesheet entries for [MissedDates] are currently incomplete (missing hours or below your standard allocated capacity).\n\n" +
      "Please log into Nexus and update your timesheet as soon as possible.\n\n" +
      "Link to Nexus: " + CONFIG.NEXUS_BASE_URL + "\n\n" +
      "Thank you for your prompt cooperation,\n" +
      "Team Nexus"
    );

    // Substitute placeholders
    const rName = empNameMap[lowerEmail] || "Team Member";

    // Resolve Missed Dates nicely
    const missedList = missedDatesMap[email] || missedDatesMap[lowerEmail] || [];
    const missedStr = missedList.length > 0 ? missedList.join(", ") : ("the week starting " + weekStartDateStr);

    subject = subject.replace(/\[Name\]/g, rName).replace(/\[Week\]/g, weekStartDateStr);
    body = body.replace(/\[Name\]/g, rName).replace(/\[Week\]/g, weekStartDateStr).replace(/\[MissedDates\]/g, missedStr);

    const htmlBodyContent = body.replace(/\n/g, "<br>");
    const portalUrl = CONFIG.NEXUS_BASE_URL;
    const wrappedHtmlBody = getEmailHtml(
      "Action Required: Update Your Timesheet Logs",
      `
        <p class="body-text">${htmlBodyContent}</p>
        <div class="btn-container">
          <a href="${portalUrl}" target="_blank" class="btn">Update Timesheet in Portal</a>
        </div>
      `
    );

    try {
      MailApp.sendEmail({
        to: email,
        subject: subject,
        body: body, // Plain text fallback
        htmlBody: wrappedHtmlBody
      });
    } catch (e) {
      console.error("Failed to send nudge email to " + email + ": " + e.message);
    }

    // Simultaneous Google Chat Direct Message Ping
    try {
      const memberships = [{ member: { name: 'users/' + email, type: 'HUMAN' } }];
      const space = Chat.Spaces.setup({
        space: {
          spaceType: 'DIRECT_MESSAGE'
        },
        memberships: memberships
      });

      // Format markdown nicely for Google Chat
      const chatMessage = `*${subject}*\n\n${body}\n\n*Portal Link:* ${portalUrl}`;
      Chat.Spaces.Messages.create({ text: chatMessage }, space.name);
      console.log("Successfully sent Google Chat nudge to " + email);
    } catch (chatErr) {
      console.error("Failed to send Google Chat nudge to " + email + ": " + chatErr.message);
    }
  });

  // Instrument telemetry & system events for compliance nudges
  try {
    const details = `Nudged ${emails.length} users: ${emails.join(', ')}`;
    logSystemEvent(session.email, "MULTIPLE", "Sent TPM Compliance Nudge", "TPM Workspace", "N/A", details);
    logBackendTelemetry("TPM_COMPLIANCE_NUDGE_SENT", "TPM Workspace", details, "SYSTEM");
  } catch(telErr) {
    console.warn("Failed to log TPM compliance nudge telemetry: " + telErr.message);
  }

  return "Successfully sent " + emails.length + " compliance reminder emails and Google Chat pings!";
}

/**
 * Global cache for the Spreadsheet Timezone to prevent high-latency remote API calls.
 */
var globalSpreadsheetTimezone = null;

/**
 * HELPER: Strictly normalizes any Date object or Date string into "YYYY-MM-DD" to prevent formatting mismatches.
 */
function normalizeDateToYMD(rawDate) {
  if (!rawDate) return "";

  const isDate = rawDate instanceof Date || (typeof rawDate === 'object' && rawDate !== null && typeof rawDate.getMonth === 'function');
  if (isDate) {
    try {
      if (!globalSpreadsheetTimezone) {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        globalSpreadsheetTimezone = ss ? ss.getSpreadsheetTimeZone() : "GMT";
      }
      return Utilities.formatDate(rawDate, globalSpreadsheetTimezone, "yyyy-MM-dd");
    } catch(e) {}
  }

  if (typeof rawDate === 'string') {
    const trimmed = rawDate.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
    // If it is a string representation of a date/timestamp, try parsing it safely
    try {
      const d = new Date(trimmed);
      if (!isNaN(d.getTime())) {
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;;
      }
    } catch(e) {}
    return trimmed;
  }

  return String(rawDate).trim();
}

/**
 * API: Fetches the summary and details of a single Jira ticket by key.
 * Accessible to any TPM User.
 */
function fetchJiraTicketSummary(key) {
  const session = getCurrentUserSession();
  if (!session.isTpmUser) {
    throw new Error("Unauthorized");
  }
  if (!key) return null;

  const normalizedKey = key.trim().toUpperCase();

  // 1. Try to search in local Jira Cache (Instant)
  try {
    const cacheData = getSheetData(CONFIG.SHEETS.TPM_JIRA_CACHE);
    const cachedRow = cacheData.find(row => String(row["Key"] || "").toUpperCase().trim() === normalizedKey);
    if (cachedRow) {
      return {
        "Key": String(cachedRow["Key"] || "").toUpperCase(),
        "Summary": cachedRow["Summary"] || "No Summary",
        "Status": cachedRow["Status"] || "Active",
        "Issue_Type": cachedRow["Issue_Type"] || "Task",
        "Assignee_Email": String(cachedRow["Assignee_Email"] || "unassigned@osttra.com").toLowerCase().trim(),
        "Secondary_Assignee_Email": String(cachedRow["Secondary_Assignee_Email"] || "").toLowerCase().trim()
      };
    }
  } catch(e) {
    console.error("Local cache lookup failed: " + e.message);
  }

  // 2. Fall back to Live Atlassian Jira API Query
  const scriptProperties = PropertiesService.getScriptProperties();
  const JIRA_BASE = scriptProperties.getProperty('JIRA_BASE_URL') || 'https://osttra.atlassian.net';

  let authHeader;
  try {
    authHeader = getJiraHeaders();
  } catch (e) {
    console.warn(e.message + " for live ticket fetch.");
    return null;
  }

  try {
    const response = UrlFetchApp.fetch(`${JIRA_BASE}/rest/api/3/issue/${normalizedKey}?fields=summary,status,issuetype,assignee`, {
      method: 'get',
      headers: authHeader,
      muteHttpExceptions: true
    });
    
    if (response.getResponseCode() === 200) {
      const data = JSON.parse(response.getContentText());
      const f = data.fields || {};
      return {
        "Key": data.key,
        "Summary": f.summary || "No Summary",
        "Status": f.status && f.status.name ? f.status.name : "Active",
        "Issue_Type": f.issuetype && f.issuetype.name ? f.issuetype.name : "Task",
        "Assignee_Email": f.assignee && f.assignee.emailAddress ? f.assignee.emailAddress.toLowerCase().trim() : "unassigned@osttra.com"
      };
    }
  } catch(e) {
    console.error("Error fetching live issue from Jira: " + e.message);
  }
  return null;
}

/**
 * Executes the automated TPM compliance nudges for both Chat and Email.
 * Triggered every Friday at 8 AM GMT.
 */
function executeAutomatedTpmNudge() {
  console.log("Starting automated Friday TPM compliance nudge execution...");

  const today = new Date();
  const dayOfWeek = today.getDay() || 7; 
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dayOfWeek - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const getStr = (d) => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const mondayStr = getStr(monday);
  const sundayStr = getStr(sunday);
  const todayStr = getStr(today);

  let dashboardData;
  try {
    dashboardData = getTpmDashboardData(mondayStr, sundayStr, true);
  } catch (err) {
    console.error("Automated Nudge Failed: Error generating dashboard payload: " + err.message);
    return;
  }

  if (!dashboardData || !dashboardData.matrix) return;

  const targets = dashboardData.matrix.filter(r => r.isCompliant === false);

  if (targets.length === 0) {
    console.log("Automated Nudge: No non-compliant members found. Exiting cleanly.");
    return;
  }

  const emailsToNudge = [];
  const missedDatesMap = {};

  targets.forEach(row => {
    emailsToNudge.push(row.email);
    
    const missedDays = [];
    dashboardData.weekDates.forEach((dateStr, idx) => {
      const parts = dateStr.split('-');
      const dObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      const dow = dObj.getDay();
      const isWeekend = (dow === 0 || dow === 6);

      if (!isWeekend && dateStr <= todayStr && !(row.oooDates && row.oooDates.includes(dateStr))) {
        const hoursLogged = dashboardData.weekDates.indexOf(dateStr) !== -1 ? row.dailyHours[idx] : 0;
        if (hoursLogged <= 0) {
          const yr = parts[0].substring(2);
          const mIdx = parseInt(parts[1], 10) - 1;
          const day = parseInt(parts[2], 10);
          const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          missedDays.push(`${day}-${months[mIdx]}-${yr}`);
        }
      }
    });
    missedDatesMap[row.email] = missedDays;
  });

  try {
    const result = sendTpmComplianceNudge(emailsToNudge, mondayStr, "", "", missedDatesMap);
    console.log("Automated Nudge Success: " + result);
  } catch (err) {
    console.error("Automated Nudge Exception during dispatch: " + err.message);
  }
}

/**
 * TRIGGER: Installs the weekly automated TPM compliance nudge.
 * Runs on Fridays between 8:00 AM and 9:00 AM.
 * Execute this once from the Apps Script editor.
 */
function setupAutomatedTpmNudgeTrigger() {
  const functionName = "executeAutomatedTpmNudge";

  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger(functionName)
    .timeBased()
    .everyWeeks(1)
    .onWeekDay(ScriptApp.WeekDay.FRIDAY)
    .atHour(8)
    .create();

  console.log(`Weekly trigger successfully established for ${functionName}() (Runs Fridays between 8:00 AM - 9:00 AM).`);
}
