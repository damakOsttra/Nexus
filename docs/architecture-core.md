# Nexus Core Architecture

This document outlines the foundational system mechanics of the Nexus application ecosystem, designed to ensure scalability, security, and a fluid user experience within the Google Apps Script (GAS) and GCP runtime environment.

---

## 1. 5-Tier Role-Based Access Control (RBAC) System

Nexus implements a strict, hierarchical server-side RBAC engine that governs user interfaces, API endpoints, and data visibility based on dynamic HR attributes.

*   **Implementation (`Auth.js`):** The `getInitialSession()` function dynamically evaluates the active user's identity based on their email, management line, and specific flags in the Dayforce HR system.
*   **The 5-Tier Hierarchy:**
    *   **Tier 1 (Employee):** Base access. Grants permission to view personal profile details, self-certify monthly allocations, and browse the Org Chart.
    *   **Tier 2 (Manager):** Mid-level management access. Enables data modification for direct reports, product mapping (`AssignProduct.html`), skill mapping (`AssignSkill.html`), and proxy-submitting allocations (`TeamAllocationsReview.html`).
    *   **Tier 3 (Admin):** Global system access. Grants permission to configure system-wide settings, access compliance dashboards, view real-time telemetry, and run backups.
    *   **Tier 4 (Specialized - TPM & OPEX):** Dynamically assigned based on departmental alignment (e.g., membership in specialized leadership orgs like the TPM or OPEX branches).
    *   **Tier 5 (Executive View):** Advanced executive analytics level. Calculated using a specialized "Depth Check" algorithm to grant high-level rollup reports to directors 2 levels below the department head.

---

## 2. User Impersonation ("Simulate As" Support Tool)

To facilitate high-speed technical support and ease bug replication, Nexus provides a secure user impersonation feature for system administrators.

*   **Implementation (`Auth.js` / `Code.js`):** The `simulateUser(targetEmail)` function overrides the active session email with the specified target email.
*   **Security Guardrail:** The backend strictly checks the administrator's original email:
    ```javascript
    if (!getAdminEmails().includes(realEmail)) {
      throw new Error("Unauthorized access attempt.");
    }
    ```
    This ensures that lower-tier users cannot spoof or elevate their privileges, keeping administrative actions safe and auditable.

---

## 3. Progressive UI Rendering (SPA Shell Architecture)

Nexus operates as a high-performance Single Page Application (SPA), loading code dynamically rather than delivering unnecessary administrative modules to every user.

*   **Implementation (`Code.js`):** The main entrypoint `doget(e)` intercepts incoming HTTP requests, queries the user's role via `Auth.js`, and serves the corresponding role-specific application shell:
    *   `EmployeeApp.html`
    *   `ManagerApp.html`
    *   `AdminApp.html`
    *   `OpexApp.html`
*   **Dynamic Module Routing:** The UI requests partial modules dynamically using:
    ```javascript
    google.script.run.getView(pageName)
    ```
    The backend checks permissions against a strict server-side map before serializing the requested HTML string back to the browser.

---

## 4. Application Telemetry & Audit Logging

Nexus features an asynchronous telemetry engine that monitors user activity, logs error states, and tracks overall platform adoption.

*   **Implementation (`Telemetry.js`):** The `TelemetryLogger` class buffers logging events in-memory and flushes them in batches to the telemetry database (`CONFIG.SHEETS.TELEMETRY`) to avoid hitting Google Sheets API write rate limits.
*   **Tracked System Events:**
    *   `SESSION_START`: Captures daily active users and browser environments.
    *   `MODULE_ACCESSED`: Monitors UI navigation trends.
    *   `ALLOCATION_SUBMITTED`: Audits completed compliance transactions.
    *   `ERROR`: Captures stack traces, line numbers, and active context for backend exceptions.

---

## 5. API Credential Abstraction & Rotation

To maintain rigorous security, sensitive third-party integrations (such as Atlassian Jira, People API, and Dayforce) are abstracted entirely to the server-side runtime.

*   **Implementation (`Config.js`):** Keys, tokens, and basic auth headers are retrieved dynamically using Apps Script's `PropertiesService.getScriptProperties()`.
*   **Security Benefits:** 
    *   Zero credentials or tokens are exposed to the client browser.
    *   Credential rotation is seamless: admins update the script properties directly without altering or redeploying any codebase file.

---

## 6. Scheduled Background Jobs (Cron Workers)

Heavy operations are processed asynchronously during off-peak hours using standard time-driven triggers to keep the interactive user interface fast and lightweight.

*   **Implementation (`Db.js`, `Backup.js`, `OpexBackend.js`):** Background cron instances are programmatically registered using GAS's `ScriptApp.newTrigger()` engine.
*   **Critical Scheduled Routines:**
    *   **Nightly HR Sync (`dailySyncPeopleData`):** Re-syncs employee hierarchies and roster details from Dayforce at 2:00 AM.
    *   **Automated Jira Sync (`syncOpexJiraData` / `syncTpmJiraData`):** Paginate through the Atlassian API to retrieve the latest status updates and parent Epics, caching the results to speed up client-side queries.

---

## 7. Feature Flagging & System Controls

Nexus features global toggles to lock the system for maintenance or gracefully transition the platform across deployment phases.

*   **System Offline Toggle:** Controlled by a hardcoded `SYSTEM_OFFLINE` variable in `Code.js`. If active, it intercepts all incoming requests and routes the user to `Error.html` (displaying a maintenance message) while granting access only to whitelisted system administrators.
*   **Phase State Toggles (`SystemSettings.html`):** Administrators can toggle functional phases (such as closing or opening the monthly allocation cycle). Toggling updates a config table, which client views poll to conditionally hide action buttons or show warning banners.
