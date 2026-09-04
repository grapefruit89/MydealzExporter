# MyDealz Data Schema: What AI Actually Needs

To summarize product feedback effectively, an LLM needs **Context**, **Structure**, and **Signal**. It does *not* need UI bloat.

Here is the breakdown of the raw GraphQL data (`export_full.json`) and my recommendation for the final "Clean JSON".

## 1. Structure (Nesting & Logic)

The absolute most important thing for the AI is to know **Who talks to Whom**.

| Original Field | Keep? | Why? |
| :--- | :--- | :--- |
| `commentId` | **YES** | Unique ID is essential for referencing. |
| `mainCommentId` | **NO** | Redundant if we nest the JSON properly. |
| `parentCommentId` | **YES** (conditionally) | Only needed if the list is flat. If we use a **Nested List** (Tree), the structure itself defines the relationship. **Recommendation: Use Nested List.** |
| `repliesPreview` | **YES (Process)** | This array contains the actual replies. We should "unpack" this into a clean `replies` attributes. |

## 2. Signal (Quality Indicators)

How much weight should the AI give to a statement?

| Original Field | Keep? | Why? |
| :--- | :--- | :--- |
| `reactionCounts` | **YES (Summarized)** | Crucial. `HELPFUL: 5` > `LIKE: 2`. `FUNNY: 20` usually means "Off-Topic/Joke". |
| `voteScore` | **MAYBE** | Often redundant if we have reaction counts. Can be skipped for slimness. |
| `bestBadge` | **NO** | "Staatsanwalt" or "Feuersturm" level usually doesn't correlate with technical Webcam knowledge. **Trash it.** |

## 3. Context (Time & Content)

| Original Field | Keep? | Why? |
| :--- | :--- | :--- |
| `content` | **YES (Cleaned)** | The core data. HTML tags (`<br>`, `<i>`) should be stripped. |
| `createdAt` | **YES (Simplified)** | **Argument:** You said "no time", but consider this: If User A asks "Does it work with Linux?" and User B says "Yes" *2 years later*, that "Yes" might be referring to a newer driver. <br> **Compromise:** We keep the date (e.g., "2025-12-09") but drop the exact `14:32:01` timestamp. Relative order matters. |
| `user.username` | **YES** | Essential for tracking conversation flow ("@Ruksson said..."). |
| `user.imageUrls` | **NO** | Useless for text analysis. |

---

## 🏗️ The Proposed "Perfect AI Schema"

This is what `console_scanner_clean.js` will output. It's minimal but structurally complete.

```json
[
  {
    "id": "55810218",
    "user": "Ruksson",
    "date": "9. Dez",   // Shortened Date
    "text": "Jemand Erfahrungen, kann die was? Oder was kann die? Habe aktuell die Logitech BRIO 4K.",
    "votes": { "like": 1, "helpful": 0, "funny": 0 }, // Signal
    "replies": [ // <-- NESTING is key for Synapses!
      {
        "id": "55810384",
        "user": "biochem",
        "date": "9. Dez",
        "text": "wieso solltest du von einer der besseren Webcams... umsteigen?",
        "votes": { "like": 13, "helpful": 1, "funny": 0 } // High Signal!
      }
    ]
  }
]
```

### Why this works for LLMs:
1.  **Zero Hallucination Risk:** The physical nesting in JSON forces the AI to understand that the reply belongs to the parent.
2.  **Signal Filtering:** The AI can be instructed: *"Ignore comments with High Funny Score if looking for technical facts."*
3.  **Token Efficiency:** We drop ~80% of the bytes without losing a single bit of meaning.
