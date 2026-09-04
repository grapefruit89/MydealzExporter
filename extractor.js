const fs = require('fs');

try {
    const html = fs.readFileSync('temp_raw.html', 'utf8');
    
    // Regex to capture the JSON object assigned to __INITIAL_STATE__
    // It usually looks like: window.__INITIAL_STATE__ = { ... };
    // We look for the start and try to find the balancing brace or just the semicolon at the end of the line if minified.
    const match = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\});/);
    
    if (!match) {
        console.log("No Initial State found in HTML.");
        process.exit(1);
    }

    const rawJson = match[1];
    const data = JSON.parse(rawJson);

    // Data Found!
    console.log("Found Initial State!");
    console.log("Thread ID:", data.threadDetail?.threadId || "Unknown");
    console.log("Title:", data.threadDetail?.title || "Unknown");
    
    // Save to export.txt as requested (Formatted JSON)
    fs.writeFileSync('export.txt', JSON.stringify(data, null, 2));
    console.log("Saved to export.txt");

} catch (e) {
    console.error("Error:", e.message);
}
