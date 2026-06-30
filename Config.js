/**
 * src/Config.js
 * Centralized configuration for the Nexus application.
 */

const CONFIG = {
  // Master Spreadsheet ID
  SPREADSHEET_ID: '1lZJ2B5HVJ_SYwaPY_3Ga6-oCC8CJJViOyzvD5rbVi34',
  
  // Sheet Names
  SHEETS: {
    EMPLOYEES: "App All Employee Data (Read / Write)",
    PRODUCTS: "App Product Data (Read / Write)",
    SKILL_LEVELS: "App Skill Level Data (Read / Write)",
    ALLOCATION_HISTORICAL: "App Employee Allocation Data (Read / Write)",
    SKILL_MATRIX: "App Employee Skill Matrix (Read / Write)",
    MANAGER_PRODUCT_ALLOCATION: "App Manager Product Allocation (Read / Write)",
    CONFIG: "App Config (Reference)",
    SYSTEM_LOGS: "App System Logs (Read / Write)",
    ANALYTICAL_HUB: "App Analytical Hub (Read / Write)",
    DATA_AUDIT: "App Audit: Discrepancies (Reference)",
    SNAPSHOT_LOGS: "App Snapshot Logs (Read / Write)"
  },

  // Google Drive Folder Configuration
  DRIVE_BACKUP_FOLDER_ID: '1E9uY9o-NTHO5ciy4dXFDZ2u7uDojcXaP',

  // Ignored / Excluded Emails from compliance & monitoring tracking
  IGNORED_EMAILS: [
    "john.stewart@osttra.com",
    "misuzu.fujiwara@osttra.com",
    "sanghmitra.khanna@osttra.com"
  ],

  // BigQuery Configuration
  BQ: {
    PROJECT_ID: 'prj-p-bi-data-5rsa', // Production Project ID from GCP
    DATASETS: {
      SALESFORCE: 'digops_self_service_looker.salesforce_case_intermediate_digops',
      JIRA: 'digops_self_service_looker.jira_issues',
      PEOPLE_DATA: 'digops_self_service_looker.people_data_records', 
      SYSTEM_LOGS: 'digops_self_service_looker.app_logs_prod'
    },
    STD_MONTHLY_HOURS: 160 // Used for capacity calculations
  }
};

/**
 * Returns a list of Admin emails.
 */
function getAdminEmails() {
  return ["damak.k@osttra.com", "richard.crossley@osttra.com"];
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