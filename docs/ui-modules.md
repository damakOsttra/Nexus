# Nexus UI Modules Reference

The Nexus platform utilizes a Single Page Application (SPA) architecture driven by role-based shells. This document acts as a comprehensive reference guide to all interactive modules inside the `ui/` directory, detailing their purpose and business use cases.

---

## 1. General Employee & Personal UIs
*Designed for all Client Services staff to manage their personal profile, allocations, and organizational structure.*

### ✦ Home Profile (`HomeProfile.html`)
*   **Use Case:** Personal Landing Page.
*   **Description:** Serves as the initial entry point for all employees. It reads from the synchronized Dayforce HR roster to display core employee information, team alignment, and allows users to quickly verify their department, manager, and metadata correctness.

### ✦ Effort Allocation / My Allocations (`MyAllocations.html`)
*   **Use Case:** Tabular Self-Certification.
*   **Description:** The primary transactional engine where employees submit their monthly work effort allocations. Employees log time percentages across designated categories (BAU vs. Project initiatives) and formally lock their monthly submissions to meet corporate compliance standards.

### ✦ Analytics Hub (`AnalyticsHub.html`)
*   **Use Case:** Analytical Intelligence.
*   **Description:** A centralized directory giving employees access to team metrics, operational KPIs, and high-fidelity, interactive BI dashboard links (such as Looker or Data Studio reports) based on their RBAC tier.

### ✦ Organization Chart (`OrgChart.html`)
*   **Use Case:** Interactive Roster & Directory.
*   **Description:** A visual, search-enabled hierarchical tree of the OSTTRA organization. It provides instant visibility into reporting structures, teams, and includes capabilities to export the active structure as an image or high-resolution SVG.

### ✦ About & User Guide (`About.html` / `UserGuide.html`)
*   **Use Case:** Onboarding & RACI Reference.
*   **Description:** In-app documentation providing the project charter, on-boarding instructions, support contacts, and a breakdown of the platform's multi-regional governance model.

---

## 2. Manager & Team Leadership UIs
*Designed to give leaders tools for resource planning, capability mapping, and compliance tracking.*

### ✦ Assign Products (`AssignProduct.html`)
*   **Use Case:** Scope & Product Boundary Definition.
*   **Description:** Enables managers to assign specific product boundaries or system domains to their direct reports. This defines the exact drop-down choices available to employees when logging their monthly effort allocations.

### ✦ Assign Skills (`AssignSkill.html`)
*   **Use Case:** Skill Matrix & Competency Tracking.
*   **Description:** A system for managers to map, monitor, and update the operational skills and proficiency levels of their team members, creating an aggregate operational capability matrix.

### ✦ Team Allocation Board (`TeamAllocationsReview.html`)
*   **Use Case:** Compliance Monitoring & Proxy Submissions.
*   **Description:** A comprehensive team-level dashboard where managers review their direct reports' monthly allocation statuses. Managers can filter by 'Incomplete' to target outstanding logs, trigger email reminders, or submit proxy allocations on behalf of employees who are absent.

---

## 3. OPEX & TPM Specialized UIs
*Specialized modules built for Operational Excellence leads and Technical Project Managers.*

### ✦ OPEX Project Board (`OpexProjectBoard.html`)
*   **Use Case:** Operational Initiatives Tracker.
*   **Description:** Allows OPEX leads to create, monitor, and prioritize internal process optimization and digitisation projects, including a background synchronization engine to feed updates directly to Atlassian Jira.

### ✦ TPM Timesheet (`TpmTimesheet.html`)
*   **Use Case:** High-Fidelity Professional Services Time Logging.
*   **Description:** A replacement for legacy time-logging systems explicitly engineered for the Professional Services - Technical Project Management (PS-TPM) team. It enforces strict time validations (blocking logs exceeding 24 hours, OOO blocking) and dynamically caches active Jira Epic titles for rapid logging.

### ✦ TPM Compliance Dashboard (`TpmDashboard.html`)
*   **Use Case:** TPM Analytics Center.
*   **Description:** Aggregates and displays compliance compliance trends, visualizing TPM time-logging completeness against current sprint and Jira initiative deadlines.

---

## 4. System Administration UIs
*Restricted, high-privilege administrative utilities for system maintainers.*

### ✦ Compliance & Monitoring (`ComplianceAdmin.html` / `MonitoringAdmin.html`)
*   **Use Case:** Enterprise Status Tracking & Automation.
*   **Description:** Gives system administrators a macro view of the entire OSTTRA Client Services organization. Displays completion rates for product mappings, skill assignments, and allocation submittals, with automated bulk email-triggering utilities to chase late submissions.

### ✦ System Settings (`SystemSettings.html`)
*   **Use Case:** Master System Configuration.
*   **Description:** Allows administrators to toggle global parameters, update master reference lists (Cost Centers, Product catalogs), and switch feature flags (such as activating "Phase 1" mode or triggering system-wide read-only lockouts).

### ✦ Database Backups (`BackupAdmin.html`)
*   **Use Case:** Cycle Closure & Snapshot Compliance.
*   **Description:** Controls the workflow to "Close the Cycle" for a given fiscal month. Freezes all user modifications and takes an immutable snapshot of the active relational tables, archiving it to an audit folder for historical trace compliance.

### ✦ Report Hub Admin (`ReportHubAdmin.html`)
*   **Use Case:** Analytics Registry Governance.
*   **Description:** A centralized control panel where administrators register, configure, secure, and publish Looker/BI analytics URLs directly into the users' Analytics Hub.

### ✦ Nexus Adoption (`NexusAdoption.html`)
*   **Use Case:** Real-Time Platform Telemetry.
*   **Description:** Visualizes live adoption metrics, tracking unique login trends, module popularity, error occurrence rates, and total self-service actions taken by the workforce.
