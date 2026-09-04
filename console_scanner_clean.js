/**
 * 🧠 MYDEALZ AI-CONTEXT SCANNER (v6 - Final AI Edition)
 * 
 * DESIGN-PHILOSOPHIE (AI-Approved):
 * 1. ZERO NOISE: Keine Badges, keine Avatar-URLs, keine internen IDs.
 * 2. MAX CONTEXT: Echtes Nesting (Eltern -> Kind) für Kausalität.
 * 3. SIGNAL-ONLY: Votes werden zusammengefasst. HTML wird gesäubert.
 * 4. RELIABILITY: Nutzt 'preparedHtmlContent' (da 'content' oft fehlt).
 */

(async () => {
    console.clear();
    console.log("%c🧠 STARTING AI CONTEXT SCAN...", "color: #b084f5; font-size: 20px; font-weight: bold; background: #2d0a4e; padding: 10px; border-radius: 5px;");

    // --- 1. SETUP & AUTH ---
    const getXsrfToken = () => {
        const meta = document.querySelector('meta[name="csrf-token"]');
        if (meta) return meta.getAttribute('content');
        const match = document.cookie.match(/xsrf_t=([^;]+)/);
        return match ? decodeURIComponent(match[1]) : null;
    };

    const CONFIG = {
        threadId: window.location.href.split('-').pop(),
        token: getXsrfToken(),
        delay: 300 // Schnell genug für Menschen, langsam genug für Server
    };

    if (!CONFIG.token || !CONFIG.threadId) {
        console.error("❌ Auth Error: Bitte logge dich ein oder öffne einen Deal.");
        return;
    }

    // --- 2. THE QUERY (AI-Tailored) ---
    // Wir holen nur Felder, die für die semantische Analyse wichtig sind.
    const GQL_QUERY = `
        query comments($filter: CommentFilter!, $limit: Int, $page: Int) {
          comments(filter: $filter, limit: $limit, page: $page) {
            items {
              commentId
              preparedHtmlContent  # HIER steckt der Text (mit Emoji-Tags)
              createdAt            # Datums-String (perfekt für Kontext)
              user { username }
              reactionCounts { type count }
              repliesPreview {
                 commentId
                 preparedHtmlContent
                 createdAt
                 user { username }
                 reactionCounts { type count }
              }
            }
            pagination { last }
          }
        }
    `;

    const fetchGql = async (query, variables) => {
        try {
            const res = await fetch('/graphql', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-xsrf-token': CONFIG.token,
                    'x-request-type': 'application/vnd.pepper.v1+json'
                },
                body: JSON.stringify({ query, variables })
            });
            const json = await res.json();
            return json.data;
        } catch (e) { console.error("Netzwerkfehler", e); return null; }
    };

    // --- 3. CLEANING ENGINE (Synapse Optimized) ---
    
    // Wandelt HTML-Chaos in reinen, tokenizer-freundlichen Text um.
    const cleanText = (html) => {
        if (!html) return "";
        let text = html
            .replace(/<br\s*\/?>/gi, "\n")       // Zeilenumbrüche retten
            .replace(/<[^>]+>/g, "")             // Alle Tags entfernen
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .trim();
        return text;
    };

    // Komprimiert {type: "LIKE", count: 5} zu { like: 5 }
    // Spart MASSIV Token.
    const compressVotes = (counts) => {
        if (!counts || counts.length === 0) return undefined; // undefined = Feld wird im JSON weggelassen
        const out = {};
        let hasSignal = false;
        counts.forEach(c => {
            const type = c.type.toLowerCase();
            if (type === 'like' && c.count > 0) { out.up = c.count; hasSignal = true; }
            if (type === 'helpful' && c.count > 0) { out.good = c.count; hasSignal = true; } // "Good" = Starkes Signal
            if (type === 'funny' && c.count > 0) { out.meme = c.count; hasSignal = true; } // "Meme" = Warnung
        });
        return hasSignal ? out : undefined;
    };

    // Rekursive Transformation für Tree-Structure
    const transformNode = (item) => {
        if (!item) return null;
        
        const node = {
            id: item.commentId,
            user: item.user?.username || "Deleted",
            date: item.createdAt, // "9. Dez" ist informativer als Timestamp für LLM
            text: cleanText(item.preparedHtmlContent),
            // Votes nur hinzufügen wenn sie existieren (Sparsity)
            votes: compressVotes(item.reactionCounts)
        };

        // Wenn Replies existieren, fügen wir sie direkt ein (Nesting)
        if (item.repliesPreview && item.repliesPreview.length > 0) {
            node.replies = item.repliesPreview.map(r => transformNode(r)).filter(Boolean);
        }

        return node;
    };

    // --- 4. EXECUTION ---
    let allItems = [];
    
    // Page 1 Fetch
    console.log("📥 Lade Diskussion...");
    const data = await fetchGql(GQL_QUERY, {
        filter: { threadId: { eq: CONFIG.threadId }, order: { direction: "Ascending" } },
        limit: 100, page: 1
    });

    if (data?.comments?.items) {
        allItems.push(...data.comments.items);
        
        const totalPages = data.comments.pagination.last;
        for (let p = 2; p <= totalPages; p++) {
            console.log(`📥 Lade Seite ${p}/${totalPages}...`);
            const pData = await fetchGql(GQL_QUERY, {
                filter: { threadId: { eq: CONFIG.threadId }, order: { direction: "Ascending" } },
                limit: 100, page: p
            });
            if(pData?.comments?.items) allItems.push(...pData.comments.items);
            await new Promise(r => setTimeout(r, CONFIG.delay));
        }
    }

    // --- 5. FINALIZE ---
    console.log(`🧠 Optimiere ${allItems.length} Konversationen...`);
    // Wir wandeln nur die Root-Items um. Die Replies werden rekursiv mitgenommen.
    const aiData = allItems.map(transformNode);

    // Statistik für den User
    const totalComments = aiData.reduce((acc, c) => acc + 1 + (c.replies?.length || 0), 0);
    console.log(`✅ Fertig! ${totalComments} Nachrichten extrahiert.`);
    
    // Download
    const blob = new Blob([JSON.stringify(aiData, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `mydealz_AI_${CONFIG.threadId}.json`;
    link.click();

})();
