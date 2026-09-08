# Google Chat Integration Guide for Google Apps Script

This guide explains how Google Chat notifications are configured and sent within the Nexus application, and provides step-by-step procedures and reusable code so that other Google Apps Script projects can adopt this integration.

---

## Technical Overview

Nexus uses the **Advanced Google Chat Service** in Apps Script instead of static webhooks. This approach provides several powerful advantages:
1. **Dynamic space creation**: The application dynamically creates a direct message (DM) if there is only one recipient, or a group chat if there are multiple recipients (such as the employee and their managers).
2. **On-the-fly membership**: Users are automatically invited to the space based on their email addresses, removing the need for manual room configuration.
3. **No incoming webhooks required**: It utilises the Google Chat API's `Spaces.setup` and `Spaces.Messages.create` endpoints, running with the authority of the active user or service account.

---

## Configuration Procedure

To enable Google Chat notifications in a new Apps Script project, follow these setup steps.

### Step 1: Enable the Google Chat service in Apps Script
1. Open your Apps Script project editor.
2. In the left-hand navigation pane, click the **+** icon next to **Services**.
3. In the list of services, select **Google Chat API**.
4. Set the **Version** to `v1`.
5. Set the **Identifier** to `Chat`.
6. Click **Add**.

### Step 2: Configure OAuth Scopes
Ensure your script has authorization to manage spaces and send messages.
1. Open the project settings (gear icon) and check **Show "appsscript.json" manifest file in editor**.
2. Open `appsscript.json` from the file list.
3. In the `"oauthScopes"` array, add the following scopes:
   ```json
   "https://www.googleapis.com/auth/chat.spaces.create",
   "https://www.googleapis.com/auth/chat.messages"
   ```

### Step 3: Link and Configure Your Google Cloud Project
The Google Chat API requires configuration within a standard Google Cloud Platform (GCP) project.
1. In your Apps Script project, go to **Project Settings** > **Google Cloud Platform (GCP) Project** and link it to a standard GCP project.
2. Open the [Google Cloud Console](https://console.cloud.google.com/) for that project.
3. Go to **APIs and services** > **Library**, search for **Google Chat API**, and click **Enable**.
4. Go to **APIs and services** > **Google Chat API** > **Configuration** tab. Configure the following:
   - **App name**: Choose a descriptive name (for example, "Nexus Alert Bot").
   - **Avatar URL**: Provide a link to an image (for example, an icon of your application).
   - **Description**: Add a brief description of the integration's purpose.
   - **Functionality**: Check **Join group chats** and **Send direct messages**.
   - **Connection settings**: Select **Apps Script project** and enter your Apps Script **Deployment ID** (found under Deploy > Manage deployments in Apps Script).
   - **Visibility**: Set to **Everyone in your organisation** so your users can receive messages from it.

---

## Reusable Code Implementation

Below is the production-ready code based on the Nexus implementation. You can copy and adapt this code directly into your Apps Script project.

```javascript
/**
 * Sends a Google Chat notification to a user, optionally creating a group chat with CC'd users.
 * 
 * @param {Object} payload The notification payload.
 * @param {string} payload.to The primary recipient's email address.
 * @param {string[]} [payload.ccList] Optional list of CC'd email addresses.
 * @param {string} payload.subject The subject of the notification.
 * @param {string} [payload.customMessage] Optional custom message body.
 * @param {string} [payload.portalUrl] Link to the main application portal.
 * @param {string} [payload.supportUrl] Link to the support room.
 * @param {string} [payload.videoUrl] Link to a tutorial video.
 * @returns {Object} Result object indicating success or failure.
 */
function sendGoogleChatNotification(payload) {
  const { 
    to, 
    ccList = [], 
    subject, 
    customMessage = "", 
    portalUrl = "", 
    supportUrl = "", 
    videoUrl = "" 
  } = payload;
  
  try {
    // Construct the membership list
    const memberships = [{ member: { name: `users/${to}`, type: 'HUMAN' } }];
    ccList.forEach(cc => {
      memberships.push({ member: { name: `users/${cc}`, type: 'HUMAN' } });
    });
    
    // Set up the chat space
    // Note: displayName is not allowed when spaceType is 'GROUP_CHAT'.
    const space = Chat.Spaces.setup({
      space: {
        spaceType: memberships.length > 1 ? 'GROUP_CHAT' : 'DIRECT_MESSAGE'
      },
      memberships: memberships
    });
    
    // Construct the formatted markdown message
    let chatMessage = `*${subject}*\n\n`;
    if (customMessage) {
      chatMessage += `${customMessage}\n\n`;
    }
    
    if (portalUrl) {
      chatMessage += `*Portal Link:* ${portalUrl}\n\n`;
    }
    if (supportUrl) {
      chatMessage += `*Support:* ${supportUrl}\n\n`;
    }
    if (videoUrl) {
      chatMessage += `*Tutorial:* ${videoUrl}`;
    }
    
    // Post the message to the newly created space
    const response = Chat.Spaces.Messages.create({ text: chatMessage.trim() }, space.name);
    
    return { 
      success: true, 
      spaceName: space.name, 
      messageId: response.name 
    };
  } catch (err) {
    console.error(`Google Chat notification failed for ${to}: ${err.message}`);
    return { 
      success: false, 
      error: err.message 
    };
  }
}
```

---

## Important Tips and Limitations

1. **Space type constraints**: When creating a space via `Chat.Spaces.setup`, specifying a `displayName` is **not permitted** if `spaceType` is `'GROUP_CHAT'`. Setting one will cause the API to throw an error.
2. **First-time permission request**: When a user runs the script for the first time, they will be prompted to authorize the `chat.spaces.create` and `chat.messages` scopes.
3. **No-reply bots vs. user authority**: Since this script runs under the authority of the user executing the script (or as a web app executing as the developer), the space will show the app name configured in the GCP Console, but will list the running user as the creator of the space.
4. **Active Google Directory requirement**: Recipient email addresses must be active Google Accounts within the same Workspace domain. If an email address does not exist or cannot be resolved, `Chat.Spaces.setup` will throw a membership error.
