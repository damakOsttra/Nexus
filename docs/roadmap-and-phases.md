# Nexus Strategic Roadmap & Phases

This document maps out the strategic vision, current development sprints, and phased execution timeline for the Nexus platform as it modernizes OSTTRA's operational landscape.

---

## 🎯 Strategic Vision
To modernize the OSTTRA Client Services and Operational Excellence (OPEX) operations. Nexus achieves this by eliminating manual administrative overhead, establishing robust API-driven system connections, and empowering non-technical operational teams to build seamlessly via citizen engineering.

---

## 🏃 Current Sprint / Immediate Focus
*   **Vanity URLs (WIP):** Sub-domain creation (`NET-16133`) is Done. We are currently awaiting final F5 VIP Creation for HTTP Redirects (`NET-16209`, Work in progress by Abhishek Soni). *(Note: DevOps vanity URL `SEOPS-981` was Canceled).*
*   **CloudSQL Database Migration (In Progress):** Formulating database schematics and exploring workarounds to navigate current infrastructure access challenges (`GCP-1634`). This is an active, ongoing effort.
*   **Jira-to-Sheet Sync (In Progress):** Developing background mechanisms to automatically synchronize the OPEX Jira project (`OP`) with underlying Sheets for sprint-tracking convenience.
*   **AI Developer Tooling (WIP):** Setting up required Model Context Protocol (MCP) servers to aid development. The codebase-memory-mcp whitelist is Done (`SECO-600`), however, Atlassian MCP access is Waiting for support (`ITS-44489`) and the Google Drive MCP request is Open (`GCP-1635`).

---

## 🗺️ Phased Implementation Timeline

### ✦ Phase 1: Client Services Modernization (Completed)
*   **Focus:** Core Infrastructure & Spreadsheet Elimination.
*   **Key Accomplishments:** Designed the Single Page Application (SPA) architecture, implemented the 5-Tier server-side RBAC engine, integrated Dayforce HR roster feeds, and developed the core Home Profile, My Allocations, and Org Chart modules.
*   **Problem Solved:** Client Services was burdened by fragmented spreadsheets, manual data entries, and inconsistent team reporting, creating massive data-entry errors and zero management oversight.
*   **Business Value:** Reclaimed hundreds of administrative hours monthly by centralizing operations into an automated single source of truth.

### ✦ Phase 2: TPM Timesheet & Atlassian Independence (Completed)
*   **Focus:** Bespoke Professional Services Tracking & Licensing Cost Reduction.
*   **Key Accomplishments:** Engineered the high-fidelity `TpmTimesheet.html` module with client-side rules enforcing 24h limits and out-of-office blocks, while caching Jira ticket data to facilitate swift timesheet completion.
*   **Problem Solved:** The PS-TPM team needed robust time-logging capabilities against Jira Epics. The alternative was purchasing expensive marketplace add-ons, bloating Atlassian licensing costs.
*   **Business Value:** Avoided recurring external SaaS license fees by building the capability natively inside Nexus, while tailoring the software exactly to the TPM team's workflow requirements.

### ✦ Phase 3: Enterprise Scalability & Capacity Heatmapping (In Progress)
*   **Focus:** Storage Scaling & Visual Workforce Equilibrium.
*   **Key Accomplishments:** 
    *   **Shared Service Deployment:** Successfully deployed the application from the shared Google Service Account (`svc-nexus@osttra.com`), resolving Apps Script ownership transfer (`ITS-44581`) and securing shared mailbox access (`ITS-44483`). This completely eliminates the key-person dependency on Damak and opens the door for other citizen developers to contribute to the codebase.
    *   Commenced migration planning from flat-file Google Sheets to a relational GCP CloudSQL model.
    *   Began design of a dynamic, interactive Allocation Heatmap.
*   **Current Focus:** Actively navigating CloudSQL access and infrastructure hurdles (`GCP-1634`) via workarounds to keep migration plans on track.
*   **Problem Solved:** 
    *   *Technical:* Google Sheets suffers performance degradation and concurrency limitations at enterprise scale.
    *   *Operational:* Managers lack high-level, visual tools to identify who is overworked or underworked, preventing intelligent, data-driven resource rebalancing.
*   **Business Value:** Scales database architecture to handle high concurrency while giving leadership visual capacity heatmaps to optimize resource deployment, prevent burnout, and streamline operations.

### ✦ Phase 4: Finance Allocation Data Supply & OPEX Project Tracker (Future)
*   **Focus:** Financial Data Reporting Integration & Operational Project Alignment.
*   **Target Features:** Build the consolidated Business Management Admin (BMA) mapping UI, expose secure REST API endpoints (`FinanceApi.js`) for monthly allocation data transfer, deploy the Jira-as-Master read-only OPEX Project Board (polled hourly) tracking milestones and strategic classifications, integrate Gemini AI to generate automated project update summaries, and establish the BMA-to-Allocation bridge allowing employees to log effort directly against active OPEX initiatives.
*   **Problem Solved:** 
    *   *Finance:* Delivering manual or disjointed labor capitalization reporting to Corporate Finance is slow, non-auditable, and prone to formatting errors.
    *   *OPEX:* OPEX project boards currently operate in a silo, requiring manual project tracking and duplicating work done in Jira.
*   **Business Value:** Automates CapEx/OpEx labor allocation reporting for Corporate Finance. Promotes OPEX project tracking to a live, read-only Jira-integrated environment with AI-powered summaries, and guarantees a 100% auditable trail of time-tracking against active corporate initiatives.

### ✦ Phase 5: Analytical Intelligence & Salesforce/BigQuery Integration (Future)
*   **Focus:** Cross-System Data Warehousing & Predictive Utilization.
*   **Target Features:** Integrate Salesforce CRM APIs with the GCP data warehouse, correlating client issue ticket volume (BAU) directly with logged project hours (Jira/Timesheet).
*   **Problem Solved:** Leadership cannot easily correlate internal employee effort with external client satisfaction or ticket resolution speeds due to data silos.
*   **Business Value:** Unifies operational metrics with customer support data, providing leadership with deep, actionable insights to calculate precise cost-to-serve and optimize hiring strategies.

### ✦ Phase 6: HR Experience & Global Resourcing (Future)
*   **Focus:** Centralized Holiday Management & Visual Coverage Optimization.
*   **Target Features:** 
    *   Sync Personal and Shared Client Services Google Calendars (strictly no Outlook) using the Apps Script `CalendarApp` service.
    *   Ingest aggregate Dayforce booked leave as a read-only consumer.
    *   Integrate monthly HR Excel working day reports to set baseline capacities.
    *   Allow employees and managers to confirm actual working days and input Overtime (OT) in the Allocation UI.
    *   Build a visual Global Resourcing calendar dashboard.
*   **Problem Solved:** Coordinating global holidays and ensuring coverage across regional support teams (Traiana, MarkitWire) is a manual, email-heavy process. Staff capacities are completely disconnected from incoming case volumes.
*   **Business Value:** Delivers a unified resourcing calendar. Overlays actual daily available headcount (Calendar capacity) against predicted workload volumes (Salesforce case counts and Jira tickets), allowing managers to proactively balance workloads and schedule coverage before SLA breaches occur.

### ✦ Phase 7: Cross-Regional Upskilling & RACI Governance (Future)
*   **Focus:** Standardizing Operational Knowledge & Restructuring Teams.
*   **Target Features:** Build integrated L1 CS proficiency assessments and embed a global, interactive RACI matrix directly into the Nexus core.
*   **Problem Solved:** Onboarding processes lack standardized evaluation metrics, and division of labor between L1 support, Service Delivery, and TPM teams is often ambiguous.
*   **Business Value:** Guarantees standardized competency across global regions, maps critical Single Points of Failure (SPOFs) in niche products, and visualizes regional skill gaps for managers via executive skill heatmaps.

---

## 🎁 Platform Bonus Features (The Unified Workspace)
Beyond structured milestones, Nexus provides integrated productivity utilities:
1.  **The CS Launch Portal:** A centralized, curated directory of deep links to standard operational utilities (e.g., KYC Research Tool, Transformer Bot, JARVIS), reducing bookmark bloat.
2.  **The Governed Analytics Hub:** A single home for verified Data Studio and Looker dashboard links, enforcing access control based on user RBAC tiers.
3.  **Dynamic Hierarchy Export:** Allows managers to export the live org chart structure directly as a vector SVG or image file for presentation slide decks.
