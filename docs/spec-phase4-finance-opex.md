# Technical Specification: Phase 4 (Finance Allocation Data Supply & OPEX Tracker)

This specification defines the architecture, database design, and workflow integration for **Phase 4: Finance Allocation Data Supply & OPEX Project Tracker**. 

---

# Strategic Objective
Phase 4 bridges the gap between active operational tracking and corporate finance. It establishes a single source of truth for administrative master data, automates compliance reporting for labor capitalization, and moves the Operational Excellence (OPEX) initiatives board into a live production environment.

---

# ✦ Pillar A: Finance Allocation Data Supply

Pillar A establishes a governed, restricted interface for Business Management Admins (BMAs) to control reference data, maps Client Services allocations to corporate financial categories, and exposes an authenticated API to feed raw data into the Finance department's internal tooling.

```
                      ┌────────────────────────────────────┐
                      │      Consolidated BMA UI           │
                      │ (Admin Master Data & Mapping UI)   │
                      └─────────────────┬──────────────────┘
                                        │
                                        ▼
┌─────────────────┐       ┌─────────────┴──────────┐       ┌─────────────────┐
│ User Allocation ├──────►│   Nexus Database       ├──────►│ Finance API     │
│ Submissions (%) │       │ (CloudSQL / GAS Cache) │       │ (GET json feed) │
└─────────────────┘       └────────────────────────┘       └────────┬────────┘
                                                                    │
                                                                    ▼
                                                           ┌────────┴────────┐
                                                           │ Finance Tooling │
                                                           └─────────────────┘
```

## 1. The Consolidated BMA Master Data UI
Before migrating to GCP CloudSQL, all static and semi-static reference lists must be decoupled from code files and managed via a unified, secure database repository. BMAs and system administrators will manage these entries through a single, consolidated admin interface.

The UI governs three strict directories:
1.  **Client Services (CS) Products & Sub-Products:** The active service catalogue of CS (e.g., `MarkitWire` ➜ `DMS`, `Traiana` ➜ `Netlink`).
2.  **Finance Products & Sub-Products:** The corporate accounting hierarchy (e.g., `Rates & Credit` ➜ `Post-Trade Operations`).
3.  **Skills & Competencies:** The core skill list and designated capabilities (e.g., `Python`, `MarkitWire DMS Support` | Levels: `Novice`, `Proficient`, `Expert`).

### Proposed Database Schema (Pre-CloudSQL Sheet or DB Table Layout)
*   **Table: `REF_CS_PRODUCTS`**
    *   `id` (UUID / Primary Key)
    *   `product_name` (String)
    *   `sub_product_name` (String)
    *   `is_active` (Boolean)
*   **Table: `REF_FINANCE_PRODUCTS`**
    *   `id` (UUID / Primary Key)
    *   `finance_product` (String)
    *   `finance_sub_product` (String)
    *   `is_active` (Boolean)
*   **Table: `REF_SKILLS`**
    *   `id` (UUID / Primary Key)
    *   `skill_name` (String)
    *   `competency_levels` (Comma-separated string / JSON, e.g., `["Novice", "Proficient", "Expert"]`)

---

## 2. The Finance Mapping Engine
The BMA UI features a dedicated **Finance Mapping Table**. Every active `CS Product` and `Sub-Product` must map directly to an official `Finance Product` and `Sub-Product` to correctly classify labor costs.

### Mapping Fields
*   **CS Product Key:** Foreign key to `REF_CS_PRODUCTS`.
*   **Finance Product Key:** Foreign key to `REF_FINANCE_PRODUCTS`.
*   **Capitalization Tag:** Classified as one of the following:
    *   `RUN`: Routine operations, support, and business-as-usual (OpEx).
    *   `CHANGE`: Active software development, process modernization, and optimization (CapEx).
    *   `REGULATORY`: Work mandated by compliance or market regulators.
*   **Effective Start Date:** Date when the mapping becomes active (YYYY-MM-DD).
*   **Effective End Date:** Date when the mapping expires (YYYY-MM-DD), allowing for historical retention of accounting mappings.
*   **Audit Trail:** Records the email of the BMA who created/modified the record and a timestamp.

### Table: `FINANCE_MAPPING`
| Field Name | Data Type | Example Value |
| :--- | :--- | :--- |
| `mapping_id` | UUID (PK) | `f47ac10b-58cc-4372-a567-0e02b2c3d479` |
| `cs_product_id` | UUID (FK) | `d290f11d-6c04-4bc0-bc43-98777122cf2c` (`MarkitWire-DMS`) |
| `finance_product_id` | UUID (FK) | `a888b11c-22ff-4ac0-bc11-09888122ab3d` (`Rates-PostTrade`) |
| `cap_tag` | Enum | `CHANGE` |
| `start_date` | Date | `2026-01-01` |
| `end_date` | Date | `2026-12-31` |
| `created_by` | String | `bma-admin@osttra.com` |
| `updated_at` | Timestamp| `2026-08-12 14:32:00` |

---

## 3. REST API Delivery Mechanism
Instead of manual monthly spreadsheet exports, Nexus exposes a secure REST-like API endpoint using the Google Apps Script `doGet(e)` engine. This endpoint resides in a new backend service: `FinanceApi.js`.

### Authentication
*   **Mechanism:** A static API token is generated and stored in the secure server-side environment via `PropertiesService.getScriptProperties().getProperty('FINANCE_API_TOKEN')`.
*   **Query Access:** The corporate Finance ETL tool must execute a `GET` request passing the token as a query parameter (`?token=xyz`).

### The Query Endpoint
```
https://script.google.com/macros/s/{SCRIPT_ID}/exec?action=getAllocations&month=2026-08&token={FINANCE_API_TOKEN}
```

### Server-Side Processing Workflow (`FinanceApi.js`)
1.  **Authorize:** Intercept the request. Validate that the incoming `token` matches the secure Script Property. If invalid, return a `401 Unauthorized` JSON payload.
2.  **Fetch Allocations:** Retrieve all certified, frozen monthly allocation records for the requested `month` (e.g., `2026-08`).
3.  **Perform Join:** Query the `FINANCE_MAPPING` table. For each allocation record, correlate the employee's logged `CS Product` with the active `Finance Product` and `Capitalization Tag` (ensuring the `month` falls between the `start_date` and `end_date` boundary).
4.  **Serialize:** Format the joined dataset into a clean JSON array and return it with MIME type `ContentService.MimeType.JSON`.

### Expected JSON Response Payload
```json
[
  {
    "employee_id": "EMP-4920",
    "email": "jane.doe@osttra.com",
    "cost_center": "CC-9012",
    "month": "2026-08",
    "allocation_percent": 40,
    "cs_product": "MarkitWire",
    "cs_sub_product": "DMS",
    "finance_product": "Rates & Credit",
    "finance_sub_product": "Post-Trade Operations",
    "capitalization_classification": "CHANGE",
    "certified_at": "2026-08-03T10:15:00Z"
  },
  {
    "employee_id": "EMP-3810",
    "email": "john.smith@osttra.com",
    "cost_center": "CC-4011",
    "month": "2026-08",
    "allocation_percent": 100,
    "cs_product": "Traiana",
    "cs_sub_product": "Netlink",
    "finance_product": "FX & Credit",
    "finance_sub_product": "Post-Trade Operations",
    "capitalization_classification": "RUN",
    "certified_at": "2026-08-02T15:30:00Z"
  }
]
```

---

# ✦ Pillar B: OPEX Project Tracker Go-Live

Pillar B promotes the OPEX Project Board (`OpexProjectBoard.html`) to a live production utility. It expands the project tracking schema to cover milestones and classification tags, integrates AI to generate automated executive status reports, and establishes the crucial BMA bridge that feeds active OPEX initiatives directly into the employee effort allocation UI.

---

## 1. Jira-as-Master Sync Architecture
To maintain absolute data integrity, avoid write conflicts, and keep operations aligned with corporate workflows, Atlassian Jira remains the **single source of truth** for all project statuses and deadlines.

*   **The Sync Engine:** A time-driven background worker (`syncOpexJiraData` in `OpexBackend.js`) executes an hourly poll of the Atlassian Jira API.
*   **The Process:** 
    *   The cron job paginates through the designated Jira project (`OP`), downloading all active Epic keys, titles, status categories, and milestone fields.
    *   It caches these records directly into the Nexus database.
*   **Read-Only UI:** The Nexus board is entirely read-only for core project dates and board stages. If a user needs to modify a project's target date or change its stage, they are presented with a direct deep-link to the corresponding Jira Epic. Upon updating in Jira, the change is reflected in Nexus on the next hourly poll.

---

## 2. Expanded OPEX Project Data Model
The database representation of OPEX initiatives is expanded beyond basic metadata (like "Project Champions") to track progress through a structured, multi-milestone framework and formal strategic classifications.

### Project Classifications
Every initiative is tagged with a distinct category to facilitate high-level executive analytics:
*   `CTB`: Change-the-Business / Transformation initiatives.
*   `GROWTH`: Projects directly scaling business capability or onboarding revenue-generating products.
*   `NON_GROWTH`: Efficiency or regulatory-mandated initiatives that do not expand market footprint.
*   `DIGIOPS`: Digital Operations / Automation scripting projects.
*   `PROCESS_IMPROVEMENT`: Lean, administrative, or non-technical process optimizations.

### Proposed Milestones & Status Schema
Each project has a child array or relational table tracking its underlying milestones.

*   **Table: `OPEX_PROJECT_MILESTONES`**
    *   `id` (UUID / Primary Key)
    *   `project_id` (UUID / Foreign Key to Master Project)
    *   `milestone_name` (String, e.g., "UAT Signed Off")
    *   `milestone_status` (Enum: `NOT_STARTED`, `IN_PROGRESS`, `COMPLETED`, `DELAYED`)
    *   `target_date` (Date)
    *   `completed_date` (Date / Nullable)

---

## 3. AI-Powered Project Summaries & Reports
To eliminate manual slide-deck creation and spreadsheet reporting for OPEX leads, Nexus integrates an automated executive reporting engine powered by the built-in Gemini LLM.

*   **Trigger:** OPEX leads can click a "Generate Summary" button on the project board or system dashboard.
*   **Input Context:** Nexus compiles the project classification, overall status, the child milestones table, and the historical activity logs.
*   **Prompt Construction:** The compiled payload is sent to Gemini with instructions to generate a professional, concise executive bulletin:
    ```
    Analyze this project data: [Project Name: Traiana Netlink Automation, Category: DIGIOPS, Milestones: 2/3 Completed, 1/3 Delayed].
    Generate a 3-sentence executive update highlighting recent accomplishments (completed milestones), current roadblocks (delayed milestones), and overall progress against the strategic goal.
    ```
*   **The Output:** Nexus displays the beautifully written executive summary directly on the dashboard, saving the OPEX lead hours of manual writing.

---

## 4. The BMA-to-Allocation Bridge (The Unified Workflow)
The most critical capability of Phase 4 is connecting Pillar B (OPEX Projects) with Pillar A (Effort Allocations). This ensures that every hour logged against an internal optimization initiative is backed by an active, audited Jira project.

```
┌────────────────────────────────┐
│   Jira OP Project (Epics)      │
└───────────────┬────────────────┘
                │ (Hourly Poll)
                ▼
┌────────────────────────────────┐
│   Synced OPEX Project Table    │
└───────────────┬────────────────┘
                │ (Consumed By)
                ▼
┌────────────────────────────────┐
│      BMA UI Control Panel      │ ◄── BMA checks "Active for Allocation"
└───────────────┬────────────────┘
                │ (Filter Applied)
                ▼
┌────────────────────────────────┐
│  Employee Allocation UI (Dropdown)
│   (MyAllocations.html)         │ ◄── Employee logs % against OP Project
└────────────────────────────────┘
```

### The Workflow:
1.  **Ingestion:** The hourly Jira sync populates the Nexus master project table with active Jira Epics.
2.  **Governance (BMA UI):** Inside the BMA UI, the BMA team can view all synced OPEX projects. The UI provides a simple check-box toggle: `Active for Allocation` (Boolean: `TRUE/FALSE`).
3.  **Dropdown Mapping:** The employee allocation page (`MyAllocations.html`) queries this database, filtering only for projects marked `Active for Allocation = TRUE` by the BMA team.
4.  **Logging:** Employees select the specific, audited OPEX project from their dropdown and log their monthly effort percentage against it.
5.  **Capitalization Audit:** When Finance queries the `FinanceApi.js` endpoint (Pillar A), the returned payload contains the exact hours/percentage logged against that specific, mapped OPEX project, giving them a 100% auditable trail of R&D effort capitalization.
