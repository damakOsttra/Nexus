# Nexus Industrialization Roadmap

## 🎯 Strategic Vision
Modernize the OSTTRA Client Services operation by eliminating manual overhead, migrating to scalable infrastructure (CloudSQL), and empowering operational teams to build seamlessly within the Nexus ecosystem.

---

## 🏃 Current Sprint / Immediate Focus
*   **Vanity URLs:** Awaiting Network Team F5 Load Balancer configuration for `nexus.osttra.com`.
*   **Jira-to-Sheet Sync:** Building the mechanism to pull the `OP` board directly into Google Sheets for Agile tracking.
*   **Database Foundation:** Preparing architecture plans for the Google Sheets to GCP CloudSQL migration.

---

## 🗂️ Project Backlog & Status

### Phase 1: Client Services Modernization (Completed)
| Key | Type | Summary | Status |
| :--- | :--- | :--- | :--- |
| **OP-15** | Epic | Core Architecture: SPA, RBAC & API Abstraction | Done |
| OP-16 | Task | Implement Core Architecture: SPA Routing & 5-Tier RBAC | Done |
| OP-17 | Task | Develop Employee Home Profile & My Allocations UIs | Done |
| OP-18 | Task | Develop Manager Dashboards & Organization Chart | Done |

### Phase 2: TPM Timesheet Integration (Completed)
| Key | Type | Summary | Status |
| :--- | :--- | :--- | :--- |
| **OP-19** | Epic | TPM Timesheet Integration | Done |
| OP-20 | Task | Develop TPM Timesheet Application | Done |
| OP-21 | Task | Develop TPM Compliance Dashboards & Telemetry | Done |

### Phase 3: Industrialization & CloudSQL Migration (In Progress)
| Key | Type | Summary | Status |
| :--- | :--- | :--- | :--- |
| **OP-22** | Epic | Industrialization & CloudSQL Migration | In Progress |
| OP-23 | Task | Manage deployment via shared Google Service Account | **Done** |
| OP-24 | Task | Setup Vanity URLs (PROD & UAT) via F5 Load Balancer | Blocked (IT) |
| OP-25 | Task | Migrate Master Database from Google Sheets to GCP CloudSQL | To Do |
| OP-26 | Task | Establish UAT DB Environment and Automated Backup Policies | To Do |

### Phase 4: OPEX Tracking & Finance Tool Integration (Future)
| Key | Type | Summary | Status |
| :--- | :--- | :--- | :--- |
| **OP-27** | Epic | OPEX Tracking & Finance Tool Integration | To Do |
| OP-28 | Task | Develop OPEX Project Boards & Jira Sync | To Do |
| OP-29 | Task | Develop BMA UI for Finance Product Mapping | To Do |
| OP-30 | Task | Implement Validation & Approval Workflow for Allocation Data | To Do |

---

## 🤖 AI / Dev Notes & Thoughts
*   *(Paste your Google Sheet exports and thoughts into the chat, and I will update this document accordingly!)*