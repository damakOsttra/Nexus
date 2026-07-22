/**
 * src/Auth.js
 * Handles user identity and 5-Tier Role-Based Access Control (RBAC).
 */

/**
 * TIER DEFINITIONS:
 * 3: Admin ("God Mode")
 * 2: Manager (Direct Managers & Team Leads - hasReports === true)
 * 1: Employee (Individual Contributor - hasReports === false)
 */

// Global state cache for active user session (memoized per single execution path)
let _cachedUserSession = null;

function getCurrentUserSession() {
  if (_cachedUserSession) {
    return _cachedUserSession;
  }

  // Real Identity
  let realEmail = String(Session.getActiveUser().getEmail() || "").trim().toLowerCase();
  
  // Normalize well-known G-Suite/HR primary email aliases to match spreadsheet Email Addresses
  const aliasMap = {
    "nikita.sukhmal@osttra.com": "nikita.jain@osttra.com",
    "nikita.sukhmal.jain@osttra.com": "nikita.jain@osttra.com"
  };
  if (aliasMap[realEmail]) {
    realEmail = aliasMap[realEmail];
  }

  // Fetch simulated user using a composite key tied to the real user to prevent cross-user leakage
  const scriptProps = PropertiesService.getScriptProperties();
  const simulatedEmail = scriptProps.getProperty('SIMULATED_USER_' + realEmail);
  
  // Active Identity (Simulated or Real)
  const activeEmail = String(simulatedEmail || realEmail).trim().toLowerCase();
  
  // 1. Fetch Directory Data
  const allEmployees = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  
  // Create lookup maps for efficiency
  const empMap = {};
  const managerMap = {}; // managerId -> count of direct reports
  const directManagerMap = {}; // directManagerName -> count of reports
  const directMgrEmailMap = {}; // directManagerEmail -> count of reports
  const regionalHeads = new Set();

  allEmployees.forEach(emp => {
    const email = String(emp["Email Address"] || "").trim().toLowerCase();
    if (email) empMap[email] = emp;
    
    const mgrId = String(emp["Manager ID"] || "").trim();
    if (mgrId) managerMap[mgrId] = (managerMap[mgrId] || 0) + 1;
    
    const directMgrName = String(emp["Direct Manager Name"] || "").toLowerCase().trim();
    if (directMgrName) directManagerMap[directMgrName] = (directManagerMap[directMgrName] || 0) + 1;

    const directMgrEmail = String(emp["Direct Manager Email"] || "").toLowerCase().trim();
    if (directMgrEmail) directMgrEmailMap[directMgrEmail] = (directMgrEmailMap[directMgrEmail] || 0) + 1;
    
    const regHead = String(emp["Regional Head/Head of function"] || "").toLowerCase().trim();
    if (regHead) regionalHeads.add(regHead);
  });
  
  const userRecord = empMap[activeEmail];
  
  let tier = 1;
  let photoUrl = "https://ui-avatars.com/api/?name=Unknown+User&background=222222&color=fff";
  let name = "Unknown User";
  let role = "Employee";
  let region = "Global";
  let empId = "";
  let hasReports = false;

  if (userRecord) {
    name = (userRecord["Google Chat Full Name"] || userRecord["HR Name"] || `${userRecord["First Name"] || ""} ${userRecord["Last Name"] || ""}`).trim();
    empId = String(userRecord["Employee ID"]).trim();
    photoUrl = userRecord["Photo URL"] && userRecord["Photo URL"] !== "N/A" ? userRecord["Photo URL"] : `https://ui-avatars.com/api/?name=${name.replace(/\s+/g, '+')}&background=FF0061&color=fff`;
    role = userRecord["Profile"] || "Employee";
    region = userRecord["Cost Center"] || "Global";

    const managerIdStr = empId;
    const userNameLower = name.toLowerCase();

    // Tier 2: Manager Check (Check ID, Direct Manager Name, or Direct Manager Email as primary - ignore sentinels)
    hasReports = (empId && empId !== "N/A" && empId !== "undefined" && (managerMap[managerIdStr] || 0) > 0) || 
                 (name && name !== "Unknown User" && (directManagerMap[userNameLower] || 0) > 0) ||
                 (activeEmail && activeEmail !== "N/A" && (directMgrEmailMap[activeEmail] || 0) > 0);
    if (hasReports) tier = 2;

  } else if (getAdminEmails().includes(activeEmail)) {
    // Generate mock Admin session to prevent 'Unknown User' in sidebar if not in roster
    name = "System Administrator";
    empId = "ADMIN-000";
    photoUrl = `https://ui-avatars.com/api/?name=System+Admin&background=FF0061&color=fff`;
    role = "Super Admin";
    region = "Global Operations";
    hasReports = false;
  }

  // Tier 3: Admin Check for Active/Simulated Identity
  if (getAdminEmails().includes(activeEmail)) tier = 3;

  const identityTier = tier; // Capture the actual tier of the active/simulated identity
  const isAdmin = getAdminEmails().includes(realEmail);

  // Dynamic Depth Check for Executive Access (Anup -2 Level)
  let isExecutiveView = false;
  if (getAdminEmails().includes(activeEmail) || activeEmail === 'john.stewart@osttra.com') {
    isExecutiveView = true;
  } else {
    let current = activeEmail;
    let depth = 0;
    const visited = new Set();
    while (current && depth <= 3) {
      if (current === 'anup.hariharan@osttra.com') {
        if (depth <= 2) {
          isExecutiveView = true;
        }
        break;
      }
      visited.add(current);
      const rec = empMap[current];
      const nextMgr = rec ? String(rec["Direct Manager Email"] || "").trim().toLowerCase() : "";
      if (!nextMgr || nextMgr === current || visited.has(nextMgr)) {
        break;
      }
      current = nextMgr;
      depth++;
    }
  }

  // Dynamic Hierarchy & Tagging Check for TPM Access (Jack Jeffreys' Org)
  let isTpmUser = false;
  let isTpmManager = false;

  if (getAdminEmails().includes(activeEmail) || activeEmail === 'jack.jeffreys@osttra.com' || activeEmail === 'nicholas.allcock@osttra.com') {
    isTpmUser = true;
    isTpmManager = true;
  } else {
    // 1. Check dynamic hierarchy (Does this person roll up to Jack?)
    let current = activeEmail;
    let depth = 0;
    const visited = new Set();
    while (current && depth <= 6) {
      if (current === 'jack.jeffreys@osttra.com') {
        isTpmUser = true;
        if (hasReports) isTpmManager = true;
        break;
      }
      visited.add(current);
      const rec = empMap[current];
      const nextMgr = rec ? String(rec["Direct Manager Email"] || "").trim().toLowerCase() : "";
      if (!nextMgr || nextMgr === current || visited.has(nextMgr)) break;
      current = nextMgr;
      depth++;
    }
    
    // 2. Fallback to manual spreadsheet tagging if not in Jack's hierarchy
    if (!isTpmUser && userRecord) {
      const isTpmVal = String(userRecord["is_tpm"] || userRecord["Is_TPM"] || userRecord["IS_TPM"] || "").trim().toLowerCase();        
      if (["yes", "true", "y", "1"].includes(isTpmVal)) {
        isTpmUser = true;
        if (hasReports) isTpmManager = true;
      }
    }
  }

  console.log(`User: ${activeEmail} | Identity Tier: ${identityTier} | Effective Tier: ${tier} | Executive View: ${isExecutiveView} | TPM User: ${isTpmUser} | TPM Mgr: ${isTpmManager}`);
  
  const currentPeriod = getActivePeriod();
  
  _cachedUserSession = {
    email: activeEmail,
    realEmail: realEmail,
    name: name,
    role: role,
    region: region,
    photoUrl: photoUrl,
    tier: tier,
    identityTier: identityTier,
    isAdmin: isAdmin,
    empId: empId,
    isSimulated: !!simulatedEmail,
    phase1State: getSystemConfig()["PHASE_1_STATE"] || "1",
    hasReports: hasReports,
    currentPeriod: currentPeriod,
    isExecutiveView: isExecutiveView,
    isTpmUser: isTpmUser,
    isTpmManager: isTpmManager
  };
  
  return _cachedUserSession;
}

/**
 * Backend Security Guard: Validates that the active user has at least the required tier.
 */
function validateTier(requiredTier) {
  const session = getCurrentUserSession();
  if (session.tier < requiredTier) {
    throw new Error(`Unauthorized: Tier ${requiredTier} required. Current tier: ${session.tier}`);
  }
  return session;
}

/**
 * Simulation Utility: Set a simulated user email
 */
function setSimulatedUser(email) {
  const realEmail = Session.getActiveUser().getEmail().toLowerCase();
  if (!getAdminEmails().includes(realEmail)) throw new Error("Unauthorized: Admin privileges required for simulation.");
  
  _cachedUserSession = null; // Bust memoized session cache on simulation switch
  
  if (email) {
    const targetEmail = String(email).trim().toLowerCase();
    
    // Check if the user exists in the roster
    const employees = getSheetData(CONFIG.SHEETS.EMPLOYEES);
    const userInRoster = employees.some(e => String(e["Email Address"] || "").trim().toLowerCase() === targetEmail);
    if (!userInRoster) {
      throw new Error(`Simulation Rejected: User "${targetEmail}" is not in the active employee roster.`);
    }

    PropertiesService.getScriptProperties().setProperty('SIMULATED_USER_' + realEmail, targetEmail);
  } else {
    PropertiesService.getScriptProperties().deleteProperty('SIMULATED_USER_' + realEmail);
  }
  return true;
}

/**
 * Simulation Utility: Clear simulation
 */
function clearSimulatedUser() {
  const realEmail = Session.getActiveUser().getEmail().toLowerCase();
  _cachedUserSession = null; // Bust memoized session cache on simulation clear
  PropertiesService.getScriptProperties().deleteProperty('SIMULATED_USER_' + realEmail);
  return true;
}