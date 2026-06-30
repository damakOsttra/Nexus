/**
 * src/Db.js
 * Database operations, BigQuery integration, and data aggregation logic.
 */

/**
 * Global Utility: Force date objects to explicit strings before writing back to prevent Google Sheets format-loss.
 */
function createSafeRowForDatabase(row, tz, periodIdxAlloc) {
  return row.map((cell, idx) => {
    if (periodIdxAlloc !== undefined && idx === periodIdxAlloc) {
      if (cell instanceof Date) {
        return "'" + Utilities.formatDate(cell, tz, "MMMM yyyy");
      }
      const cellStr = String(cell || "").trim();
      return cellStr !== "" && !cellStr.startsWith("'") ? "'" + cellStr : cellStr;
    }
    if (cell instanceof Date) {
      return Utilities.formatDate(cell, tz, "dd/MM/yyyy HH:mm:ss");
    }
    return cell;
  });
}

/**
 * CACHE UTILITY: Puts data into ScriptCache with chunking to handle sizes > 100KB.
 */
function putCachedData(key, data, expirationSeconds) {
  try {
    const cache = CacheService.getScriptCache();
    const jsonStr = JSON.stringify(data);
    const chunkSize = 90 * 1024; // ~90KB chunk size (safely below 100KB limit)
    
    // Clear any previous cached data of this key to avoid leftovers
    clearCachedData(key);
    
    const chunksCount = Math.ceil(jsonStr.length / chunkSize);
    
    // Store metadata index
    cache.put("CACHE_META_" + key, String(chunksCount), expirationSeconds || 300);
    
    // Store chunks
    for (let i = 0; i < chunksCount; i++) {
      const chunk = jsonStr.substring(i * chunkSize, (i + 1) * chunkSize);
      cache.put("CACHE_CHUNK_" + key + "_" + i, chunk, expirationSeconds || 300);
    }
  } catch (e) {
    console.warn("Put Cache failed silently for key: " + key + " Error: " + e.message);
  }
}

/**
 * CACHE UTILITY: Retrieves chunked data from ScriptCache and reconstructs it.
 */
function getCachedData(key) {
  try {
    const cache = CacheService.getScriptCache();
    const metaVal = cache.get("CACHE_META_" + key);
    if (!metaVal) return null;
    
    const chunksCount = parseInt(metaVal, 10);
    let jsonStr = "";
    
    for (let i = 0; i < chunksCount; i++) {
      const chunk = cache.get("CACHE_CHUNK_" + key + "_" + i);
      if (!chunk) return null; // If any chunk is evicted, consider cache miss
      jsonStr += chunk;
    }
    
    return JSON.parse(jsonStr);
  } catch (e) {
    console.warn("Get Cache failed silently for key: " + key + " Error: " + e.message);
    return null;
  }
}

/**
 * CACHE UTILITY: Removes chunked metadata and chunk keys from cache.
 */
function clearCachedData(key) {
  try {
    const cache = CacheService.getScriptCache();
    const metaVal = cache.get("CACHE_META_" + key);
    if (metaVal) {
      const chunksCount = parseInt(metaVal, 10);
      cache.remove("CACHE_META_" + key);
      for (let i = 0; i < chunksCount; i++) {
        cache.remove("CACHE_CHUNK_" + key + "_" + i);
      }
    }
  } catch (e) {
    console.warn("Clear Cache failed silently for key: " + key + " Error: " + e.message);
  }
}

/**
 * CACHE UTILITY: Specific shorthand to clear sheet reads cache.
 */
function clearSheetCache(sheetName) {
  clearCachedData("SHEET_" + sheetName);
}

/**
 * Utility: Fetches sheet data as an array of objects with chunked ScriptCache caching.
 */
function getSheetData(sheetName) {
  const cacheKey = "SHEET_" + sheetName;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  
  const data = sheet.getDataRange().getValues();
  if (data.length < 1) return [];
  
  // Clean headers: trim and remove newlines
  const rawHeaders = data.shift();
  const headers = rawHeaders.map(h => String(h || "").trim());
  
  const parsedData = data.map(row => {
    const obj = {};
    headers.forEach((header, i) => {
      if (!header) return;
      let val = row[i];
      // Convert all values to strings/numbers consistently if needed, 
      // but primarily preserve original for date/number handling.
      if (val instanceof Date && (header === "Month and Year" || header === "Period")) {
        val = Utilities.formatDate(val, tz, "MMMM yyyy");
      }
      if (typeof val === 'string') val = val.trim();
      obj[header] = val;
    });
    return obj;
  });

  // Put into cache for 5 minutes (300 seconds)
  putCachedData(cacheKey, parsedData, 300);

  return parsedData;
}

/**
 * DB UTILITY: Runs a database-modifying work function inside an exclusive write lock.
 * Prevents concurrent writes, mitigates "Lost Update" race conditions, and forces SpreadsheetApp flush.
 */
function runWithWriteLock(workFunction) {
  const lock = LockService.getScriptLock();
  try {
    const gotLock = lock.tryLock(30000);
    if (!gotLock) {
      throw new Error("The database is currently busy. Please wait a moment and try again.");
    }
    const result = workFunction();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Admin Utility: Overwrites a specific sheet with a new 2D array.
 */
function updateSheetData(sheetName, data2D) {
  validateTier(3); // Admin Only
  return runWithWriteLock(() => {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) throw new Error("Target sheet not found.");
    
    sheet.clearContents();
    sheet.getRange(1, 1, data2D.length, data2D[0].length).setValues(data2D);
    return true;
  });
}

/**
 * BIGQUERY UTILITY: Executes a SQL query and returns rows as objects.
 * Handles the mapping from BigQuery nested arrays to clean JSON.
 */
function executeBQQuery(sql) {
  try {
    const request = {
      query: sql,
      useLegacySql: false
    };
    
    const queryResults = BigQuery.Jobs.query(request, CONFIG.BQ.PROJECT_ID);
    const jobId = queryResults.jobReference.jobId;

    // Check on status of the Query Job
    let sleepTime = 500;
    while (!queryResults.jobComplete) {
      Utilities.sleep(sleepTime);
      sleepTime *= 2;
      queryResults = BigQuery.Jobs.getQueryResults(CONFIG.BQ.PROJECT_ID, jobId);
    }

    const rows = queryResults.rows;
    if (!rows) return [];

    const fields = queryResults.schema.fields;
    return rows.map(row => {
      const obj = {};
      row.f.forEach((cell, i) => {
        obj[fields[i].name] = cell.v;
      });
      return obj;
    });

  } catch (error) {
    console.error("BigQuery Error:", error.message);
    return null; // Return null to trigger fallback logic
  }
}

/**
 * PHASE 2.1: Fetch Historical Allocation
 */
function getHistoricalAllocation(email) {
  validateTier(1);
  const data = getSheetData(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
  const results = data.filter(r => String(r["Email Address"]).toLowerCase().trim() === String(email).toLowerCase().trim())
    .map(latest => {
      const bauVal = latest["Allocation BAU"] !== undefined ? latest["Allocation BAU"] : latest["BAU (%)"];
      const nbauVal = latest["Allocation Non-BAU"] !== undefined ? latest["Allocation Non-BAU"] : latest["Non-BAU (%)"];
      
      const rawPeriod = latest["Month and Year"] !== undefined ? latest["Month and Year"] : latest["Period"];
      const periodVal = String(rawPeriod || "Previous").trim();
      
      const commentVal = latest["Allocation Comment"] !== undefined ? latest["Allocation Comment"] : latest["Comment"];
      const lastUpdatedByVal = latest["Last Updated By"] || "";
      
      let subTime = latest["Date and time of Submission"] || latest["Date of Submission"] || "";
      if (subTime instanceof Date) {
        subTime = subTime.toISOString();
      } else {
        subTime = String(subTime);
      }
      
      return {
        bau: parseFloat(bauVal) || 0,
        nbau: parseFloat(nbauVal) || 0,
        period: periodVal,
        product: latest["Product"] || "",
        subProduct: latest["Sub-Product"] || "",
        comment: commentVal || "",
        lastUpdatedBy: lastUpdatedByVal,
        submissionTimestamp: subTime,
        standardWeekdays: parseInt(latest["Standard Weekdays in Month"]) || 0,
        regularDays: parseInt(latest["Regular Days Worked"]) || 0,
        workedWeekend: (latest["Worked Weekend"] === true || latest["Worked Weekend"] === "TRUE" || latest["Worked Weekend"] === "true"),
        weekendDays: parseFloat(latest["Weekend Days Worked"]) || 0,
        workingDaysComment: latest["Comments"] || ""
      };
    });
  return JSON.parse(JSON.stringify(results));
}

/**
 * PHASE 2.1: Fetch Skill Matrix
 */
function getSkillMatrix(email) {
  validateTier(1);
  const data = getSheetData(CONFIG.SHEETS.SKILL_MATRIX);
  const results = data.filter(r => String(r["Email Address"]).toLowerCase().trim() === String(email).toLowerCase().trim())
    .map(r => {
      let lastUpdated = r["Date and time of Submission"] || "";
      if (lastUpdated instanceof Date) {
        lastUpdated = lastUpdated.toISOString();
      } else {
        lastUpdated = String(lastUpdated);
      }
      return {
        product: r["Product"] || "",
        subProduct: r["Sub-Product"] || "",
        skill: r["Skill Level"] || 0,
        lastUpdated: lastUpdated
      };
    });
  return JSON.parse(JSON.stringify(results));
}

/**
 * PHASE 2.1: Fetch Employee Mapped Products & Skill Ratings Combined
 * Fetches the products assigned to the employee in MANAGER_PRODUCT_ALLOCATION
 * and merges them with any ratings they currently have in SKILL_MATRIX.
 */
function getEmployeeProductSkills(email) {
  validateTier(1);
  const scope = getManagerProductAllocation(email); // [{ product, subProduct }]
  const skills = getSkillMatrix(email); // [{ product, subProduct, skill }]
  
  const combinedMap = {};
  
  // 1. Add all from Allocation Scope (baseline)
  scope.forEach(item => {
    const key = `${item.product.toLowerCase().trim()}|${(item.subProduct || "general").toLowerCase().trim()}`;
    combinedMap[key] = {
      product: item.product,
      subProduct: item.subProduct || "General",
      skill: "N/A"
    };
  });

  // 2. Overlay / Add from Skills Matrix (Deduplicated Union)
  skills.forEach(s => {
    const key = `${s.product.toLowerCase().trim()}|${(s.subProduct || "general").toLowerCase().trim()}`;
    if (combinedMap[key]) {
      combinedMap[key].skill = s.skill || "N/A"; // Overlay rating if active in scope
    } else {
      // Add extra skill outside of allocation scope (Unlimited Skills rule)
      combinedMap[key] = {
        product: s.product,
        subProduct: s.subProduct || "General",
        skill: s.skill || "N/A"
      };
    }
  });
  
  return JSON.parse(JSON.stringify(Object.values(combinedMap)));
}

/**
 * PHASE 3: Fetch Skill Gap Data
 */
function getSkillGapData(email) {
  validateTier(1);
  const data = getSheetData(CONFIG.SHEETS.SKILL_MATRIX);
  const payload = data.filter(r => String(r["Email Address"]).toLowerCase().trim() === String(email).toLowerCase().trim())
    .map(r => {
      const current = r["Skill Level"] || 0;
      const target = r["Target Skill Level"] || 5;
      return {
        product: r["Product"],
        subProduct: r["Sub-Product"],
        current: current,
        target: target,
        gap: Math.max(0, target - current)
      };
    });
    
  return JSON.parse(JSON.stringify(payload));
}

/**
 * Diagnostic tool to list sheet names.
 */
function getDebugSheetInfo() {
  validateTier(3);
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    return JSON.parse(JSON.stringify(ss.getSheets().map(s => s.getName())));
  } catch (e) {
    return ["Error: " + e.message];
  }
}

/**
 * PHASE 5.1: Automated BAU & Non-BAU Calculation
 * Fetches actual productivity data from BigQuery for pre-population.
 * FALLBACK: If BQ fails, returns zeroes to allow manual entry.
 */
function getPrePopulatedData(email) {
  validateTier(1);
  
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const currentPeriod = months[d.getMonth()] + " " + d.getFullYear();
  
  // 1. Define SQL for Productivity (BAU from Salesforce, Non-BAU from Jira)
  const sql = `
    WITH sfdc AS (
      SELECT email, SUM(case_hours) as bau_hours
      FROM \`${CONFIG.BQ.PROJECT_ID}.${CONFIG.BQ.DATASETS.SALESFORCE}\`
      WHERE email = '${email}' AND period = '${currentPeriod}'
      GROUP BY 1
    ),
    jira AS (
      SELECT email, SUM(logged_hours) as nbau_hours
      FROM \`${CONFIG.BQ.PROJECT_ID}.${CONFIG.BQ.DATASETS.JIRA}\`
      WHERE email = '${email}' AND period = '${currentPeriod}'
      GROUP BY 1
    )
    SELECT 
      COALESCE(sfdc.bau_hours, 0) as bau,
      COALESCE(jira.nbau_hours, 0) as nbau
    FROM sfdc 
    FULL OUTER JOIN jira ON sfdc.email = jira.email
  `;

  const results = executeBQQuery(sql);
  
  if (!results || results.length === 0) {
    return { bau: 0, non_bau: 0, mgmt: 0 }; // Fallback
  }

  const data = results[0];
  const totalHours = parseFloat(data.bau) + parseFloat(data.nbau);
  
  // Map raw hours to percentages (Normalizing to 100% productive base)
  if (totalHours === 0) return { bau: 0, non_bau: 0, mgmt: 0 };
  
  return {
    bau: Math.round((data.bau / totalHours) * 100),
    non_bau: Math.round((data.nbau / totalHours) * 100),
    mgmt: 0 // Management is usually manual or fixed
  };
}

/**
 * PHASE 2.1: Product Catalog Fetch
 */
function getProductCatalog() {
  validateTier(1);
  const cacheKey = "product_catalog";
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch(e) {
      console.warn("Failed to parse cached product catalog:", e);
    }
  }

  const data = getSheetData(CONFIG.SHEETS.PRODUCTS);
  const catalog = {};
  data.forEach(row => {
    const p = row["Product"];
    const s = row["Sub-Product"];
    if (!p) return;
    if (!catalog[p]) catalog[p] = [];
    if (s && !catalog[p].includes(s)) catalog[p].push(s);
  });

  try {
    cache.put(cacheKey, JSON.stringify(catalog), 21600); // 6 hours
  } catch(e) {
    console.warn("Failed to cache product catalog:", e);
  }

  return catalog;
}

/**
 * HELPER: Applies global filters to a dataset
 */
function applyGlobalFilters(data, filters, bypassProductFilters) {
  if (!filters) return data;
  return data.filter(row => {
    let match = true;
    if (filters.region && filters.region !== 'All') {
      const rowRegion = String(row["Cost Center"] || row["Region (Normalized)"] || "Global").trim().toLowerCase();
      if (rowRegion !== filters.region.toLowerCase()) match = false;
    }
    if (filters.role && filters.role !== 'All') {
      const rowRole = row["Profile"] || row["Manual Role"] || "Employee";
      if (rowRole !== filters.role) match = false;
    }
    if (filters.manager && filters.manager !== 'All') {
      const rowMgr = String(row["Direct Manager Name"] || "");
      if (rowMgr !== filters.manager) match = false;
    }
    if (!bypassProductFilters) {
      if (filters.product && filters.product !== 'All') {
        const rowProducts = String(row["Products"] || "").toLowerCase();
        if (!rowProducts.includes(filters.product.toLowerCase())) match = false;
      }
      if (filters.subProduct && filters.subProduct !== 'All') {
        const rowSubs = String(row["Sub-Products"] || "").toLowerCase();
        if (!rowSubs.includes(filters.subProduct.toLowerCase())) match = false;
      }
    }
    if (filters.regionalHead && filters.regionalHead !== 'All') {
      const rowHead = String(row["Regional Head/Head of function"] || "");
      if (rowHead !== filters.regionalHead) match = false;
    }
    if (filters.employeeName && filters.employeeName.trim() !== '') {
      const search = filters.employeeName.toLowerCase().trim();
      const rowName = String(row["Google Chat Full Name"] || row["HR Name"] || row["Employee Name"] || "").toLowerCase();
      if (!rowName.includes(search)) match = false;
    }
    return match;
  });
}

/**
 * HELPER: Joins Employees sheet with Manager Product Allocation to enrich with Products & Sub-Products by Email
 */
function enrichEmployeesWithProducts(data) {
  const allocations = getSheetData(CONFIG.SHEETS.MANAGER_PRODUCT_ALLOCATION);
  const allocMap = {};
  
  allocations.forEach(row => {
    const email = String(row["Email Address"] || row["Email"] || row["Corporate Email"] || row["Primary Email"] || "").toLowerCase().trim();
    if (!email) return;
    if (!allocMap[email]) {
      allocMap[email] = { products: new Set(), subProducts: new Set() };
    }
    const p = String(row["Product"] || "").trim();
    const s = String(row["Sub-Product"] || "").trim();
    if (p && p !== "N/A" && p !== "") allocMap[email].products.add(p);
    if (s && s !== "N/A" && s !== "") allocMap[email].subProducts.add(s);
  });

  return data.map(emp => {
    const email = String(emp["Email Address"] || emp["Email"] || emp["Corporate Email"] || emp["Primary Email"] || "").toLowerCase().trim();
    if (email && allocMap[email]) {
      const pArr = Array.from(allocMap[email].products);
      const sArr = Array.from(allocMap[email].subProducts);
      if (pArr.length > 0) emp["Products"] = pArr.join(", ");
      if (sArr.length > 0) emp["Sub-Products"] = sArr.join(", ");
    }
    return emp;
  });
}

/**
 * Fetches unique filter options
 */
function getFilterMetadata() {
  validateTier(1);
  const cacheKey = "filter_metadata_v4";
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch(e) {
      console.warn("Failed to parse cached filter metadata:", e);
    }
  }

  let data = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  data = enrichEmployeesWithProducts(data);
  
  const regionsMap = new Map(); // lowercase -> original
  const rolesMap = new Map();
  const managersMap = new Map();
  const headsMap = new Map();
  const productsSet = new Set();
  const subsSet = new Set();

  data.forEach(emp => {
    if (emp["Cost Center"]) {
      const cc = String(emp["Cost Center"]).trim();
      const key = cc.toLowerCase();
      if (!regionsMap.has(key)) regionsMap.set(key, cc);
    }
    if (emp["Profile"]) {
      const role = String(emp["Profile"]).trim();
      const key = role.toLowerCase();
      if (!rolesMap.has(key)) rolesMap.set(key, role);
    }
    if (emp["Direct Manager Name"]) {
      const mgr = String(emp["Direct Manager Name"]).trim();
      const key = mgr.toLowerCase();
      if (mgr && mgr !== "N/A" && mgr !== "Unknown") {
        if (!managersMap.has(key)) managersMap.set(key, mgr);
      }
    }
    if (emp["Regional Head/Head of function"]) {
      const head = String(emp["Regional Head/Head of function"]).trim();
      const key = head.toLowerCase();
      if (head && head !== "N/A" && head !== "Unknown") {
        if (!headsMap.has(key)) headsMap.set(key, head);
      }
    }
    if (emp["Products"]) {
      String(emp["Products"]).split(",").forEach(p => {
        const product = p.trim();
        if (product && product !== "N/A") productsSet.add(product);
      });
    }
    if (emp["Sub-Products"]) {
      String(emp["Sub-Products"]).split(",").forEach(s => {
        const sub = s.trim();
        if (sub && sub !== "N/A") subsSet.add(sub);
      });
    }
  });

  const metadata = {
    regions: ['All', ...Array.from(regionsMap.values()).sort()],
    roles: ['All', ...Array.from(rolesMap.values()).sort()],
    managers: ['All', ...Array.from(managersMap.values()).sort()],
    heads: ['All', ...Array.from(headsMap.values()).sort()],
    products: ['All', ...Array.from(productsSet).sort()],
    subProducts: ['All', ...Array.from(subsSet).sort()]
  };

  try {
    cache.put(cacheKey, JSON.stringify(metadata), 21600); // 6 hours
  } catch(e) {
    console.warn("Failed to cache filter metadata:", e);
  }

  return metadata;
}

/**
 * PHASE 4: Global Headcount Aggregation
 */
function getGlobalHeadcountData(filters) {
  validateTier(1);
  let data = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  data = enrichEmployeesWithProducts(data);
  data = applyGlobalFilters(data, filters);
  
  const getEmail = (row) => String(row["Email Address"] || row["Email"] || row["Corporate Email"] || row["Primary Email"] || "").toLowerCase().trim();

  if (filters && filters.period && filters.period !== 'All') {
    const historicalAlloc = getSheetData(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const tz = ss.getSpreadsheetTimeZone();
    const activeEmailsInPeriod = new Set(
      historicalAlloc
        .filter(row => {
          const rawP = row["Month and Year"] !== undefined ? row["Month and Year"] : row["Period"];
          const rowPeriod = (rawP instanceof Date) ? Utilities.formatDate(rawP, tz, "MMMM yyyy") : String(rawP || "");
          return rowPeriod.toLowerCase().trim() === filters.period.toLowerCase().trim();
        })
        .map(row => String(row["Email Address"] || row["Email"] || row["Corporate Email"] || row["Primary Email"] || "").toLowerCase().trim())
    );
    data = data.filter(emp => activeEmailsInPeriod.has(getEmail(emp)));
  }
  
  const ccMap = {}; // lowercase -> { count, label }
  const headMap = {}; // lowercase -> { count, label }
  const managerMap = {}; // lowercase -> { count, label }
  const roleCountMap = {}; // role -> count

  data.forEach(emp => {
    if (!getEmail(emp)) return;

    const rawCc = String(emp["Cost Center"] || "Unknown").trim();
    const ccKey = rawCc.toLowerCase();
    if (!ccMap[ccKey]) ccMap[ccKey] = { count: 0, label: rawCc };
    ccMap[ccKey].count++;

    const rawHead = String(emp["Regional Head/Head of function"] || "Unknown").trim();
    const headKey = rawHead.toLowerCase();
    if (!headMap[headKey]) headMap[headKey] = { count: 0, label: rawHead };
    headMap[headKey].count++;

    const rawMgr = String(emp["Direct Manager Name"] || "Unknown").trim();
    const mgrKey = rawMgr.toLowerCase();
    if (!managerMap[mgrKey]) managerMap[mgrKey] = { count: 0, label: rawMgr };
    managerMap[mgrKey].count++;

    const rawRole = String(emp["Profile"] || "Employee").trim();
    if (rawRole) {
      roleCountMap[rawRole] = (roleCountMap[rawRole] || 0) + 1;
    }
  });

  const sortedManagers = Object.values(managerMap).sort((a, b) => b.count - a.count);

  return {
    totalHeadcount: data.filter(e => getEmail(e)).length,
    regionalHeadsCount: Object.keys(headMap).filter(h => h !== "unknown").length,
    costCentersCount: Object.keys(ccMap).filter(c => c !== "unknown").length,
    ccDistribution: { 
      labels: Object.values(ccMap).map(v => v.label), 
      values: Object.values(ccMap).map(v => v.count) 
    },
    headBreakdown: { 
      labels: Object.values(headMap).map(v => v.label), 
      values: Object.values(headMap).map(v => v.count) 
    },
    managerDistribution: {
      labels: sortedManagers.map(v => v.label),
      values: sortedManagers.map(v => v.count)
    },
    roleDistribution: {
      labels: Object.keys(roleCountMap),
      values: Object.values(roleCountMap)
    },
    employees: data.filter(e => getEmail(e)).map(e => ({
      name: (e["Google Chat Full Name"] || e["HR Name"] || e["Employee Name"] || e["Name"] || `${e["First Name"] || ""} ${e["Last Name"] || ""}`).trim(),
      email: getEmail(e),
      role: e["Profile"] || "Employee",
      costCenter: e["Cost Center"] || "Global",
      headOfFunction: e["Regional Head/Head of function"] || "N/A",
      directManager: e["Direct Manager Name"] || "N/A",
      directManagerEmail: e["Direct Manager Email"] ? String(e["Direct Manager Email"]).toLowerCase().trim() : ""
    }))
  };
}

/**
 * PHASE 2.1: Save User Allocation
 */
/**
 * PHASE 2.1: Save User Allocation
 * Saves granular, product-specific records to the Historical/Allocation database sheet,
 * and updates the aggregated total to the Master Employee Roster for dashboard compatibility.
 */
function saveUserAllocation(payload) {
  return runWithWriteLock(() => {
    const session = validateTier(1);
    
    // Validate period format (must be "Month YYYY", e.g., "May 2026")
    const validPeriodRegex = /^[A-Za-z]+ \d{4}$/;
    if (!payload || !payload.period || !validPeriodRegex.test(String(payload.period).trim())) {
      throw new Error("Critical Database Guardrail: Cannot save allocation. The period must be in a valid format (e.g. 'May 2026').");
    }
    
    // Enforce 3-State Master Switch Business Rules
    const state = getSystemConfig()["PHASE_1_STATE"] || "1";
    if (state === "3") {
      throw new Error("Submission failed: The Allocation module is currently under maintenance.");
    }
    if (state === "2" && session.tier < 3) {
      throw new Error("Submission failed: The Allocation module has been closed and locked by an Administrator.");
    }

    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const tz = ss.getSpreadsheetTimeZone();
    
    // 1. SAVE GRANULAR RECORDS TO ALLOCATION HISTORICAL SHEET
    const allocSheet = ss.getSheetByName(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
    if (!allocSheet) throw new Error("Allocation Historical sheet not found.");
    
    const allocData = allocSheet.getDataRange().getValues();
    const allocHeaders = allocData[0].map(h => String(h || "").trim());
    
    const emailIdxAlloc = allocHeaders.indexOf("Email Address");
    let periodIdxAlloc = allocHeaders.indexOf("Month and Year");
    if (periodIdxAlloc === -1) {
      periodIdxAlloc = allocHeaders.indexOf("Period");
    }
    
    if (emailIdxAlloc === -1 || periodIdxAlloc === -1) {
      throw new Error("Required columns ('Email Address', 'Month and Year' or 'Period') not found in Allocation sheet.");
    }
    
    // Verify optimistic concurrency if lastKnownTimestamp is provided
    if (payload.lastKnownTimestamp !== undefined) {
      let currentDatabaseTimestamp = "";
      for (let i = 1; i < allocData.length; i++) {
        const row = allocData[i];
        const rowEmail = String(row[emailIdxAlloc]).toLowerCase().trim();
        const rawP = row[periodIdxAlloc];
        const rowPeriod = (rawP instanceof Date) ? Utilities.formatDate(rawP, tz, "MMMM yyyy") : String(rawP);
        
        if (rowEmail === payload.email.toLowerCase().trim() && 
            rowPeriod.toLowerCase().trim() === payload.period.toLowerCase().trim()) {
          const dateIdx = allocHeaders.indexOf("Date and time of Submission") !== -1 
            ? allocHeaders.indexOf("Date and time of Submission") 
            : allocHeaders.indexOf("Date of Submission");
          if (dateIdx !== -1 && row[dateIdx]) {
            const dbVal = row[dateIdx];
            const dbTimeStr = (dbVal instanceof Date) ? dbVal.toISOString() : String(dbVal);
            if (!currentDatabaseTimestamp || dbTimeStr > currentDatabaseTimestamp) {
              currentDatabaseTimestamp = dbTimeStr;
            }
          }
        }
      }
      
      if (currentDatabaseTimestamp && currentDatabaseTimestamp !== payload.lastKnownTimestamp) {
        throw new Error("STALE_DATA_ERROR: This allocation has been updated by another user (possibly your manager) since you loaded the page. Please refresh to load the latest values.");
      }
    }
    
    // Remove existing entries for this user and period to prevent duplicates on resubmission
    const filteredRows = [allocHeaders];
    for (let i = 1; i < allocData.length; i++) {
      const row = allocData[i];
      const rowEmail = String(row[emailIdxAlloc]).toLowerCase().trim();
      
      const rawP = row[periodIdxAlloc];
      const rowPeriod = (rawP instanceof Date) ? Utilities.formatDate(rawP, tz, "MMMM yyyy") : String(rawP);
      
      const matchesCurrent = (rowEmail === payload.email.toLowerCase().trim() && 
                              rowPeriod.toLowerCase().trim() === payload.period.toLowerCase().trim());
      if (!matchesCurrent) {
        filteredRows.push(createSafeRowForDatabase(row, tz, periodIdxAlloc));
      }
    }
    
    // Map payload allocations into the new rows
    payload.allocations.forEach(alloc => {
      const rowValues = allocHeaders.map(h => {
        switch(h.toLowerCase()) {
          case "email address": return payload.email;
          case "month and year": 
          case "period": return "'" + payload.period;
          case "allocation bau":
          case "bau (%)": return parseFloat(alloc.bau) || 0;
          case "allocation non-bau":
          case "non-bau (%)": return parseFloat(alloc.nbau) || 0;
          case "total fte (%)": return (parseFloat(alloc.bau) || 0) + (parseFloat(alloc.nbau) || 0);
          case "allocation comment": return alloc.comment || "";
          case "product": return alloc.product || "";
          case "sub-product": return alloc.subProduct || "";
          case "last updated by": return session.realEmail || session.email;
          case "date and time of submission":
          case "date of submission": return Utilities.formatDate(new Date(), tz, "dd/MM/yyyy HH:mm:ss");
          case "standard weekdays in month": return payload.workingDays ? parseInt(payload.workingDays.standardWeekdays) || 0 : 0;
          case "regular days worked": return payload.workingDays ? parseInt(payload.workingDays.regularDays) || 0 : 0;
          case "worked weekend": return payload.workingDays ? (payload.workingDays.workedWeekend === true || payload.workingDays.workedWeekend === "true") : false;
          case "weekend days worked": return payload.workingDays ? parseFloat(payload.workingDays.weekendDays) || 0 : 0;
          case "comments": return payload.workingDays ? payload.workingDays.comment || "" : "";
          default: return "";
        }
      });
      filteredRows.push(rowValues);
    });
    
    // Overwrite Allocation Historical Sheet
    allocSheet.clearContents();
    allocSheet.getRange(1, 1, filteredRows.length, filteredRows[0].length).setValues(filteredRows);
    
    // 2. UPDATE AGGREGATED SUMMARY TO MASTER EMPLOYEES SHEET FOR DASHBOARD COMPATIBILITY
    const empSheet = ss.getSheetByName(CONFIG.SHEETS.EMPLOYEES);
    if (empSheet) {
      const empData = empSheet.getDataRange().getValues();
      const empHeaders = empData[0];
      const emailIdxEmp = empHeaders.indexOf("Email Address");
      
      if (emailIdxEmp !== -1) {
        let empRowIndex = -1;
        for (let i = 1; i < empData.length; i++) {
          if (String(empData[i][emailIdxEmp]).toLowerCase().trim() === payload.email.toLowerCase().trim()) {
            empRowIndex = i + 1;
            break;
          }
        }
        
        if (empRowIndex !== -1) {
          // Calculate totals across all allocated products
          let totalBau = 0;
          let totalNbau = 0;
          const productsList = [];
          const subProductsList = [];
          let combinedComment = [];
          
          payload.allocations.forEach(alloc => {
            totalBau += parseFloat(alloc.bau) || 0;
            totalNbau += parseFloat(alloc.nbau) || 0;
            if (alloc.product && !productsList.includes(alloc.product)) productsList.push(alloc.product);
            if (alloc.subProduct && !subProductsList.includes(alloc.subProduct)) subProductsList.push(alloc.subProduct);
            if (alloc.comment) combinedComment.push(`${alloc.product}: ${alloc.comment}`);
          });
          
          const totalFte = totalBau + totalNbau;
          
          const updatedRow = empHeaders.map(h => {
            switch(h) {
              case "Email Address": return payload.email;
              case "BAU (%)": return totalBau;
              case "Non-BAU (%)": return totalNbau;
              case "Total FTE (%)": return totalFte;
              case "Allocation Comment": return combinedComment.join(" | ");
              case "Products": return productsList.join(", ");
              case "Sub-Products": return subProductsList.join(", ");
              case "Last Updated": return new Date();
              default: return empData[empRowIndex-1][empHeaders.indexOf(h)];
            }
          });
          
          empSheet.getRange(empRowIndex, 1, 1, updatedRow.length).setValues([updatedRow]);
        }
      }
    }
    
    // Bust user profile cache and sheet caches to reflect newly saved allocations
    clearUserProfileCache(payload.email);
    clearSheetCache(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
    clearSheetCache(CONFIG.SHEETS.EMPLOYEES);
    
    // Log telemetry event for adoption tracking (Project Nexus)
    try {
      let totalBau = 0; let totalNbau = 0; let totalMgmt = 0;
      payload.allocations.forEach(alloc => {
        totalBau += parseFloat(alloc.bau) || 0;
        totalNbau += parseFloat(alloc.nbau) || 0;
        totalMgmt += parseFloat(alloc.mgmt) || 0;
      });
      const totalFte = totalBau + totalNbau + totalMgmt;
      logBackendTelemetry(
        "ALLOCATION_SUBMITTED", 
        CONFIG.SHEETS.ALLOCATION_HISTORICAL, 
        `Period: ${payload.period} | Total FTE: ${totalFte}%`,
        payload.email
      );
    } catch (e) {
      console.warn("Failed to log ALLOCATION_SUBMITTED telemetry event:", e.message);
    }
    
    return true;
  });
}

/**
 * PHASE 2.3: Finance Export Aggregation
 */
function getFinanceExportData() {
  validateTier(3);
  const data = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  const exportData = [["Employee Name", "Email Address", "Region", "Operational Category", "Finance Classification", "Allocation %"]];
  
  const regionsMap = new Map(); // lowercase -> original

  data.forEach(emp => {
    if (!emp["Email Address"]) return;
    const name = (emp["Google Chat Full Name"] || emp["HR Name"] || `${emp["First Name"] || ""} ${emp["Last Name"] || ""}`).trim();
    
    const rawCc = String(emp["Cost Center"] || "Global").trim();
    const ccKey = rawCc.toLowerCase();
    if (!regionsMap.has(ccKey)) regionsMap.set(ccKey, rawCc);
    const region = regionsMap.get(ccKey);

    if (emp["BAU (%)"] > 0) exportData.push([name, emp["Email Address"], region, "BAU", "Run", emp["BAU (%)"]]);
    if (emp["Non-BAU (%)"] > 0) exportData.push([name, emp["Email Address"], region, "Non-BAU", "Change", emp["Non-BAU (%)"]]);
  });
  
  // Log telemetry for audit (Project Nexus)
  try {
    logBackendTelemetry("FINANCE_REPORT_EXPORTED", "None", `Exported capacity data for ${exportData.length - 1} records`, "SYSTEM");
  } catch (e) {
    console.warn("Failed to log FINANCE_REPORT_EXPORTED telemetry event:", e.message);
  }

  return JSON.parse(JSON.stringify(exportData));
}

/**
 * PHASE 4: Regional Heatmap Aggregation
 */
function getRegionalHeatmapData(filters) {
  const session = validateTier(2);
  if (!session.isExecutiveView) {
    throw new Error("Unauthorized: Executive access required.");
  }

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();

  const employees = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  const allocations = getSheetData(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
  const skillMatrix = getSheetData(CONFIG.SHEETS.SKILL_MATRIX);
  const skillLevels = getSheetData(CONFIG.SHEETS.SKILL_LEVELS);

  // 1. Identify target period
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const defaultPeriod = months[d.getMonth()] + " " + d.getFullYear();
  const period = (filters && filters.period && filters.period !== "All") ? filters.period : defaultPeriod;
  const targetPeriodLower = period.toLowerCase().trim();

  // 2. Map allocations by email address (lowercase) for target period
  const periodAllocationsMap = {};
  allocations.forEach(a => {
    const rawP = a["Month and Year"] !== undefined ? a["Month and Year"] : a["Period"];
    const rowPeriod = (rawP instanceof Date) ? Utilities.formatDate(rawP, tz, "MMMM yyyy") : String(rawP || "");
    if (rowPeriod.toLowerCase().trim() === targetPeriodLower) {
      const email = String(a["Email Address"] || "").toLowerCase().trim();
      if (!periodAllocationsMap[email]) {
        periodAllocationsMap[email] = [];
      }
      periodAllocationsMap[email].push(a);
    }
  });

  // 3. Map skills by email address (lowercase)
  const empSkillsMap = {};
  skillMatrix.forEach(s => {
    const email = String(s["Email Address"] || "").toLowerCase().trim();
    if (!empSkillsMap[email]) {
      empSkillsMap[email] = [];
    }
    empSkillsMap[email].push(s);
  });

  // Map skill names (e.g. Beginner, SME) to their numeric points
  const skillLevelToPoints = {};
  skillLevels.forEach(sl => {
    const levelStr = String(sl["Skill Level"] || "").trim().toLowerCase();
    const pts = parseFloat(sl["Skill Legend points"]) || 0;
    if (levelStr) {
      skillLevelToPoints[levelStr] = pts;
    }
  });

  // 4. Filter employees matching criteria
  const filteredEmployees = applyGlobalFilters(employees, filters, true);

  // Sets to collect rows and columns
  const productsSet = new Set();
  const subProductsSet = new Set();
  const regionsSet = new Set();
  const headsSet = new Set();

  const employeesWithAllocations = new Set();
  const employeesWithSkills = new Set();

  // FTE Pivots: { [col]: { [row]: value } }
  const prodRegionFte = {}; 
  const prodHeadFte = {}; 
  const prodSubFte = {}; 

  // Skill Pivots Temps: { [col]: { [row]: { sum, count } } }
  const prodRegionSkillTemp = {};
  const prodHeadSkillTemp = {};
  const prodSubSkillTemp = {};

  filteredEmployees.forEach(emp => {
    const email = String(emp["Email Address"] || "").toLowerCase().trim();
    if (!email) return;

    const region = String(emp["Cost Center"] || "Global").trim();
    const head = String(emp["Regional Head/Head of function"] || "N/A").trim();

    regionsSet.add(region);
    headsSet.add(head);

    // --- FTE Aggregations ---
    const empAllocations = periodAllocationsMap[email] || [];
    empAllocations.forEach(a => {
      const product = String(a["Product"] || "Unmapped").trim();
      const subProduct = String(a["Sub-Product"] || "General").trim();
      if (product === "" || product.toLowerCase() === "unmapped") return;

      if (filters && filters.product && filters.product !== 'All') {
        if (product.toLowerCase() !== filters.product.toLowerCase()) return;
      }
      if (filters && filters.subProduct && filters.subProduct !== 'All') {
        if (subProduct.toLowerCase() !== filters.subProduct.toLowerCase()) return;
      }

      employeesWithAllocations.add(email);
      productsSet.add(product);
      subProductsSet.add(subProduct);

      const bauVal = a["Allocation BAU"] !== undefined ? a["Allocation BAU"] : a["BAU (%)"];
      const bau = parseFloat(bauVal) || 0;

      const nbauVal = a["Allocation Non-BAU"] !== undefined ? a["Allocation Non-BAU"] : a["Non-BAU (%)"];
      const nbau = parseFloat(nbauVal) || 0;

      const fte = (bau + nbau) / 100;

      // Pivot 1: Product vs Region FTE
      if (!prodRegionFte[region]) prodRegionFte[region] = {};
      prodRegionFte[region][product] = (prodRegionFte[region][product] || 0) + fte;

      // Pivot 2: Product vs Head of Function FTE
      if (!prodHeadFte[head]) prodHeadFte[head] = {};
      prodHeadFte[head][product] = (prodHeadFte[head][product] || 0) + fte;

      // Pivot 3: Product vs Sub-Product FTE
      if (!prodSubFte[subProduct]) prodSubFte[subProduct] = {};
      prodSubFte[subProduct][product] = (prodSubFte[subProduct][product] || 0) + fte;
    });

    // --- Skill Level Aggregations ---
    const empSkills = empSkillsMap[email] || [];
    empSkills.forEach(s => {
      const product = String(s["Product"] || "Unmapped").trim();
      const subProduct = String(s["Sub-Product"] || "General").trim();
      if (product === "" || product.toLowerCase() === "unmapped") return;

      if (filters && filters.skillScope === 'Active') {
        const empAllocations = periodAllocationsMap[email] || [];
        const isActiveAllocation = empAllocations.some(a => {
          const aProd = String(a["Product"] || "").trim().toLowerCase();
          const aSub = String(a["Sub-Product"] || "General").trim().toLowerCase();
          return aProd === product.toLowerCase() && aSub === subProduct.toLowerCase();
        });
        if (!isActiveAllocation) return; // Skip if not active in allocations for this period
      }

      if (filters && filters.product && filters.product !== 'All') {
        if (product.toLowerCase() !== filters.product.toLowerCase()) return;
      }
      if (filters && filters.subProduct && filters.subProduct !== 'All') {
        if (subProduct.toLowerCase() !== filters.subProduct.toLowerCase()) return;
      }

      // Map string values (e.g. SME) to skill legend points
      const rawSkill = String(s["Skill Level"] || "").trim();
      const points = skillLevelToPoints[rawSkill.toLowerCase()] || 0;
      if (points <= 0) return; // Skip unrated/NA skills

      if (filters && filters.skillLevel && filters.skillLevel !== 'All') {
        const minPts = parseFloat(filters.skillLevel) || 0;
        if (points < minPts) return;
      }

      employeesWithSkills.add(email);
      productsSet.add(product);
      subProductsSet.add(subProduct);

      const addSkill = (tempObj, col, row, val, valStr) => {
        if (!tempObj[col]) tempObj[col] = {};
        if (!tempObj[col][row]) tempObj[col][row] = { maxPoints: 0, text: "-" };
        if (val > tempObj[col][row].maxPoints) {
          tempObj[col][row].maxPoints = val;
          tempObj[col][row].text = valStr;
        }
      };

      addSkill(prodRegionSkillTemp, region, product, points, rawSkill);
      addSkill(prodHeadSkillTemp, head, product, points, rawSkill);
      addSkill(prodSubSkillTemp, subProduct, product, points, rawSkill);
    });
  });

  // Helper to resolve max skill ratings into final maps
  const finalizeMaxSkills = (tempObj) => {
    const finalObj = {};
    for (const col in tempObj) {
      finalObj[col] = {};
      for (const row in tempObj[col]) {
        const cell = tempObj[col][row];
        finalObj[col][row] = {
          text: cell ? (cell.text || "-") : "-",
          points: cell ? (cell.maxPoints || 0) : 0
        };
      }
    }
    return finalObj;
  };

  const prodRegionSkill = finalizeMaxSkills(prodRegionSkillTemp);
  const prodHeadSkill = finalizeMaxSkills(prodHeadSkillTemp);
  const prodSubSkill = finalizeMaxSkills(prodSubSkillTemp);

  const mappedRoster = (emailSet) => {
    return filteredEmployees
      .filter(e => e["Email Address"] && emailSet.has(String(e["Email Address"]).toLowerCase().trim()))
      .map(e => ({
        name: (e["Google Chat Full Name"] || e["HR Name"] || `${e["First Name"] || ""} ${e["Last Name"] || ""}`).trim(),
        email: e["Email Address"],
        region: e["Cost Center"] || "Global",
        head: e["Regional Head/Head of function"] || "N/A"
      }));
  };

  return {
    period,
    employees: mappedRoster(employeesWithAllocations),
    skillEmployees: mappedRoster(employeesWithSkills),
    prodHeadFte: {
      rows: Array.from(productsSet).sort(),
      cols: Array.from(headsSet).sort(),
      data: prodHeadFte
    },
    prodRegionFte: {
      rows: Array.from(productsSet).sort(),
      cols: Array.from(regionsSet).sort(),
      data: prodRegionFte
    },
    prodSubFte: {
      rows: Array.from(productsSet).sort(),
      cols: Array.from(subProductsSet).sort(),
      data: prodSubFte
    },
    prodHeadSkill: {
      rows: Array.from(productsSet).sort(),
      cols: Array.from(headsSet).sort(),
      data: prodHeadSkill
    },
    prodRegionSkill: {
      rows: Array.from(productsSet).sort(),
      cols: Array.from(regionsSet).sort(),
      data: prodRegionSkill
    },
    prodSubSkill: {
      rows: Array.from(productsSet).sort(),
      cols: Array.from(subProductsSet).sort(),
      data: prodSubSkill
    }
  };
}

/**
 * PHASE 4: Cost of Delivery Aggregation
 */
function getCostOfDeliveryData(filters) {
  const session = validateTier(2);
  if (!session.isExecutiveView) {
    throw new Error("Unauthorized: Executive access required.");
  }

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();

  const employees = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  const allocations = getSheetData(CONFIG.SHEETS.ALLOCATION_HISTORICAL);

  // 1. Identify target period
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const defaultPeriod = months[d.getMonth()] + " " + d.getFullYear();
  const period = (filters && filters.period && filters.period !== "All") ? filters.period : defaultPeriod;
  const targetPeriodLower = period.toLowerCase().trim();

  // 2. Map allocations by email address (lowercase) for fast lookup
  const periodAllocationsMap = {};
  const firstAllocationRow = {}; // email -> first raw row for day calculations
  allocations.forEach(a => {
    const rawP = a["Month and Year"] !== undefined ? a["Month and Year"] : a["Period"];
    const rowPeriod = (rawP instanceof Date) ? Utilities.formatDate(rawP, tz, "MMMM yyyy") : String(rawP || "");
    if (rowPeriod.toLowerCase().trim() === targetPeriodLower) {
      const email = String(a["Email Address"] || "").toLowerCase().trim();
      if (!periodAllocationsMap[email]) {
        periodAllocationsMap[email] = [];
      }
      periodAllocationsMap[email].push(a);
      if (!firstAllocationRow[email]) {
        firstAllocationRow[email] = a;
      }
    }
  });

  // 3. Filter employees matching criteria
  const filteredEmployees = applyGlobalFilters(employees, filters, true);

  let totalRun = 0;
  let totalChange = 0;
  const regionalMap = {}; // lowercase -> { run, change, label }

  const pendingRoster = [];
  const employeesWithAllocations = new Set();
  let submittedCount = 0;

  // Audits counters for compliance charts
  let fteValidCount = 0;
  let fteInvalidCount = 0;
  let ftePendingCount = 0;

  let daysLessCount = 0;
  let daysEqualCount = 0;
  let daysMoreCount = 0;
  let daysPendingCount = 0;

  filteredEmployees.forEach(emp => {
    const email = String(emp["Email Address"] || "").toLowerCase().trim();
    if (!email) return;

    const name = (emp["Google Chat Full Name"] || emp["HR Name"] || `${emp["First Name"] || ""} ${emp["Last Name"] || ""}`).trim();
    const rawCc = String(emp["Cost Center"] || "Global").trim();
    const ccKey = rawCc.toLowerCase();

    if (!regionalMap[ccKey]) {
      regionalMap[ccKey] = { run: 0, change: 0, label: rawCc };
    }

    const empAllocations = periodAllocationsMap[email] || [];

    if (empAllocations.length > 0) {
      submittedCount++;

      // Compute total allocation percentage across all their rows to check 1.00 FTE compliance
      let empTotalAllocPct = 0;
      empAllocations.forEach(a => {
        const bauVal = a["Allocation BAU"] !== undefined ? a["Allocation BAU"] : a["BAU (%)"];
        const bau = parseFloat(bauVal) || 0;
        const nbauVal = a["Allocation Non-BAU"] !== undefined ? a["Allocation Non-BAU"] : a["Non-BAU (%)"];
        const nbau = parseFloat(nbauVal) || 0;
        empTotalAllocPct += bau + nbau;
      });

      if (empTotalAllocPct === 100) {
        fteValidCount++;
      } else {
        fteInvalidCount++;
      }

      // Calculate days worked comparison for this employee
      if (firstAllocationRow[email]) {
        const row = firstAllocationRow[email];
        const standardWeekdays = parseInt(row["Standard Weekdays in Month"] || row["Standard Weekdays"]) || 0;
        const weekdaysWorked = parseInt(row["Regular Days Worked"] || row["Weekdays Worked"]) || 0;
        const weekendDaysWorked = parseFloat(row["Weekend Days Worked"]) || 0;

        if (weekdaysWorked + weekendDaysWorked < standardWeekdays) {
          daysLessCount++;
        } else if (weekdaysWorked === standardWeekdays && weekendDaysWorked === 0) {
          daysEqualCount++;
        } else {
          daysMoreCount++;
        }
      }

      let hasMatchingAllocation = false;
      empAllocations.forEach(a => {
        // Direct filters at allocation row level for maximum precision
        let rowMatch = true;
        const product = String(a["Product"] || "Unmapped").trim();
        const subProduct = String(a["Sub-Product"] || "General").trim();
        
        if (filters && filters.product && filters.product !== 'All') {
          if (product.toLowerCase() !== filters.product.toLowerCase()) rowMatch = false;
        }
        if (filters && filters.subProduct && filters.subProduct !== 'All') {
          if (subProduct.toLowerCase() !== filters.subProduct.toLowerCase()) rowMatch = false;
        }
        
        if (!rowMatch) return;

        hasMatchingAllocation = true;

        const bauVal = a["Allocation BAU"] !== undefined ? a["Allocation BAU"] : a["BAU (%)"];
        const bau = (parseFloat(bauVal) || 0) / 100;

        const nbauVal = a["Allocation Non-BAU"] !== undefined ? a["Allocation Non-BAU"] : a["Non-BAU (%)"];
        const nbau = (parseFloat(nbauVal) || 0) / 100;

        totalRun += bau;
        totalChange += nbau;

        regionalMap[ccKey].run += bau;
        regionalMap[ccKey].change += nbau;
      });

      if (hasMatchingAllocation) {
        employeesWithAllocations.add(email);
      }
    } else {
      // Pending submission
      ftePendingCount++;
      daysPendingCount++;

      const managerName = String(emp["Direct Manager Name"] || "N/A").trim();
      const managerEmail = String(emp["Direct Manager Email"] || emp["Manager ID"] || "N/A").trim();

      pendingRoster.push({
        name,
        email: emp["Email Address"],
        managerEmail,
        managerName,
        region: rawCc,
        period
      });
    }
  });

  const totalEmployees = filteredEmployees.length;
  const certificationRate = totalEmployees > 0 ? Math.round((submittedCount / totalEmployees) * 100) : 100;

  return {
    totalProductiveFTE: totalRun + totalChange,
    totalRun,
    totalChange,
    employees: filteredEmployees
      .filter(e => e["Email Address"] && employeesWithAllocations.has(String(e["Email Address"]).toLowerCase().trim()))
      .map(e => ({
        name: (e["Google Chat Full Name"] || e["HR Name"] || `${e["First Name"] || ""} ${e["Last Name"] || ""}`).trim(),
        email: e["Email Address"],
        region: e["Cost Center"] || "Global",
        head: e["Regional Head/Head of function"] || "N/A"
      })),
    regionalDistribution: {
      labels: Object.values(regionalMap).map(r => r.label),
      run: Object.values(regionalMap).map(r => r.run),
      change: Object.values(regionalMap).map(r => r.change)
    },
    compliance: {
      period,
      totalEmployees,
      submittedCount,
      certificationRate,
      pendingRoster,
      fteAudit: {
        valid: fteValidCount,
        invalid: fteInvalidCount,
        pending: ftePendingCount
      },
      daysAudit: {
        less: daysLessCount,
        equal: daysEqualCount,
        more: daysMoreCount,
        pending: daysPendingCount
      }
    }
  };
}

/**
 * HELPER: Clears the cached profile payload for a specific employee
 */
function clearUserProfileCache(email) {
  if (!email) return;
  const cleanEmail = String(email).toLowerCase().trim().replace(/[^a-z0-9_]/g, "");
  const cacheKey = "profile_" + cleanEmail;
  try {
    CacheService.getScriptCache().remove(cacheKey);
    console.log(`[CACHE] Busted profile cache for: ${email}`);
  } catch(e) {
    console.warn("Failed to bust user profile cache:", e);
  }
}

/**
 * PHASE 4: Employee Profile Lookup
 */
function getEmployeeProfileData(email) {
  const session = validateTier(1);
  if (!email) throw new Error("Email parameter is required for profile lookup.");

  const searchEmail = String(email).trim().toLowerCase();
  const cleanEmail = searchEmail.replace(/[^a-z0-9_]/g, "");
  const cacheKey = "profile_" + cleanEmail;
  const cache = CacheService.getScriptCache();
  
  // Try reading from cache
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      console.log(`[CACHE] Serving profile from cache for: ${searchEmail}`);
      return JSON.parse(cached);
    } catch(e) {
      console.warn("Failed to parse cached employee profile:", e);
    }
  }

  const employees = getSheetData(CONFIG.SHEETS.EMPLOYEES);

  // LOGGING FOR TERMINAL/EXECUTION LOGS
  console.log(`[PROFILE_LOOKUP] Email: ${searchEmail} | Total Roster: ${employees.length}`);

  let user = employees.find(e => {
    const rosterEmail = String(e["Email Address"] || "").trim().toLowerCase();
    return rosterEmail === searchEmail;
  });

  if (!user) {
    // If user is an Admin but not in the roster, create a mock profile instead of failing
    if (session.isAdmin && getAdminEmails().includes(searchEmail)) {
      console.log(`[PROFILE_LOOKUP] Admin ${searchEmail} not in roster. Generating mock profile.`);
      user = {
        "First Name": "System",
        "Last Name": "Administrator",
        "Email Address": searchEmail,
        "Employee ID": "ADMIN-000",
        "Profile": "Super Admin",
        "Cost Center": "Global Operations",
        "Regional Head/Head of function": "N/A",
        "Direct Manager Name": "N/A",
        "Photo URL": `https://ui-avatars.com/api/?name=System+Admin&background=FF0061&color=fff`
      };
    } else {
      console.warn(`[PROFILE_LOOKUP] FAILED: User ${searchEmail} not found in roster.`);
      return null;
    }
  }

  console.log(`[PROFILE_LOOKUP] SUCCESS: Found ${user["Google Chat Full Name"] || user["HR Name"] || (user["First Name"] + " " + user["Last Name"])}`);

  // Normalize Cost Center for display consistency (7 Region Standard)
  if (user["Cost Center"]) {
    user["Cost Center"] = String(user["Cost Center"]).trim();
  }

  // Fetch actual case counts from BigQuery
  let caseCount = 0;
  try {
    const sql = `
      SELECT COUNT(*) as cases
      FROM \`${CONFIG.BQ.PROJECT_ID}.${CONFIG.BQ.DATASETS.SALESFORCE}\`
      WHERE email = '${searchEmail}'
    `;
    const bqResult = executeBQQuery(sql);
    if (bqResult && bqResult.length > 0) {
      caseCount = parseInt(bqResult[0].cases, 10) || 0;
    }
  } catch(e) {
    console.warn("BigQuery Case Metrics Failed:", e);
  }

  // Real-time submission validation to avoid cached roster sync issues
  const allocations = getHistoricalAllocation(email);
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const currentPeriod = months[d.getMonth()] + " " + d.getFullYear();
  const hasSubmitted = (allocations || []).some(a => String(a.period).trim().toLowerCase() === currentPeriod.toLowerCase());

  const payload = { user, skills: getSkillMatrix(email), metrics: { cases: caseCount }, hasSubmitted: hasSubmitted };
  const serialized = JSON.stringify(payload);
  
  // Cache the profile payload for 1 hour (3600 seconds)
  try {
    cache.put(cacheKey, serialized, 3600);
    console.log(`[CACHE] Profile cached successfully for: ${searchEmail}`);
  } catch(e) {
    console.warn("Failed to cache employee profile:", e);
  }
  
  return JSON.parse(serialized);
}
/**
 * PHASE 5.2: Capacity vs. Actuals Tracking
 * Integrates BigQuery Joins (Salesforce actuals + People Data PTO).
 * FALLBACK: Uses spreadsheet allocation data if BQ is unavailable.
 */
function getUtilizationData(managerName) {
  validateTier(2); // Managers+
  
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const currentPeriod = months[d.getMonth()] + " " + d.getFullYear();

  // 1. Fetch capacity data from People Data (BigQuery)
  const ptoSql = `
    SELECT email, SUM(pto_hours) as pto
    FROM \`${CONFIG.BQ.PROJECT_ID}.${CONFIG.BQ.DATASETS.PEOPLE_DATA}\`
    WHERE period = '${currentPeriod}'
    GROUP BY 1
  `;
  const ptoResults = executeBQQuery(ptoSql) || [];
  const ptoMap = {};
  ptoResults.forEach(r => ptoMap[r.email.toLowerCase()] = parseFloat(r.pto) || 0);

  // 2. Fetch Employee Roster
  let roster = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  if (managerName && managerName !== 'All') {
    roster = roster.filter(e => String(e["Direct Manager Name"]) === managerName);
  }

  const teamMetrics = roster.filter(e => e["Email Address"]).map(e => {
    const emailLower = String(e["Email Address"]).toLowerCase();
    const bau = parseFloat(e["BAU (%)"]) || 0;
    const nbau = parseFloat(e["Non-BAU (%)"]) || 0;
    
    // Calculate Capacity: Standard hours minus PTO
    const ptoHours = ptoMap[emailLower] || 0;
    const availableHours = Math.max(1, CONFIG.BQ.STD_MONTHLY_HOURS - ptoHours);
    
    // Calculate Actuals (from current submission)
    const totalProductivePct = bau + nbau;
    const utilization = Math.round((totalProductivePct / 100) * (CONFIG.BQ.STD_MONTHLY_HOURS / availableHours) * 100);

    return {
      name: (e["Google Chat Full Name"] || e["HR Name"] || `${e["First Name"] || ""} ${e["Last Name"] || ""}`).trim(),
      email: e["Email Address"],
      role: e["Profile"] || "Employee",
      utilization: utilization,
      bau: bau,
      nbau: nbau,
      status: utilization > 100 ? 'Over' : (utilization < 80 ? 'Under' : 'Optimal')
    };
  });

  return {
    avgUtilization: teamMetrics.reduce((acc, curr) => acc + curr.utilization, 0) / (teamMetrics.length || 1),
    overCount: teamMetrics.filter(m => m.status === 'Over').length,
    underCount: teamMetrics.filter(m => m.status === 'Under').length,
    team: teamMetrics
  };
}

/**
 * HELPER: Get Team Roster for Manager Workspace
 */
function getTeamData() {
  const session = validateTier(2);
  const employees = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  const userEmailLower = session.email.toLowerCase();
  const userNameLower = session.name.toLowerCase();
  const isAdmin = session.tier >= 3;

  return employees.filter(e => {
    if (isAdmin) return isActiveEmployee(e);

    const email = String(e["Email Address"] || "").toLowerCase();
    if (email === userEmailLower) return false;

    const lead = String(e["Leads"] || "").toLowerCase();
    const managerEmail = String(e["Direct Manager Email"] || "").toLowerCase();
    const managerName = String(e["Direct Manager Name"] || "").toLowerCase();
    return (lead === userNameLower || managerEmail === userEmailLower || managerName === userNameLower) && isActiveEmployee(e);
  })
    .map(e => {
      const util = (parseFloat(e["BAU (%)"]) || 0) + (parseFloat(e["Non-BAU (%)"]) || 0);
      return { firstName: e["First Name"], lastName: e["Last Name"], name: (e["Google Chat Full Name"] || e["HR Name"] || `${e["First Name"] || ""} ${e["Last Name"] || ""}`).trim(), email: e["Email Address"], role: e["Profile"] || e["Manual Role"], region: e["Cost Center"], photoUrl: e["Photo URL"], bau: e["BAU (%)"], nbau: e["Non-BAU (%)"], status: util > 0 ? "Submitted" : "Pending", lastUpdated: e["Last Updated"] };
    });
}

/**
 * PHASE 2.1: Assign Product and Skill Level to Employee (Manager Action)
 */
function assignProductToEmployee(payload) {
  const session = validateTier(2); // Manager or above
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEETS.SKILL_MATRIX);
  if (!sheet) throw new Error("Skill Matrix sheet not found.");
  
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h || "").trim());
  const emailIdx = headers.indexOf("Email Address");
  const productIdx = headers.indexOf("Product");
  const subProductIdx = headers.indexOf("Sub-Product");
  const skillIdx = headers.indexOf("Skill Level");
  const targetIdx = headers.indexOf("Target Skill Level");
  
  if (emailIdx === -1 || productIdx === -1 || subProductIdx === -1) {
    throw new Error("Missing required headers in Skill Matrix.");
  }
  
  const targetEmail = payload.email.toLowerCase().trim();
  const targetProduct = payload.product.trim();
  const targetSubProduct = (payload.subProduct || "General").trim();
  const tz = ss.getSpreadsheetTimeZone();
  
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    const rowEmail = String(data[i][emailIdx]).toLowerCase().trim();
    const rowProduct = String(data[i][productIdx]).trim();
    const rowSubProduct = String(data[i][subProductIdx] || "General").trim();
    
    if (rowEmail === targetEmail && rowProduct === targetProduct && rowSubProduct === targetSubProduct) {
      rowIndex = i + 1;
      break;
    }
  }
  
  const rowValues = headers.map(h => {
    switch(h.toLowerCase()) {
      case "email address": return targetEmail;
      case "product": return targetProduct;
      case "sub-product": return targetSubProduct;
      case "skill level": return parseInt(payload.skillLevel) || 1;
      case "target skill level": return parseInt(payload.targetSkillLevel) || 5;
      case "last updated by": return session.realEmail || session.email;
      case "date and time of submission": return Utilities.formatDate(new Date(), tz, "dd/MM/yyyy HH:mm:ss");
      default: return rowIndex !== -1 ? data[rowIndex-1][headers.indexOf(h)] : "";
    }
  });
  
  if (rowIndex !== -1) {
    sheet.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
  
  return true;
}

/**
 * PHASE 2.1: Remove Product Assignment from Employee (Manager Action)
 */
function removeProductFromEmployee(email, product, subProduct) {
  const session = validateTier(2); // Manager or above
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEETS.SKILL_MATRIX);
  if (!sheet) throw new Error("Skill Matrix sheet not found.");
  
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h || "").trim());
  const emailIdx = headers.indexOf("Email Address");
  const productIdx = headers.indexOf("Product");
  const subProductIdx = headers.indexOf("Sub-Product");
  
  if (emailIdx === -1 || productIdx === -1 || subProductIdx === -1) {
    throw new Error("Missing required headers in Skill Matrix.");
  }
  
  const targetEmail = email.toLowerCase().trim();
  const targetProduct = product.trim();
  const targetSubProduct = (subProduct || "General").trim();
  
  const filteredRows = [headers];
  let removedCount = 0;
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rowEmail = String(row[emailIdx]).toLowerCase().trim();
    const rowProduct = String(row[productIdx]).trim();
    const rowSubProduct = String(row[subProductIdx] || "General").trim();
    
    const matchesTarget = (rowEmail === targetEmail && 
                            rowProduct === targetProduct && 
                            rowSubProduct === targetSubProduct);
    if (matchesTarget) {
      removedCount++;
    } else {
      filteredRows.push(row);
    }
  }
  
  if (removedCount > 0) {
    sheet.clearContents();
    sheet.getRange(1, 1, filteredRows.length, filteredRows[0].length).setValues(filteredRows);
  }
  
  return true;
}

/**
 * DB: Cascading Update Trigger (Self-Healing)
 * Updates email addresses across all transactional sheets when an Employee ID's email changes.
 */
function cascadeEmailUpdate(oldEmail, newEmail) {
  validateTier(3); // System Sync is Tier 3
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const targetSheets = [CONFIG.SHEETS.SKILL_MATRIX, CONFIG.SHEETS.ALLOCATION_HISTORICAL];
  
  targetSheets.forEach(sheetName => {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return;
    
    const headers = data[0].map(h => String(h || "").trim());
    const emailIdx = headers.indexOf("Email Address");
    if (emailIdx === -1) return;
    
    let updated = false;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][emailIdx]).toLowerCase().trim() === oldEmail.toLowerCase().trim()) {
        data[i][emailIdx] = newEmail.toLowerCase().trim();
        updated = true;
      }
    }
    
    if (updated) {
      sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
      logSystemEvent("SYSTEM_SYNC", oldEmail, "Email Cascade Update", sheetName, oldEmail, newEmail);
    }
  });
}

/**
 * Helper: Logs system and governance events to the System Logs sheet.
 */
function logSystemEvent(actor, target, action, sheetName, before, after) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let logSheet = ss.getSheetByName(CONFIG.SHEETS.SYSTEM_LOGS);
  if (!logSheet) {
    logSheet = ss.insertSheet(CONFIG.SHEETS.SYSTEM_LOGS);
    logSheet.appendRow(["Timestamp", "Actor Email", "Target Email", "Action Type", "Sheet Affected", "Before State", "After State"]);
  }
  logSheet.appendRow([new Date(), actor, target, action, sheetName, before, after]);
}

/**
 * Admin Utility: Automatically initializes or updates Google Sheet tables and headers
 * to match the finalized Relational Schema (Phase 1).
 */
function initializeDatabaseSchema() {
  validateTier(3); // Admin Only
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  
  const schemas = [
    {
      name: CONFIG.SHEETS.SKILL_LEVELS,
      headers: ["Skill Id", "Skill Legend points", "Skill Description", "Skill Level"]
    },
    {
      name: CONFIG.SHEETS.PRODUCTS,
      headers: ["Product ID", "Product", "Sub-Product"]
    },
    {
      name: CONFIG.SHEETS.SKILL_MATRIX,
      headers: ["Email Address", "Product", "Sub-Product", "Skill Level", "Last Updated By", "Date and time of Submission"]
    },
    {
      name: CONFIG.SHEETS.MANAGER_PRODUCT_ALLOCATION,
      headers: ["Email Address", "Product", "Sub-Product", "Last Updated By", "Date and time of Submission"]
    },
    {
      name: CONFIG.SHEETS.ALLOCATION_HISTORICAL,
      headers: ["Email Address", "Month and Year", "Allocation BAU", "Allocation Non-BAU", "Product", "Sub-Product", "Last Updated By", "Date and time of Submission", "Standard Weekdays in Month", "Regular Days Worked", "Worked Weekend", "Weekend Days Worked", "Comments"]
    },
    {
      name: CONFIG.SHEETS.SYSTEM_LOGS,
      headers: ["Timestamp", "Actor Email", "Target Email", "Action Type", "Sheet Affected", "Before State", "After State"]
    },
    {
      name: CONFIG.SHEETS.ANALYTICAL_HUB,
      headers: ["Report ID", "Report Name", "Description", "Category", "Link URL", "Created By", "Data Freshness", "Visibility Scope", "Is Active"]
    },
    {
      name: CONFIG.SHEETS.DATA_AUDIT,
      headers: ["Timestamp", "Employee Email", "Employee Name", "Discrepancy Field", "Google Value", "Dayforce Value", "Severity", "Action Status"]
    }
  ];
  
  const results = [];
  
  schemas.forEach(schema => {
    let sheet = ss.getSheetByName(schema.name);
    if (!sheet) {
      sheet = ss.insertSheet(schema.name);
      sheet.appendRow(schema.headers);
      applyFormatting(sheet); // Format header row (globally accessible from AllEmployee)
      results.push(`Created sheet '${schema.name}' with fresh headers.`);
    } else {
      const data = sheet.getDataRange().getValues();
      if (data.length === 0 || (data.length === 1 && !data[0][0])) {
        sheet.appendRow(schema.headers);
        applyFormatting(sheet);
        results.push(`Initialized empty sheet '${schema.name}' with headers.`);
      } else {
        const existingHeaders = data[0].map(h => String(h || "").trim());
        const missingHeaders = schema.headers.filter(h => !existingHeaders.includes(h));
        if (missingHeaders.length > 0) {
          const lastCol = sheet.getLastColumn();
          sheet.getRange(1, lastCol + 1, 1, missingHeaders.length).setValues([missingHeaders]);
          applyFormatting(sheet);
          results.push(`Updated sheet '${schema.name}' - Appended missing headers: ${missingHeaders.join(", ")}`);
        } else {
          results.push(`Sheet '${schema.name}' already matches relational schema.`);
        }
      }
    }
  });
  
  return results.join("\n");
}

/**
 * ADMIN: System Diagnostics - Database Health Check
 * Verifies the existence and connection status of all configured Google Sheets.
 */
function getDatabaseHealth() {
  validateTier(3); // Admin Only

  const health = {
    status: 'online',
    sheets: []
  };

  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const actualSheets = ss.getSheets().map(s => s.getName());

    for (const key in CONFIG.SHEETS) {
      const expectedName = CONFIG.SHEETS[key];
      const isConnected = actualSheets.includes(expectedName);

      health.sheets.push({
        key: key,
        name: expectedName,
        connected: isConnected
      });

      if (!isConnected) {
        health.status = 'degraded';
      }
    }
  } catch (error) {
    health.status = 'offline';
    health.error = error.message;
  }

  return JSON.parse(JSON.stringify(health));
}

/**
 * ADMIN: Fetch global system configuration (e.g., Phase toggle state)
 */
function getSystemConfig() {
  const cacheKey = "system_config";
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch(e) {
      console.warn("Failed to parse cached system config:", e);
    }
  }

  SpreadsheetApp.flush(); // BUST CACHE
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.SHEETS.CONFIG);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEETS.CONFIG);
    sheet.appendRow(["Setting Key", "Setting Value", "Description"]);
    // Initialize default state
    sheet.appendRow(["PHASE_1_STATE", "1", "1: Active, 2: Locked, 3: Maintenance"]);
  }
  
  const data = sheet.getDataRange().getValues();
  const config = {};
  for (let i = 1; i < data.length; i++) {
    const key = String(data[i][0]).trim();
    if (key) config[key] = data[i][1];
  }
  
  // Default to State 1 if missing
  if (!config["PHASE_1_STATE"]) config["PHASE_1_STATE"] = "1";
  
  try {
    cache.put(cacheKey, JSON.stringify(config), 21600); // Cache for 6 hours
  } catch(e) {
    console.warn("Failed to cache system config:", e);
  }

  return JSON.parse(JSON.stringify(config));
}

/**
 * ADMIN: Update a global system configuration key
 */
function updateSystemConfig(key, value) {
  const session = validateTier(3); // Admin Only
  
  // TRIGGER AUTOMATED SNAPSHOT BACKUP ON SYSTEM LOCK (State 2)
  if (key === "PHASE_1_STATE" && String(value) === "2") {
    try {
      console.log("[SNAPSHOT] AutoClose trigger detected. Running automatic close snapshot...");
      triggerSnapshotAndNotify("AutoClose");
    } catch (snapErr) {
      console.error("[SNAPSHOT] AutoClose failed. Error: ", snapErr.message);
    }
  }

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.SHEETS.CONFIG);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEETS.CONFIG);
    sheet.appendRow(["Setting Key", "Setting Value", "Description"]);
  }
  
  const data = sheet.getDataRange().getValues();
  let updated = false;
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      updated = true;
      break;
    }
  }
  
  if (!updated) {
    sheet.appendRow([key, value, "Added via Settings UI"]);
  }
  
  logSystemEvent(session.realEmail, "GLOBAL", `Config Update: ${key}`, CONFIG.SHEETS.CONFIG, "Unknown", value);
  try {
    logBackendTelemetry("SYSTEM_STATE_CHANGED", CONFIG.SHEETS.CONFIG, `${key} changed to ${value}`, "GLOBAL");
  } catch (e) {
    console.warn("Failed to log SYSTEM_STATE_CHANGED telemetry event:", e.message);
  }
  SpreadsheetApp.flush(); // Force write to avoid race condition on reload

  try {
    CacheService.getScriptCache().remove("system_config");
  } catch(e) {
    console.warn("Failed to clear system config cache:", e);
  }

  return true;
}

/**
 * MANAGER: Fetch unified, tabular bulk-edit data for all direct reports
 * Merges demographics, skills (matrix), and monthly allocations into one spreadsheet model.
 */
function getManagerBulkAllocationData() {
  const session = validateTier(2); // Manager or above
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  
  // 1. Fetch Direct Reports
  const employees = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  const userEmailLower = session.email.toLowerCase();
  const userNameLower = session.name.toLowerCase();
  const isAdmin = session.tier >= 3;

  const directReports = employees.filter(e => {
    if (isAdmin) return isActiveEmployee(e);

    const email = String(e["Email Address"] || "").toLowerCase();
    if (email === userEmailLower) return false;

    const lead = String(e["Leads"] || "").toLowerCase();
    const managerEmail = String(e["Direct Manager Email"] || "").toLowerCase();
    const managerName = String(e["Direct Manager Name"] || "").toLowerCase();
    return (lead === userNameLower || managerEmail === userEmailLower || managerName === userNameLower) && isActiveEmployee(e);
  });
  
  if (directReports.length === 0) {
    return { rows: [], catalog: [], skillsLegend: [] };
  }
  
  const reportEmails = directReports.map(e => String(e["Email Address"]).toLowerCase().trim());
  
  // 2. Fetch all Manager Product Allocation rows (Allocation Scope)
  const allAllocationScope = getSheetData(CONFIG.SHEETS.MANAGER_PRODUCT_ALLOCATION);
  const teamAllocationScope = allAllocationScope.filter(s => reportEmails.includes(String(s["Email Address"]).toLowerCase().trim()));
  
  // 3. Fetch current monthly Allocations (Dynamic current period)
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const currentPeriod = months[d.getMonth()] + " " + d.getFullYear();

  const allAllocations = getSheetData(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
  const teamAllocations = allAllocations.filter(a => {
    const isTeam = reportEmails.includes(String(a["Email Address"]).toLowerCase().trim());
    const rawP = a["Month and Year"] !== undefined ? a["Month and Year"] : a["Period"];
    const period = (rawP instanceof Date) ? Utilities.formatDate(rawP, tz, "MMMM yyyy") : String(rawP || "");
    return isTeam && period.toLowerCase().trim() === currentPeriod.toLowerCase();
  });
  
  // 4. Fetch catalog and skill levels
  const productCatalog = getSheetData(CONFIG.SHEETS.PRODUCTS).map(p => ({
    product: p["Product"],
    subProduct: p["Sub-Product"]
  }));
  const skillLevels = getSheetData(CONFIG.SHEETS.SKILL_LEVELS).map(s => ({
    id: s["Skill Id"],
    level: s["Skill Level"],
    points: s["Skill Legend points"],
    desc: s["Skill Description"]
  }));

  // Build spreadsheet rows
  const rows = [];
  
  const allManagers = new Set();
  employees.forEach(e => {
    const mgr = String(e["Direct Manager Name"] || "").toLowerCase().trim();
    if (mgr && mgr !== "n/a" && mgr !== "unknown") allManagers.add(mgr);
  });
  
  directReports.forEach(emp => {
    const empEmail = String(emp["Email Address"]).toLowerCase().trim();
    const empName = (emp["Google Chat Full Name"] || emp["HR Name"] || `${emp["First Name"] || ""} ${emp["Last Name"] || ""}`).trim();
    const empNameLower = empName.toLowerCase();
    const empHasReports = allManagers.has(empNameLower);
    
    // Find assigned products in Manager Product Allocation sheet
    const empScope = teamAllocationScope.filter(s => String(s["Email Address"]).toLowerCase().trim() === empEmail);
    
    if (empScope.length === 0) {
      // Empty State: Rep has no products assigned yet
      rows.push({
        email: emp["Email Address"],
        name: empName,
        role: emp["Profile"] || "Employee",
        hasReports: empHasReports,
        product: "",
        subProduct: "",
        skillLevel: "N/A",
        bau: 0,
        nbau: 0,
        mgmt: 0,
        comment: "",
        isPendingAssignment: true
      });
    } else {
      empScope.forEach(assignment => {
        const prod = assignment["Product"];
        const subProd = assignment["Sub-Product"] || "General";
        
        // Find matching allocation row
        let alloc = teamAllocations.find(a => {
          const mEmail = String(a["Email Address"]).toLowerCase().trim() === empEmail;
          const mProd = String(a["Product"]).trim() === String(prod).trim();
          const mSub = String(a["Sub-Product"] || "General").trim() === String(subProd).trim();
          return mEmail && mProd && mSub;
        });
        
        let isHistoricalFallback = false;
        if (!alloc) {
          // Fallback to the most recent previous period allocation
          const pastAllocations = allAllocations.filter(a => {
            const mEmail = String(a["Email Address"]).toLowerCase().trim() === empEmail;
            const mProd = String(a["Product"]).trim() === String(prod).trim();
            const mSub = String(a["Sub-Product"] || "General").trim() === String(subProd).trim();
            const rawP = a["Month and Year"] !== undefined ? a["Month and Year"] : a["Period"];
            const mPeriod = (rawP instanceof Date) ? Utilities.formatDate(rawP, tz, "MMMM yyyy") : String(rawP || "");
            return mEmail && mProd && mSub && mPeriod.toLowerCase().trim() !== currentPeriod.toLowerCase();
          });
          if (pastAllocations.length > 0) {
            alloc = pastAllocations[pastAllocations.length - 1]; // Take the latest appended record
            isHistoricalFallback = true;
          }
        }
        
        // Allocation data is saved as percentage. Map it directly
        rows.push({
          email: emp["Email Address"],
          name: empName,
          role: emp["Profile"] || "Employee",
          hasReports: empHasReports,
          product: prod,
          subProduct: subProd,
          skillLevel: "N/A", // Decoupled from Skill Matrix
          bau: alloc ? (parseInt(alloc["Allocation BAU"] || alloc["BAU (%)"]) || 0) : 0,
          nbau: alloc ? (parseInt(alloc["Allocation Non-BAU"] || alloc["Non-BAU (%)"]) || 0) : 0,
          comment: (alloc && !isHistoricalFallback) ? (alloc["Allocation Comment"] || "") : "", // Do not carry over old comments
          isCurrentSubmission: alloc !== undefined && !isHistoricalFallback,
          submissionTimestamp: (alloc && !isHistoricalFallback) ? (() => {
            const rawSub = alloc["Date and time of Submission"] || alloc["Date of Submission"] || "";
            return (rawSub instanceof Date) ? rawSub.toISOString() : String(rawSub);
          })() : "",
          standardWeekdays: (alloc && !isHistoricalFallback) ? (parseInt(alloc["Standard Weekdays in Month"]) || 0) : 0,
          regularDays: (alloc && !isHistoricalFallback) ? (parseInt(alloc["Regular Days Worked"]) || 0) : 0,
          workedWeekend: (alloc && !isHistoricalFallback) ? (alloc["Worked Weekend"] === true || alloc["Worked Weekend"] === "TRUE" || alloc["Worked Weekend"] === "true") : false,
          weekendDays: (alloc && !isHistoricalFallback) ? (parseFloat(alloc["Weekend Days Worked"]) || 0) : 0,
          workingDaysComment: (alloc && !isHistoricalFallback) ? (alloc["Comments"] || "") : ""
        });
      });
    }
  });
  
  return JSON.parse(JSON.stringify({
    rows: rows,
    catalog: productCatalog,
    skillsLegend: skillLevels
  }));
}

/**
 * MANAGER: Save bulk updates (skills matrix and allocations) submitted by manager.
 * Consolidates into transactional writes and logs overrides silently.
 */
function saveManagerBulkAllocation(payload) {
  return runWithWriteLock(() => {
    const session = validateTier(2); // Manager or above
    
    // Enforce 3-State Master Switch Business Rules
    const state = getSystemConfig()["PHASE_1_STATE"] || "1";
    if (state === "3") {
      throw new Error("Save failed: The System is currently under maintenance.");
    }
    if (state === "2" && session.tier < 3) {
      throw new Error("Save failed: The Allocation module has been closed and locked by an Administrator.");
    }

    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const tz = ss.getSpreadsheetTimeZone();
    
    const skillSheet = ss.getSheetByName(CONFIG.SHEETS.SKILL_MATRIX);
    const allocSheet = ss.getSheetByName(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
    
    if (!skillSheet || !allocSheet) throw new Error("Database sheets not found.");
    
    const skillValues = skillSheet.getDataRange().getValues();
    const skillHeaders = skillValues[0].map(h => String(h || "").trim());
    const sEmailIdx = skillHeaders.indexOf("Email Address");
    const sProdIdx = skillHeaders.indexOf("Product");
    const sSubIdx = skillHeaders.indexOf("Sub-Product");
    const sSkillIdx = skillHeaders.indexOf("Skill Level");
    
    const allocValues = allocSheet.getDataRange().getValues();
    const allocHeaders = allocValues[0].map(h => String(h || "").trim());
    const aEmailIdx = allocHeaders.indexOf("Email Address");
    const aProdIdx = allocHeaders.indexOf("Product");
    const aSubIdx = allocHeaders.indexOf("Sub-Product");
    let aPeriodIdx = allocHeaders.indexOf("Month and Year");
    if (aPeriodIdx === -1) aPeriodIdx = allocHeaders.indexOf("Period");
    
    // Build lookup index keys for allocations (Dynamic current period)
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const allocPeriod = months[d.getMonth()] + " " + d.getFullYear();
    
    let skillUpdatedCount = 0;
    let allocUpdatedCount = 0;
    
    // Track system logs
    const logsToCommit = [];
    
    payload.forEach(item => {
      const email = String(item.email).toLowerCase().trim();
      const prod = String(item.product).trim();
      const subProd = String(item.subProduct || "General").trim();
      
      // Skip empty placeholder entries
      if (!prod) return;
      
      // 1. UPDATE SKILL MATRIX
      let skillRowIndex = -1;
      for (let i = 1; i < skillValues.length; i++) {
        if (String(skillValues[i][sEmailIdx]).toLowerCase().trim() === email &&
            String(skillValues[i][sProdIdx]).trim() === prod &&
            String(skillValues[i][sSubIdx] || "General").trim() === subProd) {
          skillRowIndex = i + 1;
          break;
        }
      }
      
      const mappedSkillRowValues = skillHeaders.map(h => {
        switch(h.toLowerCase()) {
          case "email address": return email;
          case "product": return prod;
          case "sub-product": return subProd;
          case "skill level": return item.skillLevel;
          case "last updated by": return session.realEmail || session.email;
          case "date and time of submission":
          case "date of submission": return Utilities.formatDate(new Date(), tz, "dd/MM/yyyy HH:mm:ss");
          default: return skillRowIndex !== -1 ? skillValues[skillRowIndex-1][skillHeaders.indexOf(h)] : "";
        }
      });
      
      if (skillRowIndex !== -1) {
        const beforeState = String(skillValues[skillRowIndex - 1][sSkillIdx]);
        if (beforeState !== String(item.skillLevel)) {
          skillSheet.getRange(skillRowIndex, 1, 1, skillHeaders.length).setValues([mappedSkillRowValues]);
          logsToCommit.push([email, "SKILL_MATRIX", `Skill update to ${item.skillLevel}`, beforeState, item.skillLevel]);
          skillUpdatedCount++;
        }
      } else {
        // Insert new skill record if product has been freshly assigned by manager
        skillSheet.appendRow(mappedSkillRowValues);
        logsToCommit.push([email, "SKILL_MATRIX", "Fresh Product Assignment", "None", item.skillLevel]);
        skillUpdatedCount++;
      }
      
      // 2. UPDATE HISTORICAL ALLOCATIONS (Proxy Entry / Override)
      let allocRowIndex = -1;
      for (let i = 1; i < allocValues.length; i++) {
        const rawP = allocValues[i][aPeriodIdx];
        const rowPeriod = (rawP instanceof Date) ? Utilities.formatDate(rawP, tz, "MMMM yyyy") : String(rawP);
        
        if (String(allocValues[i][aEmailIdx]).toLowerCase().trim() === email &&
            String(allocValues[i][aProdIdx]).trim() === prod &&
            String(allocValues[i][aSubIdx] || "General").trim() === subProd &&
            rowPeriod.toLowerCase().trim() === allocPeriod.toLowerCase()) {
          allocRowIndex = i + 1;
          break;
        }
      }
      
      // Let's check optimistic concurrency here
      if (item.lastKnownTimestamp !== undefined) {
        let currentDbTimestamp = "";
        if (allocRowIndex !== -1) {
          const dateIdx = allocHeaders.indexOf("Date and time of Submission") !== -1 
            ? allocHeaders.indexOf("Date and time of Submission") 
            : allocHeaders.indexOf("Date of Submission");
          if (dateIdx !== -1 && allocValues[allocRowIndex-1][dateIdx]) {
            const dbVal = allocValues[allocRowIndex-1][dateIdx];
            currentDbTimestamp = (dbVal instanceof Date) ? dbVal.toISOString() : String(dbVal);
          }
        }
        
        if (currentDbTimestamp && currentDbTimestamp !== item.lastKnownTimestamp) {
          throw new Error("STALE_DATA_ERROR: One or more records for " + email + " have been updated since you loaded the page. Please refresh to fetch the latest changes.");
        }
      }
      
      const mappedRowValues = allocHeaders.map(h => {
        switch(h.toLowerCase()) {
          case "email address": return email;
          case "month and year":
          case "period": return "'" + allocPeriod;
          case "allocation bau":
          case "bau (%)": return parseFloat(item.bau) || 0;
          case "allocation non-bau":
          case "non-bau (%)": return parseFloat(item.nbau) || 0;
          case "total fte (%)": return (parseFloat(item.bau) || 0) + (parseFloat(item.nbau) || 0);
          case "allocation comment": return item.comment || "Proxy submission by Manager";
          case "product": return prod;
          case "sub-product": return subProd;
          case "last updated by": return session.realEmail || session.email;
          case "date and time of submission":
          case "date of submission": return Utilities.formatDate(new Date(), tz, "dd/MM/yyyy HH:mm:ss");
          case "standard weekdays in month": return item.workingDays ? parseInt(item.workingDays.standardWeekdays) || 0 : 0;
          case "regular days worked": return item.workingDays ? parseInt(item.workingDays.regularDays) || 0 : 0;
          case "worked weekend": return item.workingDays ? (item.workingDays.workedWeekend === true || item.workingDays.workedWeekend === "true") : false;
          case "weekend days worked": return item.workingDays ? parseFloat(item.workingDays.weekendDays) || 0 : 0;
          case "comments": return item.workingDays ? item.workingDays.comment || "" : "";
          default: return "";
        }
      });
      
      if (allocRowIndex !== -1) {
        const beforeState = `BAU: ${allocValues[allocRowIndex-1][allocHeaders.indexOf("Allocation BAU") === -1 ? allocHeaders.indexOf("BAU (%)") : allocHeaders.indexOf("Allocation BAU")]}%`;
        const afterState = `BAU: ${item.bau}%`;
        
        // Update existing allocation row
        allocSheet.getRange(allocRowIndex, 1, 1, allocHeaders.length).setValues([mappedRowValues]);
        logsToCommit.push([email, "ALLOCATION_DATA", "Manager Proxy/Override Update", beforeState, afterState]);
        allocUpdatedCount++;
      } else {
        // Append new allocation row
        allocSheet.appendRow(mappedRowValues);
        logsToCommit.push([email, "ALLOCATION_DATA", "Manager Fresh Proxy Entry", "None", `BAU: ${item.bau}%`]);
        allocUpdatedCount++;
      }
    });
    
    // Commit logs to System Logs and fire telemetry hooks
    logsToCommit.forEach(log => {
      logSystemEvent(session.realEmail || session.email, log[0], log[2], log[1], log[3], log[4]);
      
      // Fire adoption telemetry
      if (log[1] === "ALLOCATION_DATA") {
        logBackendTelemetry("MANAGER_PROXY_SUBMITTED", CONFIG.SHEETS.ALLOCATION_HISTORICAL, log[4], log[0]);
      } else if (log[1] === "SKILL_MATRIX") {
        logBackendTelemetry("SKILL_ASSIGNED", CONFIG.SHEETS.SKILL_MATRIX, log[4], log[0]);
      }
    });
    
    // Also recalculate cached summaries in All Employee sheet for updated employees
    // (We trigger this silently to make sure dashboards are accurate!)
    if (skillUpdatedCount > 0) {
      clearSheetCache(CONFIG.SHEETS.SKILL_MATRIX);
    }
    if (allocUpdatedCount > 0) {
      clearSheetCache(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
      clearSheetCache(CONFIG.SHEETS.EMPLOYEES);
      
      const updatedEmails = [...new Set(payload.map(item => String(item.email).toLowerCase().trim()))];
      updatedEmails.forEach(email => {
        recalculateEmployeeFteCache(email);
        clearUserProfileCache(email); // Bust profile cache to reflect changes
      });
    }
    
    return `Successfully saved. Updated ${skillUpdatedCount} skills and ${allocUpdatedCount} allocation splits.`;
  });
}

/**
 * HELPER: Recalculates and updates the aggregated FTE cache inside 'App All Employee Data' for a specific employee
 */
function recalculateEmployeeFteCache(email) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  const empSheet = ss.getSheetByName(CONFIG.SHEETS.EMPLOYEES);
  const allocSheet = ss.getSheetByName(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
  
  if (!empSheet || !allocSheet) return;
  
  const empValues = empSheet.getDataRange().getValues();
  const empHeaders = empValues[0].map(h => String(h || "").trim());
  const empEmailIdx = empHeaders.indexOf("Email Address");
  
  const allocValues = allocSheet.getDataRange().getValues();
  const allocHeaders = allocValues[0].map(h => String(h || "").trim());
  const aEmailIdx = allocHeaders.indexOf("Email Address");
  const aPeriodIdx = allocHeaders.indexOf("Month and Year") === -1 ? allocHeaders.indexOf("Period") : allocHeaders.indexOf("Month and Year");
  const aBauIdx = allocHeaders.indexOf("Allocation BAU") === -1 ? allocHeaders.indexOf("BAU (%)") : allocHeaders.indexOf("Allocation BAU");
  const aNbauIdx = allocHeaders.indexOf("Allocation Non-BAU") === -1 ? allocHeaders.indexOf("Non-BAU (%)") : allocHeaders.indexOf("Allocation Non-BAU");
  
  let sumBau = 0, sumNbau = 0;
  
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const currentPeriod = months[d.getMonth()] + " " + d.getFullYear();

  for (let i = 1; i < allocValues.length; i++) {
    const rawP = allocValues[i][aPeriodIdx];
    const rowPeriod = (rawP instanceof Date) ? Utilities.formatDate(rawP, tz, "MMMM yyyy") : String(rawP);
    
    if (String(allocValues[i][aEmailIdx]).toLowerCase().trim() === email.toLowerCase().trim() &&
        rowPeriod.toLowerCase().trim() === currentPeriod.toLowerCase()) {
      sumBau += parseFloat(allocValues[i][aBauIdx]) || 0;
      sumNbau += parseFloat(allocValues[i][aNbauIdx]) || 0;
    }
  }
  
  // Find employee row and update
  for (let i = 1; i < empValues.length; i++) {
    if (String(empValues[i][empEmailIdx]).toLowerCase().trim() === email.toLowerCase().trim()) {
      const bauIdx = empHeaders.indexOf("BAU (%)");
      const nbauIdx = empHeaders.indexOf("Non-BAU (%)");
      const fteIdx = empHeaders.indexOf("Total FTE (%)");
      const lastUpdatedIdx = empHeaders.indexOf("Last Updated");
      
      if (bauIdx !== -1) empSheet.getRange(i + 1, bauIdx + 1).setValue(sumBau);
      if (nbauIdx !== -1) empSheet.getRange(i + 1, nbauIdx + 1).setValue(sumNbau);
      if (fteIdx !== -1) empSheet.getRange(i + 1, fteIdx + 1).setValue(sumBau + sumNbau);
      if (lastUpdatedIdx !== -1) empSheet.getRange(i + 1, lastUpdatedIdx + 1).setValue(new Date());
      break;
    }
  }
}

/**
 * TEMPORARY ADMIN UTILITY: Migrate Legacy Allocations to Granular Rows
 * Finds rows in App Employee Allocation Data with comma-separated Sub-Products,
 * splits them into individual rows, and divides the FTE % evenly to maintain totals.
 */
function migrateLegacyAllocationsToGranular() {
  validateTier(3); // Admin Only
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  const allocSheet = ss.getSheetByName(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
  
  if (!allocSheet) throw new Error("Allocation Historical sheet not found.");
  
  const data = allocSheet.getDataRange().getValues();
  if (data.length < 2) return "No data to migrate.";
  
  const headers = data[0].map(h => String(h || "").trim());
  const subProdIdx = headers.indexOf("Sub-Product");
  const bauIdx = headers.indexOf("Allocation BAU") !== -1 ? headers.indexOf("Allocation BAU") : headers.indexOf("BAU (%)");
  const nbauIdx = headers.indexOf("Allocation Non-BAU") !== -1 ? headers.indexOf("Allocation Non-BAU") : headers.indexOf("Non-BAU (%)");
  let periodIdx = headers.indexOf("Month and Year");
  if (periodIdx === -1) periodIdx = headers.indexOf("Period");
  
  if (subProdIdx === -1) throw new Error("Missing 'Sub-Product' column.");
  if (bauIdx === -1 || nbauIdx === -1) throw new Error("Missing allocation percentage columns.");
  
  const newRows = [headers];
  let splitCount = 0;
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const subProductStr = String(row[subProdIdx] || "").trim();
    
    if (subProductStr.includes(",")) {
      // It's a legacy consolidated row. We need to split it!
      const subProductsArray = subProductStr.split(",").map(s => s.trim()).filter(s => s);
      const splitFactor = subProductsArray.length;
      
      if (splitFactor > 0) {
        // Calculate divided percentages (rounding to 1 decimal place to prevent wild floats)
        const dividedBau = Math.round((parseFloat(row[bauIdx]) || 0) / splitFactor * 10) / 10;
        const dividedNbau = Math.round((parseFloat(row[nbauIdx]) || 0) / splitFactor * 10) / 10;
        
        subProductsArray.forEach(subProd => {
          const newRow = [...row]; // Clone original row
          newRow[subProdIdx] = subProd; // Overwrite with granular sub-product
          newRow[bauIdx] = dividedBau;
          newRow[nbauIdx] = dividedNbau;
          newRows.push(createSafeRowForDatabase(newRow, tz, periodIdx));
        });
        splitCount++;
      }
    } else {
      // It's already granular (or empty), keep it exactly as is
      newRows.push(createSafeRowForDatabase(row, tz, periodIdx));
    }
  }
  
  if (splitCount > 0) {
    allocSheet.clearContents();
    allocSheet.getRange(1, 1, newRows.length, newRows[0].length).setValues(newRows);
    return `Migration Complete. Split ${splitCount} legacy consolidated rows into granular Phase-1 records.`;
  } else {
    return "No legacy consolidated rows found. Database is already fully granular.";
  }
}

/**
 * MANAGER: Fetch data specifically for mapping direct reports to products and skill ratings (Tool 1)
 */
function getTeamProductsData() {
  const session = validateTier(2); // Manager or above
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  
  // 1. Fetch direct reports
  const employees = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  const userNameLower = session.name.toLowerCase();
  const userEmailLower = session.email.toLowerCase();
  const isAdmin = session.tier >= 3;

  const directReports = employees.filter(e => {
    if (isAdmin) return isActiveEmployee(e);

    const email = String(e["Email Address"] || "").toLowerCase();
    if (email === userEmailLower) return false;

    const lead = String(e["Leads"] || "").toLowerCase();
    const managerEmail = String(e["Direct Manager Email"] || "").toLowerCase();
    const managerName = String(e["Direct Manager Name"] || "").toLowerCase();
    return (lead === userNameLower || managerEmail === userEmailLower || managerName === userNameLower) && isActiveEmployee(e);
  }).map(e => ({
    name: (e["Google Chat Full Name"] || e["HR Name"] || `${e["First Name"] || ""} ${e["Last Name"] || ""}`).trim(),
    email: e["Email Address"],
    role: e["Profile"] || "Employee"
  }));
  
  // 2. Fetch skill levels catalog
  const skillLevels = getSheetData(CONFIG.SHEETS.SKILL_LEVELS).map(s => ({
    id: s["Skill Id"],
    level: s["Skill Level"],
    points: s["Skill Legend points"],
    desc: s["Skill Description"]
  }));
  
  // 3. Fetch product catalog
  const productCatalog = getProductCatalog(); // returns object { Product: [Sub-Products] }
  
  return JSON.parse(JSON.stringify({
    reports: directReports,
    skillsLegend: skillLevels,
    catalog: productCatalog
  }));
}

/**
 * MANAGER: Save product assignments and skill matrix changes for a direct report (Tool 1)
 */
function saveTeamProducts(email, assignments) {
  return runWithWriteLock(() => {
    const session = validateTier(2); // Manager or above
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const tz = ss.getSpreadsheetTimeZone();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.SKILL_MATRIX);
    if (!sheet) throw new Error("Skill Matrix sheet not found.");
    
    let data = sheet.getDataRange().getValues();
    let headers = data[0] ? data[0].map(h => String(h || "").trim()) : [];
    let emailIdx = headers.indexOf("Email Address");
    let productIdx = headers.indexOf("Product");
    let subProductIdx = headers.indexOf("Sub-Product");
    
    if (emailIdx === -1 || productIdx === -1 || subProductIdx === -1) {
      if (data.length <= 1 && headers.join("") === "") {
        // Sheet is completely empty, initialize it
        headers = ["Email Address", "Product", "Sub-Product", "Skill Level", "Last Updated By", "Date and time of Submission"];
        data = [headers];
        emailIdx = 0;
        productIdx = 1;
        subProductIdx = 2;
      } else {
        throw new Error("Missing required headers in Skill Matrix.");
      }
    }
    
    // Re-build sheet: Keep rows belonging to other users, but overwrite/re-insert rows for this user
    const targetEmail = email.toLowerCase().trim();
    const filteredRows = [headers];
    
    // 1. Keep non-target rows
    for (let i = 1; i < data.length; i++) {
      const rowEmail = String(data[i][emailIdx]).toLowerCase().trim();
      if (rowEmail !== targetEmail) {
        filteredRows.push(data[i]);
      }
    }
    
    // 2. Append updated assignments for this user
    assignments.forEach(item => {
      const mappedRowValues = headers.map(h => {
        switch(h.toLowerCase()) {
          case "email address": return targetEmail;
          case "product": return item.product;
          case "sub-product": return item.subProduct || "General";
          case "skill level": return item.skillLevel || "N/A";
          case "last updated by": return session.realEmail || session.email;
          case "date and time of submission": return Utilities.formatDate(new Date(), tz, "dd/MM/yyyy HH:mm:ss");
          default: return "";
        }
      });
      filteredRows.push(mappedRowValues);
    });
    
    sheet.clearContents();
    sheet.getRange(1, 1, filteredRows.length, filteredRows[0].length).setValues(filteredRows);
    
    // Bust user profile cache and sheet reads cache to reflect newly mapped products
    clearUserProfileCache(email);
    clearSheetCache(CONFIG.SHEETS.SKILL_MATRIX);
    
    logSystemEvent(session.realEmail || session.email, targetEmail, `Updated Product Mapping Matrix (${assignments.length} products)`, CONFIG.SHEETS.SKILL_MATRIX, "Prior Matrix", `${assignments.length} products`);
    logBackendTelemetry("PRODUCT_SCOPE_ASSIGNED", CONFIG.SHEETS.SKILL_MATRIX, `Mapped ${assignments.length} products`, targetEmail);
    return `Successfully saved operational product scope for ${email}.`;
  });
}

/**
 * MANAGER: Fetch product assignments for employee allocation scope
 */
function getManagerProductAllocation(email) {
  validateTier(1);
  const data = getSheetData(CONFIG.SHEETS.MANAGER_PRODUCT_ALLOCATION);
  const results = data.filter(r => String(r["Email Address"]).toLowerCase().trim() === String(email).toLowerCase().trim())
    .map(r => ({
      product: r["Product"] || "",
      subProduct: r["Sub-Product"] || ""
    }));

  // Auto-inject Mgmt/Mgmt product for Managers
  const employees = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  const emp = employees.find(e => String(e["Email Address"] || "").toLowerCase().trim() === String(email).toLowerCase().trim());
  const empName = emp ? (emp["Google Chat Full Name"] || emp["HR Name"] || `${emp["First Name"] || ""} ${emp["Last Name"] || ""}`).trim().toLowerCase() : "";
  
  const allManagers = new Set();
  employees.forEach(e => {
    const mgr = String(e["Direct Manager Name"] || "").toLowerCase().trim();
    if (mgr && mgr !== "n/a" && mgr !== "unknown") allManagers.add(mgr);
  });
  
  const hasReports = empName ? allManagers.has(empName) : false;
  
  if (hasReports) {
    const hasMgmt = results.some(r => String(r.product).trim().toLowerCase() === "mgmt" && String(r.subProduct).trim().toLowerCase() === "mgmt");
    if (!hasMgmt) {
      results.push({ product: "Mgmt", subProduct: "Mgmt" });
    }
  }

  return JSON.parse(JSON.stringify(results));
}

/**
 * MANAGER: Save product assignments for employee allocation scope
 */
function saveManagerProductAllocation(email, assignments) {
  const session = validateTier(2); // Manager or above
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  const sheet = ss.getSheetByName(CONFIG.SHEETS.MANAGER_PRODUCT_ALLOCATION);
  if (!sheet) throw new Error("Manager Product Allocation sheet not found.");

  let data = sheet.getDataRange().getValues();
  let headers = data[0] ? data[0].map(h => String(h || "").trim()) : [];
  let emailIdx = headers.indexOf("Email Address");
  
  if (emailIdx === -1) {
    if (data.length <= 1 && headers.join("") === "") {
      // Sheet is completely empty, initialize it
      headers = ["Email Address", "Product", "Sub-Product", "Last Updated By", "Date and time of Submission"];
      data = [headers];
      emailIdx = 0;
    } else {
      throw new Error("Missing required 'Email Address' header in Manager Product Allocation.");
    }
  }
  
  const targetEmail = email.toLowerCase().trim();
  const filteredRows = [headers];
  
  // 1. Keep non-target rows
  for (let i = 1; i < data.length; i++) {
    const rowEmail = String(data[i][emailIdx]).toLowerCase().trim();
    if (rowEmail !== targetEmail) {
      filteredRows.push(data[i]);
    }
  }
  
  // 2. Append updated assignments for this user
  assignments.forEach(item => {
    const mappedRowValues = headers.map(h => {
      switch(h.toLowerCase()) {
        case "email address": return targetEmail;
        case "product": return item.product;
        case "sub-product": return item.subProduct || "General";
        case "last updated by": return session.realEmail || session.email;
        case "date and time of submission": return Utilities.formatDate(new Date(), tz, "dd/MM/yyyy HH:mm:ss");
        default: return "";
      }
    });
    filteredRows.push(mappedRowValues);
  });
  
    sheet.clearContents();
    sheet.getRange(1, 1, filteredRows.length, filteredRows[0].length).setValues(filteredRows);
    
    // Bust user profile cache and sheet reads cache to reflect newly updated allocation products
    clearUserProfileCache(email);
    clearSheetCache(CONFIG.SHEETS.MANAGER_PRODUCT_ALLOCATION);
    
    logSystemEvent(session.realEmail || session.email, targetEmail, `Updated Allocation Product Scope (${assignments.length} products)`, CONFIG.SHEETS.MANAGER_PRODUCT_ALLOCATION, "Prior Scope", `${assignments.length} products`);
    logBackendTelemetry("PRODUCT_SCOPE_ASSIGNED", CONFIG.SHEETS.MANAGER_PRODUCT_ALLOCATION, `Scope Mapped: ${assignments.length} products`, targetEmail);
    return `Successfully saved allocation product scope for ${email}.`;
}

/**
 * ANALYTICAL HUB: Fetch reports visible to the current user
 * Filters reports dynamically based on user tier or specific email.
 * Admins (Tier 3) see all reports for management purposes.
 */
function getReportLinks() {
  const session = getCurrentUserSession();
  const data = getSheetData(CONFIG.SHEETS.ANALYTICAL_HUB);
  
  // If the sheet is empty or has no data, return an empty array
  if (data.length === 0) return [];
  
  // Admins bypass filtering
  if (session.tier >= 3) {
    return data;
  }
  
  // Filter for active reports matching visibility scope
  return data.filter(rpt => {
    if (String(rpt["Is Active"]).toUpperCase() !== "TRUE") return false;
    
    const scope = String(rpt["Visibility Scope"] || "").toLowerCase();
    const scopesArray = scope.split(",").map(s => s.trim());
    
    const emailLower = session.email.toLowerCase().trim();
    const tierStr = `tier ${session.tier}`;
    
    return (
      scopesArray.includes("all users") ||
      scopesArray.includes(tierStr) ||
      scopesArray.includes(emailLower)
    );
  });
}

/**
 * ANALYTICAL HUB: Save / Update a report link (Admin Only)
 */
function saveReportLink(payload) {
  const session = validateTier(3); // Admin Only
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.SHEETS.ANALYTICAL_HUB);
  
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEETS.ANALYTICAL_HUB);
    sheet.appendRow(["Report ID", "Report Name", "Description", "Category", "Link URL", "Created By", "Data Freshness", "Visibility Scope", "Is Active"]);
    try { applyFormatting(sheet); } catch(e) {} // Auto-format if helper exists
  }
  
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h || "").trim());
  const idIdx = headers.indexOf("Report ID");
  
  if (idIdx === -1) throw new Error("'Report ID' column not found in App Analytical Hub.");
  
  let reportId = payload.id;
  let rowIndex = -1;
  
  if (reportId) {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idIdx]).trim() === reportId) {
        rowIndex = i + 1;
        break;
      }
    }
  } else {
    // Generate new unique sequential key e.g., RPT-001
    let maxNum = 0;
    for (let i = 1; i < data.length; i++) {
      const idStr = String(data[i][idIdx]).trim();
      const match = idStr.match(/^RPT-(\d+)$/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
    reportId = "RPT-" + String(maxNum + 1).padStart(3, "0");
  }
  
  const rowValues = headers.map(h => {
    switch(h) {
      case "Report ID": return reportId;
      case "Report Name": return payload.name;
      case "Description": return payload.description;
      case "Category": return payload.category;
      case "Link URL": return payload.url;
      case "Created By": return payload.createdBy;
      case "Data Freshness": return payload.freshness;
      case "Visibility Scope": return payload.scope;
      case "Is Active": return String(payload.isActive).toUpperCase() === "TRUE" ? "TRUE" : "FALSE";
      default: return "";
    }
  });
  
  if (rowIndex !== -1) {
    sheet.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }

  // Log telemetry (Project Nexus)
  try {
    logBackendTelemetry("REPORT_PUBLISHED", CONFIG.SHEETS.ANALYTICAL_HUB, `Report ID: ${reportId} | Name: ${payload.name}`, "SYSTEM");
  } catch (e) {
    console.warn("Failed to log REPORT_PUBLISHED telemetry event:", e.message);
  }
  
  return true;
}

/**
 * ANALYTICAL HUB: Delete a report link (Admin Only)
 */
function deleteReportLink(id) {
  validateTier(3); // Admin Only
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEETS.ANALYTICAL_HUB);
  if (!sheet) throw new Error("App Analytical Hub sheet not found.");
  
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h || "").trim());
  const idIdx = headers.indexOf("Report ID");
  
  if (idIdx === -1) throw new Error("'Report ID' column not found in App Analytical Hub.");
  
  const filteredRows = [headers];
  let removedCount = 0;
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]).trim() === id) {
      removedCount++;
    } else {
      filteredRows.push(data[i]);
    }
  }
  
  if (removedCount > 0) {
    sheet.clearContents();
    sheet.getRange(1, 1, filteredRows.length, filteredRows[0].length).setValues(filteredRows);
    
    // Log telemetry (Project Nexus)
    try {
      logBackendTelemetry("REPORT_DELETED", CONFIG.SHEETS.ANALYTICAL_HUB, `Deleted Report ID: ${id}`, "SYSTEM");
    } catch (e) {
      console.warn("Failed to log REPORT_DELETED telemetry event:", e.message);
    }
    
    return true;
  }
  
  throw new Error("Report ID not found.");
}

/**
 * DATA AUDIT: Compare Google Workspace Directory against Dayforce HCM
 * Identifies sync discrepancies, with high priority on reporting lines (managers).
 */
/**
 * DATA AUDIT: Compare Google Workspace Directory against Dayforce HCM
 * Identifies sync discrepancies, focusing STRICTLY on accounts missing from either system under Anup's Org.
 */
function auditDayforceVsGoogle() {
  const session = validateTier(3); // Admin Only
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  console.log("[DATA_AUDIT] Fetching Google directory...");
  const googleMap = getCompleteDirectoryMap();
  const googleEmails = Object.keys(googleMap);

  console.log("[DATA_AUDIT] Fetching Dayforce records...");
  const dayforceData = fetchDayforceData();
  const dayforceMap = dayforceData.byEmail || {};
  const dayforceByNameMap = dayforceData.byName || {};
  const dayforceEmails = Object.keys(dayforceMap);

  // Preserve existing Action Statuses
  let existingData = [];
  try {
    existingData = getSheetData(CONFIG.SHEETS.DATA_AUDIT);
  } catch (e) {
    console.log("[DATA_AUDIT] No existing audit sheet to read statuses from.");
  }
  const existingStatusMap = {};
  existingData.forEach(r => {
    const emailKey = Object.keys(r).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === 'employeeemail') || 'Employee Email';
    const e = String(r[emailKey] || "").toLowerCase().trim();
    if (e) {
      const statusKey = Object.keys(r).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === 'actionstatus') || 'Action Status';
      existingStatusMap[e] = r[statusKey] || "Pending";
    }
  });

  const discrepancies = [];
  const timestamp = new Date();

  // A helper to recursively verify if a Dayforce email belongs to Anup's Org
  const isEmailInAnupOrgGoogle = (email) => {
    let currentEmail = email;
    let depth = 0;
    while (currentEmail && depth < 10) {
      const currentPObj = googleMap[currentEmail.toLowerCase()];
      if (!currentPObj) break;
      if (String(currentPObj.name).toLowerCase().includes("anup")) {
        return true;
      }
      currentEmail = currentPObj.managerEmail;
      depth++;
    }
    return false;
  };

  // Helper to trace manager chain in Dayforce
  const isEmailInAnupOrgDayforce = (email) => {
    let currentEmail = email;
    let depth = 0;
    while (currentEmail && depth < 10) {
      const dfRec = dayforceMap[currentEmail.toLowerCase()];
      if (!dfRec) break;
      const dfRow = dfRec.rawRow;
      const managerName = String(dfRow.EmployeeManager_ManagerDisplayName || "").toLowerCase();
      if (managerName.includes("anup")) {
        return true;
      }
      // Recursively lookup manager email if possible
      const managerEmail = String(dfRow.Manager_EmailCheck || dfRow.Manager_Email || "").toLowerCase().trim();
      if (managerEmail && managerEmail !== currentEmail) {
        currentEmail = managerEmail;
      } else {
        break;
      }
      depth++;
    }
    return false;
  };

  // Check 1: Google has employee (in Anup's Org), but Dayforce has no record matching email or name
  // Check 3: Google chain is broken (Not in Google Org), but Dayforce says they belong in Anup's Org (Orphan)
  googleEmails.forEach(email => {
    const pObj = googleMap[email];
    const inGoogleOrg = isEmailInAnupOrgGoogle(email);
    
    if (inGoogleOrg) {
      const sanitizedName = String(pObj.name || "").toLowerCase().replace(/[^a-z0-9]/g, '');
      const hasDayforceRecord = dayforceMap[email] || (sanitizedName && dayforceByNameMap[sanitizedName]);
      
      if (!hasDayforceRecord) {
        discrepancies.push([
          timestamp,
          email,
          pObj.name || "Unknown",
          "Employment Record Mismatch",
          "Active in Workspace Profile",
          "Missing in Dayforce Report",
          "HIGH",
          existingStatusMap[email] || "Pending"
        ]);
      }
    } else {
      // Check 3: Orphan check - Google chain is broken, but Dayforce chain verifies they are in Ops
      if (dayforceMap[email] && isEmailInAnupOrgDayforce(email)) {
        discrepancies.push([
          timestamp,
          email,
          pObj.name || "Unknown",
          "Hierarchy Broken (Orphan)",
          "Missing/Broken Manager Chain",
          "Operations (Under Anup)",
          "CRITICAL",
          existingStatusMap[email] || "Pending"
        ]);
      }
    }
  });

  // Check 2: Dayforce has employee (under Anup's Org), but Google Directory has no record matching email
  dayforceEmails.forEach(email => {
    if (googleMap[email]) return; // Already checked or active in google

    // Check if under Anup's Org in Dayforce
    if (!isEmailInAnupOrgDayforce(email)) return;

    const dfRecord = dayforceMap[email];
    const dfRow = dfRecord.rawRow;
    const name = `${dfRow.Employee_FirstName || ""} ${dfRow.Employee_LastName || ""}`.trim();

    discrepancies.push([
      timestamp,
      email,
      name || "Unknown Dayforce User",
      "Employment Record Mismatch",
      "Missing in Workspace Profile",
      "Active in Dayforce Report",
      "HIGH",
      existingStatusMap[email] || "Pending"
    ]);
  });

  // Write result to the App Audit Discrepancies sheet (Self-Healing Creation)
  let sheet = ss.getSheetByName(CONFIG.SHEETS.DATA_AUDIT);
  if (!sheet) {
    console.log("[DATA_AUDIT] Creating " + CONFIG.SHEETS.DATA_AUDIT + " on-the-fly...");
    sheet = ss.insertSheet(CONFIG.SHEETS.DATA_AUDIT);
  }

  sheet.clearContents();

  const headers = ["Timestamp", "Employee Email", "Employee Name", "Discrepancy Field", "Google Value", "Dayforce Value", "Severity", "Action Status"];
  const rowsToWrite = [headers];

  if (discrepancies.length > 0) {
    discrepancies.forEach(d => rowsToWrite.push(d));
  } else {
    rowsToWrite.push([timestamp, "N/A", "N/A", "N/A", "No discrepancies identified", "Perfect sync", "INFO", "N/A"]);
  }

  sheet.getRange(1, 1, rowsToWrite.length, rowsToWrite[0].length).setValues(rowsToWrite);
  applyFormatting(sheet);
  SpreadsheetApp.flush(); // CRITICAL: Force write to complete before the UI attempts to read it back!

  logSystemEvent(session.realEmail, "GLOBAL", `Completed Data Audit - Identified ${discrepancies.length} mismatches`, CONFIG.SHEETS.DATA_AUDIT, "Prior State", `Discrepancies: ${discrepancies.length}`);
  try {
    logBackendTelemetry("DAYFORCE_AUDIT_RUN", CONFIG.SHEETS.DATA_AUDIT, `Identified ${discrepancies.length} mismatches`, "GLOBAL");
  } catch (e) {
    console.warn("Failed to log DAYFORCE_AUDIT_RUN telemetry event:", e.message);
  }

  return `Audit complete! Identified and mapped ${discrepancies.length} account mismatches between Google directory and Dayforce. Results written to '${CONFIG.SHEETS.DATA_AUDIT}'.`;
}

/**
 * ADMIN: Fetch the list of current audit discrepancies (New/Ignored/Actioned)
 */
function getAuditDiscrepancies() {
  validateTier(3); // Admin Only
  SpreadsheetApp.flush(); // FORCE SPREADSHEET FLUSH TO BYPASS CACHING
  
  const data = getSheetData(CONFIG.SHEETS.DATA_AUDIT);
  console.log("[DATA_AUDIT] Raw fetched count from sheet: " + data.length);
  if (data.length > 0) {
    console.log("[DATA_AUDIT] Raw row 0 keys: " + Object.keys(data[0]).join(", "));
  }
  
  const filtered = data.filter(r => {
    // Alphanumeric-only key cleaning to fully immunize against whitespace, tab, or hidden character variations
    const googleValKey = Object.keys(r).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === 'googlevalue') || 'Google Value';
    const googleVal = String(r[googleValKey] || "").trim();

    const emailKey = Object.keys(r).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === 'employeeemail') || 'Employee Email';
    const email = String(r[emailKey] || "").trim();
    
    // Structured flags to filter placeholders/headers while preserving real discrepancies (even with N/A emails)
    const isPlaceholder = (googleVal.toLowerCase() === "no discrepancies identified") || 
                          (email.toLowerCase() === "n/a" && googleVal.toLowerCase() === "no discrepancies identified");
    const isHeader = (googleVal.toLowerCase() === "google value") || 
                     (email.toLowerCase() === "employee email");
    const isEmpty = (googleVal === "" && email === "");

    return !isPlaceholder && !isHeader && !isEmpty;
  });
  
  console.log("[DATA_AUDIT] Filtered count returned to UI: " + filtered.length);
  return JSON.parse(JSON.stringify(filtered));
}

/**
 * ADMIN: Check if the daily audit trigger is currently enabled.
 */
function checkAuditTriggerStatus() {
  validateTier(3);
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'auditDayforceVsGoogle') {
      return true;
    }
  }
  return false;
}

/**
 * ADMIN: Toggles the daily background audit trigger.
 * If it exists, deletes it. If it doesn't, creates it.
 */
function toggleAuditTrigger() {
  validateTier(3); // Admin Only
  
  const triggers = ScriptApp.getProjectTriggers();
  let found = false;
  
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'auditDayforceVsGoogle') {
      ScriptApp.deleteTrigger(t);
      found = true;
    }
  });
  
  if (found) {
    return { isEnabled: false, message: "Daily scan trigger has been DISABLED." };
  } else {
    ScriptApp.newTrigger('auditDayforceVsGoogle')
      .timeBased()
      .everyDays(1)
      .atHour(0)
      .create();
    return { isEnabled: true, message: "Successfully ENABLED daily midnight scan." };
  }
}

/**
 * MANAGER: Delete all allocation entries for a specific direct report and period (Unlock function)
 */
function deleteEmployeeAllocation(email, period) {
  // Strict period guardrail
  if (!period || String(period).trim() === "") {
    throw new Error("Critical Database Guardrail: Cannot delete allocation. A specific period must be explicitly provided.");
  }

  const session = validateTier(2); // Manager or above
  
  // Historical Deletion Protection Guardrail: Managers cannot delete past/historical cycles
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const currentActivePeriod = months[d.getMonth()] + " " + d.getFullYear();
  
  if (String(period).toLowerCase().trim() !== currentActivePeriod.toLowerCase().trim() && session.tier < 3) {
    throw new Error(`Critical Database Guardrail: Managers are only permitted to reset/delete allocations for the current active period (${currentActivePeriod}). Historical allocation data (${period}) is locked and cannot be altered.`);
  }
  
  // Prevent deletions during locked state unless Admin
  const state = getSystemConfig()["PHASE_1_STATE"] || "1";
  if (state === "2" && session.tier < 3) {
    throw new Error("Action failed: The database is currently locked by an Administrator.");
  }
  
  return runWithWriteLock(() => {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const tz = ss.getSpreadsheetTimeZone();
    const allocSheet = ss.getSheetByName(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
    if (!allocSheet) throw new Error("Allocation Historical sheet not found.");
    
    const allocData = allocSheet.getDataRange().getValues();
    const allocHeaders = allocData[0].map(h => String(h || "").trim());
    const emailIdx = allocHeaders.indexOf("Email Address");
    let periodIdx = allocHeaders.indexOf("Month and Year");
    if (periodIdx === -1) periodIdx = allocHeaders.indexOf("Period");
    
    if (emailIdx === -1 || periodIdx === -1) {
      throw new Error("Required columns not found in Allocation sheet.");
    }
    
    const targetEmail = String(email).toLowerCase().trim();
    const targetPeriod = String(period).toLowerCase().trim();
    
    const filteredRows = [allocHeaders];
    let removedCount = 0;
    
    for (let i = 1; i < allocData.length; i++) {
      const row = allocData[i];
      const rowEmail = String(row[emailIdx]).toLowerCase().trim();
      
      const rawP = row[periodIdx];
      const rowPeriod = (rawP instanceof Date) ? Utilities.formatDate(rawP, tz, "MMMM yyyy") : String(rawP);
      
      if (rowEmail === targetEmail && rowPeriod.toLowerCase().trim() === targetPeriod) {
        removedCount++;
      } else {
        filteredRows.push(createSafeRowForDatabase(row, tz, periodIdx));
      }
    }
    
    if (removedCount > 0) {
      allocSheet.clearContents();
      allocSheet.getRange(1, 1, filteredRows.length, filteredRows[0].length).setValues(filteredRows);
      
      // Log governance event
      logSystemEvent(session.realEmail || session.email, targetEmail, `Reset/Deleted Monthly Allocation timecard for ${period}`, CONFIG.SHEETS.ALLOCATION_HISTORICAL, `Removed ${removedCount} entries`, "Cleared (0%)");
      logBackendTelemetry("ALLOCATION_UNLOCKED", CONFIG.SHEETS.ALLOCATION_HISTORICAL, `Period: ${period} | Rows Cleared: ${removedCount}`, targetEmail);
      
      // Recalculate summary totals in employee roster to reflect 0% allocation
      recalculateEmployeeFteCache(targetEmail);
      clearUserProfileCache(targetEmail); // Bust profile cache to reflect cleared state
    }
    
    return `Successfully reset and unlocked allocations for ${email}.`;
  });
}

/**
 * ADMIN/UTILITY: Clean up corrupted allocation rows that contain prompt text or invalid periods.
 * Safe to run. Restores the database to a clean state.
 */
function cleanupCorruptedRows() {
  validateTier(3); // Admin Only
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  const allocSheet = ss.getSheetByName(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
  if (!allocSheet) throw new Error("Allocation Historical sheet not found.");
  
  const allocData = allocSheet.getDataRange().getValues();
  const allocHeaders = allocData[0].map(h => String(h || "").trim());
  const emailIdx = allocHeaders.indexOf("Email Address");
  let periodIdx = allocHeaders.indexOf("Month and Year");
  if (periodIdx === -1) periodIdx = allocHeaders.indexOf("Period");
  
  if (emailIdx === -1 || periodIdx === -1) {
    throw new Error("Required columns not found in Allocation sheet.");
  }
  
  const cleanRows = [allocHeaders];
  let removedCount = 0;
  let normalizedCount = 0;
  let isModified = false;
  
  // Valid period regex: e.g., "April 2026", "May 2026"
  const validPeriodRegex = /^[A-Za-z]+ \d{4}$/;
  
  for (let i = 1; i < allocData.length; i++) {
    const row = allocData[i];
    const rawP = row[periodIdx];
    
    let isValid = false;
    let normalizedPeriod = null;
    
    if (rawP instanceof Date) {
      isValid = true;
      normalizedPeriod = Utilities.formatDate(rawP, tz, "MMMM yyyy");
    } else {
      const rowPeriod = String(rawP || "").trim();
      if (validPeriodRegex.test(rowPeriod)) {
        isValid = true;
        normalizedPeriod = rowPeriod;
      } else if (rowPeriod !== "") {
        // Attempt parsing non-standard date variations (e.g. "April-26", "Apr-26", "01/04/2026")
        let parsedDate = null;
        try {
          const testPeriod = rowPeriod.replace(/-/g, ' ');
          const parsedTimestamp = Date.parse(testPeriod);
          if (!isNaN(parsedTimestamp)) {
            parsedDate = new Date(parsedTimestamp);
          }
        } catch(e) {}
        
        if (parsedDate) {
          isValid = true;
          normalizedPeriod = Utilities.formatDate(parsedDate, tz, "MMMM yyyy");
          normalizedCount++;
          isModified = true;
        }
      }
    }
    
    // Check if the row period contains keywords from the corrupting prompt
    if (isValid && normalizedPeriod) {
      const rowPeriodStr = normalizedPeriod.toLowerCase();
      if (rowPeriodStr.includes("emergency hotfix") || 
          rowPeriodStr.includes("deleteemployeeallocation") || 
          rowPeriodStr.includes("strict requirement") ||
          rowPeriodStr.includes("verification:") ||
          rowPeriodStr.includes("execute the following")) {
        isValid = false;
      }
    }
    
    if (isValid) {
      if (normalizedPeriod && String(rawP) !== normalizedPeriod) {
        row[periodIdx] = "'" + normalizedPeriod;
        isModified = true;
      }
      cleanRows.push(createSafeRowForDatabase(row, tz, periodIdx));
    } else {
      removedCount++;
      isModified = true;
    }
  }
  
  if (isModified) {
    allocSheet.clearContents();
    allocSheet.getRange(1, 1, cleanRows.length, cleanRows[0].length).setValues(cleanRows);
    
    // Recalculate FTE cache for affected users so their roster matches the clean state
    const affectedEmails = ["gianni.loffredo@osttra.com", "oskar.gustafsson@osttra.com"];
    affectedEmails.forEach(email => {
      recalculateEmployeeFteCache(email);
      clearUserProfileCache(email);
    });
    
    return `Clean-up Complete. Normalized ${normalizedCount} non-standard date rows. Removed ${removedCount} actual corrupted rows. Database is successfully self-healed.`;
  } else {
    return "Database is already clean and normalized. No changes needed.";
  }
}

/**
 * HELPER: Checks if an employee is active in the company (not terminated or inactive)
 */
function isActiveEmployee(e) {
  const status = String(e["HR Employment Status"] || "").toLowerCase().trim();
  const termDate = String(e["HR Termination Date"] || "").toLowerCase().trim();
  if (status.includes("term") || status.includes("inactive")) return false;
  
  const emptyTermDates = ["", "n/a", "active (no term date)", "null", "-", "none", "0"];
  if (termDate && !emptyTermDates.includes(termDate)) return false;
  return true;
}

/**
 * ADMIN: Fetch monitoring and compliance data for all employees.
 * Tracks current period allocation submissions, skill assignments, and product scope mappings.
 * Excludes employees marked with an 'Ignore' action status in the data audit.
 */
function getAdminMonitorData(period) {
  validateTier(3); // Admin Only
  
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  
  // Fetch lists
  const employees = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  const allocations = getSheetData(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
  const skills = getSheetData(CONFIG.SHEETS.SKILL_MATRIX);
  const productScopes = getSheetData(CONFIG.SHEETS.MANAGER_PRODUCT_ALLOCATION);
  const auditData = getSheetData(CONFIG.SHEETS.DATA_AUDIT);
  
  // Find ignored emails from audit mismatches (Exclude any employee explicitly marked with Action Status 'Ignore')
  const ignoredEmails = new Set(["john.stewart@osttra.com"]); // Exclude top leader from compliance tracking
  auditData.forEach(r => {
    const emailKey = Object.keys(r).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === 'employeeemail') || 'Employee Email';
    const statusKey = Object.keys(r).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === 'actionstatus') || 'Action Status';
    const rowEmail = String(r[emailKey] || "").toLowerCase().trim();
    const status = String(r[statusKey] || "").toLowerCase().trim();
    
    if (rowEmail && rowEmail !== "n/a" && status === "ignore") {
      ignoredEmails.add(rowEmail);
    }
  });
  
  // Current Period Setup
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const currentPeriod = period || (months[d.getMonth()] + " " + d.getFullYear());
  
  // Aggregate emails and total allocation percentage for fast lookup (lowercase and trimmed)
  const allocationTotals = {}; // email -> total percentage sum
  const firstAllocationRow = {}; // email -> first matching raw allocation row
  allocations.forEach(a => {
    const rawP = a["Month and Year"] !== undefined ? a["Month and Year"] : a["Period"];
    const rowPeriod = (rawP instanceof Date) ? Utilities.formatDate(rawP, tz, "MMMM yyyy") : String(rawP || "");
    if (rowPeriod.toLowerCase().trim() === currentPeriod.toLowerCase()) {
      const email = String(a["Email Address"] || "").toLowerCase().trim();
      
      const bauVal = a["Allocation BAU"] !== undefined ? a["Allocation BAU"] : a["BAU (%)"];
      const bau = parseFloat(bauVal) || 0;
      
      const nbauVal = a["Allocation Non-BAU"] !== undefined ? a["Allocation Non-BAU"] : a["Non-BAU (%)"];
      const nbau = parseFloat(nbauVal) || 0;
      
      allocationTotals[email] = (allocationTotals[email] || 0) + bau + nbau;
      
      if (!firstAllocationRow[email]) {
        firstAllocationRow[email] = a;
      }
    }
  });
  
  const skillAssigned = new Set();
  skills.forEach(s => {
    if (s["Skill Level"] && s["Skill Level"] !== "N/A" && s["Skill Level"] !== "NA" && s["Skill Level"] !== "") {
      skillAssigned.add(String(s["Email Address"] || "").toLowerCase().trim());
    }
  });
  
  const productScopeAssigned = new Set();
  productScopes.forEach(p => {
    if (p["Product"]) {
      productScopeAssigned.add(String(p["Email Address"] || "").toLowerCase().trim());
    }
  });
  
  // Map and return employee status list, excluding ignored employees
  const allValidEmails = new Set(employees.map(emp => String(emp["Email Address"] || "").toLowerCase().trim()));
  
  const results = employees
    .filter(e => e["Email Address"])
    .filter(e => !ignoredEmails.has(String(e["Email Address"]).toLowerCase().trim()))
    .map(e => {
      const email = String(e["Email Address"]).toLowerCase().trim();
      const name = (e["Google Chat Full Name"] || e["HR Name"] || `${e["First Name"] || ""} ${e["Last Name"] || ""}`).trim();
      const managerEmail = String(e["Direct Manager Email"] || e["Manager ID"] || "N/A").trim();
      const managerName = String(e["Direct Manager Name"] || "N/A").trim();
      
      const isManagerInvalid = managerEmail !== "N/A" && managerEmail !== "" && !allValidEmails.has(managerEmail.toLowerCase());
      
      const hasAllocation = allocationTotals[email] !== undefined;
      const totalAllocPct = hasAllocation ? allocationTotals[email] : 0;
      const fteStatus = !hasAllocation ? "Pending" : (totalAllocPct === 100 ? "Valid" : "Invalid");
      
      // Extract days information
      let standardWeekdays = 0;
      let weekdaysWorked = 0;
      let weekendDaysWorked = 0;
      let workedWeekend = false;
      let daysComparison = "Pending";
      
      if (hasAllocation && firstAllocationRow[email]) {
        const row = firstAllocationRow[email];
        standardWeekdays = parseInt(row["Standard Weekdays in Month"] || row["Standard Weekdays"]) || 0;
        weekdaysWorked = parseInt(row["Regular Days Worked"] || row["Weekdays Worked"]) || 0;
        weekendDaysWorked = parseFloat(row["Weekend Days Worked"]) || 0;
        
        const rawWw = row["Worked Weekend"];
        workedWeekend = (rawWw === true || rawWw === "true" || weekendDaysWorked > 0);
        
        if (weekdaysWorked + weekendDaysWorked < standardWeekdays) {
          daysComparison = "Less";
        } else if (weekdaysWorked === standardWeekdays && weekendDaysWorked === 0) {
          daysComparison = "Equal";
        } else {
          daysComparison = "More";
        }
      }
      
      return {
        name,
        email: e["Email Address"],
        managerEmail,
        managerName,
        region: e["Cost Center"] || "Global",
        hasAllocation,
        totalAllocPct,
        fteStatus,
        hasSkills: skillAssigned.has(email),
        hasProductScope: productScopeAssigned.has(email),
        // New compliance fields
        standardWeekdays,
        weekdaysWorked,
        weekendDaysWorked,
        workedWeekend,
        daysComparison,
        isActive: isActiveEmployee(e),
        hrStatus: e["HR Employment Status"] || "Active"
      };
    });
    
  return JSON.parse(JSON.stringify(results));
}

/**
 * ADMIN: Send bulk reminder notifications via email.
 */
/**
 * ADMIN: Send bulk reminder notifications via email.
 */
function sendBulkNotifications(payload) {
  validateTier(3); // Admin Only
  
  const { notificationType, selectedUsers, subject, customMessage, ccManagers, pingChat, globalCc, globalBcc } = payload;
  if (!selectedUsers || selectedUsers.length === 0) {
    throw new Error("No users selected for notification.");
  }
  if (!subject) throw new Error("Email subject is required.");
  
  const prodUrl = "https://script.google.com/a/macros/osttra.com/s/AKfycby7bDQ1d4cvOdK3aRqWmFlygrTLo5Jeio123wJQglApifdcnMbPleqymrfKoxhljOov/exec";
  const supportUrl = "https://chat.google.com/room/AAQA8P9oueE?cls=7";
  const videoUrl = "https://drive.google.com/file/d/1KI-rN_SXiOt7hSipvZl5mnAh7Lk8OCgh/view";

  let successCount = 0;
  let failureCount = 0;
  const errors = [];

  const parseEmails = (str) => {
    if (!str) return [];
    return str.split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
  };

  const extraCcList = parseEmails(globalCc);
  const bccList = parseEmails(globalBcc);

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
          .custom-msg { background-color: #F9F9F9; border-left: 4px solid #FF0061; padding: 15px; margin-bottom: 24px; font-style: italic; border-radius: 0 8px 8px 0; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; }
          th { background-color: #222222; color: #FFFFFF; text-align: left; padding: 12px; font-weight: bold; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
          td { padding: 12px; border-bottom: 1px solid #E5E5E5; color: #333333; }
          .badge { display: inline-block; padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: bold; text-transform: uppercase; }
          .badge-submitted { background-color: #E6F4EA; color: #137333; }
          .badge-pending { background-color: #FCE8E6; color: #C5221F; }
          .badge-mapped { background-color: #E8F0FE; color: #1A73E8; }
          .badge-unmapped { background-color: #FEF7E0; color: #B06000; }
          .btn-container { margin: 30px 0; text-align: center; }
          .btn-primary { display: inline-block; background: linear-gradient(135deg, #FF0061 0%, #9125BF 100%); color: #FFFFFF !important; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 10px rgba(255, 0, 97, 0.2); }
          .links-section { border-top: 1px solid #E5E5E5; padding-top: 20px; font-size: 12px; color: #555555; line-height: 1.6; }
          .links-section a { color: #FF0061; text-decoration: none; font-weight: bold; }
          .footer { background-color: #222222; padding: 24px; text-align: center; color: #888888; font-size: 11px; }
          .footer p { margin: 4px 0; }
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
            <p>© 2026 OSTTRA Group. All rights reserved.</p>
            <p>The home of <strong>MarkitServ, Traiana, TriOptima & Reset</strong></p>
          </div>
        </div>
      </body>
      </html>
    `;
  };

  selectedUsers.forEach(user => {
    try {
      const to = String(user.toEmail || user.email).trim().toLowerCase();
      const ccList = [...extraCcList];
      
      if (ccManagers && user.managerEmail && user.managerEmail !== "N/A" && user.managerEmail !== "") {
        ccList.push(String(user.managerEmail).trim().toLowerCase());
      }
      if (user.ccEmail) {
        parseEmails(user.ccEmail).forEach(e => ccList.push(e));
      }

      // Deduplicate CC list and ensure TO is excluded
      const finalCcList = [...new Set(ccList)].filter(e => e !== to);

      let htmlBody = "";
      let textBody = "";

      if (notificationType === "ALLOCATION") {
        const customBlock = customMessage ? `<div class="custom-msg">${customMessage.replace(/\n/g, "<br>")}</div>` : "";
        
        htmlBody = getEmailHtml("Action Required: Complete Your Monthly Allocation", `
          <p class="body-text">Hello,</p>
          <p class="body-text">This is an administrative reminder that your Monthly FTE Allocation is currently pending for the <strong>${payload.period || "current"}</strong> period.</p>
          ${customBlock}
          <p class="body-text">Keeping these records accurate is critical for resource visibility and delivery reporting. Please complete your submission in the portal immediately.</p>
          
          <table>
            <thead>
              <tr>
                <th>Required Task</th>
                <th>Portal Interface</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Monthly FTE Allocation</strong></td>
                <td>Personal &gt; My Allocations</td>
                <td><span class="badge badge-pending">Pending</span></td>
              </tr>
            </tbody>
          </table>

          <div class="btn-container">
            <a href="${prodUrl}" class="btn-primary">Submit Allocation in Nexus</a>
          </div>

          <div class="links-section">
            <strong>Need Help?</strong><br>
            • Support Room: <a href="${supportUrl}" target="_blank">Google Chat Support</a><br>
            • Tutorial: <a href="${videoUrl}" target="_blank">Watch Video Guide</a>
          </div>
        `);

        textBody = `Action Required: Complete Your Monthly Allocation\n\nHello,\n\nYour FTE Allocation is pending for ${payload.period || "current"}.\n\nAccess Nexus: ${prodUrl}\nSupport: ${supportUrl}\nTutorial: ${videoUrl}`;

      } else if (notificationType === "SKILLS") {
        const customBlock = customMessage ? `<div class="custom-msg">${customMessage.replace(/\n/g, "<br>")}</div>` : "";
        
        let reportRows = "";
        user.employees.forEach(emp => {
          const allocBadge = emp.hasAllocation ? `<span class="badge badge-submitted">Submitted</span>` : `<span class="badge badge-pending">Pending</span>`;
          const productBadge = emp.hasProductScope ? `<span class="badge badge-submitted">Mapped</span>` : `<span class="badge badge-pending">Unmapped</span>`;
          const skillsBadge = emp.hasSkills ? `<span class="badge badge-submitted">Certified</span>` : `<span class="badge badge-pending">Uncertified</span>`;
          
          let action = [];
          if (!emp.hasProductScope) action.push("Assign Product");
          if (!emp.hasSkills) action.push("Verify Skills");
          if (action.length === 0) action.push("None");

          reportRows += `
            <tr>
              <td><strong>${emp.name}</strong><br><span style="font-size:10px;color:#888;">${emp.email}</span></td>
              <td>${allocBadge}</td>
              <td>${productBadge}</td>
              <td>${skillsBadge}</td>
              <td style="font-weight:bold;color:#FF0061;">${action.join(" & ")}</td>
            </tr>
          `;
        });

        htmlBody = getEmailHtml("Action Required: Team Product & Skills Mapping", `
          <p class="body-text">Dear Manager (${user.managerName || "Manager"}),</p>
          <p class="body-text">This is a reminder that the following direct reports on your team have pending product mappings or skill certifications in the Nexus database.</p>
          ${customBlock}
          <p class="body-text">Please review and update their assignments in the Teams interface immediately to ensure compliance.</p>
          
          <table>
            <thead>
              <tr>
                <th>Direct Report</th>
                <th>Allocation</th>
                <th>Product Scope</th>
                <th>Skills Matrix</th>
                <th>Required Manager Action</th>
              </tr>
            </thead>
            <tbody>
              ${reportRows}
            </tbody>
          </table>

          <div class="btn-container">
            <a href="${prodUrl}" class="btn-primary">Update Assignments in Nexus</a>
          </div>

          <div class="links-section">
            <strong>Need Help?</strong><br>
            • Support Room: <a href="${supportUrl}" target="_blank">Google Chat Support</a><br>
            • Tutorial: <a href="${videoUrl}" target="_blank">Watch Video Guide</a>
          </div>
        `);

        textBody = `Action Required: Team Product & Skills Mapping\n\nDear Manager,\n\nYour direct reports have pending product mappings or skill certifications.\n\nAccess Nexus: ${prodUrl}\nSupport: ${supportUrl}\nTutorial: ${videoUrl}`;
      }

      const options = {
        htmlBody: htmlBody
      };
      
      if (finalCcList.length > 0) {
        options.cc = finalCcList.join(",");
      }
      if (bccList.length > 0) {
        options.bcc = bccList.join(",");
      }

      MailApp.sendEmail(to, subject, textBody, options);
      successCount++;

      // Simultaneous Google Chat Group Ping
      if (pingChat) {
        try {
          const memberships = [{ member: { name: 'users/' + to } }];
          finalCcList.forEach(cc => {
            memberships.push({ member: { name: 'users/' + cc } });
          });
          
          // Setup Group Chat space with the Bot, Employee, and Manager
          const space = Chat.Spaces.setup({
            space: {
              spaceType: 'GROUP_CHAT',
              displayName: 'Nexus Compliance Alert'
            },
            memberships: memberships
          });
          
          // Send the message into the newly setup group chat
          let chatMessage = `*${subject}*\n\n`;
          if (customMessage) chatMessage += `_${customMessage}_\n\n`;
          
          if (notificationType === "ALLOCATION") {
            chatMessage += `Your FTE Allocation is pending for *${payload.period || "current"}*. Please complete it immediately.\n\n`;
          } else {
            chatMessage += `The following direct reports have pending product mappings or skill certifications:\n`;
            user.employees.forEach(emp => {
              chatMessage += `• *${emp.name}* (Product: ${emp.hasProductScope ? '🟢 Mapped' : '🔴 Unmapped'} | Skills: ${emp.hasSkills ? '🟢 Certified' : '🔴 Uncertified'})\n`;
            });
            chatMessage += `\nPlease update their assignments in the Teams interface.\n\n`;
          }
          chatMessage += `*Portal Link:* ${prodUrl}\n*Support:* ${supportUrl}\n*Tutorial:* ${videoUrl}`;
          
          Chat.Spaces.Messages.create({ text: chatMessage }, space.name);
        } catch (chatErr) {
          console.error(`Google Chat Ping failed for ${to}: ${chatErr.message}`);
          errors.push(`Chat Ping Error (${to}): ${chatErr.message}`);
        }
      }

    } catch (e) {
      failureCount++;
      errors.push(`${user.toEmail || user.email || user.originalEmail || "Unknown"}: ${e.message}`);
    }
  });

  logSystemEvent(
    getCurrentUserSession().email, 
    "SYSTEM", 
    `Dispatched ${successCount} ${notificationType} Reminders (Failed: ${failureCount})`, 
    "NONE", 
    `CC Managers: ${ccManagers} | Ping Chat: ${pingChat}`, 
    subject
  );
  
  // Log telemetry (Project Nexus)
  try {
    logBackendTelemetry(
      "BULK_EMAILS_SENT",
      "NONE",
      `Dispatched: ${successCount} | Failed: ${failureCount} | CC Managers: ${ccManagers}`,
      "SYSTEM"
    );
  } catch (e) {
    console.warn("Failed to log BULK_EMAILS_SENT telemetry event:", e.message);
  }
  
  return {
    success: true,
    successCount,
    failureCount,
    errors
  };
}

/**
 * ADMIN: Update Action Status for a specific mismatch discrepancy.
 * Stores status (Pending, Discrepancy, Ignore) in the DATA_AUDIT sheet.
 */
function updateAuditStatus(email, newStatus) {
  const session = validateTier(3); // Admin Only
  
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEETS.DATA_AUDIT);
  if (!sheet) throw new Error("App Audit Discrepancies sheet not found.");
  
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h || "").trim());
  const emailIdx = headers.indexOf("Employee Email");
  let statusIdx = headers.indexOf("Action Status");
  
  if (emailIdx === -1) {
    throw new Error("Required column 'Employee Email' missing in App Audit Discrepancies.");
  }
  
  // Self-Healing: If 'Action Status' column doesn't exist yet, append it dynamically
  if (statusIdx === -1) {
    statusIdx = headers.length;
    sheet.getRange(1, statusIdx + 1).setValue("Action Status");
    // Format the new header if applyFormatting exists
    try { applyFormatting(sheet); } catch(e) {}
  }
  
  const targetEmail = String(email).toLowerCase().trim();
  let updated = false;
  
  for (let i = 1; i < data.length; i++) {
    const rowEmail = String(data[i][emailIdx]).toLowerCase().trim();
    if (rowEmail === targetEmail) {
      sheet.getRange(i + 1, statusIdx + 1).setValue(newStatus);
      updated = true;
    }
  }
  
  if (!updated) {
    throw new Error(`Discrepancy record for email '${email}' not found.`);
  }
  
  logSystemEvent(session.realEmail, targetEmail, `Updated discrepancy action status: ${newStatus}`, CONFIG.SHEETS.DATA_AUDIT, "N/A", newStatus);
  return true;
}

/**
 * ADMIN: Aggregates system telemetry logs for the internal adoption dashboard.
 * Parses the "App System Logs" sheet for high-value metrics over the last 30 days.
 */
function getSystemTelemetry() {
  validateTier(3); // Admin Only
  
  const rawLogs = getSheetData(CONFIG.SHEETS.SYSTEM_LOGS);
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
  
  const dailyActivity = {}; // "YYYY-MM-DD" -> Set of unique active users
  const eventCounts = {
    ALLOCATION_SUBMITTED: 0,
    MANAGER_PROXY_SUBMITTED: 0,
    ALLOCATION_UNLOCKED: 0,
    PRODUCT_SCOPE_ASSIGNED: 0,
    SKILL_ASSIGNED: 0,
    ANALYTICS_VIEWED: 0,
    FINANCE_REPORT_EXPORTED: 0,
    DB_BACKUP_EXECUTED: 0,
    REPORT_PUBLISHED: 0,
    REPORT_DELETED: 0,
    SYSTEM_STATE_CHANGED: 0,
    DAYFORCE_AUDIT_RUN: 0,
    BULK_EMAILS_SENT: 0
  };
  
  const uniqueUsers = new Set();
  const recentLogs = [];
  
  // Parse rows
  rawLogs.forEach(row => {
    // Alphanumeric clean key check to be fully robust
    const timestampKey = Object.keys(row).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === 'timestamp') || 'Timestamp';
    const actionKey = Object.keys(row).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === 'actiontype') || 'Action Type';
    const actorKey = Object.keys(row).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === 'actoremail') || 'Actor Email';
    
    const timestampStr = row[timestampKey];
    const action = row[actionKey];
    const actor = row[actorKey];
    
    if (!timestampStr || !action || !ALLOWED_TELEMETRY_EVENTS.includes(action)) return;
    
    const timestamp = new Date(timestampStr);
    if (isNaN(timestamp.getTime())) return;
    
    // Aggregate over the last 30 days
    if (timestamp >= thirtyDaysAgo) {
      uniqueUsers.add(actor);
      
      // Daily Active Users
      const dateKey = Utilities.formatDate(timestamp, "GMT", "yyyy-MM-dd");
      if (!dailyActivity[dateKey]) dailyActivity[dateKey] = new Set();
      dailyActivity[dateKey].add(actor);
      
      // Counts
      if (eventCounts[action] !== undefined) {
        eventCounts[action]++;
      }
    }
    
    // Collect the 50 most recent events for live feed
    recentLogs.push({
      timestamp: Utilities.formatDate(timestamp, "GMT", "yyyy-MM-dd HH:mm:ss"),
      actor: actor,
      action: action,
      target: row["Target Email"] || row["Target"] || "N/A",
      details: row["After State"] || row["After"] || ""
    });
  });
  
  // Format daily active users for Chart.js
  const sortedDates = Object.keys(dailyActivity).sort();
  const chartData = {
    labels: sortedDates,
    values: sortedDates.map(date => dailyActivity[date].size)
  };
  
  // Sort logs by date descending and slice to 50
  recentLogs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const finalRecentLogs = recentLogs.slice(0, 50);
  
  return JSON.parse(JSON.stringify({
    activeUserCount30D: uniqueUsers.size,
    eventCounts: eventCounts,
    chartData: chartData,
    recentLogs: finalRecentLogs
  }));
}