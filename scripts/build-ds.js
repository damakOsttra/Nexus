const fs = require('fs');
const path = require('path');

// Paths
const cssPath = path.join(__dirname, '../package/dist/styles/osttra-ds.min.css');
const packageDir = path.join(__dirname, '../package');
const outputPath = path.join(__dirname, '../src/ui/Shells/OsttraDsCss.html');

console.log("Starting OSTTRA Design System CSS bundling...");
console.log("Reading CSS from: " + cssPath);

if (!fs.existsSync(cssPath)) {
  console.error("Error: CSS file not found at " + cssPath + ". Please ensure the package is extracted.");
  process.exit(1);
}

let cssContent = fs.readFileSync(cssPath, 'utf8');

// Regex to capture the @osttra/ds paths with optional quotes, hashes, or query parameters
const urlRegex = /url\(['"]?(@osttra\/ds\/styles\/[^'")\s\?#]+)(?:\?[^'")\s]*)?(?:#[^'")\s]*)?['"]?\)/g;

let matchCount = 0;
let successCount = 0;
let missingCount = 0;

cssContent = cssContent.replace(urlRegex, (match, assetPath) => {
  matchCount++;
  
  // Strip the package prefix to find the relative path
  const relativePart = assetPath.replace('@osttra/ds/styles/', '');
  
  // Look in both dist/styles/ and styles/ directories
  let localPath = path.join(packageDir, 'dist/styles', relativePart);
  if (!fs.existsSync(localPath)) {
    localPath = path.join(packageDir, 'styles', relativePart);
  }

  if (fs.existsSync(localPath)) {
    const ext = path.extname(localPath).toLowerCase();
    const data = fs.readFileSync(localPath);
    let mimeType = '';
    
    switch (ext) {
      case '.svg':
        mimeType = 'image/svg+xml';
        break;
      case '.woff2':
        mimeType = 'font/woff2';
        break;
      case '.woff':
        mimeType = 'font/woff';
        break;
      case '.ttf':
        mimeType = 'font/ttf';
        break;
      case '.eot':
        mimeType = 'application/vnd.ms-fontobject';
        break;
      case '.png':
        mimeType = 'image/png';
        break;
      case '.jpg':
      case '.jpeg':
        mimeType = 'image/jpeg';
        break;
      default:
        console.warn(`Warning: Unknown asset extension: "${ext}" for ${assetPath}`);
        return match;
    }

    const base64Data = data.toString('base64');
    successCount++;
    return `url("data:${mimeType};base64,${base64Data}")`;
  } else {
    missingCount++;
    console.warn(`Warning: Asset file not found locally: ${localPath} (from ${assetPath})`);
    return match; // keep original URL reference if not found
  }
});

// ==========================================
// 🎨 OSTTRA PREMIUM LIGHT THEME OVERRIDES
// ==========================================
const customThemeOverrides = `
/* Global Shell Overrides */
body {
  background-color: #f8f8f8 !important;
  color: #373838 !important;
}

main {
  background-color: #f8f8f8 !important;
  color: #373838 !important;
}

/* Scrollbar tuning for light theme */
::-webkit-scrollbar-track {
  background: #f8f8f8 !important;
}
::-webkit-scrollbar-thumb {
  background: rgba(55, 56, 56, 0.15) !important;
}

/* Glassmorphic elements to Clean Enterprise White Cards */
.glass {
  background: #ffffff !important;
  border-color: #ececec !important;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03) !important;
  backdrop-filter: none !important;
}

/* Content blocks and Admin Section background adjustments */
.bg-white\\/5, .bg-white\\/10, [class*="bg-[#1a1a1a]"], [class*="bg-[#151515]"], [class*="bg-[#222222]/30"], [class*="bg-[#222222]/50"] {
  background-color: #ffffff !important;
  border-color: #ececec !important;
}
.hover\\:bg-white\\/10:hover {
  background-color: #f1f5f9 !important;
}
.border-white\\/5, .border-white\\/10, [class*="border-white"] {
  border-color: #ececec !important;
}

/* Dark mode text replacement to High-Contrast Slate/Gray colors */
main .text-white {
  color: #373838 !important;
}
main .text-white\\/80 {
  color: #334155 !important; /* slate-700 */
}
main .text-white\\/70 {
  color: #334155 !important;
}
main .text-white\\/60 {
  color: #475569 !important; /* slate-600 */
}
main .text-white\\/50 {
  color: #475569 !important;
}
main .text-white\\/40 {
  color: #64748b !important; /* slate-500 */
}
main .text-white\\/30 {
  color: #64748b !important;
}
main .text-white\\/20 {
  color: #94a3b8 !important; /* slate-400 */
}
main .text-white\\/10 {
  color: #cbd5e1 !important; /* slate-300 */
}

/* Input elements stylings with appropriate padding */
main input, main select, main textarea {
  background-color: #ffffff !important;
  border: 1px solid #cbd5e1 !important;
  color: #373838 !important;
  padding: 0.75rem 1rem !important;
  border-radius: 4px !important;
}
main input::placeholder, main textarea::placeholder {
  color: #94a3b8 !important;
}
main input:focus, main select:focus, main textarea:focus {
  border-color: #FF0061 !important;
}

/* Table standards & typography revamps */
main table {
  background-color: #ffffff !important;
}
main thead {
  background-color: #f1f5f9 !important;
  border-bottom: 2px solid #e2e8f0 !important;
}
main thead th {
  color: #475569 !important;
  font-weight: 800 !important;
  font-size: 0.75rem !important; /* Clean 12px instead of microscopic 8px */
  text-transform: uppercase !important;
  letter-spacing: 0.075em !important;
  padding: 1rem 0.75rem !important;
}
main tbody tr {
  border-bottom: 1px solid #f1f5f9 !important;
  transition: background-color 0.15s !important;
}
main tbody tr:hover {
  background-color: #f8fafc !important;
}
main tbody td {
  color: #334155 !important;
  font-size: 0.8125rem !important; /* Standard 13px */
  padding: 1rem 0.75rem !important;
}

/* Prevent text overrides on primary action buttons and badges */
main button, main .btn, main .badge, main .osttra-gradient, main .bg-osttra-rubine, main .bg-osttra-violet, main .bg-osttra-ochre,
main button *, main .btn *, main .badge *, main .osttra-gradient *, main .bg-osttra-rubine *, main .bg-osttra-violet *, main .bg-osttra-ochre * {
  color: #ffffff !important;
}

/* Standardize card and border corners to flat, crisp enterprise styling */
.rounded-[3rem\\], .rounded-[2\\.5rem\\], .rounded-[2rem\\], .rounded-[2\\.4rem\\], .rounded-[14px\\], .rounded-3xl, .rounded-2xl, .rounded-xl, .rounded-lg {
  border-radius: 4px !important; /* Align with OSTTRA guidelines: slightly rounded 4px corners */
}

/* Status alerts & banners adaptions for light background */
.bg-emerald-500\\/10 {
  background-color: #f0fdf4 !important;
  border: 1px solid #bbf7d0 !important;
}
.text-emerald-400 {
  color: #15803d !important;
}

.bg-osttra-rubine\\/10, .bg-\\[\\#FF0061\\]\\/10 {
  background-color: #fff1f2 !important;
  border: 1px solid #fecdd3 !important;
}
.text-osttra-rubine, .text-\\[\\#FF0061\\] {
  color: #e11d48 !important;
}

.bg-osttra-ochre\\/10 {
  background-color: #fffbeb !important;
  border: 1px solid #fef3c7 !important;
}
.text-osttra-ochre {
  color: #b45309 !important;
}

.bg-osttra-violet\\/10 {
  background-color: #faf5ff !important;
  border: 1px solid #e9d5ff !important;
}
.text-osttra-violet {
  color: #7e22ce !important;
}

/* Sidebar navigation contrast retention & Soft Platinum theme overrides */
aside, aside.w-72.bg-\\[\\#222222\\] {
  background-color: #f1f5f9 !important;
  border-right: 1px solid #e2e8f0 !important;
}
aside button, aside h1, aside h2, aside h3, aside h4, aside h5, aside h6, aside span, aside div, aside p {
  color: #334155 !important;
}
aside .text-white {
  color: #334155 !important;
}
aside .text-white\\/40, aside .text-white\\/30 {
  color: #64748b !important;
}
aside .text-white\\/20 {
  color: #94a3b8 !important;
}
aside .nav-link {
  color: #64748b !important;
}
aside .nav-link:hover {
  background-color: #e2e8f0 !important;
  color: #0f172a !important;
}
aside .nav-link.active {
  background-color: #FF0061 !important;
  color: #ffffff !important;
}
aside .nav-link.active * {
  color: #ffffff !important;
}
aside [id="user-photo-container"], aside [class*="bg-[#222222]"] {
  background-color: #ffffff !important;
}
`;

cssContent += customThemeOverrides;

console.log(`\nBundling summary:`);
console.log(`- Total references found: ${matchCount}`);
console.log(`- Successfully inlined:  ${successCount}`);
console.log(`- Missing files:         ${missingCount}`);

// Write the output as an HTML file with <style> tags
const htmlContent = `<style>\n${cssContent}\n</style>\n`;
const outputDir = path.dirname(outputPath);

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(outputPath, htmlContent, 'utf8');
console.log(`\nSuccess: Generated self-contained HTML template at: ${outputPath}`);
console.log(`File size of generated template: ${(fs.statSync(outputPath).size / 1024).toFixed(2)} KB`);
