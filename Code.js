/**
 * Skill Matrix Web App - Core Router (Code.js)
 * Handles role-based shell routing and asynchronous view fetching.
 */

/**
 * 1. Web App Entry Point (MPA Routing)
 * Evaluates user tier and serves the appropriate role-based application shell.
 */
function doGet(e) {
  try {
    const session = getCurrentUserSession();
    
    // Identity Check: Handle blank emails (Commonly caused by GAS Multiple Account bug)
    if (!session.email) {
      return serveErrorShell('Identity Verification Failed', 'We could not verify your OSTTRA identity. This usually happens if you are logged into multiple Google accounts. Please use a dedicated Chrome Profile or Incognito Mode.');
    }

    // Maintenance Mode (State 3) Enforced System-Wide Lockout
    const state = getSystemConfig()["PHASE_1_STATE"] || "1";
    const isAdminUser = getAdminEmails().includes(session.realEmail) || (session.tier >= 3);
    if (state === "3" && !isAdminUser) {
      return serveErrorShell('System Maintenance Underway', 'Nexus is currently offline for scheduled database maintenance. Non-admin access is temporarily suspended. Please check back later.');
    }

    // Tier-Based Routing
    let shellFile = 'ui/Shells/EmployeeApp'; // Default Tier 1
    
    // Force Admin Shell if the REAL user is an Admin (Tier 3), regardless of simulation
    // This allows simulation testing without losing the Admin UI controls.
    if (getAdminEmails().includes(session.realEmail)) {
      shellFile = 'ui/Shells/AdminApp';
    } else if (session.tier >= 3) {
      shellFile = 'ui/Shells/AdminApp'; // Regular Admin access
    } else if (session.tier >= 2) {
      shellFile = 'ui/Shells/ManagerApp'; // Tiers 2-3 (Managers & Executives)
    }

    // Ensure we are returning a clean HtmlOutput object
    const template = HtmlService.createTemplateFromFile(shellFile);
    return template.evaluate()
      .setTitle('Nexus | OSTTRA')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  } catch (error) {
    return serveErrorShell('System Initialization Error', error.message);
  }
}

/**
 * Helper: Serves a specific Error HTML shell with data.
 */
function serveErrorShell(title, message) {
  const template = HtmlService.createTemplateFromFile('ui/Shells/Error');
  template.title = title;
  template.message = message;
  return template.evaluate()
    .setTitle('Nexus Error | OSTTRA')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 2. Asynchronous View Component Router (SPA Navigation)
 */
function getView(pageName) {
  const session = getCurrentUserSession();
  
  // Enforce Maintenance Mode (State 3) logic
  const state = getSystemConfig()["PHASE_1_STATE"] || "1";
  const isAdminUser = getAdminEmails().includes(session.realEmail) || (session.tier >= 3);
  if (state === "3" && !isAdminUser) {
    return `
      <div class="p-12 text-center text-osttra-rubine flex flex-col items-center justify-center h-full gap-4">
        <i class="fas fa-tools text-5xl mb-2 opacity-20 animate-pulse"></i>
        <h3 class="text-2xl font-black uppercase tracking-tighter text-osttra-rubine">System Maintenance</h3>
        <p class="text-sm font-medium opacity-50 max-w-md text-center text-white/60 leading-relaxed">This system is currently offline for scheduled database maintenance. Access has been temporarily suspended. Please check back later.</p>
      </div>
    `;
  }
  
  // Security Mapping (Strict Phase 1 Core Allowed List)
  const permissions = {
    'SystemSettings': 3,
    'ReportHubAdmin': 3,
    'MonitoringAdmin': 3,
    'BackupAdmin': 3,
    'NexusAdoption': 3,
    'AssignProduct': 2, 'AssignSkill': 2, 'TeamAllocationsReview': 2,
    'About': 1, 'Profile': 1, 'MyAllocations': 1, 'AnalyticsHub': 1, 'ExecAnalytics': 2,
    'UserGuide': 1, 'OrganizationChart': 1,
    'TpmTimesheet': 1,
    'TpmDashboard': 1
  };

  const requiredTier = permissions[pageName];
  if (!requiredTier) {
    return `<div class="p-8 text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex items-center gap-3">
              <i class="fas fa-exclamation-triangle"></i>
              <span>Module Locked: This module is scheduled for a future rollout phase.</span>
            </div>`;
  }

  if (session.tier < requiredTier) {
    return `<div class="p-8 text-red-500">🚫 Restricted Access: Tier ${requiredTier} required.</div>`;
  }

  // Dynamic checks for TPM access
  if (pageName === 'TpmTimesheet' && !session.isTpmUser) {
    return `<div class="p-8 text-red-500">🚫 Restricted Access: Tier-4 TPM hierarchy required.</div>`;
  }
  if (pageName === 'TpmDashboard' && !session.isTpmManager) {      
    return `<div class="p-8 text-red-500">🚫 Restricted Access: Tier-4 TPM manager clearance required.</div>`;
  }

  // Strict executive view authorization guard
  if (pageName === 'ExecAnalytics' && !session.isExecutiveView) {
    return `<div class="p-8 text-red-500 flex items-center gap-3">
              <i class="fas fa-user-lock text-lg"></i>
              <span>🚫 Restricted Access: Executive clearance (Anup-2) required.</span>
            </div>`;
  }

  const viewMap = {
    // Admin
    'SystemSettings': 'ui/Admin/SystemSettings',
    'ReportHubAdmin': 'ui/Admin/ReportHubAdmin',
    'MonitoringAdmin': 'ui/Admin/MonitoringAdmin',
    'BackupAdmin': 'ui/Admin/BackupAdmin',
    'NexusAdoption': 'ui/Admin/NexusAdoption',
    'TpmDashboard': 'ui/Admin/TpmDashboard',

    // Teams
    'AssignProduct': 'ui/Teams/AssignProduct',
    'AssignSkill': 'ui/Teams/AssignSkill',
    'TeamAllocationsReview': 'ui/Teams/TeamAllocationsReview',
    'TpmTimesheet': 'ui/Teams/TpmTimesheet',

    // Personal
    'About': 'ui/Personal/About',
    'Profile': 'ui/Personal/HomeProfile',
    'MyAllocations': 'ui/Personal/MyAllocations',
    'AnalyticsHub': 'ui/Personal/AnalyticsHub',
    'ExecAnalytics': 'ui/Personal/ExecAnalytics',
    'UserGuide': 'ui/Personal/UserGuide',
    'OrganizationChart': 'ui/Personal/OrgChart'
    };

    const filePath = viewMap[pageName];
    if (!filePath) return `<div class="p-8 text-gray-500">Module not found.</div>`;

    try {
    return HtmlService.createTemplateFromFile(filePath).evaluate().getContent();
    } catch (error) {
    return `<div class="p-8 text-red-500">Error loading module: ${error.message}</div>`;
    }
    }

    /**
    * 3. Identity Verification Service
    */
    function getUserSession() {
    const session = getCurrentUserSession();

    session.preloadedViews = {};
    const permissions = {
      'SystemSettings': 3,
      'ReportHubAdmin': 3,
      'MonitoringAdmin': 3,
      'BackupAdmin': 3,
      'NexusAdoption': 3,
      'AssignProduct': 2, 'AssignSkill': 2, 'TeamAllocationsReview': 2,
      'About': 1, 'Profile': 1, 'MyAllocations': 1, 'AnalyticsHub': 1,
      'UserGuide': 1,
      'TpmTimesheet': 1,
      'TpmDashboard': 1
    };

  for (const pageName in permissions) {
    let hasPerm = session.tier >= permissions[pageName];
    if (pageName === 'TpmTimesheet' && !session.isTpmUser) hasPerm = false;
    if (pageName === 'TpmDashboard' && !session.isTpmManager) hasPerm = false;

    if (hasPerm) {
      try {
        session.preloadedViews[pageName] = getView(pageName);
      } catch (e) {
        console.error("Failed to preload view " + pageName + ": " + e.message);
      }
    }
  }

  return session;
}

/**
 * Master Boot Endpoint: Performs batch reads to fetch all required session 
 * and operational data in a single server thread, avoiding round-trip latency.
 */
function getAppBootPayload() {
  const session = getUserSession();
  
  // Enforce Maintenance Lockout on Boot initialization
  const state = getSystemConfig()["PHASE_1_STATE"] || "1";
  const isAdminUser = getAdminEmails().includes(session.realEmail) || (session.tier >= 3);
  if (state === "3" && !isAdminUser) {
    throw new Error("System Offline: Nexus is currently undergoing scheduled database maintenance. All active sessions have been suspended.");
  }

  const email = session.email;
  
  let profile = null;
  let skillMatrix = [];
  let managerProductAllocation = [];
  let historicalAllocation = [];

  try {
    profile = getEmployeeProfileData(email);
  } catch (e) {
    console.error("Failed to fetch profile in boot payload: " + e.message);
  }

  try {
    skillMatrix = getSkillMatrix(email);
  } catch (e) {
    console.error("Failed to fetch skill matrix in boot payload: " + e.message);
  }

  try {
    managerProductAllocation = getManagerProductAllocation(email);
  } catch (e) {
    console.error("Failed to fetch manager product allocation in boot payload: " + e.message);
  }

  try {
    historicalAllocation = getHistoricalAllocation(email);
  } catch (e) {
    console.error("Failed to fetch historical allocations in boot payload: " + e.message);
  }

  // Auto-Sync Schema on Admin Login
  if (session.tier >= 3) {
    try {
      initializeDatabaseSchema();
    } catch (e) {
      console.warn("Schema auto-sync failed: " + e.message);
    }
  }

  const appUrl = getAppUrl();
  const isUAT = appUrl.indexOf('/dev') !== -1;
  const prodUrl = 'https://script.google.com/a/macros/osttra.com/s/AKfycby7bDQ1d4cvOdK3aRqWmFlygrTLo5Jeio123wJQglApifdcnMbPleqymrfKoxhljOov/exec';

  return JSON.parse(JSON.stringify({
    session: session,
    profile: profile,
    skillMatrix: skillMatrix,
    managerProductAllocation: managerProductAllocation,
    historicalAllocation: historicalAllocation,
    serverTimestamp: new Date().getTime(),
    isUAT: isUAT,
    prodUrl: prodUrl
  }));
}

/**
 * Utility: Returns the Web App URL for robust reloads.
 */
function getAppUrl() {
  return ScriptApp.getService().getUrl();
}

/**
 * Templating Utility: Injects raw HTML file contents dynamically.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * DIAGNOSTIC TOOL: Inspects why the product allocation grid is returning empty.
 * Reveals list of unique emails registered in Skill Matrix and matches found.
 */
function getSkillMatrixDebug(email) {
  validateTier(1);
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.SKILL_MATRIX);
    if (!sheet) return { searched: email, error: "App Employee Skill Matrix sheet missing from Database." };
    
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return { searched: email, error: "Skill Matrix spreadsheet is currently empty." };
    
    const headers = data[0].map(h => String(h || "").trim());
    const emailIdx = headers.indexOf("Email Address");
    if (emailIdx === -1) return { searched: email, error: "'Email Address' column not found in Skill Matrix headers." };
    
    const emails = [...new Set(data.slice(1).map(r => String(r[emailIdx] || "").trim().toLowerCase()))].filter(Boolean);
    const targetEmail = String(email || "").toLowerCase().trim();
    const rawMatchCount = data.slice(1).filter(r => String(r[emailIdx] || "").toLowerCase().trim() === targetEmail).length;
    
    return {
      searched: targetEmail,
      availableEmails: emails,
      rawMatchCount: rawMatchCount
    };
  } catch (e) {
    return { searched: email, error: e.message };
  }
}