/**
 * Pulls all Jira tickets from the OP project board into the Google Sheet.
 * This powers the AI-Agile Tracking system for Nexus Project Planning.
 */
function syncOpBoardJiraData() {
  const session = getCurrentUserSession();
  if (session.tier < 3) {
    throw new Error("Unauthorized: Only Admins can sync the OP Jira project board.");
  }

  const props = PropertiesService.getScriptProperties();
  const JIRA_BASE = props.getProperty("JIRA_BASE_URL") || "https://osttra.atlassian.net";
  const authHeader = getJiraHeaders();

  // Define the target JQL for the OP project
  const jql = 'project = OP ORDER BY rank ASC';
  const fieldsToRequest = [
    'summary',
    'status',
    'issuetype',
    'assignee',
    'created',
    'updated',
    'priority',
    'parent',
    'customfield_10014' // Epic Link (often used in company-managed projects)
  ];

  const fetchedIssues = [];
  let nextPageToken = null;
  const maxResults = 100;

  console.log(`Starting JQL Sync for OP Board: ${jql}`);

  do {
    const payload = {
      jql: jql,
      maxResults: maxResults,
      fields: fieldsToRequest,
      nextPageToken: nextPageToken
    };

    const options = {
      method: "post",
      headers: authHeader,
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const url = `${JIRA_BASE}/rest/api/3/search/jql`;
    const response = UrlFetchApp.fetch(url, options);
    const respCode = response.getResponseCode();

    if (respCode !== 200) {
      throw new Error(`Jira API Error [${respCode}]: ${response.getContentText()}`);
    }

    const data = JSON.parse(response.getContentText());
    if (data.issues && data.issues.length > 0) {
      data.issues.forEach(issue => {
        const fields = issue.fields || {};
        const key = String(issue.key || "");
        const summary = String(fields.summary || "");
        const status = fields.status ? String(fields.status.name || "") : "Unknown";
        const issueType = fields.issuetype ? String(fields.issuetype.name || "") : "Unknown";
        const assignee = fields.assignee ? String(fields.assignee.displayName || fields.assignee.emailAddress || "Unassigned") : "Unassigned";
        const priority = fields.priority ? String(fields.priority.name || "") : "";
        const created = fields.created ? String(fields.created).substring(0, 10) : "";
        const updated = fields.updated ? String(fields.updated).substring(0, 10) : "";
        const parentEpic = fields.parent ? String(fields.parent.key || "") : (fields.customfield_10014 ? String(fields.customfield_10014) : "");

        fetchedIssues.push([
          issueType,
          key,
          summary,
          status,
          "", // Placeholder for 'Comments/AI Thoughts' column
          assignee,
          "", // Due date (can be mapped if needed)
          priority,
          parentEpic,
          created,
          updated
        ]);
      });
    }
    
    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);

  console.log(`Fetched ${fetchedIssues.length} total tickets from the OP board.`);

  // Write to Google Sheets
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const targetSheetName = "App OP Project Tracker (Read / Write)";
  let sheet = ss.getSheetByName(targetSheetName);
  
  if (!sheet) {
    sheet = ss.insertSheet(targetSheetName);
    sheet.appendRow([
      "Issue Type", "Key", "Summary", "Status", "AI Thoughts & Notes", 
      "Assignee", "Due Date", "Priority", "Epic Link", "Created", "Updated"
    ]);
    const headerRange = sheet.getRange(1, 1, 1, 11);
    headerRange.setBackground("#1a202c").setFontColor("white").setFontWeight("bold");
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, 11);
  }

  // Clear existing data (but keep header)
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    // Only clear data columns (A:K) to preserve potential formatting or formulas
    sheet.getRange(2, 1, lastRow - 1, 11).clearContent();
  }

  if (fetchedIssues.length > 0) {
    sheet.getRange(2, 1, fetchedIssues.length, fetchedIssues[0].length).setValues(fetchedIssues);
  }

  return "Success! Pulled " + fetchedIssues.length + " tickets from the OP board.";
}