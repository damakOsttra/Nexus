# Nexus Workspace System Instructions

This project ("Nexus") is OSTTRA's internal modernization ecosystem built using Google Apps Script (GAS) and GCP. It is designed to modernize Client Services and OPEX operations.

## Technical Architectural Guidelines
- **Language Standards:** Maintain clean, documented JavaScript within Apps Script (`.js` files), and TailwindCSS/Vanilla CSS within the interactive views (`ui/` folder).
- **Design System Integration:** Always align frontend interfaces with the OSTTRA Design System. Utilize the custom CSS variables configured in `ui/Shells/OsttraDsCss.html` (e.g., rubine, dark, ochre).
- **Security:** Never hardcode API keys or credentials. Utilize `PropertiesService.getScriptProperties()` for production.

## Custom Jira Integration Workaround
Because the native Atlassian MCP server is blocked by corporate security policies on `osttra.atlassian.net`, we use a custom, local Node.js CLI tool (`jira_api.js`) to interact with Jira.

### Workflow for Creating Jira Tickets
When the user requests you to create a Jira ticket, task, bug, or Epic:
1. Analyze the request and structure the payload into a JSON array matching this exact schema:
   ```json
   [
     {
       "type": "Epic", // Must be "Epic", "Task", or "Bug"
       "summary": "Summarized ticket title",
       "description": "Comprehensive ticket description",
       "projectKey": "OP",
       "parentEpic": "@PREVIOUS_EPIC" // Use exactly this string to dynamically link a Task to a parent Epic created in the same array
     }
   ]
   ```
2. Use the `write_file` tool to save this JSON array to a file named exactly `.gemini_jira_payload.json` in the root directory.
3. Output a text response to the user instructing them to run `node jira_api.js` in their terminal to push the tickets. Do not attempt to run this script yourself, as it requires the user to execute it locally.