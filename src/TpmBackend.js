/**
 * src/TpmBackend.js
 * Backend logic, Jira syncing, timesheet CRUD, and compliance dashboard metrics for TPM.
 */

/**
 * Sync Jira Epic tickets for the TPM project into the local cache sheet.
 * Accessible to Admins (or triggered via a schedule).
 */
function syncTpmJiraData() {
  const session = validateTier(1); // Allow TPM users to trigger if needed, or enforce higher
  
  const scriptProperties = PropertiesService.getScriptProperties();
  const JIRA_BASE = scriptProperties.getProperty('JIRA_BASE_URL') || 'https://osttra.atlassian.net';
  const USER_EMAIL = scriptProperties.getProperty('JIRA_USER_EMAIL') || 'damak.k@osttra.com';
  const API_TOKEN = scriptProperties.getProperty('JIRA_API_TOKEN') || '';
  
  if (!API_TOKEN) {
    throw new Error("Jira API Token is missing in Script Properties (JIRA_API_TOKEN).");
  }
  
  // Fetch all issues from TPM and PSS projects to get Epics, Deployments, and Child tickets
  const JQL = 'project in ("TPM", "PSS") ORDER BY updated DESC';

  const COLUMNS_TO_EXTRACT = [
    "Key", "Issue_Type", "Parent_Key", "Account_Name", "Summary", "Status", "Go Live & Onboarding EE",
    "Project start date", "Go-live date", "UAT Estimate", "Effort Estimate (Effort days)",
    "Expected Go Live Date", "UAT start date", "Project Sizing", "Expected UAT start date",
    "Expected project start date", "Created", "Updated", "Technical go-live date", "Opportunity Close Date", "Assignee", "Secondary Assignee", "Planned end date"
  ];

  const authHeader = { 
    Authorization: 'Basic ' + Utilities.base64Encode(`${USER_EMAIL}:${API_TOKEN}`), 
    Accept: 'application/json' 
  };

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
      // Also map standard lowercase fields
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

  // 2. Fetch all matching issues
  const maxResults = 100;
  let nextPageToken = null;
  let allIssues = [];

  do {
    const payload = {
      jql: JQL,
      maxResults: maxResults,
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
    "Expected project start date", "Created", "Updated", "Technical go-live date", "Planned end date"
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

  // 5. Overwrite the sheet cache
  return runWithWriteLock(() => {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    let sheet = ss.getSheetByName(CONFIG.SHEETS.TPM_JIRA_CACHE);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.SHEETS.TPM_JIRA_CACHE);
    }
    sheet.clearContents();
    sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    clearSheetCache(CONFIG.SHEETS.TPM_JIRA_CACHE);
    return `Sync Complete. Cached ${allIssues.length} TPM Epics.`;
  });
}

/**
 * Retrieve timesheet Epics and existing weekly logs for the current logged-in user.
 * @param {string} weekStartDateStr "YYYY-MM-DD" representing Monday.
 * @param {boolean} showAllEpics Flag to bypass status-based Epic exclusions.
 */
function getTpmTimesheetData(weekStartDateStr, showAllEpics = false) {
  const session = getCurrentUserSession();
  if (!session.isTpmUser && !session.isAdmin && session.identityTier !== 3) {
    throw new Error("Unauthorized: TPM Workspace is restricted to Tier-4 TPM hierarchy.");
  }

  // 1. Fetch user's Epics and associated tickets from local Jira Cache
  const cacheData = getSheetData(CONFIG.SHEETS.TPM_JIRA_CACHE);
  const userEmail = session.email.toLowerCase().trim();
  
  // Calculate Monday-Sunday date strings robustly to prevent timezone shifting
  const weekDates = [];
  const parts = String(weekStartDateStr).split('-');
  if (parts.length === 3) {
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    
    for (let i = 0; i < 7; i++) {
      const d = new Date(year, month, day + i); // Instantiates in script's local timezone
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      weekDates.push(`${yyyy}-${mm}-${dd}`);
    }
  }

  // Support 7-day status transition rule for Completed/Canceled
  const now = new Date();
  const sevenDaysAgoStr = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const fourteenDaysAgoStr = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const activeTpmStatuses = [
    'assigned', 'preparing deployment', 'initiation', 'implementation', 
    'tpm handover approved', 'go live', 'uat', 'technical go live'
  ];
  const activePssStatuses = [
    'flow seen', 'flow pending', 'awaiting implementation', 'new', 
    '4-eye approval', 'review'
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
      if (!activeTpmStatuses.includes(status)) {
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
      if (!whitelist.includes(status)) {
        return false;
      }
    }

    return true;
  });

  // 2. Fetch logged hours for this week from TPM_Timesheet_Logs
  const logData = getSheetData(CONFIG.SHEETS.TPM_TIMESHEET_LOGS);
  
  const userLogs = logData.filter(row => {
    const rowEmail = String(row["User_Email"] || "").toLowerCase().trim();
    const rowDate = normalizeDateToYMD(row["Date_Logged"]);
    return rowEmail === userEmail && weekDates.includes(rowDate);
  });

  const formattedLogs = userLogs.map(log => {
    return { ...log, "Date_Logged": normalizeDateToYMD(log["Date_Logged"]) };
  });

  // Ensure any ticket in the user logs is included in userEpics or childTickets (Resolves disappearing logs bug)
  const loggedKeys = [...new Set(formattedLogs.map(l => String(l["Jira_Key"] || "").toUpperCase().trim()).filter(k => k && k !== 'ooo' && k !== 'ADMIN' && k !== 'MGMT'))];
  
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
      // Fallback placeholder if not in cache (e.g. newly synced or manually entered key)
      const isEpicType = key.startsWith('TPM-');
      const placeholder = {
        "Key": key,
        "Issue_Type": isEpicType ? "Epic" : "Task",
        "Summary": isEpicType ? "Manually Logged Project Epic" : "Manually Logged Support Ticket",
        "Status": "Active",
        "Assignee_Email": session.email,
        "Secondary_Assignee_Email": ""
      };
      if (isEpicType) {
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
    
    if (["canceled", "completed", "closed", "answered"].includes(status)) return;
    
    const isPss = issueType === "pss" || key.startsWith("PSS-");
    if (isPss && !pssSet.has(key)) {
      pssSet.add(key);
      activePssTickets.push({
        key: key,
        summary: row["Summary"] || "PSS support deployment",
        status: row["Status"] || "Active",
        issueType: "PSS"
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
    
    if (["canceled", "completed", "closed"].includes(status)) return;
    
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

  return {
    epics: userEpics,
    childTickets: childTickets,
    logs: formattedLogs,
    weekDates: weekDates,
    allPssTickets: activePssTickets,
    allEpics: activeEpicsList
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

  const userEmail = session.email.toLowerCase().trim();

  // Compute Mon-Sun dates robustly to prevent timezone shifting
  const weekDates = [];
  const parts = String(payload.weekStartDate).split('-');
  if (parts.length === 3) {
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    
    for (let i = 0; i < 7; i++) {
      const d = new Date(year, month, day + i); // Instantiates in script's local timezone
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      weekDates.push(`${yyyy}-${mm}-${dd}`);
    }
  }

  return runWithWriteLock(() => {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.SHEETS.TPM_TIMESHEET_LOGS);
    if (!sheet) throw new Error("TPM Timesheet Logs sheet not found.");

    const todayStr = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "yyyy-MM-dd");

    // Block any attempt to log hours for future dates (exempting weekends) and enforce strict 24-hour daily limits
    const dailyTotals = {};
    payload.logs.forEach(log => {
      const parts = log.date.split('-');
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;

      if (log.date > todayStr && !isWeekend) {
        throw new Error("Validation Error: Cannot log hours for future dates (" + log.date + ").");
      }
      
      const hours = parseFloat(log.hours) || 0;
      if (hours < 0 || hours > 24.01) {
        throw new Error("Validation Error: Individual ticket hours cannot exceed 24.00 hours. Found " + hours.toFixed(2) + "h on " + log.date + " for " + log.jiraKey + ".");
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

      const row = headers.map(h => {
        switch(h) {
          case "Log_ID": return "LOG-" + Utilities.getUuid().substring(0, 8).toUpperCase();
          case "User_Email": return userEmail;
          case "Jira_Key": return log.jiraKey;
          case "Date_Logged": return log.date;
          case "Hours_Logged": return hours;
          case "Created_Timestamp": return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
          case "UAT_Hours": return parseFloat(log.uatHours) || 0;
          case "Int_Hours": return parseFloat(log.intHours) || 0;
          case "Other_Hours": return otherHours;
          case "Jira_Status": return log.jiraStatus || "Active";
          case "Week_Of": return payload.weekStartDate;
          default: return "";
        }
      });
      filteredRows.push(row);
    });

    sheet.clearContents();
    sheet.getRange(1, 1, filteredRows.length, filteredRows[0].length).setValues(filteredRows);
    clearSheetCache(CONFIG.SHEETS.TPM_TIMESHEET_LOGS);

    // Sync all logged hours (Three Things + OOO) to Allocation Historical for TPM Users
    try {
      const targetMonthYear = getMonthYearFromDateStr(payload.weekStartDate);
      
      const emailIdx = headers.indexOf("User_Email");
      const keyIdx = headers.indexOf("Jira_Key");
      const dateIdx = headers.indexOf("Date_Logged");
      const hoursIdx = headers.indexOf("Hours_Logged");

      let totalMgmtHours = 0;
      let totalAdminHours = 0;
      let totalOooHours = 0;
      let totalEpicHours = 0;

      for (let i = 1; i < filteredRows.length; i++) {
        const row = filteredRows[i];
        const email = String(row[emailIdx] || "").toLowerCase().trim();
        const key = String(row[keyIdx] || "").toLowerCase().trim();
        const date = String(row[dateIdx] || "").trim();
        const hours = parseFloat(row[hoursIdx]) || 0;

        if (email === userEmail && getMonthYearFromDateStr(date) === targetMonthYear) {
          const lowerKey = key.toLowerCase();
          if (lowerKey === "mgmt") {
            totalMgmtHours += hours;
          } else if (lowerKey === "non-bau" || lowerKey === "admin") {
            totalAdminHours += hours;
          } else if (lowerKey === "ooo") {
            totalOooHours += hours;
          } else {
            // All other keys are standard Jira project Epics (representing core BAU)
            totalEpicHours += hours;
          }
        }
      }

      // 1. Sync Management hours if the user is a TPM Manager
      if (session.isTpmManager) {
        console.log("[TIMESHEET_AUTO_SYNC] Syncing total of " + totalMgmtHours + " mgmt hours for " + userEmail + " in " + targetMonthYear);
        syncTpmAllocationHours(ss, userEmail, targetMonthYear, "Mgmt", "Mgmt", totalMgmtHours);
      }

      // 2. Sync Non-BAU hours for all TPM Users
      console.log("[TIMESHEET_AUTO_SYNC] Syncing total of " + totalAdminHours + " Non-BAU hours for " + userEmail + " in " + targetMonthYear);
      syncTpmAllocationHours(ss, userEmail, targetMonthYear, "Non-BAU", "Non-BAU", totalAdminHours);

      // 3. Sync BAU (Jira Epic Project) hours for all TPM Users
      console.log("[TIMESHEET_AUTO_SYNC] Syncing total of " + totalEpicHours + " BAU project hours for " + userEmail + " in " + targetMonthYear);
      syncTpmAllocationHours(ss, userEmail, targetMonthYear, "BAU", "BAU", totalEpicHours);

      // 4. Sync OOO (Out of Office) hours for all TPM Users
      console.log("[TIMESHEET_AUTO_SYNC] Syncing total of " + totalOooHours + " OOO hours for " + userEmail + " in " + targetMonthYear);
      syncTpmAllocationHours(ss, userEmail, targetMonthYear, "OOO", "OOO", totalOooHours);

    } catch (syncErr) {
      console.error("Auto-sync of TPM hours to Allocations failed: " + syncErr.message);
    }

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

  if (forceRefresh) {
    clearSheetCache(CONFIG.SHEETS.TPM_TIMESHEET_LOGS);
    clearSheetCache(CONFIG.SHEETS.EMPLOYEES);
    console.log("[CACHE_BUST] Successfully busted sheet cache for dashboard load.");
  }

  const targetSheetName = "App All Employee Data (Read / Write)";
  const allEmployees = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  
  // 1. Resolve team roster under the manager's hierarchy (or see all if Admin)
  const managerEmail = session.email.toLowerCase().trim();
  const viewAll = session.isAdmin || session.identityTier === 3 || managerEmail === 'jack.jeffreys@osttra.com';
  
  const empMap = {};
  allEmployees.forEach(e => {
    const email = String(e["Email Address"] || "").toLowerCase().trim();
    if (email) empMap[email] = e;
  });

  const team = [];
  allEmployees.forEach(e => {
    const email = String(e["Email Address"] || "").toLowerCase().trim();
    if (!email) return;

    // Filter strictly for tagged TPM users to prevent non-TPM team members from polluting the dashboard
    const isTpmVal = String(e["is_tpm"] || e["Is_TPM"] || e["IS_TPM"] || "").trim().toLowerCase();
    const isTpm = ["yes", "true", "y", "1"].includes(isTpmVal);
    if (!isTpm) return;

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
      const d = new Date(sDate.getFullYear(), sDate.getMonth(), sDate.getDate() + i);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
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
      } else {
        hoursMap[email][date] = (hoursMap[email][date] || 0) + hours;
      }
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
        
        if (key === "ADMIN") {
          summaryText = "Meetings, admin tasks, and unticketed operations";
          statusText = "Persistent";
        } else if (key === "ooo") {
          summaryText = "Out of Office / Leave / Time Off";
          statusText = "Persistent";
        }

        ticketLogsMap[email][key] = {
          key: key,
          summary: summaryText,
          status: statusText,
          created: (key === "Admin" || key === "ooo") ? "-" : (details.created || "N/A"),
          projectStart: (key === "Admin" || key === "ooo") ? "-" : (details.projectStart || "N/A"),
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
  const allocData = getSheetData(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
  const targetMonthYear = getMonthYearFromDateStr(startDateStr);

  const matrix = team.map(member => {
    const dailyHours = weekDates.map(date => hoursMap[member.email][date] || 0);
    const weeklyTotal = dailyHours.reduce((acc, h) => acc + h, 0);
    
    // Fully compliant means hours logged > 0 for each of the non-weekend past days
    const isCompliant = dailyHours.every((h, i) => {
      const parts = weekDates[i].split('-');
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      const dayOfWeek = d.getDay();
      // Saturday (6) & Sunday (0) are exempt from compliance requirements
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        return true;
      }
      // If the day is in the future, don't penalize them for 0 hours yet (skip check)
      if (weekDates[i] > todayStr) {
        return true;
      }
      // OOO days are compliant even with 0 active contribution hours
      if (oooMap[member.email].has(weekDates[i])) {
        return true;
      }
      return h > 0;
    });

    // Fetch monthly allocated FTE percentage
    let allocatedFte = 0;
    allocData.forEach(row => {
      const email = String(row["Email Address"] || "").toLowerCase().trim();
      const rawPeriod = row["Month and Year"] || row["Period"] || "";
      const period = (rawPeriod instanceof Date) ? Utilities.formatDate(rawPeriod, "GMT", "MMMM yyyy") : String(rawPeriod).trim();
      
      if (email === member.email && period.toLowerCase().trim() === targetMonthYear.toLowerCase().trim()) {
        const bau = parseFloat(row["Allocation BAU"]) || 0;
        const nonBau = parseFloat(row["Allocation Non-BAU"]) || 0;
        allocatedFte += (bau + nonBau);
      }
    });
    // Default to 100% (40h target) if no row exists
    if (allocatedFte === 0) {
      allocatedFte = 100;
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
      allocatedFte: allocatedFte,
      epics: memberEpics,
      statusSummary: statusSummary,
      ticketLogs: Object.values(ticketLogsMap[member.email] || {}),
      oooDates: Array.from(oooMap[member.email] || [])
    };
  });

  // 5. Calculate high-level compliance percentages
  const totalTeam = matrix.length;
  const compliantCount = matrix.filter(r => r.isCompliant).length;
  const compliantPercentage = totalTeam > 0 ? Math.round((compliantCount / totalTeam) * 100) : 100;

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
      percentage: compliantPercentage
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
function sendTpmComplianceNudge(emails, weekStartDateStr) {
  const session = getCurrentUserSession();
  if (!session.isTpmManager && !session.isAdmin && session.identityTier !== 3) {
    throw new Error("Unauthorized: Only TPM Team Managers can send compliance nudges.");
  }
  if (!Array.isArray(emails) || emails.length === 0) {
    return "No emails to nudge.";
  }

  const subject = "Action Required: Outstanding Timesheet Logs - Week of " + weekStartDateStr;
  
  emails.forEach(email => {
    const body = 
      "Hi,\n\n" +
      "This is an automated operational reminder from the Nexus TPM Resource Center.\n\n" +
      "Our records indicate that your timesheet entries for the week starting " + weekStartDateStr + " are currently incomplete (missing hours or below your standard allocated capacity).\n\n" +
      "Please log into Nexus and update your timesheet as soon as possible to ensure accurate monthly product allocation metrics.\n\n" +
      "Link to Nexus: " + ScriptApp.getService().getUrl() + "\n\n" +
      "Thank you for your prompt cooperation,\n" +
      session.name + " (TPM Team Management)";
      
    try {
      MailApp.sendEmail(email, subject, body);
    } catch (e) {
      console.error("Failed to send nudge email to " + email + ": " + e.message);
    }
  });

  return "Successfully sent " + emails.length + " compliance reminder emails!";
}

/**
 * HELPER: Strictly normalizes any Date object or Date string into "YYYY-MM-DD" to prevent formatting mismatches.
 */
function normalizeDateToYMD(rawDate) {
  if (!rawDate) return "";

  if (rawDate instanceof Date) {
    const yyyy = rawDate.getFullYear();
    const mm = String(rawDate.getMonth() + 1).padStart(2, '0');
    const dd = String(rawDate.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
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
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
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
  const USER_EMAIL = scriptProperties.getProperty('JIRA_USER_EMAIL') || 'damak.k@osttra.com';
  const API_TOKEN = scriptProperties.getProperty('JIRA_API_TOKEN') || '';

  if (!API_TOKEN) {
    console.warn("Jira API Token is missing in Script Properties (JIRA_API_TOKEN) for live ticket fetch.");
    return null;
  }

  const authHeader = { 
    Authorization: 'Basic ' + Utilities.base64Encode(`${USER_EMAIL}:${API_TOKEN}`), 
    Accept: 'application/json' 
  };

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
