/**
 * src/Config.js
 * Centralized configuration for the Nexus application.
 */

// Define Environment Databases
const DATABASES = {
  UAT: '1WvLi0bMwMqcwH6QU7R58f-Pow7FbGoDQOtc1_kOOCkQ',
  PROD: '1lZJ2B5HVJ_SYwaPY_3Ga6-oCC8CJJViOyzvD5rbVi34'
};

// Determine Environment Dynamically based on Execution Context (URL)
// If running from /dev URL (testing), route to UAT. Otherwise (e.g. /exec or triggers), route to PROD.
let ACTIVE_ENV = 'PROD'; // Default fallback for background triggers
try {
  const url = ScriptApp.getService().getUrl();
  if (url && url.endsWith('/dev')) {
    ACTIVE_ENV = 'UAT';
  }
} catch (e) {
  // ScriptApp.getService().getUrl() fails when called from a time-based trigger or non-webapp context.
  // We leave it as PROD. Background triggers are routed explicitly using setEnvironment() wrappers in Triggers.js.
  ACTIVE_ENV = 'PROD'; 
}

const CONFIG = {
  // Production URL for the deployed Web App (used in emails & chats)
  NEXUS_BASE_URL: 'https://script.google.com/a/macros/osttra.com/s/AKfycby7bDQ1d4cvOdK3aRqWmFlygrTLo5Jeio123wJQglApifdcnMbPleqymrfKoxhljOov/exec',

  // Environment Flag (Gates telemetry logging & DB routing)
  ENVIRONMENT: ACTIVE_ENV,

  // Master Spreadsheet ID
  SPREADSHEET_ID: DATABASES[ACTIVE_ENV],
  
  // Sheet Names
  SHEETS: {
    EMPLOYEES: "App All Employee Data (Read / Write)",
    ALLOCATION_SNAPSHOT: "App Allocation Snapshot (Internal)",
    PRODUCTS: "App Product Data (Read / Write)",
    SKILL_LEVELS: "App Skill Level Data (Read / Write)",
    FINANCE_PRODUCTS: "App Finance Products (Read / Write)",
    FINANCE_MAPPING: "App Finance Mapping (Read / Write)",
    ALLOCATION_HISTORICAL: "App Employee Allocation Data (Read / Write)",
    SKILL_MATRIX: "App Employee Skill Matrix (Read / Write)",
    MANAGER_PRODUCT_ALLOCATION: "App Manager Product Allocation (Read / Write)",
    CONFIG: "App Config (Reference)",
    SYSTEM_LOGS: "App System Logs (Read / Write)",
    ANALYTICAL_HUB: "App Analytical Hub (Read / Write)",
    DATA_AUDIT: "App Audit: Discrepancies (Reference)",
    SNAPSHOT_LOGS: "App Snapshot Logs (Read / Write)",
    TPM_JIRA_CACHE: "TPM_Jira_Cache",
    TPM_TIMESHEET_LOGS: "TPM_Timesheet_Logs",
    TPM_UNLOCK_LOG: "TPM_Unlock_Log",
    MANUAL_INACTIVES: "App Manual Inactives (Read / Write)",
    OPEX_PROJECT_TRACKER: "App OPEX Project Tracker (Read / Write)",
    HEADCOUNT_TREND: "App Headcount Trend (Read / Write)",
    HEADCOUNT_AUDIT: "App Headcount Audit (Read / Write)"
  },

  // Google Drive Folder Configuration
  DRIVE_BACKUP_FOLDER_ID: '1BdSd68eYPnbhbqnFIxTQ15cbVLgdDq7z',

  // Ignored / Excluded Emails from compliance & monitoring tracking
  IGNORED_EMAILS: [
    "john.stewart@osttra.com",
    "misuzu.fujiwara@osttra.com",
    "sanghmitra.khanna@osttra.com",
    "svc-nexus@osttra.com"
  ],

  // Capacity & Allocation Constraints
  STD_MONTHLY_HOURS: 160 // Used for capacity calculations
};

/**
 * Returns a list of Admin emails.
 */
function getAdminEmails() {
  return ["damak.k@osttra.com", "richard.crossley@osttra.com", "svc-nexus@osttra.com", "chau.pham@osttra.com"];
}

/**
 * Returns a list of Leadership emails.
 */
function getLeadershipEmails() {
  return [
    "anup.hariharan@osttra.com", 
  "suneet.dhar@osttra.com", 
    "jane.hill@osttra.com",
    "nicholas.allcock@osttra.com",
    "scott.bolnick@osttra.com",
    "karan.singal@osttra.com",
    "jerry.lin@osttra.com"
  ];
}

/**
 * Returns the list of Regional Heads for hierarchy logic.
 */
function getAllowedHeads() {
  return [
    "anup.hariharan@osttra.com", 

    "suneet.dhar@osttra.com",
    "jane.hill@osttra.com",
    "nicholas.allcock@osttra.com",
    "scott.bolnick@osttra.com",
    "karan.singal@osttra.com",
    "jerry.lin@osttra.com"
  ];
}

/**
 * Safely calculates the active allocation period (the previous month).
 * Sets the day of the month to 1 before subtracting to prevent JS date overflow/rollover bugs on the 31st.
 */
function getActivePeriod() {
  const d = new Date();
  d.setDate(1); // Set to 1st to prevent end-of-month rollover bugs
  d.setMonth(d.getMonth() - 1);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return months[d.getMonth()] + " " + d.getFullYear();
}

/**
 * Dynamically constructs Jira API headers from secure Script Properties.
 * Supports both JIRA_USER and the older JIRA_USER_EMAIL formats.
 */
function getJiraHeaders() {
  const scriptProperties = PropertiesService.getScriptProperties();   
  const username = scriptProperties.getProperty('JIRA_USER') || scriptProperties.getProperty('JIRA_USER_EMAIL');
  const token = scriptProperties.getProperty('JIRA_API_TOKEN');       

  if (!username || !token) {
    throw new Error("Jira credentials (JIRA_USER or JIRA_API_TOKEN) are not set in Script Properties.");
  }

  const encodedAuth = Utilities.base64Encode(username + ':' + token); 

  return {
    "Authorization": "Basic " + encodedAuth,
    "Accept": "application/json",
    "Content-Type": "application/json"
  };
}

/**
 * Dynamically updates the active environment database routing.
 * @param {string} envName 'UAT' or 'PROD'
 */
function setEnvironment(envName) {
  if (!DATABASES[envName]) {
    throw new Error("Invalid environment name specified: " + envName);
  }
  CONFIG.ENVIRONMENT = envName;
  CONFIG.SPREADSHEET_ID = DATABASES[envName];
  console.log(`[CONFIG] Dynamically switched active environment to: ${envName} (ID: ${CONFIG.SPREADSHEET_ID})`);
}