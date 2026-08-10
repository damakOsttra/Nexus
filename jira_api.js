const https = require('https');
const fs = require('fs');

const CREDS_PATH = './jira-credentials.json';
const PAYLOAD_PATH = './.gemini_jira_payload.json';

if (!fs.existsSync(CREDS_PATH)) {
    console.error("Missing jira-credentials.json! Please ensure your credentials are saved.");
    process.exit(1);
}
if (!fs.existsSync(PAYLOAD_PATH)) {
    console.error("Missing .gemini_jira_payload.json! Gemini CLI must generate this file first.");
    process.exit(1);
}

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
const payload = JSON.parse(fs.readFileSync(PAYLOAD_PATH, 'utf8'));
const authHeader = 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64');

function makeRequest(data) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: creds.baseUrl,
            path: '/rest/api/3/issue',
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', reject);
        req.write(JSON.stringify(data));
        req.end();
    });
}

async function run() {
    let lastEpicKey = null;

    for (const item of payload) {
        console.log(`\nCreating ${item.type}: ${item.summary}...`);
        
        const reqData = {
            fields: {
                project: { key: item.projectKey || 'OP' },
                summary: item.summary,
                description: {
                    type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: item.description || "" }] }]
                },
                issuetype: { name: item.type }
            }
        };

        if (item.type === 'Epic') {
            reqData.fields.customfield_10011 = item.summary; 
        }

        if (item.parentEpic === "@PREVIOUS_EPIC" && lastEpicKey) {
            reqData.fields.parent = { key: lastEpicKey };
            console.log(` -> Linking to Epic: ${lastEpicKey}`);
        } else if (item.parentEpic) {
            reqData.fields.parent = { key: item.parentEpic };
            console.log(` -> Linking to Epic: ${item.parentEpic}`);
        }

        const res = await makeRequest(reqData);
        if (res.errors) {
            console.error(" -> Error creating ticket:", JSON.stringify(res.errors));
        } else {
            console.log(` -> Success! Key: ${res.key}`);
            if (item.type === 'Epic') {
                lastEpicKey = res.key;
            }
        }
    }

    fs.unlinkSync(PAYLOAD_PATH);
    console.log("\nAll tickets processed successfully and payload cleaned up.");
}

run();
