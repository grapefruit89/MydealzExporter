# MyDealz Data Structure & Signal Analysis

Based on the Deep-Dive Extraction, here are the specific peculiarities of the MyDealz/Pepper GraphQL API and how we will filter for "Product Focus".

## 1. API Peculiarities (The "Tricks")

*   **ThreadID Constraint (Critical):**
    *   Standard GraphQL allows fetching nested objects via `parentCommentId`.
    *   **MyDealz Exception:** The API silently fails unless you *also* provide the `threadId` in the filter, even when requesting a specific sub-comment tree. Using `mainCommentId` + `threadId` is the only robust composite key.
*   **Hybrid Nesting (`repliesPreview`):**
    *   The `comments` query is surprisingly rich. Root comments often contain a filled `repliesPreview` field.
    *   **Advantage:** For most discussions, we don't actually need separate recursive calls. The root query captures the entire conversation context in one go.
    *   **Strategy:** We parse the tree structure directly from the Root objects.

## 2. Signal vs. Noise (Cleaning Strategy)

To achieve the requested "Product Focus" and remove "Trash", we distinguish between these data types:

### 🚨 NOISE (Delete)
*   **User Badges/Levelling:** `bestBadge`, `level`, `maxTemperatureLevel`. (Social gamification stats irrelevant to product quality).
*   **Internal Flags:** `isDeletedOrPendingDeletion`, `canVote`, `reportable`. (System state).
*   **Redundant Content:** `preparedHtmlContent` (we use raw `content` or strip HTML for clean text).
*   **Avatar URLs:** `imageUrls` (Visual bloat).

### ✅ SIGNAL (Keep)
*   **Content:** The actual text body.
*   **Reactions (The "Vibe Check"):**
    *   `LIKE`: General agreement.
    *   `HELPFUL`: **High-value signal** for product insights/answers.
    *   `FUNNY`: **Warning signal** for Jokes/Memes (e.g., "URGEEN" comments).
    *   *Action:* We will summarize these into a simple `score` object to filter out meme-threads if needed.
*   **Context:** `createdAt` (Topicality) and `replyCount` (Controversy indicator).

## 3. Proposed "Clean Schema"

Instead of the raw GraphQL dump (100+ lines per comment), our new scanner will produce this compact format:

```json
{
  "id": "55812889",
  "user": "alvaro",
  "date": "9. Dez 2025",
  "text": "Ich könnte mir vorstellen, dass die 80° Weitwinkel nicht überall eine gute Idee sind...",
  "reactions": { "like": 4, "helpful": 1, "funny": 0 },
  "replies": [
    {
      "id": "55814572",
      "user": "NT48",
      "text": "Das Produkt richtet sich wohl an gewerbliche Damen",
      "reactions": { "like": 1, "helpful": 0, "funny": 14 } 
      // -> HIGH FUNNY COUNT detected -> Can be flagged as "Off-Topic" by AI later.
    }
  ]
}
```

This reduces token usage by ~70% and maximizes context density.
