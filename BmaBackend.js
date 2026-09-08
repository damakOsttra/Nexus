/**
 * BmaBackend.js
 * Backend service for Business Management Admin (BMA) master data and financial mappings.
 */

/**
 * Checks if the caller has BMA User or Admin permission.
 * Throws an error if unauthorized.
 */
function checkBmaAuth() {
  const session = getCurrentUserSession();
  if (!session || !session.isBmaUser) {
    throw new Error("🚫 Unauthorized: BMA or Admin credentials required.");
  }
}

/**
 * Runs DB auto-migration schemas.
 */
function forceDbMigration() {
  checkBmaAuth();
  return initializeDatabaseSchema();
}

/**
 * Fetch all necessary master data for the BMA Admin Dashboard.
 */
function getBmaMasterData() {
  checkBmaAuth();
  
  // Make sure the sheets exist
  initializeDatabaseSchema();
  
  const csProducts = getSheetData(CONFIG.SHEETS.PRODUCTS);
  const skills = getSheetData(CONFIG.SHEETS.SKILL_LEVELS);
  const financeProducts = getSheetData(CONFIG.SHEETS.FINANCE_PRODUCTS);
  const mappings = getSheetData(CONFIG.SHEETS.FINANCE_MAPPING);
  
  return {
    csProducts: csProducts,
    skills: skills,
    financeProducts: financeProducts,
    mappings: mappings
  };
}

/**
 * Create or Update CS Product
 */
function saveCsProduct(id, product, subProduct, isActive) {
  checkBmaAuth();
  return runWithWriteLock(() => {
    if (!product || !subProduct) {
      throw new Error("Product and Sub-Product names are required.");
    }
    
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.PRODUCTS);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    
    const idCol = headers.indexOf("Product ID");
    const prodCol = headers.indexOf("Product");
    const subCol = headers.indexOf("Sub-Product");
    const actCol = headers.indexOf("Is Active");
    
    if (idCol === -1 || prodCol === -1 || subCol === -1) {
      throw new Error("App Product Data sheet is missing required columns.");
    }
    
    let targetRowIndex = -1;
    let finalId = id;
    
    if (id) {
      // Find existing
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][idCol]).trim() === String(id).trim()) {
          targetRowIndex = i + 1;
          break;
        }
      }
    }
    
    if (targetRowIndex === -1) {
      // Generate sequential ID like P143
      let maxNum = 0;
      for (let i = 1; i < data.length; i++) {
        const val = String(data[i][idCol]).trim();
        const match = val.match(/^P(\d+)$/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      }
      finalId = "P" + (maxNum + 1);
    }
    
    const activeVal = (isActive === "true" || isActive === true || isActive === undefined) ? "TRUE" : "FALSE";
    
    if (targetRowIndex !== -1) {
      const oldProduct = String(data[targetRowIndex - 1][prodCol] || "").trim();
      const oldSubProduct = String(data[targetRowIndex - 1][subCol] || "").trim();

      sheet.getRange(targetRowIndex, prodCol + 1).setValue(product);
      sheet.getRange(targetRowIndex, subCol + 1).setValue(subProduct);
      if (actCol !== -1) {
        sheet.getRange(targetRowIndex, actCol + 1).setValue(activeVal);
      }

      // Cascade rename to other sheets if changed
      cascadeCsProductRename(oldProduct, oldSubProduct, product, subProduct);
    } else {
      const rowValues = [];
      rowValues[idCol] = finalId;
      rowValues[prodCol] = product;
      rowValues[subCol] = subProduct;
      if (actCol !== -1) {
        rowValues[actCol] = activeVal;
      }
      sheet.appendRow(rowValues);
    }
    
    SpreadsheetApp.flush();
    clearSheetCache(CONFIG.SHEETS.PRODUCTS);
    return { success: true, id: finalId };
  });
}

/**
 * Cascades CS Product and Sub-Product rename across:
 * 1. App Employee Allocation Data (Historical Allocations)
 * 2. App Manager Product Allocation (Manager Scope)
 * 3. App Finance Mapping (Finance Mappings)
 */
function cascadeCsProductRename(oldProd, oldSub, newProd, newSub) {
  const oProd = String(oldProd || "").trim();
  const oSub = String(oldSub || "").trim();
  const nProd = String(newProd || "").trim();
  const nSub = String(newSub || "").trim();

  // If there's no actual change, return early
  if (oProd === nProd && oSub === nSub) return;

  const ss = getSpreadsheet();

  // 1. UPDATE CONFIG.SHEETS.ALLOCATION_HISTORICAL
  const histSheet = ss.getSheetByName(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
  if (histSheet) {
    const histData = histSheet.getDataRange().getValues();
    const histHeaders = histData[0];
    const pCol = histHeaders.indexOf("Product");
    const sCol = histHeaders.indexOf("Sub-Product");
    if (pCol !== -1 && sCol !== -1) {
      let updatedCount = 0;
      for (let i = 1; i < histData.length; i++) {
        if (String(histData[i][pCol]).trim() === oProd && String(histData[i][sCol]).trim() === oSub) {
          histSheet.getRange(i + 1, pCol + 1).setValue(nProd);
          histSheet.getRange(i + 1, sCol + 1).setValue(nSub);
          updatedCount++;
        }
      }
      console.log(`[CASCADE] Updated ${updatedCount} historical allocations from "${oProd} | ${oSub}" to "${nProd} | ${nSub}"`);
    }
  }

  // 2. UPDATE CONFIG.SHEETS.MANAGER_PRODUCT_ALLOCATION
  const mgrSheet = ss.getSheetByName(CONFIG.SHEETS.MANAGER_PRODUCT_ALLOCATION);
  if (mgrSheet) {
    const mgrData = mgrSheet.getDataRange().getValues();
    const mgrHeaders = mgrData[0];
    const pCol = mgrHeaders.indexOf("Product");
    const sCol = mgrHeaders.indexOf("Sub-Product");
    if (pCol !== -1 && sCol !== -1) {
      let updatedCount = 0;
      for (let i = 1; i < mgrData.length; i++) {
        if (String(mgrData[i][pCol]).trim() === oProd && String(mgrData[i][sCol]).trim() === oSub) {
          mgrSheet.getRange(i + 1, pCol + 1).setValue(nProd);
          mgrSheet.getRange(i + 1, sCol + 1).setValue(nSub);
          updatedCount++;
        }
      }
      console.log(`[CASCADE] Updated ${updatedCount} manager scope mappings from "${oProd} | ${oSub}" to "${nProd} | ${nSub}"`);
    }
  }

  // 3. UPDATE CONFIG.SHEETS.FINANCE_MAPPING
  const finSheet = ss.getSheetByName(CONFIG.SHEETS.FINANCE_MAPPING);
  if (finSheet) {
    const finData = finSheet.getDataRange().getValues();
    const finHeaders = finData[0];
    const pCol = finHeaders.indexOf("CS Product Name");
    const sCol = finHeaders.indexOf("CS Sub-Product");
    if (pCol !== -1 && sCol !== -1) {
      let updatedCount = 0;
      for (let i = 1; i < finData.length; i++) {
        if (String(finData[i][pCol]).trim() === oProd && String(finData[i][sCol]).trim() === oSub) {
          finSheet.getRange(i + 1, pCol + 1).setValue(nProd);
          finSheet.getRange(i + 1, sCol + 1).setValue(nSub);
          updatedCount++;
        }
      }
      console.log(`[CASCADE] Updated ${updatedCount} finance mappings from "${oProd} | ${oSub}" to "${nProd} | ${nSub}"`);
    }
  }

  // 4. UPDATE CONFIG.SHEETS.SKILL_MATRIX
  const skillSheet = ss.getSheetByName(CONFIG.SHEETS.SKILL_MATRIX);
  if (skillSheet) {
    const skillData = skillSheet.getDataRange().getValues();
    const skillHeaders = skillData[0];
    const pCol = skillHeaders.indexOf("Product");
    const sCol = skillHeaders.indexOf("Sub-Product");
    if (pCol !== -1 && sCol !== -1) {
      let updatedCount = 0;
      for (let i = 1; i < skillData.length; i++) {
        if (String(skillData[i][pCol]).trim() === oProd && String(skillData[i][sCol]).trim() === oSub) {
          skillSheet.getRange(i + 1, pCol + 1).setValue(nProd);
          skillSheet.getRange(i + 1, sCol + 1).setValue(nSub);
          updatedCount++;
        }
      }
      console.log(`[CASCADE] Updated ${updatedCount} skill matrix records from "${oProd} | ${oSub}" to "${nProd} | ${nSub}"`);
    }
  }

  SpreadsheetApp.flush();
  clearSheetCache(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
  clearSheetCache(CONFIG.SHEETS.MANAGER_PRODUCT_ALLOCATION);
  clearSheetCache(CONFIG.SHEETS.FINANCE_MAPPING);
  clearSheetCache(CONFIG.SHEETS.SKILL_MATRIX);
}

/**
 * Toggle CS Product Active/Inactive (Soft Delete / Archive)
 */
function toggleCsProductStatus(id, isActive) {
  checkBmaAuth();
  return runWithWriteLock(() => {
    if (!id) throw new Error("Product ID is required.");
    
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.PRODUCTS);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf("Product ID");
    const actCol = headers.indexOf("Is Active");
    
    if (idCol === -1 || actCol === -1) {
      throw new Error("Missing Product ID or Is Active columns in sheet.");
    }
    
    const activeVal = isActive === "true" || isActive === true ? "TRUE" : "FALSE";
    
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]).trim() === String(id).trim()) {
        sheet.getRange(i + 1, actCol + 1).setValue(activeVal);
        SpreadsheetApp.flush();
        clearSheetCache(CONFIG.SHEETS.PRODUCTS);
        return { success: true };
      }
    }
    throw new Error("Product not found: " + id);
  });
}

/**
 * Create or Update Skill Definition
 */
function saveSkill(id, points, description, level) {
  checkBmaAuth();
  return runWithWriteLock(() => {
    if (!description || !level) {
      throw new Error("Skill Description and Level are required.");
    }
    
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.SKILL_LEVELS);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    
    const idCol = headers.indexOf("Skill Id");
    const ptsCol = headers.indexOf("Skill Legend points");
    const descCol = headers.indexOf("Skill Description");
    const lvlCol = headers.indexOf("Skill Level");
    
    if (idCol === -1 || ptsCol === -1 || descCol === -1 || lvlCol === -1) {
      throw new Error("Skill Level Data sheet is missing required columns.");
    }
    
    let targetRowIndex = -1;
    let finalId = id;
    
    if (id) {
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][idCol]).trim() === String(id).trim()) {
          targetRowIndex = i + 1;
          break;
        }
      }
    }
    
    if (targetRowIndex === -1) {
      let maxNum = 0;
      for (let i = 1; i < data.length; i++) {
        const val = String(data[i][idCol]).trim();
        const match = val.match(/^S(\d+)$/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      }
      finalId = "S" + (maxNum + 1);
    }
    
    if (targetRowIndex !== -1) {
      sheet.getRange(targetRowIndex, ptsCol + 1).setValue(points);
      sheet.getRange(targetRowIndex, descCol + 1).setValue(description);
      sheet.getRange(targetRowIndex, lvlCol + 1).setValue(level);
    } else {
      const rowValues = [];
      rowValues[idCol] = finalId;
      rowValues[ptsCol] = points;
      rowValues[descCol] = description;
      rowValues[lvlCol] = level;
      sheet.appendRow(rowValues);
    }
    
    SpreadsheetApp.flush();
    clearSheetCache(CONFIG.SHEETS.SKILL_LEVELS);
    return { success: true, id: finalId };
  });
}

/**
 * Delete Skill
 */
function deleteSkill(id) {
  checkBmaAuth();
  return runWithWriteLock(() => {
    if (!id) throw new Error("Skill ID is required.");
    
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.SKILL_LEVELS);
    const data = sheet.getDataRange().getValues();
    const idCol = data[0].indexOf("Skill Id");
    
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]).trim() === String(id).trim()) {
        sheet.deleteRow(i + 1);
        SpreadsheetApp.flush();
        clearSheetCache(CONFIG.SHEETS.SKILL_LEVELS);
        return { success: true };
      }
    }
    throw new Error("Skill not found: " + id);
  });
}

/**
 * Create or Update Finance Product
 */
function saveFinanceProduct(id, product, subProduct, isActive) {
  checkBmaAuth();
  return runWithWriteLock(() => {
    if (!product || !subProduct) {
      throw new Error("Finance Product and Sub-Product names are required.");
    }
    
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.FINANCE_PRODUCTS);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    
    const idCol = headers.indexOf("Finance Product ID");
    const prodCol = headers.indexOf("Finance Product");
    const subCol = headers.indexOf("Finance Sub-Product");
    const actCol = headers.indexOf("Is Active");
    
    let targetRowIndex = -1;
    let finalId = id;
    
    if (id) {
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][idCol]).trim() === String(id).trim()) {
          targetRowIndex = i + 1;
          break;
        }
      }
    }
    
    if (targetRowIndex === -1) {
      let maxNum = 0;
      for (let i = 1; i < data.length; i++) {
        const val = String(data[i][idCol]).trim();
        const match = val.match(/^F(\d+)$/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      }
      finalId = "F" + (maxNum + 1);
    }
    
    const activeVal = isActive === "true" || isActive === true ? "TRUE" : "FALSE";
    
    if (targetRowIndex !== -1) {
      const oldProduct = String(data[targetRowIndex - 1][prodCol] || "").trim();
      const oldSubProduct = String(data[targetRowIndex - 1][subCol] || "").trim();

      sheet.getRange(targetRowIndex, prodCol + 1).setValue(product);
      sheet.getRange(targetRowIndex, subCol + 1).setValue(subProduct);
      sheet.getRange(targetRowIndex, actCol + 1).setValue(activeVal);

      // Cascade rename to other sheets if changed
      cascadeFinanceProductRename(oldProduct, oldSubProduct, product, subProduct);
    } else {
      const rowValues = [];
      rowValues[idCol] = finalId;
      rowValues[prodCol] = product;
      rowValues[subCol] = subProduct;
      rowValues[actCol] = activeVal;
      sheet.appendRow(rowValues);
    }
    
    SpreadsheetApp.flush();
    clearSheetCache(CONFIG.SHEETS.FINANCE_PRODUCTS);
    return { success: true, id: finalId };
  });
}

/**
 * Cascades Finance Product and Sub-Product rename across:
 * 1. App Finance Mapping (Finance Mappings)
 */
function cascadeFinanceProductRename(oldProd, oldSub, newProd, newSub) {
  const oProd = String(oldProd || "").trim();
  const oSub = String(oldSub || "").trim();
  const nProd = String(newProd || "").trim();
  const nSub = String(newSub || "").trim();

  // If there's no actual change, return early
  if (oProd === nProd && oSub === nSub) return;

  const ss = getSpreadsheet();

  // 1. UPDATE CONFIG.SHEETS.FINANCE_MAPPING
  const finSheet = ss.getSheetByName(CONFIG.SHEETS.FINANCE_MAPPING);
  if (finSheet) {
    const finData = finSheet.getDataRange().getValues();
    const finHeaders = finData[0];
    const pCol = finHeaders.indexOf("Finance Product Name");
    const sCol = finHeaders.indexOf("Finance Sub-Product");
    if (pCol !== -1 && sCol !== -1) {
      let updatedCount = 0;
      for (let i = 1; i < finData.length; i++) {
        if (String(finData[i][pCol]).trim() === oProd && String(finData[i][sCol]).trim() === oSub) {
          finSheet.getRange(i + 1, pCol + 1).setValue(nProd);
          finSheet.getRange(i + 1, sCol + 1).setValue(nSub);
          updatedCount++;
        }
      }
      console.log(`[CASCADE] Updated ${updatedCount} finance mappings from Finance Product "${oProd} | ${oSub}" to "${nProd} | ${nSub}"`);
    }
  }

  SpreadsheetApp.flush();
  clearSheetCache(CONFIG.SHEETS.FINANCE_MAPPING);
}

/**
 * Toggle Finance Product Active/Inactive (Soft Delete / Archive)
 */
function toggleFinanceProductStatus(id, isActive) {
  checkBmaAuth();
  return runWithWriteLock(() => {
    if (!id) throw new Error("Finance Product ID is required.");
    
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.FINANCE_PRODUCTS);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf("Finance Product ID");
    const actCol = headers.indexOf("Is Active");
    
    if (idCol === -1 || actCol === -1) {
      throw new Error("Missing Finance Product ID or Is Active columns in sheet.");
    }
    
    const activeVal = isActive === "true" || isActive === true ? "TRUE" : "FALSE";
    
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]).trim() === String(id).trim()) {
        sheet.getRange(i + 1, actCol + 1).setValue(activeVal);
        SpreadsheetApp.flush();
        clearSheetCache(CONFIG.SHEETS.FINANCE_PRODUCTS);
        return { success: true };
      }
    }
    throw new Error("Finance Product not found: " + id);
  });
}

/**
 * Create or Update Finance Mapping with overlap checking
 */
/**
 * Create or Update Finance Mapping (Simplified Archive Toggle)
 */
function saveFinanceMapping(mappingId, csProductId, financeProductId, capTag, isActive) {
  checkBmaAuth();
  return runWithWriteLock(() => {
    if (!csProductId || !financeProductId || !capTag) {
      throw new Error("CS Product, Finance Product, and Cap Tag are required.");
    }
    
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.FINANCE_MAPPING);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    
    const mapIdCol = headers.indexOf("Mapping ID");
    const csIdCol = headers.indexOf("CS Product ID");
    const actCol = headers.indexOf("Is Active");
    
    if (mapIdCol === -1 || csIdCol === -1 || actCol === -1) {
      throw new Error("Finance Mapping sheet is missing required columns.");
    }

    const activeVal = (isActive === "true" || isActive === true) ? "TRUE" : "FALSE";

    // Check if trying to activate this mapping, and see if ANOTHER active mapping already exists for this CS Product ID
    if (activeVal === "TRUE") {
      for (let i = 1; i < data.length; i++) {
        if (mappingId && String(data[i][mapIdCol]).trim() === String(mappingId).trim()) {
          continue; // Skip itself
        }
        if (String(data[i][csIdCol]).trim() === String(csProductId).trim()) {
          const otherActive = String(data[i][actCol]).trim().toUpperCase() === "TRUE";
          if (otherActive) {
            throw new Error(`Activation Blocked: CS Product is already actively mapped on Mapping ID ${data[i][mapIdCol]}. To avoid duplicate records during exports, please Archive that existing mapping first before activating this one.`);
          }
        }
      }
    }

    // Read references to build the denormalized record
    const csProducts = getSheetData(CONFIG.SHEETS.PRODUCTS);
    const finProducts = getSheetData(CONFIG.SHEETS.FINANCE_PRODUCTS);
    
    const csProd = csProducts.find(p => String(p["Product ID"] || p["Product_ID"]) === String(csProductId));
    const finProd = finProducts.find(p => String(p["Finance Product ID"] || p["Finance_Product_ID"]) === String(financeProductId));
    
    if (!csProd) throw new Error("Client Services Product not found for ID: " + csProductId);
    if (!finProd) throw new Error("Finance Product not found for ID: " + financeProductId);
    
    const csName = csProd["Product"] || "";
    const csSub = csProd["Sub-Product"] || "";
    const finName = finProd["Finance Product"] || "";
    const finSub = finProd["Finance Sub-Product"] || "";
    
    let targetRowIndex = -1;
    let finalId = mappingId;
    
    if (mappingId) {
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][mapIdCol]).trim() === String(mappingId).trim()) {
          targetRowIndex = i + 1;
          break;
        }
      }
    }
    
    if (targetRowIndex === -1) {
      let maxNum = 0;
      for (let i = 1; i < data.length; i++) {
        const val = String(data[i][mapIdCol]).trim();
        const match = val.match(/^M(\d+)$/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      }
      finalId = "M" + (maxNum + 1);
    }
    
    const currentUser = getCurrentUserSession().email;
    const currentTimestamp = new Date().toISOString();
    
    const rowValues = [];
    rowValues[headers.indexOf("Mapping ID")] = finalId;
    rowValues[headers.indexOf("CS Product ID")] = csProductId;
    rowValues[headers.indexOf("CS Product Name")] = csName;
    rowValues[headers.indexOf("CS Sub-Product")] = csSub;
    rowValues[headers.indexOf("Finance Product ID")] = financeProductId;
    rowValues[headers.indexOf("Finance Product Name")] = finName;
    rowValues[headers.indexOf("Finance Sub-Product")] = finSub;
    rowValues[headers.indexOf("Cap Tag")] = capTag;
    rowValues[headers.indexOf("Is Active")] = activeVal;
    rowValues[headers.indexOf("Updated By")] = currentUser;
    rowValues[headers.indexOf("Updated At")] = currentTimestamp;
    
    if (targetRowIndex !== -1) {
      sheet.getRange(targetRowIndex, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }
    
    SpreadsheetApp.flush();
    clearSheetCache(CONFIG.SHEETS.FINANCE_MAPPING);
    return { success: true, id: finalId };
  });
}

/**
 * Toggle Finance Mapping Active/Inactive (Soft Delete / Archive)
 */
function toggleFinanceMappingStatus(id, isActive) {
  checkBmaAuth();
  return runWithWriteLock(() => {
    if (!id) throw new Error("Mapping ID is required.");
    
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.FINANCE_MAPPING);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    
    const mapIdCol = headers.indexOf("Mapping ID");
    const csIdCol = headers.indexOf("CS Product ID");
    const actCol = headers.indexOf("Is Active");
    
    if (mapIdCol === -1 || csIdCol === -1 || actCol === -1) {
      throw new Error("Missing required columns in Finance Mapping sheet.");
    }
    
    const activeVal = isActive === "true" || isActive === true ? "TRUE" : "FALSE";
    
    // Find current mapping record to get its CS Product ID
    let targetRowIndex = -1;
    let csProductId = "";
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][mapIdCol]).trim() === String(id).trim()) {
        targetRowIndex = i + 1;
        csProductId = String(data[i][csIdCol]).trim();
        break;
      }
    }
    
    if (targetRowIndex === -1) throw new Error("Mapping record not found: " + id);
    
    // If activating, verify that no other mapping is currently active for this CS Product
    if (activeVal === "TRUE") {
      for (let i = 1; i < data.length; i++) {
        if (i + 1 === targetRowIndex) continue; // Skip itself
        if (String(data[i][csIdCol]).trim() === csProductId) {
          const otherActive = String(data[i][actCol]).trim().toUpperCase() === "TRUE";
          if (otherActive) {
            throw new Error(`Activation Blocked: CS Product is already actively mapped on Mapping ID ${data[i][mapIdCol]}. Please Archive that existing mapping first.`);
          }
        }
      }
    }
    
    sheet.getRange(targetRowIndex, actCol + 1).setValue(activeVal);
    SpreadsheetApp.flush();
    clearSheetCache(CONFIG.SHEETS.FINANCE_MAPPING);
    return { success: true };
  });
}

/**
 * Fetch Mapping History for a given CS Product
 */
function getMappingHistory(csProductId) {
  checkBmaAuth();
  const mappings = getSheetData(CONFIG.SHEETS.FINANCE_MAPPING);
  return mappings.filter(m => String(m["CS Product ID"] || m["CS_Product_ID"]) === String(csProductId));
}

/**
 * Fetch list of unique periods available for export
 */
function getAvailableFinancePeriods() {
  checkBmaAuth();
  
  const ss = getSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  const allocs = getSheetData(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
  
  const periods = new Set();
  allocs.forEach(a => {
    const rawP = a["Month and Year"] !== undefined ? a["Month and Year"] : a["Period"];
    if (!rawP) return;
    const period = (rawP instanceof Date) ? Utilities.formatDate(rawP, tz, "MMMM yyyy") : String(rawP || "").trim();
    if (period) periods.add(period);
  });
  
  // Sort descending (Newest first)
  return Array.from(periods).sort((a, b) => {
    const dateA = new Date(a);
    const dateB = new Date(b);
    return dateB - dateA;
  });
}

/**
 * Execute Mapped Point-in-Time Finance Export
 */
function executeBmaFinanceExport(selectedPeriod) {
  checkBmaAuth();
  if (!selectedPeriod) throw new Error("Please specify an export period.");
  
  const ss = getSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  
  const employees = getSheetData(CONFIG.SHEETS.EMPLOYEES);
  const allocs = getSheetData(CONFIG.SHEETS.ALLOCATION_HISTORICAL);
  const mappings = getSheetData(CONFIG.SHEETS.FINANCE_MAPPING);
  
  // 1. Create quick lookup for employee demographics (Name, Cost Center/Region)
  const empMap = {};
  employees.forEach(emp => {
    if (!emp["Email Address"]) return;
    const email = String(emp["Email Address"]).toLowerCase().trim();
    const name = (emp["Google Chat Full Name"] || emp["HR Name"] || `${emp["First Name"] || ""} ${emp["Last Name"] || ""}`).trim();
    const region = String(emp["Cost Center"] || "Global").trim();
    empMap[email] = { name, region };
  });
  
  // 2. Map CS Product Name + Sub-Product to active Finance details
  // Filter mappings to active only
  const activeMappings = mappings.filter(m => String(m["Is Active"] || m["Is_Active"] || "").trim().toUpperCase() === "TRUE");
  
  // Create mapping map: "CS Name | CS Sub" -> Finance Details
  const mappingLookup = {};
  activeMappings.forEach(m => {
    const csName = String(m["CS Product Name"] || m["CS_Product_Name"] || "").trim().toLowerCase();
    const csSub = String(m["CS Sub-Product"] || m["CS_Sub_Product"] || "").trim().toLowerCase();
    const key = `${csName}|${csSub}`;
    
    mappingLookup[key] = {
      finProduct: m["Finance Product Name"] || m["Finance_Product_Name"] || "",
      finSubProduct: m["Finance Sub-Product"] || m["Finance_Sub_Product"] || "",
      capTag: m["Cap Tag"] || m["Cap_Tag"] || "UNMAPPED"
    };
  });
  
  // 3. Filter historical allocations down to the selected period
  const periodLower = selectedPeriod.toLowerCase().trim();
  const filteredAllocs = allocs.filter(a => {
    const rawP = a["Month and Year"] !== undefined ? a["Month and Year"] : a["Period"];
    if (!rawP) return false;
    const period = (rawP instanceof Date) ? Utilities.formatDate(rawP, tz, "MMMM yyyy") : String(rawP || "").trim();
    return period.toLowerCase().trim() === periodLower;
  });
  
  // 4. Aggregate allocation percentages per Employee + Region + Finance Product + Sub-Product
  const aggregates = {};
  filteredAllocs.forEach(a => {
    const email = String(a["Email Address"] || "").toLowerCase().trim();
    if (!email) return;
    
    const csProdName = String(a["Product"] || "").trim();
    const csSubName = String(a["Sub-Product"] || "").trim();
    const mapKey = `${csProdName.toLowerCase()}|${csSubName.toLowerCase()}`;
    
    // Resolve mappings
    const finDetails = mappingLookup[mapKey] || {
      finProduct: "UNMAPPED",
      finSubProduct: `UNMAPPED (${csProdName} / ${csSubName})`,
      capTag: "UNMAPPED"
    };
    
    // Sum BAU + Non-BAU
    const bauVal = a["Allocation BAU"] !== undefined ? a["Allocation BAU"] : (a["BAU (%)"] !== undefined ? a["BAU (%)"] : 0);
    const nbauVal = a["Allocation Non-BAU"] !== undefined ? a["Allocation Non-BAU"] : (a["Non-BAU (%)"] !== undefined ? a["Non-BAU (%)"] : 0);
    const totalAlloc = (parseInt(bauVal, 10) || 0) + (parseInt(nbauVal, 10) || 0);
    
    if (totalAlloc <= 0) return; // Skip zero-hours logs
    
    const empInfo = empMap[email] || { name: "Unknown Employee", region: "Global" };
    
    // Grouping Key
    const groupKey = `${email}|${finDetails.finProduct}|${finDetails.finSubProduct}|${finDetails.capTag}`;
    
    if (!aggregates[groupKey]) {
      aggregates[groupKey] = {
        name: empInfo.name,
        email: email,
        region: empInfo.region,
        finProduct: finDetails.finProduct,
        finSubProduct: finDetails.finSubProduct,
        capTag: finDetails.capTag,
        totalAllocPercent: 0
      };
    }
    
    aggregates[groupKey].totalAllocPercent += totalAlloc;
  });
  
  // 5. Format results into output CSV grid
  const exportData = [["Employee Name", "Email Address", "Region", "Finance Product", "Finance Sub-Product", "Cap Tag", "Total Allocation %"]];
  
  Object.keys(aggregates).forEach(key => {
    const agg = aggregates[key];
    exportData.push([
      agg.name,
      agg.email,
      agg.region,
      agg.finProduct,
      agg.finSubProduct,
      agg.capTag,
      agg.totalAllocPercent
    ]);
  });
  
  // Log telemetry for audit (Project Nexus)
  try {
    logBackendTelemetry("FINANCE_REPORT_EXPORTED", "None", `Exported point-in-time capacity data for ${exportData.length - 1} records in period ${selectedPeriod}`, "SYSTEM");
  } catch (e) {
    console.warn("Failed to log FINANCE_REPORT_EXPORTED telemetry event:", e.message);
  }
  
  return exportData;
}
