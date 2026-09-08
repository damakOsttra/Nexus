# Nexus Analytics & Data Strategy

This document details how the Nexus platform leverage existing HR, allocation, and telemetry datasets to generate advanced business intelligence, and outlines our future data collection expansion plans.

---

## 1. Advanced Metrics Calculated from Existing Data

By correlating Dayforce HR data, monthly effort allocations, TPM timesheets, and system logs, Nexus computes high-signal operational indicators.

```
                  ┌──────────────────────┐
                  │   Dayforce HR Data   │
                  └──────────┬───────────┘
                             ▼
┌─────────────────┐       ┌──┴───────────┐       ┌──────────────────┐
│ Effort Allocations ├───►│  Nexus Core  │◄──────┤ TPM/Jira Logging │
└─────────────────┘       └──┬───────────┘       └──────────────────┘
                             ▼
                  ┌──────────┴───────────┐
                  │ Advanced Analytics   │
                  │   - Cost of Ops      │
                  │   - Burnout Score    │
                  │   - Skill SPOFs      │
                  └──────────────────────┘
```

### ✦ Cost of Operations (Delivery vs. Overhead)
*   **Source Data:** Job Roles / Cost Centers (HR Data) + BAU vs. Non-BAU Allocations + Logged Project Hours.
*   **Formula:** Identifies the ratio of direct customer delivery (Run-the-Business / BAU) to internal administrative tasks, meetings, and training (Change-the-Business / Non-BAU), sliced by region and tier.
*   **Use Case:** Provides leadership with empirical evidence to justify headcount requests, identify teams bogged down by administrative overhead, or spot instances where highly-paid senior staff are performing basic support tasks.

### ✦ Attrition Risk & Burnout Index
*   **Source Data:** Work Hour Volatility (Jira data > 40hrs/week) + Continuous Over-Allocation (>100% capacity) + Lack of booked leave (from calendar sync).
*   **Formula:** Aggregates extreme capacity indicators, late-night login times (from telemetry logs), and low vacation rates into a composite "Burnout Score."
*   **Use Case:** Allows HR and management to proactively flag teams at high risk of attrition, prompting timely interventions (forced leave or resource rebalancing) before valuable domain knowledge is lost to resignations.

### ✦ Skill-Gap & Single Point of Failure (SPOF) Analysis
*   **Source Data:** Skill Assignment Matrix + Product Ownership Catalogs.
*   **Formula:** Automatically scans regional teams to identify "SPOF" configurations—where only 1 or 2 employees globally (or in a timezone) are proficient in a critical product line (such as Traiana Netlink or MarkitWire DMS).
*   **Use Case:** Alerts management of operational resilience gaps, automatically triggering cross-regional training recommendations before an unexpected absence creates a support bottleneck.

### ✦ Training ROI & Time-to-Productivity
*   **Source Data:** Dayforce Start Dates + Skill Matrix progressions + Proficiency Assessment scores.
*   **Formula:** Calculates the duration between a new hire's onboarding date and their achievement of "Proficient" status in core product competencies.
*   **Use Case:** Evaluates the effectiveness of training programs. If "Time-to-Productivity" for APAC averages 6 months while EMEA averages 3 months, it highlights regional training process bottlenecks.

---

## 2. Expanded Data Collection Capabilities

To support advanced forecasting and automated routing capabilities, Nexus is expanding its data acquisition framework into both passive API harvesting and active user-input mechanisms.

### A. Passive Ingestion (System APIs)
*   **IT Service Management (ServiceNow / Jira Service Desk):**
    *   *Collected Data:* Personal ticket queue volumes, hardware error counts, and average resolution times.
    *   *Purpose:* Correlates IT friction with productivity, helping leadership see if a drop in output is driven by system issues rather than operational failures.
*   **Version Control (GitHub / Bitbucket):**
    *   *Collected Data:* Commit frequencies, pull request review turnaround times, and build successes for citizen developers.
    *   *Purpose:* Measures the velocity and concrete technical impact of the "Democratization of Engineering" initiative.
*   **Client Support Systems (Salesforce CRM):**
    *   *Collected Data:* Client case volumes, escalation rates, and Case-Level Client Satisfaction (CSAT) scores.
    *   *Purpose:* Directly links internal employee skill sets with external client resolution speeds, proving that upskilling directly boosts client satisfaction.

### B. Active Collection (Direct In-App Inputs)
*   **Weekly Pulse Check:**
    *   *Collected Data:* A brief 1-to-5 micro-sentiment rating prompt upon weekly login (e.g., *"How manageable was your workload this week?"*).
    *   *Purpose:* Replaces outdated annual surveys with a rolling, real-time indicator of departmental morale.
*   **Operational "Blocker" Logs:**
    *   *Collected Data:* Mandatory dropdown categorization (e.g., *"Waiting on Client"*, *"System Downtime"*, *"Vague Requirements"*) when milestones are missed.
    *   *Purpose:* Identifies systemic bottlenecks across the organization, revealing where processes need redesigning.
*   **Peer-to-Peer Recognition:**
    *   *Collected Data:* In-app "Bounty" submissions where team members reward virtual points or badges to peers who help them resolve complex issues.
    *   *Purpose:* Identifies informal subject matter experts and "glue" people who keep teams running but may lack formal leadership titles.
