/**
 * 🚀 MYDEALZ DEEP SCANNER v3 (The "Missing Link" Fix)
 * 
 * CHANGES:
 * 1. Introspection entfernt (ist serverseitig deaktiviert).
 * 2. REPLIES FIX: Nutze wieder 'mainCommentId', aber ZUSÄTZLICH mit 'threadId'.
 *    (Das hat vermutlich in v1 gefehlt).
 * 3. Bessere Fehler-Logs (Text statt [object]).
 */

(async () => {
    console.clear();
    console.log("%c💪 STARTING SCAN v3...", "color: #00ff00; font-size: 20px; font-weight: bold;");

    // 1. SETUP
    const getXsrfToken = () => {
        const meta = document.querySelector('meta[name="csrf-token"]');
        if (meta) return meta.getAttribute('content');
        const match = document.cookie.match(/xsrf_t=([^;]+)/);
        return match ? decodeURIComponent(match[1]) : null;
    };

    const CONFIG = {
        threadId: window.location.href.split('-').pop(),
        token: getXsrfToken(),
        delay: 500
    };

    if (!CONFIG.token) return console.error("❌ Kein Token gefunden!");
    console.log(`🔑 Token: OK | Thread: ${CONFIG.threadId}`);

    // 2. HELPER
    const fetchGql = async (query, variables, name) => {
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
            if (json.errors) {
                console.warn(`⚠️ GQL Error [${name}]:`, JSON.stringify(json.errors, null, 2));
                return null;
            }
            return json.data;
        } catch (e) {
            console.error(`💥 Net Error [${name}]:`, e);
            return null;
        }
    };

    // 3. QUERIES
    // Root-Kommentare
    const GQL_ROOT = `
        query comments($filter: CommentFilter!, $limit: Int, $page: Int) {
          comments(filter: $filter, limit: $limit, page: $page) {
            items {
              commentId
              replyCount
              content
              createdAt
              voteScore
              user { username bestBadge { level { name } } }
              reactionCounts { type count }
            }
            pagination { last }
          }
        }
    `;

    // Antworten (Replies) - Hier war der Hund begraben
    const GQL_REPLIES = `
        query comments($filter: CommentFilter!, $limit: Int) {
          comments(filter: $filter, limit: $limit) {
            items {
              commentId
              parentCommentId
              content
              createdAt
              voteScore
              user { username bestBadge { level { name } } }
              reactionCounts { type count }
            }
          }
        }
    `;

    // 4. EXECUTION
    let allItems = [];

    // A. FETCH ROOTS
    console.log("🌳 Lade Root-Kommentare...");
    const rootData = await fetchGql(GQL_ROOT, {
        filter: { threadId: { eq: CONFIG.threadId }, order: { direction: "Ascending" } },
        limit: 100,
        page: 1
    }, "Roots");

    if (rootData?.comments?.items) {
        allItems.push(...rootData.comments.items);
        console.log(`   -> ${rootData.comments.items.length} Roots gefunden.`);

        // B. FETCH REPLIES
        const parents = allItems.filter(c => c.replyCount > 0);
        console.log(`🔍 Lade Antworten für ${parents.length} Threads...`);

        for (const p of parents) {
            console.log(`   ↳ Antworten zu ${p.commentId} (${p.user.username})...`);
            await new Promise(r => setTimeout(r, CONFIG.delay));

            // CRITICAL FIX: "threadId" muss auch hier rein, sonst 400/500 Error
            const replyData = await fetchGql(GQL_REPLIES, {
                filter: { 
                    mainCommentId: p.commentId,     // <--- Das ist der Parent
                    threadId: { eq: CONFIG.threadId }, // <--- DAS HAT GEFEHLT!
                    order: { direction: "Ascending" } 
                },
                limit: 100
            }, "Replies");

            if (replyData?.comments?.items) {
                console.log(`      + ${replyData.comments.items.length} Replies.`);
                // Wir fügen Eltern-ID hinzu, falls sie fehlt, für sauberes Nesting
                const replies = replyData.comments.items.map(r => ({ ...r, parentCommentId: p.commentId }));
                allItems.push(...replies);
            } else {
                console.log(`      (Leer oder Fehler)`);
            }
        }
    }

    // 5. EXPORT
    console.log(`💾 SPEICHERE DUMP (${allItems.length} Items)...`);
    const dBlob = new Blob([JSON.stringify(allItems, null, 2)], { type: "application/json" });
    const dLink = document.createElement("a");
    dLink.href = URL.createObjectURL(dBlob);
    dLink.download = `mydealz_${CONFIG.threadId}_v3_full.json`;
    dLink.click();
    console.log("✅ FERTIG.");

})();
