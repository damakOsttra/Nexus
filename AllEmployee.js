/**
 * OSTTRA Corporate Master Data Export - Filtered for Anup Hariharan's Org
 * New Columns: Regional Head/Head of function & Leads
 */

/**
 * Global Utility: Normalizes names to resolve typos and discrepancies in Google/Dayforce.
 */
function normalizeName(name) {
  if (!name) return "N/A";
  const lower = name.toLowerCase().trim();
  if (lower === "" || lower === "unknown" || lower === "n/a" || lower === "na") return "N/A";
  if (lower.includes("nicholas") && lower.includes("allcock")) return "Nicholas Allcock";
  if (lower.includes("anup") && lower.includes("hariharan")) return "Anup Hariharan";
  if (lower.includes("sanghmitra") && lower.includes("khanna")) return "Sanghmitra Khanna";
  if (lower.includes("john") && lower.includes("stewart")) return "John Stewart";
  return name.trim();
}

function exportAnupOrgMasterData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  try {
    // 1. PREPARATION: Load Manual Data
    console.log("Mapping Manual Data...");
    const manualMaps = getManualDataMaps(ss);
    
    // NEW: Load Manual Inactive Overrides
    console.log("Mapping Manual Inactive Overrides...");
    const manualInactives = getManualInactiveOverrides(ss);
    
    // 2. PREPARATION: Load Directory
    console.log("Downloading directory...");
    const directoryMap = getCompleteDirectoryMap();
    const allEmails = Object.keys(directoryMap);
    
    if (allEmails.length === 0) {
      return "Error: No directory data retrieved. Please check if People API is enabled and has correct permissions.";
    }
    
    const targetSheetName = "App All Employee Data (Read / Write)";
    let sheet = ss.getSheetByName(targetSheetName);
    
    // --- DB CASCADE: Detect Email Changes Before Overwrite ---
    const existingIdToEmailMap = {};
    if (sheet) {
      const existingData = sheet.getDataRange().getValues();
      if (existingData.length > 1) {
        const h = existingData[0].map(header => String(header).trim());
        const idIdx = h.indexOf("Employee ID");
        const emailIdx = h.indexOf("Email Address");
        if (idIdx !== -1 && emailIdx !== -1) {
          for (let i = 1; i < existingData.length; i++) {
            const eId = String(existingData[i][idIdx]).trim();
            const eMail = String(existingData[i][emailIdx]).toLowerCase().trim();
            if (eId && eMail) existingIdToEmailMap[eId] = eMail;
          }
        }
      }
      sheet.clear(); 
    } else { 
      sheet = ss.insertSheet(targetSheetName); 
    }
    // ---------------------------------------------------------

    // Define the allowed Regional Heads
    const allowedHeads = getAllowedHeads();
    const allowedHeadsLower = allowedHeads.map(h => h.toLowerCase());

    // --- DAYFORCE INTEGRATION: Fetch Dayforce Data ---
    const dayforceData = fetchDayforceData();
    const dayforceMap = dayforceData.byEmail || {};
    const dfEmpMap = dayforceData.byEmpId || {};
    const dayforceByNameMap = dayforceData.byName || {};

    // Build resolved maps for robust Google-to-Dayforce and employee ID-to-email correlation
    const resolvedDayforceByGoogleEmail = {};
    const empIdToGoogleEmail = {};

    allEmails.forEach(gEmail => {
      const person = directoryMap[gEmail];
      let dfRec = dayforceMap[gEmail.toLowerCase().trim()];
      
      if (!dfRec && person.empId && person.empId !== "N/A" && dfEmpMap[person.empId]) {
        dfRec = dfEmpMap[person.empId];
      }
      
      if (!dfRec && person.name) {
        const sanitizedName = String(person.name).toLowerCase().replace(/[^a-z0-9]/g, '');
        if (dayforceByNameMap[sanitizedName]) {
          dfRec = dayforceByNameMap[sanitizedName];
        }
      }
      
      if (dfRec) {
        resolvedDayforceByGoogleEmail[gEmail.toLowerCase().trim()] = dfRec;
        dfRec.googleEmail = gEmail.toLowerCase().trim(); // Link Dayforce record to canonical Google email
      }

      if (person.empId && person.empId !== "N/A") {
        empIdToGoogleEmail[String(person.empId).trim()] = gEmail.toLowerCase().trim();
      }
    });

    const isoToCountry = {
      "IN": "India",
      "US": "United States",
      "GB": "United Kingdom",
      "SG": "Singapore",
      "SE": "Sweden",
      "MY": "Malaysia",
      "JP": "Japan"
    };

    const allRows = [];
    // FINAL HEADERS - Expanded with Dayforce HR metrics
    allRows.push([
      "Employee ID", "First Name", "Last Name", "Google Chat Full Name", "HR Name", "Email Address", 
      "Photo URL", "Cost Center", 
      "Regional Head/Head of function",
      "Direct Manager Name", "Direct Manager Email", "Manager ID", 
      "Management Line (Hierarchy)", "Profile", "HR Job Role", "Start Date",
      "HR Start Date", "HR Termination Date", "HR Employment Status", "HR Pay Class", "HR Legal Entity",
      "is_tpm", "is_opex"
    ]);

    allEmails.forEach(email => {
      const person = directoryMap[email];
      let dfRecord = resolvedDayforceByGoogleEmail[email.toLowerCase().trim()];
      
      // Keep logging consistent with original implementation
      if (dfRecord && dfRecord.email !== email.toLowerCase().trim()) {
        console.log(`[DAYFORCE_RESOLVER] Email mismatch resolved for ${email} -> ${dfRecord.hrName}`);
      }
      
      // Resolve Manager Info & Hierarchy strictly from Dayforce, falling back to Google Workspace Directory
      let managerEmailAddr = "N/A";
      let managerName = "N/A";
      let managerEmpId = "N/A";

      if (dfRecord) {
        managerEmpId = dfRecord.managerEmpId || "N/A";
        
        // Reverse-lookup manager's email using manager ID, prioritizing canonical Google email
        if (managerEmpId !== "N/A" && dfEmpMap[managerEmpId]) {
          const dfMgr = dfEmpMap[managerEmpId];
          managerEmailAddr = dfMgr.googleEmail || dfMgr.email || "N/A";
        } else if (managerEmpId !== "N/A" && empIdToGoogleEmail[managerEmpId]) {
          managerEmailAddr = empIdToGoogleEmail[managerEmpId];
        }
      }

      // Fallback to Google Directory for direct manager if Dayforce lookup is empty
      if (managerEmailAddr === "N/A") {
        if (person.managerEmail) {
          managerEmailAddr = person.managerEmail;
        }
      }

      // Resolve manager details: prioritizing Google Chat Full Name (from Google Directory map)
      if (managerEmailAddr !== "N/A" && directoryMap[managerEmailAddr.toLowerCase()]) {
        const mgrObj = directoryMap[managerEmailAddr.toLowerCase()];
        managerName = mgrObj.name || "N/A";
        if (managerEmpId === "N/A") {
          managerEmpId = mgrObj.empId || "N/A";
        }
      }

      // Fallback to Dayforce manager name if Google Directory lookup yields empty name
      if (managerName === "N/A" && dfRecord && dfRecord.managerName) {
        managerName = dfRecord.managerName;
      }

      // Build Hierarchy utilizing Dayforce recursion, falling back to Google Directory if needed
      const chain = [{ email: email.toLowerCase().trim(), name: normalizeName(person.name) }];
      let currMngrEmail = managerEmailAddr;
      const visited = new Set([email.toLowerCase().trim()]);

      while (currMngrEmail && currMngrEmail !== "N/A") {
        const mgrKey = currMngrEmail.toLowerCase().trim();
        if (visited.has(mgrKey)) break; // Prevent infinite loops
        visited.add(mgrKey);

        let nextMgrName = "N/A";
        let nextMgrEmail = "N/A";

        // Try Dayforce record first to resolve next manager's email
        const dfMgr = resolvedDayforceByGoogleEmail[mgrKey] || dayforceMap[mgrKey];
        if (dfMgr) {
          if (dfMgr.managerEmpId && dfMgr.managerEmpId !== "N/A" && dfEmpMap[dfMgr.managerEmpId]) {
            const nextMgrRec = dfEmpMap[dfMgr.managerEmpId];
            nextMgrEmail = nextMgrRec.googleEmail || nextMgrRec.email || "N/A";
          } else if (dfMgr.managerEmpId && dfMgr.managerEmpId !== "N/A" && empIdToGoogleEmail[dfMgr.managerEmpId]) {
            nextMgrEmail = empIdToGoogleEmail[dfMgr.managerEmpId];
          }
        } 
        
        // Fallback to Google Directory for next manager email
        if (nextMgrEmail === "N/A" && directoryMap[mgrKey]) {
          const gMgr = directoryMap[mgrKey];
          nextMgrEmail = gMgr.managerEmail || "N/A";
        }

        // Always resolve next manager name prioritizing Google Chat Full Name (from Google Directory map)
        if (directoryMap[mgrKey]) {
          nextMgrName = directoryMap[mgrKey].name || "N/A";
        }

        // Fallback to Dayforce HR name if not found in Google Directory
        if (nextMgrName === "N/A" && (resolvedDayforceByGoogleEmail[mgrKey] || dayforceMap[mgrKey])) {
          const dfMgrRec = resolvedDayforceByGoogleEmail[mgrKey] || dayforceMap[mgrKey];
          nextMgrName = dfMgrRec.hrName || (dfMgrRec.firstName + " " + dfMgrRec.lastName);
        }

        if (nextMgrName !== "N/A") {
          chain.push({ email: mgrKey, name: nextMgrName });
        }

        // Stop if we hit John Stewart or Anup Hariharan (but keep them in the chain)
        if (mgrKey === "john.stewart@osttra.com" || mgrKey === "anup.hariharan@osttra.com") break;

        currMngrEmail = nextMgrEmail;
      }

      // Resolve Cost Center (Dayforce Primary, Google Fallback)
      let costCenterValue = "N/A";
      if (dfRecord && dfRecord.countryCode && dfRecord.countryCode !== "N/A") {
        const cc = dfRecord.countryCode;
        if (isoToCountry[cc]) {
          costCenterValue = isoToCountry[cc];
        } else {
          costCenterValue = cc.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        }
      } else {
        const normalizeCase = (str) => {
          if (!str || str === "N/A") return "N/A";
          return str.toLowerCase().split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        };
        costCenterValue = normalizeCase(person.costCenter);
      }

      // --- 4. FIND REGIONAL HEAD (Functional Head) ---
      let regionalHead = "N/A";
      
      const topLevelExclusions = ["anup.hariharan@osttra.com", "sanghmitra.khanna@osttra.com", "john.stewart@osttra.com", "misuzu.fujiwara@osttra.com"];
      if (topLevelExclusions.indexOf(email.toLowerCase().trim()) === -1) {
        // Traverse up the chain to find the lowest Functional Head matching the 6 emails
        for (let i = 0; i < chain.length; i++) {
          if (allowedHeadsLower.indexOf(chain[i].email) !== -1) {
            regionalHead = normalizeName(chain[i].name);
            break; 
          }
        }
      }

      const managementLine = chain.slice(1).map(item => item.name).join(" > ");
      
      // --- 5. THE FILTERS ---
      const isJohnStewart = email.toLowerCase().trim() === "john.stewart@osttra.com";
      const isInAnupOrg = chain.some(item => item.email === "anup.hariharan@osttra.com") || email.toLowerCase().trim() === "anup.hariharan@osttra.com" || isJohnStewart;
      const hasCostCenter = costCenterValue !== "N/A";

      // Allow Google Directory fallback when Dayforce record (dfRecord) is missing to prevent breaking manager hierarchies
      if (isInAnupOrg && hasCostCenter && (person.empId !== "N/A" || person.title !== "")) {
        // DB CASCADE: Detect Email Address changes and trigger cascading updates
        const empIdStr = String(person.empId).trim();
        const newEmailStr = email.toLowerCase().trim();
        if (empIdStr && empIdStr !== "N/A" && existingIdToEmailMap[empIdStr]) {
          const oldEmailStr = existingIdToEmailMap[empIdStr];
          if (oldEmailStr !== newEmailStr) {
            console.log(`EMAIL CHANGE DETECTED FOR EMP ${empIdStr}: ${oldEmailStr} -> ${newEmailStr}. Invoking DB Cascade...`);
            cascadeEmailUpdate(oldEmailStr, newEmailStr);
          }
        }

        // Dayforce Data Merge (Enrich Google Payload)
        const dfRecordMatched = dfRecord;
        
        let personFirstName = person.firstName;
        let personLastName = person.lastName;
        let personName = person.name;
        const hrName = dfRecordMatched && dfRecordMatched.hrName ? dfRecordMatched.hrName : `${person.firstName || ""} ${person.lastName || ""}`.trim();
        let finalHrName = hrName;

        // Strict Email-Based Preferred Name Overrides (Absolute Concurrency/Safety Safeguard)
        if (email.toLowerCase().trim() === "moiz.khan@osttra.com") {
          personFirstName = "Moiz";
          personName = "Moiz Khan";
          finalHrName = "Moiz Khan";
        }

        const hrStart = dfRecordMatched && dfRecordMatched.hireDate ? String(dfRecordMatched.hireDate).substring(0, 10) : "N/A (Not in HRIS)";
        let hrTerm = dfRecordMatched && dfRecordMatched.termDate ? String(dfRecordMatched.termDate).substring(0, 10) : "Active (No Term Date)";
        let hrStatus = dfRecordMatched ? dfRecordMatched.status : "N/A (Not in HRIS)";
        const hrPay = dfRecordMatched ? dfRecordMatched.payClass : "N/A (Not in HRIS)";
        const hrLegal = dfRecordMatched ? dfRecordMatched.legalEntity : "N/A (Not in HRIS)";
        
        // **NEW: Check Manual Inactive Overrides**
        const emailLower = email.toLowerCase().trim();
        if (manualInactives[emailLower]) {
          hrStatus = "Inactive (Manual Override)";
          hrTerm = "Manually Overridden";
        }
        
        // Let's use HR Start Date as a fallback for standard Start Date to heal both columns!
        const legacyStart = (person.startDate && person.startDate !== "N/A") 
          ? person.startDate 
          : (hrStart !== "N/A (Not in HRIS)" ? hrStart : "N/A");

        // HR Job Role from Dayforce
        const hrJobRole = dfRecordMatched ? (dfRecordMatched.jobTitle || "N/A") : "N/A";
        let extractedProfile = "N/A";
        if (hrJobRole !== "N/A") {
          const underscoreIndex = hrJobRole.indexOf('_');
          if (underscoreIndex !== -1) {
            extractedProfile = hrJobRole.substring(underscoreIndex + 1).trim();
          } else {
            extractedProfile = hrJobRole.trim();
          }
        }

        // Profile mapped from Dayforce Job_ShortName (excluding region), fallback to Google Workspace Directory (Google Chat Title)
        const hrProfile = (extractedProfile !== "N/A" && extractedProfile !== "") ? extractedProfile : (person.title || "N/A");

        // Calculate is_tpm based on whether they roll up to Jack Jeffreys
        const isTpmCalculated = (email.toLowerCase().trim() === 'jack.jeffreys@osttra.com' || chain.some(item => item.email === 'jack.jeffreys@osttra.com')) ? "Yes" : "No";

        // Calculate is_opex based on whether they roll up to Suneet Dhar
        const isOpexCalculated = (email.toLowerCase().trim() === 'suneet.dhar@osttra.com' || chain.some(item => item.email === 'suneet.dhar@osttra.com')) ? "Yes" : "No";

        allRows.push([
          person.empId, 
          personFirstName, 
          personLastName, 
          normalizeName(personName), // Google Chat Full Name (Directory Display Name)
          normalizeName(finalHrName),
          email, 
          person.photoUrl,
          costCenterValue, 
          regionalHead,    
          normalizeName(managerName),     
          managerEmailAddr,
          managerEmpId,
          managementLine, 
          hrProfile, // This maps to "Profile" (derived from Dayforce HR, region-stripped)
          hrJobRole, // This maps to "HR Job Role"
          legacyStart,
          hrStart,
          hrTerm,
          hrStatus,
          hrPay,
          hrLegal,
          isTpmCalculated,
          isOpexCalculated
        ]);
      }
    });

    // Manually inject Nexus Service Account as an employee reporting to damak.k@osttra.com
    allRows.push([
      "ADMIN-999", 
      "Nexus", 
      "Service Account", 
      "System Administrator", 
      "System Administrator", 
      "svc-nexus@osttra.com", 
      "https://ui-avatars.com/api/?name=System+Admin&background=FF0061&color=fff", 
      "N/A", 
      "Anup Hariharan", 
      "Damak Varshney", 
      "damak.k@osttra.com", 
      "N/A", 
      "Anup Hariharan > Jack Jeffreys > Damak Varshney", 
      "Super Admin", 
      "Service Account", 
      "2026-08-10", 
      "2026-08-10", 
      "Active (No Term Date)", 
      "Active", 
      "N/A", 
      "OSTTRA", 
      "Yes", 
      "Yes"
    ]);

    if (allRows.length > 1) {
      // **NEW: Capture previous data for Headcount Trend comparison BEFORE overwriting**
      let previousData = [];
      try {
        previousData = sheet.getDataRange().getValues();
      } catch (e) {
        console.warn("Could not capture previous sheet data for trend logging: " + e.message);
      }

      sheet.clearContents();
      sheet.getRange(1, 1, allRows.length, allRows[0].length).setValues(allRows);
      applyFormatting(sheet);
      
      // Cache Invalidation: Force Auth/Db layers to pull fresh employee data
      try {
        clearSheetCache(targetSheetName);
        console.log("Successfully busted CacheService for employee roster.");
      } catch (cacheErr) {
        console.warn("Failed to clear sheet cache: ", cacheErr);
      }
      
      // Auto-trigger audit run to sync discrepancies
      try {
        console.log("Triggering automated discrepancy audit...");
        auditDayforceVsGoogle();
      } catch (auditErr) {
        console.warn("Automated discrepancy audit failed: ", auditErr);
      }

      // **NEW: Trigger Headcount Trend & Audit Logger**
      try {
        console.log("Generating daily headcount trend log...");
        logDailyHeadcountTrend(ss, previousData, allRows);
      } catch (trendErr) {
        console.error("Headcount Trend Logger failed: ", trendErr);
      }
      
      return "Success";
    } else {
      return "Error: No employees matched the filters (Anup Org + Cost Center).";
    }
  } catch (e) {
    return "Error: " + e.toString();
  }
}

/**
 * HELPER: Directory Fetching
 */
function getCompleteDirectoryMap() {
  const map = {};
  const resourceToEmailMap = {};
  let pageToken = null;
  try {
    do {
      const response = People.People.listDirectoryPeople({
        readMask: 'names,emailAddresses,organizations,locations,relations,externalIds,photos',
        sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
        pageSize: 1000,
        pageToken: pageToken
      });
      if (response.people) {
        response.people.forEach(p => {
          const email = p.emailAddresses?.[0]?.value;
          if (email) {
            const org = p.organizations?.[0] || {};
            const startDateObj = org.startDate || null;
            const startDateString = startDateObj
              ? `${startDateObj.year}-${String(startDateObj.month || 1).padStart(2, '0')}-${String(startDateObj.day || 1).padStart(2, '0')}`
              : "N/A";

            map[email.toLowerCase()] = {
              resourceName: p.resourceName,
              name: p.names?.[0]?.displayName || "",
              firstName: p.names?.[0]?.givenName || "",
              lastName: p.names?.[0]?.familyName || "",
              empId: p.externalIds?.find(id => id.type === 'organization')?.value || "N/A",
              title: org.title || "",
              dept: org.department || "",
              costCenter: org.costCenter || "",
              startDate: startDateString,
              loc: p.locations?.[0]?.value || "",
              managerEmailRaw: p.relations?.find(r => r.type === 'manager')?.person || null,
              photoUrl: p.photos?.[0]?.url || "N/A"
            };

            if (p.resourceName) {
              resourceToEmailMap[p.resourceName] = email.toLowerCase();
            }
          }
        });
      }
      pageToken = response.nextPageToken;
    } while (pageToken);

    // Resolve resourceName to email for managerEmail
    Object.keys(map).forEach(email => {
      const pObj = map[email];
      if (pObj.managerEmailRaw) {
        let rawVal = String(pObj.managerEmailRaw).trim();
        let resolved = null;
        
        // 1. Try exact match in resourceToEmailMap (e.g., 'people/c1234')
        if (resourceToEmailMap[rawVal]) {
          resolved = resourceToEmailMap[rawVal];
        } 
        // 2. Try prefixing with 'people/' just in case
        else if (resourceToEmailMap['people/' + rawVal]) {
          resolved = resourceToEmailMap['people/' + rawVal];
        }
        // 3. Try to see if it's already an email address
        else if (map[rawVal.toLowerCase()]) {
          resolved = rawVal.toLowerCase();
        }

        pObj.managerEmail = resolved || null;
      } else {
        pObj.managerEmail = null;
      }
    });

  } catch (e) {
    console.error("API Error: " + e.message);
    throw new Error("People API Error: " + e.message + ". Please ensure People API is enabled in Google Cloud Console.");
  }
  return map;
}

/**
 * HELPER: Manual Data Maps
 */
function getManualDataMaps(ss) {
  const manualSheet = ss.getSheetByName("Manually Added Data");
  const idMap = {};
  const nameMap = {};
  if (!manualSheet) return {idMap, nameMap};

  const data = manualSheet.getDataRange().getValues();
  const headers = data[0];
  
  const nameIdx = headers.indexOf("Name");
  const empIdIdx = headers.indexOf("Employee ID");
  const roleIdx = headers.indexOf("Role");
  const shortRoleIdx = headers.indexOf("ShortRole");
  const startDateIdx = headers.indexOf("Start Date");

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rowObj = {
      role: row[roleIdx],
      shortRole: row[shortRoleIdx],
      startDate: row[startDateIdx] instanceof Date ? 
                 Utilities.formatDate(row[startDateIdx], ss.getSpreadsheetTimeZone(), "yyyy-MM-dd") : 
                 row[startDateIdx]
    };
    const empId = String(row[empIdIdx]).trim();
    const name = String(row[nameIdx]).toLowerCase().trim();
    if (empId && empId !== "undefined") idMap[empId] = rowObj;
    if (name) nameMap[name] = rowObj;
  }
  return {idMap, nameMap};
}

/**
 * HELPER: Region Mapping
 */
function mapRegion(cc, loc) {
  const searchStr = ( (cc || "") + " " + (loc || "") ).toUpperCase();
  if (searchStr.includes("INDIA") || searchStr.includes("GURUGRAM")) return "India";
  if (searchStr.includes("UK") || searchStr.includes("LONDON")) return "UK";
  if (searchStr.includes("USA") || searchStr.includes("NEW YORK")) return "USA";
  if (searchStr.includes("SWEDEN")) return "Sweden";
  if (searchStr.includes("JAPAN")) return "Japan";
  if (searchStr.includes("MALAYSIA")) return "Malaysia";
  if (searchStr.includes("SINGAPORE")) return "Singapore";
  return "Global Hub";
}

/**
 * HELPER: Formatting
 */
function applyFormatting(sheet) {
  const headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
  headerRange.setBackground("#0d47a1").setFontColor("white").setFontWeight("bold");
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, sheet.getLastColumn());
}

/**
 * DAYFORCE: Fetch authoritative HR metrics from Dayforce HCM report API securely
 */
function fetchDayforceData() {
  const props = PropertiesService.getScriptProperties();
  const user = props.getProperty('DAYFORCE_USER') || "api.clientservices";
  const pass = props.getProperty('DAYFORCE_PASS') || "tR6$mY2!xW9#pQ5*vN";
  
  if (!user || !pass) {
    console.warn("Dayforce Credentials missing from script properties. Returning empty maps.");
    return { byEmail: {}, byEmpId: {} };
  }
  
  const url = "https://wkdeur261.dayforcehcm.com/api/osttrahcm/v1/reports/ClientServ";
  
  const headers = {
    "Authorization": "Basic " + Utilities.base64Encode(user + ":" + pass),
    "Accept": "application/json"
  };
  
  try {
    const response = UrlFetchApp.fetch(url, {
      "method": "get",
      "headers": headers,
      "muteHttpExceptions": true
    });
    
    const code = response.getResponseCode();
    if (code !== 200) {
      console.error(`Dayforce API returned error response code ${code}: ${response.getContentText()}`);
      return { byEmail: {}, byEmpId: {} };
    }
    
    const payload = JSON.parse(response.getContentText());
    const rows = payload.Data?.Rows || [];
    
    const map = {};
    const mapByEmpId = {};
    const mapByName = {}; // Fallback for email-mismatched accounts
    rows.forEach(row => {
      const email = String(row.EmailCheck || "").toLowerCase().trim();
      const empId = String(row.EmployeeEmploymentStatus_EmployeeNumber || "").trim();
      const firstName = String(row.Employee_FirstName || "").trim();
      const lastName = String(row.Employee_LastName || "").trim();
      const rawName = `${firstName} ${lastName}`.trim();
      
      let mgrNameRaw = String(row.EmployeeManager_ManagerDisplayName || "N/A").trim();
      let cleanMgrName = mgrNameRaw;
      if (mgrNameRaw !== "N/A" && mgrNameRaw.includes(",")) {
        const parts = mgrNameRaw.split(",");
        cleanMgrName = `${parts[1].trim()} ${parts[0].trim()}`.trim();
      }

      const record = {
          email: email,
          empId: empId,
          hrName: rawName || null,
          firstName: firstName,
          lastName: lastName,
          hireDate: row.Employee_HireDate || null,
          termDate: row.Employee_TerminationDate || null,
          status: row.EmploymentStatus_ShortName || "Active",
          payClass: row.PayClass_ShortName || "Full time",
          legalEntity: row.DenormOrgUnit_Field999 || "OSTTRA",
          jobTitle: row.Job_ShortName || row.JobTitle || "N/A",
          countryCode: row.GeoCountry_ISO31662Code || "N/A",
          managerEmpId: String(row.EmployeeManager_ManagerEmployeeNumber || "N/A").trim(),
          managerName: cleanMgrName,
          rawRow: row // Attach raw row for dynamic inspection in audits
      };
      
      if (email) map[email] = record;
      if (empId) mapByEmpId[empId] = record;
      
      const sanitizedName = rawName.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (sanitizedName) mapByName[sanitizedName] = record;
    });
    
    console.log(`Successfully fetched and parsed ${Object.keys(map).length} active Dayforce HR records.`);
    return { byEmail: map, byEmpId: mapByEmpId, byName: mapByName };
  } catch(e) {
    console.error("Dayforce API Fetch Failed:", e.message);
    return { byEmail: {}, byEmpId: {} };
  }
}

/**
 * HELPER: Fetch and parse manual inactive overrides based on the active period
 */
function getManualInactiveOverrides(ss) {
  const sheetName = "App Manual Inactives (Read / Write)";
  let sheet = ss.getSheetByName(sheetName);
  const map = {};
  if (!sheet) {
    // Gracefully initialize if sheet doesn't exist
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(["Email Address", "Start Month", "End Month", "Reason", "Added By", "Timestamp"]);
    applyFormatting(sheet);
    return map;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return map;

  const headers = data[0].map(h => String(h || "").trim().toLowerCase());
  const emailIdx = headers.indexOf("email address");
  const startIdx = headers.indexOf("start month");
  const endIdx = headers.indexOf("end month");
  const reasonIdx = headers.indexOf("reason");

  if (emailIdx === -1) return map;

  const currentPeriod = getActivePeriod();

  for (let i = 1; i < data.length; i++) {
    const email = String(data[i][emailIdx]).toLowerCase().trim();
    if (!email) continue;

    const startMonth = String(data[i][startIdx] || "").trim();
    const endMonth = String(data[i][endIdx] || "").trim();

    let isInactiveNow = false;
    if (!startMonth && !endMonth) {
      isInactiveNow = true; // Indefinite exclusion
    } else {
      isInactiveNow = isPeriodInOverrideRange(currentPeriod, startMonth, endMonth);
    }

    if (isInactiveNow) {
      map[email] = {
        startMonth: startMonth,
        endMonth: endMonth,
        reason: reasonIdx !== -1 ? String(data[i][reasonIdx] || "").trim() : "No reason provided"
      };
    }
  }
  return map;
}

/**
 * HELPER: Checks if the current active period falls chronologically within a start/end month override range.
 * Period format: "Month Year" (e.g. "February 2026")
 */
function isPeriodInOverrideRange(currentPeriod, startMonth, endMonth) {
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  
  const parsePeriod = (p) => {
    if (!p) return null;
    const parts = p.trim().toLowerCase().split(/\s+/);
    if (parts.length < 2) return null;
    const mIdx = months.indexOf(parts[0]);
    const y = parseInt(parts[1], 10);
    if (mIdx === -1 || isNaN(y)) return null;
    return new Date(y, mIdx, 1);
  };

  const current = parsePeriod(currentPeriod);
  if (!current) return false;

  const start = parsePeriod(startMonth);
  const end = parsePeriod(endMonth);

  if (start && current < start) return false;
  if (end && current > end) return false;

  return true;
}

/**
 * NEW: Daily Headcount Trend & Audit Logger
 * Resolves API "glitches" by recording state transitions (Joiners, Leavers, Reactivations)
 * and plotting daily numerical trends to a ledger sheet.
 */
function logDailyHeadcountTrend(ss, previousData, newRows) {
  try {
    const trendSheetName = "App Headcount Trend (Read / Write)";
    const auditSheetName = "App Headcount Audit (Read / Write)";

    let trendSheet = ss.getSheetByName(trendSheetName);
    const trendHeaders = [
      "Timestamp", "Total Headcount", "Active (Dayforce)", "Inactive (Dayforce)", 
      "Inactive (Manual Override)", "Total Managers", "Total TPM", "Total OPEX", 
      "Joiners (Delta)", "Leavers (Delta)", "Reactivations (Delta)"
    ];
    if (!trendSheet) {
      trendSheet = ss.insertSheet(trendSheetName);
      trendSheet.appendRow(trendHeaders);
      applyFormatting(trendSheet);
    } else {
      // Guardrail: Check if headers were accidentally deleted but data exists
      const lastRow = trendSheet.getLastRow();
      if (lastRow === 0) {
        trendSheet.appendRow(trendHeaders);
      } else {
        const firstRow = trendSheet.getRange(1, 1, 1, trendSheet.getLastColumn()).getValues()[0];
        if (String(firstRow[0] || "").toLowerCase().trim() !== "timestamp") {
          trendSheet.insertRowBefore(1);
          trendSheet.getRange(1, 1, 1, trendHeaders.length).setValues([trendHeaders]);
          applyFormatting(trendSheet);
        }
      }
    }

    let auditSheet = ss.getSheetByName(auditSheetName);
    const auditHeaders = [
      "Timestamp", "Event Type", "Email Address", "Name", 
      "Previous Status", "New Status", "Notes"
    ];
    if (!auditSheet) {
      auditSheet = ss.insertSheet(auditSheetName);
      auditSheet.appendRow(auditHeaders);
      applyFormatting(auditSheet);
    } else {
      // Guardrail: Check if headers were accidentally deleted but data exists
      const lastRow = auditSheet.getLastRow();
      if (lastRow === 0) {
        auditSheet.appendRow(auditHeaders);
      } else {
        const firstRow = auditSheet.getRange(1, 1, 1, auditSheet.getLastColumn()).getValues()[0];
        if (String(firstRow[0] || "").toLowerCase().trim() !== "timestamp") {
          auditSheet.insertRowBefore(1);
          auditSheet.getRange(1, 1, 1, auditHeaders.length).setValues([auditHeaders]);
          applyFormatting(auditSheet);
        }
      }
    }

    // 1. Process New Data Metrics & Map
    const newMap = {};
    const newHeaders = newRows[0];
    const nEmailIdx = newHeaders.indexOf("Email Address");
    const nNameIdx = newHeaders.indexOf("Google Chat Full Name");
    const nStatusIdx = newHeaders.indexOf("HR Employment Status");
    const nManagerIdx = newHeaders.indexOf("Direct Manager Email");
    const nTpmIdx = newHeaders.indexOf("is_tpm");
    const nOpexIdx = newHeaders.indexOf("is_opex");

    if (nEmailIdx === -1 || nStatusIdx === -1) {
      console.warn("Trend Logger: Missing critical headers in new data.");
      return;
    }

    let activeCount = 0;
    let inactiveCount = 0;
    let overrideCount = 0;
    let tpmCount = 0;
    let opexCount = 0;
    const managersSet = new Set();

    for (let i = 1; i < newRows.length; i++) {
      const row = newRows[i];
      const email = String(row[nEmailIdx]).toLowerCase().trim();
      if (!email) continue;
      
      const status = String(row[nStatusIdx] || "");
      const name = String(row[nNameIdx] || email);
      const isTpm = String(row[nTpmIdx] || "No");
      const isOpex = String(row[nOpexIdx] || "No");
      const managerEmail = String(row[nManagerIdx] || "").trim();

      newMap[email] = { status: status, name: name };

      if (status.includes("Manual Override")) {
        overrideCount++;
      } else if (status.toLowerCase().includes("active") || status === "N/A (Not in HRIS)") {
        activeCount++;
      } else {
        inactiveCount++;
      }

      if (isTpm === "Yes") tpmCount++;
      if (isOpex === "Yes") opexCount++;
      if (managerEmail && managerEmail !== "N/A") managersSet.add(managerEmail.toLowerCase());
    }

    // 2. Process Previous Data Map
    const oldMap = {};
    if (previousData && previousData.length > 1) {
      const oldHeaders = previousData[0];
      const oEmailIdx = oldHeaders.indexOf("Email Address");
      const oStatusIdx = oldHeaders.indexOf("HR Employment Status");
      
      if (oEmailIdx !== -1 && oStatusIdx !== -1) {
        for (let i = 1; i < previousData.length; i++) {
          const row = previousData[i];
          const email = String(row[oEmailIdx]).toLowerCase().trim();
          if (email) {
            oldMap[email] = { status: String(row[oStatusIdx] || "") };
          }
        }
      }
    }

    // 3. Delta Calculation & Audit Logging
    const timestamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "yyyy-MM-dd HH:mm:ss");
    const auditLogs = [];
    let joiners = 0;
    let leavers = 0;
    let reactivations = 0;

    const isActive = (stat) => stat.toLowerCase().includes("active") || stat === "N/A (Not in HRIS)";
    const isOverride = (stat) => stat.includes("Manual Override");

    // Check for Joiners, Reactivations, and Active -> Inactive
    Object.keys(newMap).forEach(email => {
      const newStat = newMap[email].status;
      const newName = newMap[email].name;

      if (!oldMap[email]) {
        // JOINER
        joiners++;
        auditLogs.push([timestamp, "JOINER", email, newName, "N/A", newStat, "Added to Master Roster"]);
      } else {
        // STATUS CHANGE
        const oldStat = oldMap[email].status;
        if (oldStat !== newStat) {
          const wasActive = isActive(oldStat);
          const isNowActive = isActive(newStat);
          const wasOverride = isOverride(oldStat);
          const isNowOverride = isOverride(newStat);

          if (!wasActive && isNowActive) {
            reactivations++;
            auditLogs.push([timestamp, "REACTIVATION", email, newName, oldStat, newStat, "Employee returned to Active status"]);
          } else if (wasActive && !isNowActive) {
            leavers++;
            auditLogs.push([timestamp, "LEAVER", email, newName, oldStat, newStat, isNowOverride ? "Manually overridden to Inactive" : "Dayforce status changed to Inactive"]);
          } else if (wasOverride && isNowActive) {
            reactivations++;
            auditLogs.push([timestamp, "REACTIVATION", email, newName, oldStat, newStat, "Manual Override removed, returning to Active"]);
          } else {
            // General data change (e.g. Terminated -> Leave of Absence)
            auditLogs.push([timestamp, "DATA_CHANGE", email, newName, oldStat, newStat, "Non-critical status transition"]);
          }
        }
      }
    });

    // Check for Leavers (Dropped off API completely)
    Object.keys(oldMap).forEach(email => {
      if (!newMap[email]) {
        leavers++;
        auditLogs.push([timestamp, "LEAVER (DROPPED)", email, email, oldMap[email].status, "N/A", "Dropped out of Anup Org/API payload completely"]);
      }
    });

    // 4. Write to Sheets
    if (auditLogs.length > 0) {
      auditSheet.getRange(auditSheet.getLastRow() + 1, 1, auditLogs.length, auditLogs[0].length).setValues(auditLogs);
    }

    const totalHeadcount = newRows.length - 1;
    const trendRow = [
      timestamp, totalHeadcount, activeCount, inactiveCount, overrideCount, 
      managersSet.size, tpmCount, opexCount, joiners, leavers, reactivations
    ];
    trendSheet.appendRow(trendRow);
    
    console.log('Headcount Trend logged. Total: ' + totalHeadcount + '. Joiners: ' + joiners + ', Leavers: ' + leavers + ', Reactivations: ' + reactivations + '.');

  } catch (err) {
    console.error("Error in logDailyHeadcountTrend: " + err.message);
  }
}
