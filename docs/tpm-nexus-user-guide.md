# TPM Nexus: Comprehensive User Guide & System Overview

This document provides a detailed overview of the Technical Project Management (TPM) modules within the Nexus Application. It is designed to serve as a user guide for both TPM Engineers logging their daily effort, and TPM Managers overseeing compliance and capacity.

---

## 1. The TPM Timesheet (`TpmTimesheet.html`)
The TPM Timesheet is the primary interface for engineering resources to log their daily effort against active Jira tickets, epics, and operational overhead.

### 1.1 Core Navigation & UI Elements
*   **Week Navigation Arrows:** Located in the top header, these left/right arrows allow users to seamlessly jump between past and present weeks.
*   **Date Range Display:** Shows the current active week (always beginning on a Sunday).
*   **"Sync Jira Data" Button:** Manually queries the active Atlassian Jira Cloud API to pull down the user's latest assigned epics, tasks, and bugs.
*   **"Save Timesheet Entries" Button:** Commits the current grid data to the backend database.
*   **"Add New Ticket" Button:** Allows users to manually search for and append a specific Jira ticket (e.g., "TPM-1234") to their grid if it was not auto-populated.
*   **"Lock" / "Unlock" Banner:** A prominent banner indicating the security state of the timesheet.
    *   **Locked (Red):** The week has passed and is frozen for compliance auditing. Editing is disabled.
    *   **Unlocked by Manager (Amber):** An administrator has authorized a temporary override allowing the user to edit a historical week.

### 1.2 The Timesheet Grid
The grid is grouped by logical business categories (e.g., "BAU Delivery Epics", "Platform Stability", "Administrative").

*   **Ticket Row:** Displays the Jira Key (hyperlinked to Atlassian) and the Epic/Task Summary.
*   **Daily Input Cells:** 7 columns representing the days of the active week. Users enter their effort in decimal hours (e.g., `4.5`).
*   **Phase Breakdown (Phase Split Tool):** Clicking the small "split" icon (`⇌`) next to a ticket expands a sub-row allowing the user to divide their daily hours into specific delivery phases:
    *   `INT` (Integration/Build)
    *   `UAT/GO` (User Acceptance Testing & Go-Live)
    *   `OTHER` (General overhead)
*   **Out of Office (OOO) Toggle:** The airplane icon column automatically logs a standard 8-hour block for full days off, or a 4-hour block for half-days, bypassing the need to type numbers.
*   **Delete/Trash Icon:** Removes the ticket from the active week's grid. *(Note: This only zeroes out the hours for the active week; it does not delete historical hours logged in previous weeks).*
*   **Daily Totals Footer:** A sticky footer that automatically sums the vertical columns. A cell turns Red if the user exceeds 24 hours in a single day, or turns Green when a standard 8-hour day is met.

### 1.3 How to Log Time (Standard Workflow)
1.  **Open Timesheet:** Navigate to the TPM Timesheet. The system defaults to the current active week.
2.  **Sync Tickets:** Click *Sync Jira Data* to populate your grid with your active assignments.
3.  **Enter Hours:** Type the number of hours worked into the corresponding day columns.
4.  **Allocate Non-BAU:** Scroll down to the "Administrative Operations" section to log Management, Training, or OOO hours.
5.  **Save:** Click *Save Timesheet Entries*. The system will confirm the successful log.

---

## 2. The TPM Compliance Dashboard (`TpmDashboard.html`)
The TPM Dashboard is the command center for TPM Leadership and Line Managers. It provides real-time visibility into team compliance, workload saturation, and automated nudging.

### 2.1 Core Navigation & UI Elements
*   **Date Range Picker:** Allows managers to select a custom rolling window (e.g., the past 3 weeks) to evaluate sustained compliance over time.
*   **Unlock Past Week (Manager Override):** A critical administrative tool. Clicking this opens a modal allowing the manager to authorize a temporary lock exception for a specific direct report on a specific historical week.
*   **Refresh Button:** Forces a hard reload of the compliance matrix from the Google Sheets database, bypassing the 6-hour cache.

### 2.2 The Compliance & Capacity Scoring Engine
The dashboard evaluates every employee against a rigorous scoring matrix based on their standard 1.0 FTE (40-hour) target.

*   **Compliant (Green):** The employee has logged hours (>0) or marked OOO for every eligible past weekday.
*   **Non-Compliance (Red):** The employee is missing timesheet entries for one or more past weekdays.
*   **Workload Balance Indicators:**
    *   `Balanced:` Effort logged is between 80% and 115% of their expected capacity target.
    *   `Underburdened:` Effort is below 80% (indicating potential bench capacity or incomplete logging).
    *   `Overburdened (Fire Icon):` Effort is ≥115% of the target baseline, flagging the employee for burnout risk.

### 2.3 The Roster Matrix (Data Grid)
A detailed, searchable table of all direct and indirect reports in the manager's hierarchy.

*   **Search & Filters:** Managers can instantly filter the grid by Employee Name, Compliance Status (Compliant vs Incomplete), and Workload Balance.
*   **Ticket Breakdown Accordion:** Clicking the chevron (`>`) next to an employee's name expands a detailed sub-table showing exactly *where* they spent their time, grouped by Jira status (e.g., Active, UAT, Closed).
*   **Daily Log Inspection:** Managers can click the magnifying glass icon (`🔍`) next to any ticket in the sub-table to open a "Level 3" modal showing the precise day-by-day phase breakdown of hours for that specific project.

### 2.4 Automated Nudging System
*   **Nudge Incomplete Members:** A dynamic action button that prepares a mass communication to non-compliant team members.
*   **Email Customization Panel:** Before dispatching, managers can customize the subject line and body of the reminder. The system automatically inserts variables like `[Name]` and `[MissedDates]`.
*   **Dual-Channel Delivery:** Once authorized, the system sends both a branded HTML email and a direct Google Chat Ping to the non-compliant employees.

---

## 3. Manager Overrides (Timesheet Unlocking Workflow)
If an employee fails to log their time before the week concludes, the system automatically locks the grid to preserve data integrity. Line Managers have the authority to grant exceptions.

### 3.1 How to Unlock a Timesheet (Manager)
1.  Open the **TPM Compliance Dashboard**.
2.  Click the **"Unlock Past Week"** button in the header.
3.  In the "Authorize New Exception" panel, select the specific Team Member and the specific Locked Week.
4.  Click **"Create Unlock Exception"**. The system instantly adds the override to the Active Overrides table.

### 3.2 How to Consume an Unlock (Employee)
1.  The employee navigates back to their **TPM Timesheet**.
2.  Using the arrow buttons, they navigate back to the historical week.
3.  The UI will recognize the active override, remove the locks, and display an Amber Alert Banner indicating the timesheet is unlocked.
4.  The employee enters their missing time and clicks **"Save"**.
5.  *Auto-Lock Mechanism:* The exact second the data is saved, the backend automatically "consumes" the exception and permanently re-locks the week.

### 3.3 How to Revoke an Unlock (Manager)
If a manager authorizes an unlock by mistake, they can instantly revoke it.
1.  Open the **Unlock Past Week** modal.
2.  Locate the exception in the "Active Overrides" data table.
3.  Click the red **"Revoke"** button. The employee's timesheet will instantly re-lock.
